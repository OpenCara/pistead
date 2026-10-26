import type { AgentVersion, ModelDefinition, Permission, SessionPullRequest, SessionRecord, UserProfile, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { hasPermission, normalizePermissions, roleSessionCeiling, sessionCreatorRoles, workspaceSessionPermissions } from '../../../packages/shared/src/policy.js';
import type { AgentRow, AppContext, Env, MemberRow, ModelRow, SessionAccess, SessionRow, UserRow } from './types.js';
import { fail, id, now, testMode } from './http.js';
import type { Query } from './db/types.js';

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.query<UserRow>('SELECT u.*, EXISTS(SELECT 1 FROM github_tokens t WHERE t.user_id = u.id) AS github_connected FROM users u WHERE u.id = ?').bind(userId).first();
}
export function userProfile(row: UserRow): UserProfile {
  return { id: row.id, githubId: row.github_id, githubLogin: row.github_login, displayName: row.display_name,
    gitName: row.git_name, gitEmail: row.git_email, env: JSON.parse(row.env_json), githubConnected: row.auth_kind === 'github' && !!row.github_connected };
}
export function modelDefinition(row: ModelRow): ModelDefinition {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, provider: row.provider, modelId: row.model_id,
    ...(row.connector_id ? { connectorId: row.connector_id, connectorOwnerId: row.connector_owner_id! } : {}) };
}
export function agentVersion(row: AgentRow): AgentVersion {
  return { id: row.id, agentId: row.agent_id, authorId: row.author_id, workspaceId: row.workspace_id, version: row.version,
    name: row.name, description: row.description, instructions: row.instructions, tools: JSON.parse(row.tools_json), modelId: row.model_id, createdAt: row.created_at };
}
/**
 * A session that pinned its repositories when it started, as sessions did before they cloned them: it stays readable
 * (transcript, approvals, backups, exports) but runs nothing. Sessions without pins and clone sessions are not frozen.
 */
export function frozenSession(row: Pick<SessionRow, 'repository_mode' | 'repositories_json'>): boolean {
  if (row.repository_mode === 'clone') return false;
  try {
    const pins: unknown = JSON.parse(row.repositories_json ?? '[]');
    return !Array.isArray(pins) || pins.length > 0;
  } catch { return true; }
}
export function requireUnfrozen(row: Pick<SessionRow, 'repository_mode' | 'repositories_json'>): void {
  if (frozenSession(row)) {
    fail(409, 'session_frozen', 'This session pinned its repositories when it started, which sessions no longer do. It stays readable, but it no longer '
      + 'runs messages, approvals, backups, restores or moves; start a new session to continue the work.');
  }
}

/** A recorded pull request URL as lists show it: its number from the last path segment (GitHub, GitLab, Bitbucket, Gitea, Azure). */
export function sessionPullRequest(url: string | null | undefined): SessionPullRequest | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const number = /\/(\d+)\/?$/.exec(parsed.pathname)?.[1];
  return { url: parsed.href, ...(number ? { number: Number(number) } : {}) };
}

