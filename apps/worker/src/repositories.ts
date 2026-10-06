import type { Hono } from 'hono';
import type { GitProvider, ProviderRepository, SessionRepository, TokenGitProvider, WorkspaceRepository } from '../../../packages/shared/src/repositories.js';
import { gitProviderNames, gitProviders, repositoryLimits, repositoryPath, validRepositoryId, validRepositoryName } from '../../../packages/shared/src/repositories.js';
import type { AppContext, Env, RepositoryRow, SessionRow, WorkerEnv } from './types.js';
import { getUser, requireMember, sessionAccess } from './db.js';
import { fail, id, identifier, jsonObject, now, testMode } from './http.js';
import { decryptToken } from './vault.js';
import { authenticateConnector, requireConnectorSession, type ConnectorRow } from './connectors.js';
import {
  credentialOrganization, gitAccountRequired, gitHost, loadCredential, providerRepository, recheckCredential, tokenProvider, validProviderHost,
  type LoadedCredential,
} from './git/accounts.js';
import { gitProviderAdapters } from './git/providers.js';
import { zipToTarGz } from './git/zip.js';

export interface GitHubAccess { token: string; ciphertext: string; userId: string; githubId: string }
/** The acting user's credential for one provider/host: the sign-in OAuth token for github.com, a token account otherwise. */
export type RepositoryAccess = { provider: 'github'; github: GitHubAccess } | { provider: TokenGitProvider; account: LoadedCredential };
interface ExpectedRepository { repositoryId: string; fullName: string }
interface RepositoryResolution {
  repositories: SessionRepository[];
  bindingIds: string;
  githubAuthority: Pick<GitHubAccess, 'ciphertext' | 'githubId'> | null;
  /** Token accounts that resolved the pins; session admission requires each to be unchanged. */
  credentials: { id: string; ciphertext: string }[];
}
const apiOrigin = 'https://api.github.com';
const jsonBytes = 512 * 1024;
const remoteTimeout = 20000;

