import type { Hono } from 'hono';
import type { GitProvider, ProviderRepository, ProviderRepositoryList, SessionRepository, TokenGitProvider, WorkspaceRepository, WorkspaceRepositoryList } from '../../../packages/shared/src/repositories.js';
import { gitProviderNames, gitProviders, repositoryLimits, repositoryPath, validRepositoryId, validRepositoryName } from '../../../packages/shared/src/repositories.js';
import type { Env, RepositoryRow, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, getUser, requireMember } from './db.js';
import { fail, id, identifier, jsonObject, now, testMode } from './http.js';
import { decryptToken } from './vault.js';
import {
  credentialOrganization, gitAccountRequired, gitHost, loadCredential, providerRepository, recheckCredential, tokenProvider, validProviderHost,
  type LoadedCredential,
} from './git/accounts.js';
import { collectRepositories, gitProviderAdapters, listBytes, listPageSize } from './git/providers.js';

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
/** A binding with the settings that live beside it (bindings are immutable): its push policy and Git LFS switch. */
export type RepositorySettingsRow = RepositoryRow & { forbid_default_branch?: number | null; lfs_enabled?: number | null };
/** Selects `r.*` with its settings; callers add their WHERE and ORDER BY on `r`. */
export const repositorySettingsSelect = `SELECT r.*, p.forbid_default_branch, l.enabled AS lfs_enabled FROM workspace_repositories r
  LEFT JOIN repository_push_policies p ON p.binding_id = r.id AND p.workspace_id = r.workspace_id
  LEFT JOIN repository_lfs_settings l ON l.binding_id = r.id AND l.workspace_id = r.workspace_id`;
