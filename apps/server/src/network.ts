import type { Hono } from 'hono';
import { bindingRemote, gitProviderNames } from '../../../packages/shared/src/repositories.js';
import { defaultNetworkPolicy, egressGitServices, egressGrantPolicy, egressLfsService, egressPushService, GIT_DIRECT_CACHE_SECONDS, packageRegistryDomains, parseNetworkPolicy,
  type EgressGitService, type EgressGrant, type GitDirectAccess, type GitDirectGrant, type NetworkPolicy } from '../../../packages/shared/src/network.js';
import { sessionBranchRefusal, type PushCommand } from '../../../packages/shared/src/git-push.js';
import { fetchGit, gitUpstreamHeaders } from '../../../packages/shared/src/git-transfer.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import type { AppContext, Env, RepositoryRow, SessionRow, WorkerEnv } from './types.js';
import type { Database } from './db/types.js';
import { auditStatement, requireMember, sessionAccess } from './db.js';
import { fail, failTransfer, identifier, jsonObject, now } from './http.js';
import { authenticateConnector, requireCallbackScope, requireConnectorSession, type ConnectorRow } from './connectors.js';
import { grantSources } from './sources.js';
import { recheckAccess, repositoryAccess, repositorySettingsSelect, verifyRepository, type RepositoryAccess, type RepositorySettingsRow } from './repositories.js';
import { lfsDisabled, lfsEnabled, lfsRelay, lfsRequestBytes } from './lfs.js';
import { ownerGitAuthorization } from './push/targets.js';
import { sessionBranchPush, sessionBranchTarget } from './push/session-branch.js';
import { requireBinding } from './push/broker.js';
import { mintPushToken, mintRepositoryReadToken, type MintedToken } from './push/mint.js';
import { sessionApis } from './api-access.js';
import { webSearchProvider } from './web-search.js';

/** Owner/admin authority, re-checked inside the write (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;
/** A fetch request lists the objects wanted and had; even huge repositories stay far below this. */
const uploadRequestBytes = 64 * 1024 * 1024;

interface PolicyRow { mode: NetworkPolicy['mode']; domains_json: string; package_registries: number; web_search: number }

/** The workspace's network access, with its web search setting always named. */
export async function workspaceNetworkPolicy(db: Database, workspaceId: string): Promise<NetworkPolicy & { webSearch: boolean }> {
  const row = await db.query<PolicyRow>('SELECT mode, domains_json, package_registries, web_search FROM workspace_network_policies WHERE workspace_id = ?')
    .bind(workspaceId).first();
  if (!row) return { ...defaultNetworkPolicy, domains: [], webSearch: false };
  return { mode: row.mode, domains: JSON.parse(row.domains_json) as string[], packageRegistries: Number(row.package_registries) === 1,
    webSearch: Number(row.web_search) === 1 };
}

/** What the network access page shows besides the policy: the allowlist's registries, and the server's search provider. */
function policyResponse(env: Env, policy: NetworkPolicy) {
  return { policy, packageRegistryDomains, webSearchProvider: webSearchProvider(env)?.name ?? null };
}

export function registerNetworkPolicies(app: Hono<WorkerEnv>): void {
  // Every member may see what their sessions can reach; owners and admins change it.
  app.get('/api/workspaces/:id/network-policy', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json(policyResponse(c.env, await workspaceNetworkPolicy(c.env.DB, workspaceId)));
  });
  app.put('/api/workspaces/:id/network-policy', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    let parsed: NetworkPolicy;
    try { parsed = parseNetworkPolicy(await jsonObject(c, 16 * 1024)); }
    catch (error) { return fail(400, 'invalid_network_policy', error instanceof Error ? error.message : 'Invalid network policy.'); }
    // A client that predates web search names no setting for it, which keeps the saved one.
    const policy = { ...parsed, webSearch: parsed.webSearch ?? (await workspaceNetworkPolicy(c.env.DB, workspaceId)).webSearch };
    const saved = await c.env.DB.query(`INSERT INTO workspace_network_policies (workspace_id, mode, domains_json, package_registries, web_search, updated_by, updated_at)
      SELECT ?,?,?,?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET mode = excluded.mode, domains_json = excluded.domains_json,
        package_registries = excluded.package_registries, web_search = excluded.web_search, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING workspace_id`)
      .bind(workspaceId, policy.mode, JSON.stringify(policy.domains), policy.packageRegistries ? 1 : 0, policy.webSearch ? 1 : 0, actor, now(), workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.network_policy.updated', workspaceId, null, { ...policy }).run();
    return c.json(policyResponse(c.env, policy));
  });
}