export function sessionRecord(row: SessionRow, grants?: Permission[]): SessionRecord {
  const pullRequest = sessionPullRequest(row.pull_request_url);
  return { id: row.id, workspaceId: row.workspace_id, ownerId: row.owner_id, agentVersionId: row.agent_version_id,
    title: row.title, visibility: row.visibility ?? 'private', policyVersion: row.policy_version, status: row.status, createdAt: row.created_at,
    repositories: JSON.parse(row.repositories_json ?? '[]'),
    ...(row.repository_mode === 'clone' ? { repositoryMode: 'clone' as const } : {}),
    ...(frozenSession(row) ? { frozen: true as const } : {}),
    ...(row.connector_id ? { connectorId: row.connector_id, connectorOwnerId: row.connector_owner_id! } : {}),
    ...(grants ? { permissions: grants } : {}),
    ...(row.activity ? { activity: row.activity } : {}),
    ...(pullRequest ? { pullRequest } : {}) };
}
export function runnerSessionRecord(row: SessionRow): Omit<SessionRecord, 'visibility' | 'permissions' | 'activity' | 'frozen' | 'pullRequest'> {
  // Visibility is live control-plane policy, and activity and the pull request are what the host and pushes report, so
  // none of them is part of the immutable runner binding.
  const { visibility: _visibility, permissions: _permissions, activity: _activity, frozen: _frozen, pullRequest: _pullRequest, ...record } = sessionRecord(row);
  return record;
}
export async function requireMember(env: Env, workspaceId: string, userId: string, roles?: readonly WorkspaceRole[]): Promise<MemberRow> {
  const member = await env.DB.query<MemberRow>('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
  if (!member) fail(404, 'not_found', 'Workspace not found.');
  if (roles && !roles.includes(member.role)) fail(403, 'forbidden', 'Workspace administrator access is required.');
  return member;
}
/** The actor's membership, as long as its role may create sessions there: a viewer only follows other people's. */
export async function requireSessionCreator(env: Env, workspaceId: string, userId: string): Promise<MemberRow> {
  const member = await requireMember(env, workspaceId, userId);
  if (!sessionCreatorRoles.includes(member.role)) fail(403, 'viewer_role', 'Viewers cannot create sessions in this workspace.');
  return member;
}
/** SQL true while `user` (a bound user id) is a member of `workspace` (an SQL expression) whose role creates sessions. */
export function sessionCreatorSQL(workspace: string): string {
  return `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${workspace} AND user_id = ?
    AND role IN (${sessionCreatorRoles.map(role => `'${role}'`).join(', ')}))`;
}
type SessionPolicyRow = SessionRow & { grants_json: string | null; actor_role: WorkspaceRole };

// Membership, visibility and explicit grants must come from the same policy snapshot. A suspended account opens no
// session, and nobody opens the sessions it owns, as if it had left the workspace.
// The newest pull request a push opened or found comes along for session lists and headers.
const SESSION_ACCESS_SQL = `SELECT s.*, g.permissions_json AS grants_json, actor.role AS actor_role,
  (SELECT pr.pull_request_url FROM push_credentials pr WHERE pr.session_id = s.id AND pr.pull_request_url IS NOT NULL
    ORDER BY pr.completed_at DESC, pr.created_at DESC, pr.id DESC LIMIT 1) AS pull_request_url FROM sessions s
  INNER JOIN workspace_members actor ON actor.workspace_id = s.workspace_id AND actor.user_id = ?
  INNER JOIN workspace_members owner ON owner.workspace_id = s.workspace_id AND owner.user_id = s.owner_id
  INNER JOIN users actor_user ON actor_user.id = actor.user_id
  INNER JOIN users owner_user ON owner_user.id = owner.user_id
  INNER JOIN agent_versions pinned_agent ON pinned_agent.id = s.agent_version_id
  INNER JOIN models session_model ON session_model.id = pinned_agent.model_id
  LEFT JOIN session_grants g ON g.session_id = s.id AND g.user_id = actor.user_id
  WHERE actor_user.suspended_at IS NULL AND owner_user.suspended_at IS NULL
    AND (? = 1 OR (actor_user.auth_kind <> 'test' AND owner_user.auth_kind <> 'test' AND session_model.provider <> 'faux'))`;

function accessFromSnapshot(snapshot: SessionPolicyRow | null, actorId: string): SessionAccess | null {
  if (!snapshot) return null;
  const { grants_json, actor_role, ...row } = snapshot;
  if (row.owner_id === actorId) return { row, permissions: [...permissions] };
  // A session shared with the workspace gives each member what its role allows there; explicit grants add to that,
  // up to the role's ceiling (a viewer only ever reads).
  const held = new Set<Permission>(grants_json ? normalizePermissions(JSON.parse(grants_json)) : []);
  if (row.visibility === 'workspace') for (const permission of workspaceSessionPermissions(actor_role)) held.add(permission);
  if (held.size) held.add('read');
  const ceiling = roleSessionCeiling(actor_role);
  const grants = permissions.filter(permission => held.has(permission) && (!ceiling || ceiling.includes(permission)));
  return grants.length ? { row, permissions: grants } : null;
}

export async function sessionAccess(env: Env, sessionId: string, actorId: string): Promise<SessionAccess | null> {
  const snapshot = await env.DB.query<SessionPolicyRow>(`${SESSION_ACCESS_SQL} AND s.id = ?`)
    .bind(actorId, testMode(env) ? 1 : 0, sessionId).first();
  return accessFromSnapshot(snapshot, actorId);
}

export async function listSessionAccess(env: Env, actorId: string): Promise<SessionAccess[]> {
  const snapshots = await env.DB.query<SessionPolicyRow>(`${SESSION_ACCESS_SQL}
    AND (s.owner_id = ? OR s.visibility = 'workspace' OR g.user_id IS NOT NULL)
    ORDER BY s.created_at DESC, s.id DESC LIMIT 500`)
    .bind(actorId, testMode(env) ? 1 : 0, actorId).all();
  return snapshots.flatMap(snapshot => {
    const access = accessFromSnapshot(snapshot, actorId);
    return access ? [access] : [];
  });
}
/** Every session of one workspace the actor can read, newest first, on the same policy snapshot as `listSessionAccess`. */
export async function workspaceSessionAccess(env: Env, workspaceId: string, actorId: string): Promise<SessionAccess[]> {
  const snapshots = await env.DB.query<SessionPolicyRow>(`${SESSION_ACCESS_SQL}
    AND s.workspace_id = ? AND (s.owner_id = ? OR s.visibility = 'workspace' OR g.user_id IS NOT NULL)
    ORDER BY s.created_at DESC, s.id DESC`)
    .bind(actorId, testMode(env) ? 1 : 0, workspaceId, actorId).all();
  return snapshots.flatMap(snapshot => {
    const access = accessFromSnapshot(snapshot, actorId);
    return access ? [access] : [];
  });
}
export async function requireSession(c: AppContext, sessionId: string, permission: Permission): Promise<SessionAccess> {
  const access = await sessionAccess(c.env, sessionId, c.get('auth').userId);
  if (!access) fail(404, 'not_found', 'Session not found.');
  if (!hasPermission(access.permissions, permission)) fail(403, 'forbidden', `Session ${permission} permission is required.`);
  if (access.row.status === 'archived' && permission !== 'read') fail(409, 'session_archived', 'Session is archived.');
  if (permission !== 'read' && await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(sessionId).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  if (permission !== 'read') await requireNoMigration(c.env, sessionId);
  return access;
}
/**
 * A session moving to another host, and its successor until the move completes, accept nothing but reads.
 * `asTarget` admits only the move's own restore into its successor.
 */
export async function requireNoMigration(env: Env, sessionId: string, asTarget = false): Promise<void> {
  if (await env.DB.query("SELECT 1 FROM host_migrations WHERE status = 'pending' AND (source_session_id = ? OR (target_session_id = ? AND ? = 0))")
    .bind(sessionId, sessionId, asTarget ? 1 : 0).first()) {
    fail(409, 'migration_pending', 'This session is moving to another host. Finish or cancel the move first.');
  }
}
export function auditAfterChange(
  env: Env, actorId: string, action: string, workspaceId: string | null,
  detail: Record<string, unknown>, auditId = id(),
): Query<never> {
  // This must immediately follow a single-row mutation in the same atomic batch.
  return env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
    SELECT ?, ?, NULL, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(auditId, workspaceId, actorId, action, JSON.stringify(detail), now());
}
export function auditStatement(env: Env, actorId: string | null, action: string, workspaceId: string | null = null, sessionId: string | null = null, detail: Record<string, unknown> = {}): Query<never> {
  // Callers supply metadata, never prompts, credentials, environment values, or operation bodies.
  return env.DB.query<never>('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id(), workspaceId, sessionId, actorId, action, JSON.stringify(detail), now());
}