export function publicRepository(row: RepositorySettingsRow): WorkspaceRepository {
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, host: row.host, repositoryId: row.repository_id,
    fullName: row.full_name, ref: row.ref, private: !!row.private, createdAt: row.created_at, forbidDefaultBranchPush: row.forbid_default_branch === 1,
    lfs: row.lfs_enabled === 1 };
}
export async function workspaceRepositories(env: Env, workspaceId: string): Promise<WorkspaceRepository[]> {
  const rows = await env.DB.query<RepositorySettingsRow>(`${repositorySettingsSelect} WHERE r.workspace_id = ? ORDER BY r.id`)
    .bind(workspaceId).all();
  return rows.map(publicRepository);
}
export async function legacyRepositoryFixture(env: Env, userId: string): Promise<boolean> {
  return testMode(env) && (await getUser(env, userId))?.auth_kind === 'test';
}
export async function requireConfiguredWorkspace(env: Env, workspaceId: string, userId: string): Promise<void> {
  await requireMember(env, workspaceId, userId);
  if (!await env.DB.query('SELECT 1 FROM workspace_repositories WHERE workspace_id = ?').bind(workspaceId).first() &&
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
  if (user?.auth_kind === 'password') fail(409, 'github_not_connected', 'github.com repositories need an account that signs in with GitHub. This account signs in with a password; its Git accounts reach other providers.');
  if (!user || user.auth_kind !== 'github' || !user.github_id) fail(409, 'github_not_connected', 'The acting user must connect GitHub. Workspace sharing does not grant repository access.');
  const vault = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM github_tokens WHERE user_id = ?').bind(userId).first();
  if (!vault) fail(409, 'github_not_connected', 'The acting user must connect GitHub.');
  return { token: await decryptToken(env, userId, vault.ciphertext), ciphertext: vault.ciphertext, userId, githubId: user.github_id };
}
async function recheckGitHubAccess(env: Env, access: GitHubAccess): Promise<void> {
  const row = await env.DB.query<{ ciphertext: string }>(`SELECT t.ciphertext FROM github_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.user_id = ? AND u.auth_kind = 'github' AND u.github_id = ?`).bind(access.userId, access.githubId).first();
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
async function githubJSON(access: GitHubAccess, path: string, limit = jsonBytes): Promise<unknown> {
  const response = await remoteFetch(`${apiOrigin}${path}`, { headers: headers(access) });
  if (!response.ok || response.status !== 200) {
    await response.body?.cancel();
    fail(response.status === 403 || response.status === 404 || response.status === 401 ? 403 : 502,
      'github_repository_unavailable', 'GitHub repository access could not be verified. Check repository access and try again.');
  }
  const bytes = await boundedRepositoryBody(response, limit);
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
/** Every repository the sign-in account (account id "github") can read, up to repositoryLimits.pickerRepositories. */
export async function githubRepositories(env: Env, userId: string): Promise<ProviderRepositoryList> {
  const access = await githubAccess(env, userId);
  const listing = await collectRepositories(listPageSize, async page => {
    const result = await githubJSON(access, `/user/repos?per_page=${listPageSize}&page=${page}&sort=full_name&direction=asc`, listBytes);
    if (!Array.isArray(result) || result.length > listPageSize) fail(502, 'invalid_github_response', 'GitHub returned invalid repository metadata.');
    return { repositories: result.map(githubRepository), hasMore: result.length === listPageSize };
  });
  await recheckGitHubAccess(env, access);
  return listing;
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
/**
 * In a clone session, the workspace repository a broker request names (`matches`), shaped like a pin so the push and
 * GitHub brokers treat both kinds of session alike. Its commit is a placeholder: no broker uses a pin's commit. Null when
 * the session pins its repositories or no binding matches.
 */
export async function cloneSessionRepository(env: Env, row: SessionRow, matches: (binding: RepositoryRow) => boolean): Promise<SessionRepository | null> {
  if (row.repository_mode !== 'clone') return null;
  const bindings = await env.DB.query<RepositoryRow>('SELECT * FROM workspace_repositories WHERE workspace_id = ? ORDER BY id').bind(row.workspace_id).all();
  const binding = bindings.find(matches);
  if (!binding) return null;
  const commit = '0'.repeat(40);
  return binding.provider === 'github'
    ? { bindingId: binding.id, repositoryId: Number(binding.repository_id), fullName: binding.full_name, ref: binding.ref, commit, path: binding.full_name }
    : { bindingId: binding.id, provider: binding.provider, host: binding.host, repositoryId: binding.repository_id, fullName: binding.full_name,
      ref: binding.ref, commit, path: repositoryPath({ provider: binding.provider, host: binding.host, fullName: binding.full_name }) };
}
/**
 * A clone session pins nothing and borrows no owner credential at creation: the egress relay checks the owner's own
 * access on every read. The workspace still needs a repository, and its bindings must not change before the insert.
 */
export async function cloneRepositories(env: Env, workspaceId: string, ownerId: string): Promise<RepositoryResolution> {
  await requireMember(env, workspaceId, ownerId);
  const configured = await workspaceRepositories(env, workspaceId);
  if (!configured.length && !await legacyRepositoryFixture(env, ownerId)) fail(409, 'workspace_repositories_required', 'Configure at least one repository before starting a session.');
  return { repositories: [], bindingIds: JSON.stringify(configured.map(item => item.id)), githubAuthority: null, credentials: [] };
}
export function registerRepositories(app: Hono<WorkerEnv>): void {
  app.get('/api/workspaces/:id/repositories', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    return c.json({ repositories: await workspaceRepositories(c.env, workspaceId), required: !await legacyRepositoryFixture(c.env, actor) } satisfies WorkspaceRepositoryList);
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
          WHERE g.id = ? AND g.user_id = ? AND g.ciphertext = ? AND (u.auth_kind IN ('github', 'password') OR (? = 1 AND u.auth_kind = 'test')))`,
        values: [access.account.credential.id, actor, access.account.ciphertext, testMode(c.env) ? 1 : 0] };
    const inserted = await c.env.DB.query(`INSERT INTO workspace_repositories (id,workspace_id,provider,host,repository_id,full_name,ref,private,created_at)
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
  // Whether sandboxed sessions may download the repository's Git LFS objects. Changes reach running sessions with their
  // next grant (within a minute), and the relay checks the setting again on every LFS request.
  app.put('/api/workspaces/:id/repositories/:bindingId/lfs', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const bindingId = identifier(c.req.param('bindingId'), 'bindingId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).some(key => key !== 'enabled') || typeof input.enabled !== 'boolean') fail(400, 'invalid_lfs_setting', 'Set enabled to true or false.');
    const saved = await c.env.DB.query(`INSERT INTO repository_lfs_settings (binding_id, workspace_id, enabled, updated_by, updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_repositories WHERE id = ? AND workspace_id = ?)
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))
      ON CONFLICT (binding_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        WHERE repository_lfs_settings.workspace_id = excluded.workspace_id
      RETURNING binding_id`)
      .bind(bindingId, workspaceId, input.enabled ? 1 : 0, actor, now(), bindingId, workspaceId, workspaceId, actor).first();
    if (!saved) fail(404, 'not_found', 'Repository not found.');
    const repository = await c.env.DB.query<RepositorySettingsRow>(`${repositorySettingsSelect} WHERE r.id = ? AND r.workspace_id = ?`)
      .bind(bindingId, workspaceId).first();
    if (!repository) fail(404, 'not_found', 'Repository not found.');
    await auditStatement(c.env, actor, 'repository.lfs.updated', workspaceId, null, { bindingId, enabled: input.enabled }).run();
    return c.json({ repository: publicRepository(repository) });
  });
  app.delete('/api/workspaces/:id/repositories/:repositoryId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    await c.env.DB.query(`DELETE FROM workspace_repositories WHERE id = ? AND workspace_id = ?
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`)
      .bind(identifier(c.req.param('repositoryId')), workspaceId, workspaceId, actor).run();
    return c.body(null, 204);
  });
}