/**
 * What one session's egress proxy may do: the workspace's network policy and its repositories. Hosts ask again every
 * minute, so a changed policy or a removed repository reaches running sessions without a restart.
 */
export async function egressGrant(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => key !== 'sessionId')) fail(400, 'invalid_egress_request', 'Only the session is accepted.');
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(input.sessionId, 'sessionId')).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  if (row.status === 'archived') fail(403, 'session_archived', 'Archived sessions have no network access.');
  const repositories = await c.env.DB.query<RepositorySettingsRow>(`${repositorySettingsSelect} WHERE r.workspace_id = ? ORDER BY r.id`)
    .bind(row.workspace_id).all();
  const grant: EgressGrant = {
    // Without the web search setting, which the control plane checks itself (web-search.ts): older connectors refuse a
    // policy that names it.
    policy: egressGrantPolicy(await workspaceNetworkPolicy(c.env.DB, row.workspace_id)),
    repositories: repositories.map(repository => ({ bindingId: repository.id, provider: repository.provider, host: repository.host,
      repositoryId: repository.repository_id, fullName: repository.full_name, lfs: repository.lfs_enabled === 1 })),
    sources: await grantSources(c.env, row.workspace_id),
  };
  // Credentialed APIs the session's proxy answers itself, asking apiCredential for the token it adds.
  const apis = sessionApis(c.env, row, repositories);
  if (apis.length) grant.apis = apis;
  return c.json(grant, 200, { 'Cache-Control': 'private, no-store' });
}

/** The request body, read whole within `limit`: Git's fetch requests are small, and the upstream wants a length. */
async function boundedRequest(c: AppContext, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > limit) fail(413, 'body_too_large', 'The Git request is too large.');
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, 'body_too_large', 'The Git request is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

interface GitAuthority {
  session: SessionRow; binding: RepositoryRow; access: RepositoryAccess;
  /** Every check of the session's authority and connector, repeated after each await that precedes an effect. */
  authorize: () => Promise<void>;
}

/**
 * What every Git request of a session's egress proxy needs, relayed or direct: the session, still the owner's and not
 * archived (with write access for a push, which only clone sessions make), served by this connector over its current
 * connection, and a repository bound to its workspace, with the owner's own account for it.
 */
async function gitAuthority(c: AppContext, connector: ConnectorRow | null, sessionId: string, bindingId: string, push: boolean): Promise<GitAuthority> {
  const original = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!original) fail(404, 'not_found', 'Session not found.');
  if (push && original.repository_mode !== 'clone') fail(403, 'session_branch_unavailable', 'Only clone sessions push through the egress proxy; use the git_push tool.');
  const authorize = async () => {
    const fresh = await sessionAccess(c.env, sessionId, original.owner_id);
    if (!fresh || fresh.row.status === 'archived' || fresh.row.owner_id !== original.owner_id || fresh.row.workspace_id !== original.workspace_id
        || (push && !hasPermission(fresh.permissions, 'write'))) {
      fail(403, 'repository_authority_changed', 'Session repository access is no longer authorized.');
    }
    if (connector) {
      const current = await authenticateConnector(c);
      if (current.id !== connector.id || current.connection_hash !== connector.connection_hash) fail(401, 'stale_connection', 'The connector connection changed.');
      await requireConnectorSession(c.env, connector.id, fresh.row, connector.connection_hash!);
    } else if (fresh.row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped Git relay.');
  };
  await authorize();
  const binding = await c.env.DB.query<RepositoryRow>('SELECT * FROM workspace_repositories WHERE id = ? AND workspace_id = ?')
    .bind(bindingId, original.workspace_id).first();
  if (!binding) fail(404, 'repository_not_bound', 'This repository is not bound to the session\'s workspace.');
  const access = await repositoryAccess(c.env, original.owner_id, binding.provider, binding.host, binding.full_name);
  return { session: original, binding, access, authorize };
}

/**
 * Relays one Git request for a session's egress proxy. Reads of a workspace repository use the session OWNER's own
 * credential; a clone session's pushes of its own branch use the workspace's push identity (sessionBranchPush). Either
 * credential stays on the control plane; the host sees only the Git protocol. Pushes elsewhere go through the approved
 * push broker. Hosts that get a direct grant (gitDirect) make these requests at the forge themselves instead.
 */