function repositoryName(provider: GitProvider, value: unknown): string {
  if (!validRepositoryName(provider, value)) {
    fail(400, 'invalid_repository', provider === 'github' ? 'Use a GitHub repository name in owner/repository form.'
      : `Use a ${gitProviderNames[provider]} repository name.`);
  }
  return value;
}
export function validRepositoryRef(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
    !/[\s\x00-\x1f\x7f\\~^:?*\[]/.test(value) && !/[\uD800-\uDFFF]/u.test(value) &&
    value !== '@' && !value.includes('..') && !value.includes('@{') && !value.endsWith('.') &&
    !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'));
}
export function repositoryRef(value: unknown): string {
  if (!validRepositoryRef(value)) fail(400, 'invalid_repository_ref', 'Use a valid branch, tag, or commit reference.');
  return value;
}
function bindingRepositoryId(provider: GitProvider, value: unknown): string {
  if (provider === 'github') {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      fail(400, 'invalid_repository', 'A GitHub numeric repository identity is required.');
    }
  } else if (!validRepositoryId(value)) fail(400, 'invalid_repository', `A ${gitProviderNames[provider]} repository identity is required.`);
  return value;
}
export function publicRepository(row: RepositoryRow & { forbid_default_branch?: number | null }): WorkspaceRepository {
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, host: row.host, repositoryId: row.repository_id,
    fullName: row.full_name, ref: row.ref, private: !!row.private, createdAt: row.created_at, forbidDefaultBranchPush: row.forbid_default_branch === 1 };
}
export async function workspaceRepositories(env: Env, workspaceId: string): Promise<WorkspaceRepository[]> {
  const rows = await env.DB.prepare(`SELECT r.*, p.forbid_default_branch FROM workspace_repositories r
    LEFT JOIN repository_push_policies p ON p.binding_id = r.id WHERE r.workspace_id = ? ORDER BY r.id`)
    .bind(workspaceId).all<RepositoryRow & { forbid_default_branch: number | null }>();
  return rows.results.map(publicRepository);
}
export async function legacyRepositoryFixture(env: Env, userId: string): Promise<boolean> {
  return testMode(env) && (await getUser(env, userId))?.auth_kind === 'test';
}
export async function requireConfiguredWorkspace(env: Env, workspaceId: string, userId: string): Promise<void> {
  await requireMember(env, workspaceId, userId);
  if (!await env.DB.prepare('SELECT 1 FROM workspace_repositories WHERE workspace_id = ?').bind(workspaceId).first() &&
      !await legacyRepositoryFixture(env, userId)) fail(409, 'workspace_repositories_required', 'Configure at least one repository for this workspace first.');
}
/** Worktree paths must be distinct and never nest, ignoring case (macOS and Windows hosts). */
function conflictingPaths(paths: string[]): boolean {
  const lower = paths.map(path => path.toLowerCase());
  return lower.some((path, index) => lower.some((other, otherIndex) => index !== otherIndex && (path === other || other.startsWith(`${path}/`))));
}
async function githubAccess(env: Env, userId: string): Promise<GitHubAccess> {
  const user = await getUser(env, userId);
  if (user?.auth_kind === 'test') fail(403, 'github_not_connected', 'Synthetic users cannot access GitHub repositories.');
  if (!user || user.auth_kind !== 'github' || !user.github_id) fail(409, 'github_not_connected', 'The acting user must connect GitHub. Workspace sharing does not grant repository access.');
  const vault = await env.DB.prepare('SELECT ciphertext FROM github_tokens WHERE user_id = ?').bind(userId).first<{ ciphertext: string }>();
  if (!vault) fail(409, 'github_not_connected', 'The acting user must connect GitHub.');
  return { token: await decryptToken(env, userId, vault.ciphertext), ciphertext: vault.ciphertext, userId, githubId: user.github_id };
}
async function recheckGitHubAccess(env: Env, access: GitHubAccess): Promise<void> {
  const row = await env.DB.prepare(`SELECT t.ciphertext FROM github_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.user_id = ? AND u.auth_kind = 'github' AND u.github_id = ?`).bind(access.userId, access.githubId).first<{ ciphertext: string }>();
  if (row?.ciphertext !== access.ciphertext) fail(403, 'github_access_changed', 'GitHub access changed; retry with the current connection.');
}
export async function repositoryAccess(env: Env, userId: string, provider: GitProvider, host: string, fullName: string): Promise<RepositoryAccess> {
  if (provider === 'github') return { provider, github: await githubAccess(env, userId) };
  const account = await loadCredential(env, userId, provider, host, credentialOrganization(provider, fullName));
  if (!account) gitAccountRequired(provider, host, fullName);
  return { provider, account };
}
export async function recheckAccess(env: Env, access: RepositoryAccess): Promise<void> {
  if (access.provider === 'github') await recheckGitHubAccess(env, access.github);
  else await recheckCredential(env, access.account);
}
function headers(access: GitHubAccess): Record<string, string> {
  return { Authorization: `Bearer ${access.token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCara-Agent-Workspace' };
}
async function remoteFetch(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout) }); }
  catch { return fail(502, 'github_unavailable', 'GitHub could not complete the repository request.'); }
}
export async function boundedRepositoryBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    fail(502, 'repository_size_limit', 'The repository response exceeds the supported size limit.');
  }
  if (!response.body) fail(502, 'invalid_github_response', 'The Git provider returned an empty response.');
  const reader = response.body.getReader();
  const deadline = Date.now() + remoteTimeout;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, remoteTimeout);
  const bytes = new Uint8Array(limit); let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (timedOut || Date.now() >= deadline) fail(502, 'repository_download_failed', 'The repository response timed out.');
      if (item.done) break;
      if (item.value.byteLength > limit - size) fail(502, 'repository_size_limit', 'The repository response exceeds the supported size limit.');
      bytes.set(item.value, size);
      size += item.value.byteLength;
    }
  } catch {
    void reader.cancel().catch(() => {});
    fail(502, 'repository_download_failed', 'The repository response was too large, incomplete, or timed out.');
  } finally { clearTimeout(timer); reader.releaseLock(); }
  return bytes.slice(0, size);
}
async function githubJSON(access: GitHubAccess, path: string): Promise<unknown> {
  const response = await remoteFetch(`${apiOrigin}${path}`, { headers: headers(access) });
  if (!response.ok || response.status !== 200) {
    await response.body?.cancel();
    fail(response.status === 403 || response.status === 404 || response.status === 401 ? 403 : 502,
      'github_repository_unavailable', 'GitHub repository access could not be verified. Check repository access and try again.');
  }
  const bytes = await boundedRepositoryBody(response, jsonBytes);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.'); }
}
function githubRepository(value: unknown): ProviderRepository {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
  const item = value as Record<string, unknown>;
  if (typeof item.private !== 'boolean') fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
  if (!Number.isSafeInteger(item.id) || (item.id as number) <= 0) fail(400, 'invalid_repository', 'A GitHub numeric repository identity is required.');
  return { id: String(item.id), fullName: repositoryName('github', item.full_name),
    defaultBranch: repositoryRef(item.default_branch), private: item.private };
}
/** The sign-in account's picker page (account id "github"). */
export async function githubRepositoryPage(env: Env, userId: string, page: number): Promise<{ repositories: ProviderRepository[]; page: number; hasMore: boolean }> {
  const access = await githubAccess(env, userId);
  const result = await githubJSON(access, `/user/repos?per_page=30&page=${page}&sort=full_name&direction=asc`);
  if (!Array.isArray(result) || result.length > 30) fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
  const repositories = result.map(githubRepository);
  await recheckGitHubAccess(env, access);
  return { repositories, page, hasMore: repositories.length === 30 && page < 1000 };
}
/** Current metadata must still carry the bound identity and exact canonical name (renames and transfers fail closed). */
export async function verifyRepository(access: RepositoryAccess, expected: ExpectedRepository): Promise<ProviderRepository> {
  const name = repositoryName(access.provider, expected.fullName);
  const metadata = access.provider === 'github'
    ? githubRepository(await githubJSON(access.github, `/repos/${name}`))
    : providerRepository(access.provider, await gitProviderAdapters[access.provider].repository(access.account.credential, { id: expected.repositoryId, fullName: name }));
  if (metadata.id !== expected.repositoryId || metadata.fullName !== name) {
    fail(409, 'repository_identity_changed', `The ${gitProviderNames[access.provider]} repository identity or canonical name changed. Remove and reconfigure this binding.`);
  }
  return metadata;
}
async function repositoryCommit(access: RepositoryAccess, binding: WorkspaceRepository): Promise<string> {
  const ref = repositoryRef(binding.ref);
  const sha = access.provider === 'github'
    ? (await githubJSON(access.github, `/repos/${binding.fullName}/commits/${encodeURIComponent(ref)}`) as { sha?: unknown } | null)?.sha
    : await gitProviderAdapters[access.provider].commit(access.account.credential, { id: binding.repositoryId, fullName: binding.fullName }, ref);
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) fail(502, 'invalid_repository_commit', `${gitProviderNames[access.provider]} did not return an immutable commit.`);
  return sha;
}
export async function resolveWorkspaceRepositories(env: Env, workspaceId: string, ownerId: string, options: { gitProviders: boolean }): Promise<RepositoryResolution> {
  await requireMember(env, workspaceId, ownerId);
  const configured = await workspaceRepositories(env, workspaceId);
  const bindingIds = JSON.stringify(configured.map(item => item.id));
  if (!configured.length) {
    if (await legacyRepositoryFixture(env, ownerId)) return { repositories: [], bindingIds, githubAuthority: null, credentials: [] };
    fail(409, 'workspace_repositories_required', 'Configure at least one repository before starting a session.');
  }
  if (configured.length > repositoryLimits.repositories) fail(409, 'repository_limit', 'Too many workspace repositories.');
  const foreign = configured.find(item => item.provider !== 'github');
  if (foreign && !options.gitProviders) {
    fail(409, 'connector_update_required', `Update the host's connector (npx pistead@latest connect) to use ${gitProviderNames[foreign.provider]} repositories.`);
  }
  if (conflictingPaths(configured.map(repositoryPath))) fail(409, 'repository_path_conflict', 'Two workspace repositories would share a worktree directory. Remove one binding.');
  // Every binding resolves with the SESSION OWNER's own account for its provider; sharing never lends credentials.
  const accounts = new Map<string, RepositoryAccess>();
  const repositories: SessionRepository[] = [];
  for (const binding of configured) {
    const key = JSON.stringify([binding.provider, binding.host, credentialOrganization(binding.provider, binding.fullName)]);
    const access = accounts.get(key) ?? await repositoryAccess(env, ownerId, binding.provider, binding.host, binding.fullName);
    accounts.set(key, access);
    await verifyRepository(access, binding);
    const commit = await repositoryCommit(access, binding);
    await verifyRepository(access, binding);
    // GitHub pins keep their original key order and numeric id so persisted bindings stay byte-identical.
    repositories.push(binding.provider === 'github'
      ? { bindingId: binding.id, repositoryId: Number(binding.repositoryId), fullName: binding.fullName, ref: binding.ref, commit, path: binding.fullName }
      : { bindingId: binding.id, provider: binding.provider, host: binding.host, repositoryId: binding.repositoryId, fullName: binding.fullName,
        ref: binding.ref, commit, path: repositoryPath(binding) });
  }
  for (const access of accounts.values()) await recheckAccess(env, access);
  await requireMember(env, workspaceId, ownerId);
  if (JSON.stringify((await workspaceRepositories(env, workspaceId)).map(item => item.id)) !== bindingIds) {
    fail(409, 'repository_configuration_changed', 'Workspace repositories changed while resolving references. Try again.');
  }
  const used = [...accounts.values()];
  const github = used.find(access => access.provider === 'github')?.github;
  return { repositories, bindingIds,
    githubAuthority: github ? { ciphertext: github.ciphertext, githubId: github.githubId } : null,
    credentials: used.flatMap(access => access.provider === 'github' ? [] : [{ id: access.account.credential.id, ciphertext: access.account.ciphertext }]) };
}

