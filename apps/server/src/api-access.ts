import { API_CREDENTIAL_CACHE_SECONDS, credentialedApiHosts, type ApiCredentialGrant } from '../../../packages/shared/src/network.js';
import type { AppContext, Env, RepositoryRow, SessionRow } from './types.js';
import { sessionAccess } from './db.js';
import { fail, identifier, jsonObject } from './http.js';
import { authenticateConnector, requireConnectorSession, type ConnectorRow } from './connectors.js';
import { recheckAccess, repositoryAccess, verifyRepository, type RepositoryAccess } from './repositories.js';
import { mintGitHubApiReadTokens } from './push/mint.js';

/*
 * Credentialed APIs for sandboxed sessions (see `credentialedApiHosts` and apps/runner/src/api-access.ts): the
 * session's egress proxy answers HTTPS to api.github.com itself and asks here for the credential it adds. The answer
 * is a GitHub App installation token per installation, limited to reading the workspace's github.com repositories that
 * the session owner can read; never the owner's own sign-in token, which can reach everything the owner can. The
 * proxy reuses it for a minute at most, so a session archived, a repository removed or an owner's access lost stops
 * its use within that.
 */

/**
 * Which hosts get these credentials (SANDBOX_GITHUB_API): `on` (the default) every host running a clone session,
 * `own-hosts` only session owners' own hosts and the server's own runner, `off` none, and sessions reach
 * api.github.com only as the network policy allows, without a credential.
 */
export function sandboxGitHubApiMode(env: Env): 'on' | 'own-hosts' | 'off' {
  const value = env.SANDBOX_GITHUB_API?.trim().toLowerCase();
  return value === 'off' || value === 'own-hosts' ? value : 'on';
}

/** The credentialed APIs a session's egress grant names: api.github.com, for a clone session of a workspace with github.com repositories. */
export function sessionApis(env: Env, session: SessionRow, repositories: Pick<RepositoryRow, 'provider'>[]): { host: string; provider: 'github' }[] {
  if (sandboxGitHubApiMode(env) === 'off' || session.repository_mode !== 'clone' || !repositories.some(repository => repository.provider === 'github')) return [];
  return [{ host: 'api.github.com', provider: 'github' }];
}

export async function apiCredential(c: AppContext, connector: ConnectorRow | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'host')) fail(400, 'invalid_api_request', 'Only the session and host are accepted.');
  const sessionId = identifier(input.sessionId, 'sessionId');
  if (typeof input.host !== 'string' || !credentialedApiHosts.includes(input.host)) fail(400, 'invalid_api_request', 'Not a credentialed API host.');
  const noStore = { 'Cache-Control': 'private, no-store' };
  const unavailable = (reason: string) => c.json({ available: false, reason, cacheSeconds: API_CREDENTIAL_CACHE_SECONDS } satisfies ApiCredentialGrant, 200, noStore);

  const original = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!original) fail(404, 'not_found', 'Session not found.');
  // The session, still its owner's and not archived, served by this connector over its current connection: the same
  // authority as each Git request of its proxy, checked again after every await that precedes handing out a token.
  const authorize = async () => {
    const fresh = await sessionAccess(c.env, sessionId, original.owner_id);
    if (!fresh || fresh.row.status === 'archived' || fresh.row.owner_id !== original.owner_id || fresh.row.workspace_id !== original.workspace_id) {
      fail(403, 'repository_authority_changed', 'Session repository access is no longer authorized.');
    }
    if (connector) {
      const current = await authenticateConnector(c);
      if (current.id !== connector.id || current.connection_hash !== connector.connection_hash) fail(401, 'stale_connection', 'The connector connection changed.');
      await requireConnectorSession(c.env, connector.id, fresh.row, connector.connection_hash!);
    } else if (fresh.row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped API credential route.');
  };
  await authorize();

  const mode = sandboxGitHubApiMode(c.env);
  if (mode === 'off') return unavailable('GitHub API access from sessions is off on this Pistead server');
  if (original.repository_mode !== 'clone') return unavailable('Only sessions that clone their repositories read the GitHub API through Pistead');
  const ownHost = connector !== null && connector.owner_id === original.owner_id && original.connector_owner_id === original.owner_id;
  if (mode === 'own-hosts' && connector !== null && !ownHost) return unavailable('This Pistead server gives GitHub API credentials only to session owners\' own hosts');

  const bindings = await c.env.DB.query<RepositoryRow>("SELECT * FROM workspace_repositories WHERE workspace_id = ? AND provider = 'github' ORDER BY id")
    .bind(original.workspace_id).all();
  if (!bindings.length) return unavailable('This workspace has no github.com repositories');
  let access: RepositoryAccess;
  try { access = await repositoryAccess(c.env, original.owner_id, 'github', 'github.com', bindings[0]!.full_name); }
  catch { return unavailable('The session owner has no GitHub connection, which reading the GitHub API with the workspace\'s repositories needs'); }
  // Only repositories the owner can read now, under the name and identity they were bound with.
  const readable: { fullName: string; repositoryId: string }[] = [];
  for (const binding of bindings.slice(0, 100)) {
    try {
      await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
      readable.push({ fullName: binding.full_name, repositoryId: binding.repository_id });
    } catch { /* Not readable by the owner, renamed or moved: left out of the token. */ }
  }
  if (!readable.length) return unavailable('The session owner can read none of this workspace\'s github.com repositories');
  await recheckAccess(c.env, access);
  await authorize();
  let minted: Awaited<ReturnType<typeof mintGitHubApiReadTokens>>;
  try { minted = await mintGitHubApiReadTokens(c.env, { workspaceId: original.workspace_id, repositories: readable }); }
  catch { return unavailable('GitHub did not issue a token for the workspace\'s GitHub App; try again later'); }
  if (!minted) return unavailable('Reading the GitHub API from sessions needs a GitHub App: the workspace\'s, under Push access, or this server\'s (GITHUB_APP_ID)');
  if (!minted.tokens.length) return unavailable(`The GitHub App is not installed on ${minted.notInstalled.slice(0, 3).join(', ')}${minted.notInstalled.length > 3 ? ' and others' : ''}`);
  await authorize();
  return c.json({
    available: true, cacheSeconds: API_CREDENTIAL_CACHE_SECONDS,
    credentials: minted.tokens.map(item => ({ account: item.account, authorization: `Bearer ${item.token}`, repositories: item.repositories,
      expiresAt: new Date(item.expiresAt * 1000).toISOString() })),
  } satisfies ApiCredentialGrant, 200, noStore);
}
