import type { Hono } from 'hono';
import type { GitHubRepository, SessionRepository, WorkspaceRepository } from '../../../packages/shared/src/repositories.js';
import { repositoryLimits } from '../../../packages/shared/src/repositories.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { getUser, requireMember, sessionAccess } from './db.js';
import { fail, id, identifier, jsonObject, now, testMode } from './http.js';
import { decryptToken } from './vault.js';
import { authenticateConnector, requireConnectorSession, type ConnectorRow } from './connectors.js';

interface RepositoryRow {
  id: string; workspace_id: string; repository_id: number; full_name: string; ref: string; private: number; created_at: string;
}
interface GitHubAccess { token: string; ciphertext: string; userId: string }
const apiOrigin = 'https://api.github.com';
const jsonBytes = 512 * 1024;
const remoteTimeout = 20000;

export function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 140 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
      ['.', '..', '.git'].includes(value.split('/')[1]!.toLowerCase())) {
    fail(400, 'invalid_repository', 'Use a GitHub repository name in owner/repository form.');
  }
  return value;
}
export function repositoryRef(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 ||
      /[\s\x00-\x1f\x7f\\~^:?*\[]/.test(value) || /[\uD800-\uDFFF]/u.test(value) ||
      value === '@' || value.includes('..') || value.includes('@{') || value.endsWith('.') ||
      value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    fail(400, 'invalid_repository_ref', 'Use a valid branch, tag, or commit reference.');
  }
  return value;
}
function repositoryId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(400, 'invalid_repository', 'A GitHub numeric repository identity is required.');
  return value as number;
}
function publicRepository(row: RepositoryRow): WorkspaceRepository {
  return { id: row.id, workspaceId: row.workspace_id, repositoryId: row.repository_id, fullName: row.full_name,
    ref: row.ref, private: !!row.private, createdAt: row.created_at };
}
export async function workspaceRepositories(env: Env, workspaceId: string): Promise<WorkspaceRepository[]> {
  const rows = await env.DB.prepare('SELECT * FROM workspace_repositories WHERE workspace_id = ? ORDER BY id').bind(workspaceId).all<RepositoryRow>();
  return rows.results.map(publicRepository);
}
export async function legacyRepositoryFixture(env: Env, userId: string): Promise<boolean> {
  return testMode(env) && (await getUser(env, userId))?.auth_kind === 'test';
}
export async function requireConfiguredWorkspace(env: Env, workspaceId: string, userId: string): Promise<void> {
  await requireMember(env, workspaceId, userId);
  if (!await env.DB.prepare('SELECT 1 FROM workspace_repositories WHERE workspace_id = ?').bind(workspaceId).first() &&
      !await legacyRepositoryFixture(env, userId)) fail(409, 'workspace_repositories_required', 'Configure at least one GitHub repository for this workspace first.');
}
async function githubAccess(env: Env, userId: string): Promise<GitHubAccess> {
  const user = await getUser(env, userId);
  if (user?.auth_kind === 'test') fail(403, 'github_not_connected', 'Synthetic users cannot access GitHub repositories.');
  if (!user || user.auth_kind !== 'github' || !user.github_id) fail(409, 'github_not_connected', 'The acting user must connect GitHub. Workspace sharing does not grant repository access.');
  const vault = await env.DB.prepare('SELECT ciphertext FROM github_tokens WHERE user_id = ?').bind(userId).first<{ ciphertext: string }>();
  if (!vault) fail(409, 'github_not_connected', 'The acting user must connect GitHub.');
  return { token: await decryptToken(env, userId, vault.ciphertext), ciphertext: vault.ciphertext, userId };
}
async function recheckGitHubAccess(env: Env, access: GitHubAccess): Promise<void> {
  const row = await env.DB.prepare(`SELECT t.ciphertext FROM github_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.user_id = ? AND u.auth_kind = 'github' AND u.github_id IS NOT NULL`).bind(access.userId).first<{ ciphertext: string }>();
  if (row?.ciphertext !== access.ciphertext) fail(403, 'github_access_changed', 'GitHub access changed; retry with the current connection.');
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
  if (!response.body) fail(502, 'invalid_github_response', 'GitHub returned an empty response.');
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
function githubRepository(value: unknown): GitHubRepository {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
  const item = value as Record<string, unknown>;
  if (typeof item.private !== 'boolean') fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
  return { id: repositoryId(item.id), fullName: repositoryName(item.full_name), defaultBranch: repositoryRef(item.default_branch), private: item.private };
}
async function verifyRepository(access: GitHubAccess, expected: { repositoryId: number; fullName: string }): Promise<GitHubRepository> {
  const name = repositoryName(expected.fullName);
  const metadata = githubRepository(await githubJSON(access, `/repos/${name}`));
  if (metadata.id !== expected.repositoryId || metadata.fullName !== name) {
    fail(409, 'repository_identity_changed', 'The GitHub repository identity or canonical name changed. Remove and reconfigure this binding.');
  }
  return metadata;
}
export async function resolveWorkspaceRepositories(env: Env, workspaceId: string, ownerId: string): Promise<{ repositories: SessionRepository[]; bindingIds: string }> {
  await requireMember(env, workspaceId, ownerId);
  const configured = await workspaceRepositories(env, workspaceId);
  const bindingIds = JSON.stringify(configured.map(item => item.id));
  if (!configured.length) {
    if (await legacyRepositoryFixture(env, ownerId)) return { repositories: [], bindingIds };
    fail(409, 'workspace_repositories_required', 'Configure at least one GitHub repository before starting a session.');
  }
  if (configured.length > repositoryLimits.repositories) fail(409, 'repository_limit', 'Too many workspace repositories.');
  const access = await githubAccess(env, ownerId);
  const repositories: SessionRepository[] = [];
  for (const binding of configured) {
    await verifyRepository(access, binding);
    const result = await githubJSON(access, `/repos/${binding.fullName}/commits/${encodeURIComponent(repositoryRef(binding.ref))}`) as { sha?: unknown };
    if (!result || typeof result.sha !== 'string' || !/^[0-9a-f]{40}$/.test(result.sha)) fail(502, 'invalid_repository_commit', 'GitHub did not return an immutable commit.');
    await verifyRepository(access, binding);
    repositories.push({ bindingId: binding.id, repositoryId: binding.repositoryId, fullName: binding.fullName,
      ref: binding.ref, commit: result.sha, path: binding.fullName });
  }
  await recheckGitHubAccess(env, access);
  await requireMember(env, workspaceId, ownerId);
  if (JSON.stringify((await workspaceRepositories(env, workspaceId)).map(item => item.id)) !== bindingIds) {
    fail(409, 'repository_configuration_changed', 'Workspace repositories changed while resolving references. Try again.');
  }
  return { repositories, bindingIds };
}

export function registerRepositories(app: Hono<WorkerEnv>): void {
  app.get('/api/github/repositories', async c => {
    const rawPage = c.req.query('page') ?? '1';
    if (!/^[1-9]\d{0,3}$/.test(rawPage) || Number(rawPage) > 1000) fail(400, 'invalid_page', 'Repository page must be between 1 and 1000.');
    const page = Number(rawPage); const access = await githubAccess(c.env, c.get('auth').userId);
    const result = await githubJSON(access, `/user/repos?per_page=30&page=${page}&sort=full_name&direction=asc`);
    if (!Array.isArray(result) || result.length > 30) fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
    const repositories = result.map(githubRepository);
    await recheckGitHubAccess(c.env, access);
    return c.json({ repositories, page, hasMore: repositories.length === 30 && page < 1000 });
  });
  app.get('/api/workspaces/:id/repositories', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ repositories: await workspaceRepositories(c.env, workspaceId) });
  });
  app.post('/api/workspaces/:id/repositories', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => !['repositoryId', 'fullName', 'ref'].includes(key))) fail(400, 'invalid_repository', 'Only repository identity and ref may be configured.');
    const expected = { repositoryId: repositoryId(input.repositoryId), fullName: repositoryName(input.fullName) };
    const access = await githubAccess(c.env, actor); const metadata = await verifyRepository(access, expected);
    const ref = input.ref === undefined ? metadata.defaultBranch : repositoryRef(input.ref);
    await recheckGitHubAccess(c.env, access);
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row: RepositoryRow = { id: id(), workspace_id: workspaceId, repository_id: expected.repositoryId, full_name: metadata.fullName,
      ref, private: metadata.private ? 1 : 0, created_at: now() };
    const inserted = await c.env.DB.prepare(`INSERT INTO workspace_repositories (id,workspace_id,repository_id,full_name,ref,private,created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))
      AND (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = ?) < 5
      AND NOT EXISTS (SELECT 1 FROM workspace_repositories WHERE workspace_id = ? AND (repository_id = ? OR full_name = ? COLLATE NOCASE)) RETURNING id`)
      .bind(row.id, workspaceId, row.repository_id, row.full_name, row.ref, row.private, row.created_at, workspaceId, actor, workspaceId, workspaceId, row.repository_id, row.full_name).first();
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

