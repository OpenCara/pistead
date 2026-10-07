import type { AgentVersion, ModelDefinition, Permission, SessionRecord, UserProfile, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { hasPermission, normalizePermissions } from '../../../packages/shared/src/policy.js';
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
export function sessionRecord(row: SessionRow, grants?: Permission[]): SessionRecord {
  return { id: row.id, workspaceId: row.workspace_id, ownerId: row.owner_id, agentVersionId: row.agent_version_id,
    title: row.title, visibility: row.visibility ?? 'private', policyVersion: row.policy_version, status: row.status, createdAt: row.created_at,
    repositories: JSON.parse(row.repositories_json ?? '[]'),
    ...(row.connector_id ? { connectorId: row.connector_id, connectorOwnerId: row.connector_owner_id! } : {}),
    ...(grants ? { permissions: grants } : {}) };
}
export function runnerSessionRecord(row: SessionRow): Omit<SessionRecord, 'visibility' | 'permissions'> {
  // Visibility is live control-plane policy, never part of the immutable runner binding.
  const { visibility: _visibility, permissions: _permissions, ...record } = sessionRecord(row);
  return record;
}
export async function requireMember(env: Env, workspaceId: string, userId: string, roles?: readonly WorkspaceRole[]): Promise<MemberRow> {
  const member = await env.DB.query<MemberRow>('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
  if (!member) fail(404, 'not_found', 'Workspace not found.');
  if (roles && !roles.includes(member.role)) fail(403, 'forbidden', 'Workspace administrator access is required.');
  return member;
}
type SessionPolicyRow = SessionRow & { grants_json: string | null };

// Membership, visibility and explicit grants must come from the same policy snapshot.
const SESSION_ACCESS_SQL = `SELECT s.*, g.permissions_json AS grants_json FROM sessions s
  INNER JOIN workspace_members actor ON actor.workspace_id = s.workspace_id AND actor.user_id = ?
  INNER JOIN workspace_members owner ON owner.workspace_id = s.workspace_id AND owner.user_id = s.owner_id
  INNER JOIN users actor_user ON actor_user.id = actor.user_id
  INNER JOIN users owner_user ON owner_user.id = owner.user_id
  INNER JOIN agent_versions pinned_agent ON pinned_agent.id = s.agent_version_id
  INNER JOIN models session_model ON session_model.id = pinned_agent.model_id
  LEFT JOIN session_grants g ON g.session_id = s.id AND g.user_id = actor.user_id
  WHERE (? = 1 OR (actor_user.auth_kind <> 'test' AND owner_user.auth_kind <> 'test' AND session_model.provider <> 'faux'))`;

function accessFromSnapshot(snapshot: SessionPolicyRow | null, actorId: string): SessionAccess | null {
  if (!snapshot) return null;
  const { grants_json, ...row } = snapshot;
  if (row.owner_id === actorId) return { row, permissions: [...permissions] };
  const grants = grants_json ? normalizePermissions(JSON.parse(grants_json)) : [];
  if ((row.visibility === 'workspace' || hasPermission(grants, 'read')) && !grants.includes('read')) grants.unshift('read');
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
export async function requireSession(c: AppContext, sessionId: string, permission: Permission): Promise<SessionAccess> {
  const access = await sessionAccess(c.env, sessionId, c.get('auth').userId);
  if (!access) fail(404, 'not_found', 'Session not found.');
  if (!hasPermission(access.permissions, permission)) fail(403, 'forbidden', `Session ${permission} permission is required.`);
  if (access.row.status === 'archived' && permission !== 'read') fail(409, 'session_archived', 'Session is archived.');
  if (permission !== 'read' && await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(sessionId).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  return access;
}
export function auditStatement(env: Env, actorId: string | null, action: string, workspaceId: string | null = null, sessionId: string | null = null, detail: Record<string, unknown> = {}): Query<never> {
  // Callers supply metadata, never prompts, credentials, environment values, or operation bodies.
  return env.DB.query<never>('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id(), workspaceId, sessionId, actorId, action, JSON.stringify(detail), now());
}