export async function gitRelay(c: AppContext, connector: ConnectorRow | null): Promise<Response> {
  const bindingId = identifier(c.req.param('bindingId'), 'bindingId');
  const service = c.req.param('service') as EgressGitService;
  if (!egressGitServices.includes(service)) fail(404, 'not_found', 'Unknown Git service.');
  const sessionId = identifier(c.req.query('sessionId'), 'sessionId');
  const { session, binding, access, authorize } = await gitAuthority(c, connector, sessionId, bindingId, egressPushService(service));
  if (egressPushService(service)) return sessionBranchPush(c, { session, binding, access, service, authorize });
  if (egressLfsService(service)) {
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415, 'unsupported_media_type', 'Expected a Git LFS relay request.');
    return lfsRelay(c, { binding, access, service, body: await boundedRequest(c, lfsRequestBytes), authorize });
  }
  const read = service as 'info-refs' | 'upload-pack';
  // Renames and transfers fail closed, on every request: nothing makes a sandboxed client fetch only after an advertisement.
  await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
  const remote = bindingRemote({ provider: binding.provider, host: binding.host, fullName: binding.full_name });
  let headers: Record<string, string>;
  try {
    headers = gitUpstreamHeaders(read, { userAgent: c.req.header('user-agent'), gitProtocol: c.req.header('git-protocol'),
      contentType: c.req.header('content-type'), contentEncoding: c.req.header('content-encoding') });
  } catch (error) { failTransfer(error); }
  const body = read === 'upload-pack' ? await boundedRequest(c, uploadRequestBytes) : undefined;
  await recheckAccess(c.env, access);
  await authorize();
  let upstream: { body: ReadableStream<Uint8Array>; contentType: string };
  try {
    upstream = await fetchGit({ remote, service: read, authorization: ownerGitAuthorization(access), headers, body,
      provider: gitProviderNames[binding.provider], fullName: binding.full_name, identity: 'owner' });
  } catch (error) { failTransfer(error); }
  return new Response(upstream.body, { headers: { 'Content-Type': upstream.contentType, 'Cache-Control': 'private, no-store' } });
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Which hosts get direct Git grants (GIT_DIRECT): `on` (the default), `own-hosts` (credentials only to the session
 * owner's own hosts and the control plane's own runner; every host still reads public repositories directly) or `off`
 * (everything is relayed, as before direct transfers).
 */
export function gitDirectMode(env: Env): 'on' | 'own-hosts' | 'off' {
  const value = env.GIT_DIRECT?.trim().toLowerCase();
  return value === 'off' || value === 'own-hosts' ? value : 'on';
}

/**
 * A direct grant for one Git request of a session's egress proxy (GitDirectGrant): the authority gitRelay checks for the
 * same request, then a credential the host uses at the forge itself, so the pack or object never crosses the control
 * plane.
 * - Reads and LFS downloads of a public repository need no credential, on any host.
 * - A private repository is read with a token limited to it and to reading (mintRepositoryReadToken) on any host, else
 *   with the owner's own account on the owner's own host or the control plane's own runner.
 * - A push of the session branch is made with the workspace's push identity, but only on the owner's own host or the
 *   control plane's own runner: its token can't be limited to that branch, which only the proxy enforces there.
 * Anything else is `direct: false`, and the host relays the request as before. The proxy reuses a read grant for at
 * most GIT_DIRECT_CACHE_SECONDS; a push asks for each request.
 */