function pinnedRepository(row: SessionRow, bindingId: string, commit: unknown): SessionRepository {
  let repositories: SessionRepository[];
  try { repositories = JSON.parse(row.repositories_json ?? '[]'); } catch { return fail(409, 'invalid_binding', 'Session repository binding is invalid.'); }
  if (!Array.isArray(repositories) || repositories.length > repositoryLimits.repositories) fail(409, 'invalid_binding', 'Session repository binding is invalid.');
  const pin = repositories.find(item => item.bindingId === bindingId);
  if (!pin || pin.commit !== commit || !/^[0-9a-f]{40}$/.test(pin.commit) || pin.path !== pin.fullName) fail(403, 'repository_binding_mismatch', 'This download does not match a pinned session repository.');
  repositoryName(pin.fullName); repositoryId(pin.repositoryId);
  return pin;
}
export function archiveRedirect(location: string | null, repository: SessionRepository): string {
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
  const access = await githubAccess(c.env, original.owner_id);
  await verifyRepository(access, repository);
  await authorize();
  const redirect = await remoteFetch(`${apiOrigin}/repos/${repository.fullName}/tarball/${repository.commit}`, { headers: headers(access) });
  if (redirect.status !== 302) { await redirect.body?.cancel(); fail(502, 'invalid_archive_redirect', 'GitHub did not return the expected archive redirect.'); }
  const location = redirect.headers.get('location'); await redirect.body?.cancel();
  const url = archiveRedirect(location, repository);
  // OAuth credentials are never forwarded across origins, even to GitHub's archive service.
  const response = await remoteFetch(url, { headers: { Accept: 'application/gzip', 'User-Agent': 'OpenCara-Agent-Workspace' } });
  if (response.status !== 200) { await response.body?.cancel(); fail(502, 'repository_download_failed', 'GitHub could not supply the pinned archive.'); }
  const bytes = await boundedRepositoryBody(response, repositoryLimits.archiveBytes);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) fail(502, 'invalid_repository_archive', 'GitHub did not return a gzip archive.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const checksum = btoa(String.fromCharCode(...digest)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  await verifyRepository(access, repository);
  await recheckGitHubAccess(c.env, access);
  await authorize();
  return new Response(bytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length),
    'Cache-Control': 'private, no-store', 'X-Repository-Commit': repository.commit, 'X-Archive-SHA256': checksum } });
}