export function registerRepositories(app: Hono<WorkerEnv>): void {
  app.get('/api/workspaces/:id/repositories', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ repositories: await workspaceRepositories(c.env, workspaceId) });
  });
  app.post('/api/workspaces/:id/repositories', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => !['provider', 'host', 'repositoryId', 'fullName', 'ref'].includes(key))) fail(400, 'invalid_repository', 'Only repository provider, host, identity and ref may be configured.');
    if (!(gitProviders as readonly unknown[]).includes(input.provider)) fail(400, 'invalid_repository', 'Choose a supported Git provider.');
    const provider = input.provider as GitProvider;
    const host = gitHost(provider, input.host);
    const expected = { repositoryId: bindingRepositoryId(provider, input.repositoryId), fullName: repositoryName(provider, input.fullName) };
    const access = await repositoryAccess(c.env, actor, provider, host, expected.fullName);
    const metadata = await verifyRepository(access, expected);
    const ref = input.ref === undefined ? metadata.defaultBranch : repositoryRef(input.ref);
    const existing = await workspaceRepositories(c.env, workspaceId);
    if (conflictingPaths([...existing.map(repositoryPath), repositoryPath({ provider, host, fullName: metadata.fullName })])) {
      fail(409, 'repository_binding_conflict', 'Repository already configured or its worktree directory is taken by another binding.');
    }
    await recheckAccess(c.env, access);
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row: RepositoryRow = { id: id(), workspace_id: workspaceId, provider, host, repository_id: expected.repositoryId, full_name: metadata.fullName,
      ref, private: metadata.private ? 1 : 0, created_at: now() };
    // The exact credential that verified the repository must still be current in the same write.
    const authority = access.provider === 'github'
      ? { sql: `EXISTS (SELECT 1 FROM github_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.user_id = ? AND t.ciphertext = ? AND u.auth_kind = 'github' AND u.github_id = ?)`,
        values: [actor, access.github.ciphertext, access.github.githubId] }
      : { sql: `EXISTS (SELECT 1 FROM git_credentials g JOIN users u ON u.id = g.user_id
          WHERE g.id = ? AND g.user_id = ? AND g.ciphertext = ? AND (u.auth_kind = 'github' OR (? = 1 AND u.auth_kind = 'test')))`,
        values: [access.account.credential.id, actor, access.account.ciphertext, testMode(c.env) ? 1 : 0] };
    const inserted = await c.env.DB.prepare(`INSERT INTO workspace_repositories (id,workspace_id,provider,host,repository_id,full_name,ref,private,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))
      AND ${authority.sql}
      AND (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = ?) < 5
      AND NOT EXISTS (SELECT 1 FROM workspace_repositories WHERE workspace_id = ? AND provider = ? AND host = ?
        AND (repository_id = ? OR full_name = ? COLLATE NOCASE)) RETURNING id`)
      .bind(row.id, workspaceId, row.provider, row.host, row.repository_id, row.full_name, row.ref, row.private, row.created_at, workspaceId, actor,
        ...authority.values, workspaceId, workspaceId, row.provider, row.host, row.repository_id, row.full_name).first();
    if (!inserted) fail(409, 'repository_binding_conflict', 'Repository already configured, limit reached, or workspace authority changed.');
    return c.json({ repository: publicRepository(row) }, 201);
  });
  app.delete('/api/workspaces/:id/repositories/:repositoryId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    await c.env.DB.prepare(`DELETE FROM workspace_repositories WHERE id = ? AND workspace_id = ?
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`)
      .bind(identifier(c.req.param('repositoryId')), workspaceId, workspaceId, actor).run();
    return c.body(null, 204);
  });
}

/** A pin must have exactly one of the two persisted shapes, with the path the server would have assigned. */
export function validPin(pin: SessionRepository): boolean {
  const keys = Object.keys(pin).sort().join(',');
  if (!('provider' in pin)) {
    return keys === 'bindingId,commit,fullName,path,ref,repositoryId' && Number.isSafeInteger(pin.repositoryId) && pin.repositoryId > 0 &&
      validRepositoryName('github', pin.fullName) && pin.path === pin.fullName;
  }
  return keys === 'bindingId,commit,fullName,host,path,provider,ref,repositoryId' && tokenProvider(pin.provider) &&
    validProviderHost(pin.provider, pin.host) && validRepositoryId(pin.repositoryId) && validRepositoryName(pin.provider, pin.fullName) &&
    pin.path === repositoryPath(pin);
}
function pinnedRepository(row: SessionRow, bindingId: string, commit: unknown): SessionRepository {
  let repositories: SessionRepository[];
  try { repositories = JSON.parse(row.repositories_json ?? '[]'); } catch { return fail(409, 'invalid_binding', 'Session repository binding is invalid.'); }
  if (!Array.isArray(repositories) || repositories.length > repositoryLimits.repositories) fail(409, 'invalid_binding', 'Session repository binding is invalid.');
  const pin = repositories.find(item => item && typeof item === 'object' && item.bindingId === bindingId);
  if (!pin || pin.commit !== commit || !/^[0-9a-f]{40}$/.test(pin.commit) || !validPin(pin)) fail(403, 'repository_binding_mismatch', 'This download does not match a pinned session repository.');
  return pin;
}
export function archiveRedirect(location: string | null, repository: { fullName: string; commit: string }): string {
  if (!location) fail(502, 'invalid_archive_redirect', 'GitHub did not return a trusted archive location.');
  let url: URL;
  try { url = new URL(location); } catch { return fail(502, 'invalid_archive_redirect', 'GitHub returned an invalid archive location.'); }
  const path = `/${repository.fullName}/legacy.tar.gz/${repository.commit}`;
  const query = url.search;
  if (url.origin !== 'https://codeload.github.com' || url.username || url.password || url.port || url.hash || url.pathname !== path ||
      (query !== '' && !/^\?token=[A-Za-z0-9_-]{1,1024}$/.test(query)) ||
      location !== `${url.origin}${path}${query}`) fail(502, 'invalid_archive_redirect', 'GitHub returned an untrusted archive location.');
  return url.href;
}
async function githubArchive(access: GitHubAccess, repository: { fullName: string; commit: string }): Promise<Uint8Array<ArrayBuffer>> {
  const redirect = await remoteFetch(`${apiOrigin}/repos/${repository.fullName}/tarball/${repository.commit}`, { headers: headers(access) });
  if (redirect.status !== 302) { await redirect.body?.cancel(); fail(502, 'invalid_archive_redirect', 'GitHub did not return the expected archive redirect.'); }
  const location = redirect.headers.get('location'); await redirect.body?.cancel();
  const url = archiveRedirect(location, repository);
  // OAuth credentials are never forwarded across origins, even to GitHub's archive service.
  const response = await remoteFetch(url, { headers: { Accept: 'application/gzip', 'User-Agent': 'OpenCara-Agent-Workspace' } });
  if (response.status !== 200) { await response.body?.cancel(); fail(502, 'repository_download_failed', 'GitHub could not supply the pinned archive.'); }
  return boundedRepositoryBody(response, repositoryLimits.archiveBytes);
}
async function providerArchive(access: Extract<RepositoryAccess, { account: LoadedCredential }>, repository: SessionRepository): Promise<Uint8Array<ArrayBuffer>> {
  const archive = await gitProviderAdapters[access.provider].archive(access.account.credential,
    { id: String(repository.repositoryId), fullName: repository.fullName }, repository.commit);
  if (archive.format === 'tar.gz') return archive.bytes;
  // Zip snapshots become the same single-top-directory tar.gz the runner extracts for GitHub (name bounded to 80 characters).
  const name = repository.fullName.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '-').slice(0, 64);
  const bytes = await zipToTarGz(archive.bytes, `${name}-${repository.commit.slice(0, 12)}`);
  if (bytes.length > repositoryLimits.archiveBytes) fail(502, 'repository_size_limit', 'The repository response exceeds the supported size limit.');
  return bytes;
}
export async function repositoryDownload(c: AppContext, connector: ConnectorRow | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'commit'].includes(key))) fail(400, 'invalid_repository_download', 'Only the session and pinned commit are accepted.');
  const sessionId = identifier(input.sessionId, 'sessionId'); const bindingId = identifier(c.req.param('bindingId'));
  const original = await c.env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first<SessionRow>();
  if (!original) fail(404, 'not_found', 'Session not found.');
  const repository = pinnedRepository(original, bindingId, input.commit);
  const authorize = async () => {
    const fresh = await sessionAccess(c.env, sessionId, original.owner_id);
    if (!fresh || fresh.row.status === 'archived' || fresh.row.policy_version !== original.policy_version ||
        fresh.row.repositories_json !== original.repositories_json || fresh.row.owner_id !== original.owner_id) fail(403, 'repository_authority_changed', 'Session repository access is no longer authorized.');
    if (connector) {
      const current = await authenticateConnector(c);
      if (current.id !== connector.id || current.connection_hash !== connector.connection_hash) fail(401, 'stale_connection', 'The connector connection changed.');
      await requireConnectorSession(c.env, connector.id, fresh.row, connector.connection_hash!);
    } else if (fresh.row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped repository callback.');
  };
  await authorize();
  const provider: GitProvider = 'provider' in repository ? repository.provider : 'github';
  const host = 'provider' in repository ? repository.host : 'github.com';
  const access = await repositoryAccess(c.env, original.owner_id, provider, host, repository.fullName);
  const expected = { repositoryId: String(repository.repositoryId), fullName: repository.fullName };
  await verifyRepository(access, expected);
  await authorize();
  const bytes = access.provider === 'github' ? await githubArchive(access.github, repository) : await providerArchive(access, repository);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) fail(502, 'invalid_repository_archive', `${gitProviderNames[provider]} did not return a gzip archive.`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const checksum = btoa(String.fromCharCode(...digest)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  await verifyRepository(access, expected);
  await recheckAccess(c.env, access);
  await authorize();
  return new Response(bytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length),
    'Cache-Control': 'private, no-store', 'X-Repository-Commit': repository.commit, 'X-Archive-SHA256': checksum } });
}