export async function gitDirect(c: AppContext, connector: ConnectorRow | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'bindingId', 'access', 'command'].includes(key))) fail(400, 'invalid_direct_request', 'Unexpected direct Git field.');
  const sessionId = identifier(input.sessionId, 'sessionId');
  const bindingId = identifier(input.bindingId, 'bindingId');
  if (!['read', 'lfs', 'push'].includes(input.access as string)) fail(400, 'invalid_direct_request', 'Invalid direct Git access.');
  const kind = input.access as GitDirectAccess;
  let command: PushCommand | undefined;
  if (input.command !== undefined) {
    const value = input.command as Record<string, unknown> | null;
    if (kind !== 'push' || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['old', 'new', 'ref'].includes(key))
        || typeof value.old !== 'string' || !OBJECT_ID.test(value.old) || typeof value.new !== 'string' || !OBJECT_ID.test(value.new)
        || typeof value.ref !== 'string' || !/^refs\/[\x21-\x7e]{1,250}$/.test(value.ref)) fail(400, 'invalid_direct_request', 'Invalid push command.');
    command = { old: value.old, new: value.new, ref: value.ref };
  }
  const noStore = { 'Cache-Control': 'private, no-store' };
  const relay = (reason: string, cacheSeconds = GIT_DIRECT_CACHE_SECONDS) => c.json({ direct: false, reason, cacheSeconds } satisfies GitDirectGrant, 200, noStore);
  const grant = (value: Omit<Extract<GitDirectGrant, { direct: true }>, 'direct'>) => c.json({ direct: true, ...value } satisfies GitDirectGrant, 200, noStore);
  const { session, binding, access, authorize } = await gitAuthority(c, connector, sessionId, bindingId, kind === 'push');
  const mode = gitDirectMode(c.env);
  if (mode === 'off') return relay('Direct Git transfers are off on this Pistead server');
  // The session owner's own host, or the control plane's own runner (which the operator runs, as they run this server).
  const ownHost = connector !== null && connector.owner_id === session.owner_id && session.connector_owner_id === session.owner_id;
  const trusted = connector === null || ownHost;
  const expires = (seconds: number) => new Date((Math.floor(Date.now() / 1000) + seconds) * 1000).toISOString();

  if (kind === 'push') {
    if (!trusted) return relay('Pushes from a host shared with the workspace go through Pistead: a push token can\'t be limited to the session branch');
    const { branch, pin, target } = await sessionBranchTarget(c, session, binding, access);
    if (command) {
      const refusal = sessionBranchRefusal([command], branch);
      if (refusal) fail(403, 'session_branch_only', refusal);
    }
    await recheckAccess(c.env, access);
    await authorize();
    await requireBinding(c, session.workspace_id, pin);
    let minted: MintedToken;
    try {
      minted = await mintPushToken(c.env, { workspaceId: session.workspace_id, sessionId: session.id, provider: binding.provider, host: binding.host,
        fullName: binding.full_name, repositoryId: binding.repository_id, branch, ownerId: session.owner_id, connectorId: session.connector_id ?? null,
        hostOwnerId: session.connector_owner_id ?? null, owner: access });
    } catch {
      // The relay mints again and tells Git exactly why it can't push (a missing identity, an app not installed).
      return relay('The workspace\'s push identity gave no credential for a direct push', 0);
    }
    if (minted.authorization === null || minted.revocation?.kind === 'github-owner') {
      // The host's own Git credentials can't serve the proxy, and an owner's GitHub sign-in token that left the server
      // would have to be reset after the push: the control plane pushes with those itself.
      return relay('This push identity pushes through Pistead', 0);
    }
    const revoke = minted.revocation?.kind === 'github-installation'
      ? { url: `${minted.revocation.apiBase}/installation/token`, authorization: `Bearer ${minted.revocation.token}` } : undefined;
    if (command) {
      await auditStatement(c.env, session.owner_id, 'git.push.session_branch', session.workspace_id, session.id, {
        bindingId: binding.id, branch, old: command.old, new: command.new, kind: minted.kind, ...(minted.identityId ? { identityId: minted.identityId } : {}),
        direct: true,
      }).run();
    }
    return grant({ remote: target.remote, authorization: minted.authorization, kind: 'push-identity', expiresAt: new Date(minted.expiresAt * 1000).toISOString(),
      cacheSeconds: 0, ...(revoke ? { revoke } : {}) });
  }

  if (kind === 'lfs' && !await lfsEnabled(c.env.DB, binding)) lfsDisabled(binding);
  // Renames and transfers fail closed, as for every relayed read; the host reuses the grant for a minute at most.
  const metadata = await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
  const remote = bindingRemote({ provider: binding.provider, host: binding.host, fullName: binding.full_name });
  await recheckAccess(c.env, access);
  await authorize();
  if (!metadata.private) return grant({ remote, authorization: null, kind: 'public', expiresAt: expires(3600), cacheSeconds: GIT_DIRECT_CACHE_SECONDS });
  if (mode === 'on' || trusted) {
    const token = await mintRepositoryReadToken(c.env, { workspaceId: session.workspace_id, provider: binding.provider, host: binding.host,
      fullName: binding.full_name, repositoryId: binding.repository_id });
    if (token?.authorization) {
      await authorize();
      return grant({ remote, authorization: token.authorization, kind: 'repository-token', expiresAt: new Date(token.expiresAt * 1000).toISOString(),
        cacheSeconds: GIT_DIRECT_CACHE_SECONDS });
    }
  }
  if (trusted) return grant({ remote, authorization: ownerGitAuthorization(access), kind: 'owner-account', expiresAt: expires(3600), cacheSeconds: GIT_DIRECT_CACHE_SECONDS });
  return relay(`No credential limited to reading ${binding.full_name} is available for a host shared with the workspace`);
}
