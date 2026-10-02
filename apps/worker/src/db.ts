import type { AgentVersion, ModelDefinition, Permission, SessionRecord, UserProfile, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { hasPermission, normalizePermissions } from '../../../packages/shared/src/policy.js';
import type { AgentRow, AppContext, Env, MemberRow, ModelRow, SessionAccess, SessionRow, UserRow } from './types.js';
import { fail, id, now, testMode } from './http.js';

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT u.*, EXISTS(SELECT 1 FROM github_tokens t WHERE t.user_id = u.id) AS github_connected FROM users u WHERE u.id = ?').bind(userId).first<UserRow>();
}
export function userProfile(row: UserRow): UserProfile {
  return { id: row.id, githubId: row.github_id, githubLogin: row.github_login, displayName: row.display_name,
    gitName: row.git_name, gitEmail: row.git_email, env: JSON.parse(row.env_json), githubConnected: row.auth_kind === 'github' && !!row.github_connected };
}
export function modelDefinition(row: ModelRow): ModelDefinition {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, provider: row.provider, modelId: row.model_id };
}
export function agentVersion(row: AgentRow): AgentVersion {
  return { id: row.id, agentId: row.agent_id, authorId: row.author_id, workspaceId: row.workspace_id, version: row.version,
    name: row.name, description: row.description, instructions: row.instructions, tools: JSON.parse(row.tools_json), modelId: row.model_id, createdAt: row.created_at };
}
export function sessionRecord(row: SessionRow, grants?: Permission[]): SessionRecord {
  return { id: row.id, workspaceId: row.workspace_id, ownerId: row.owner_id, agentVersionId: row.agent_version_id,
    title: row.title, policyVersion: row.policy_version, status: row.status, createdAt: row.created_at,
    ...(grants ? { permissions: grants } : {}) };
}
export async function requireMember(env: Env, workspaceId: string, userId: string, roles?: readonly WorkspaceRole[]): Promise<MemberRow> {
  const member = await env.DB.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first<MemberRow>();
  if (!member) fail(404, 'not_found', 'Workspace not found.');
  if (roles && !roles.includes(member.role)) fail(403, 'forbidden', 'Workspace administrator access is required.');
  return member;
}
export async function sessionAccess(env: Env, sessionId: string, actorId: string): Promise<SessionAccess | null> {
  const row = await env.DB.prepare(`SELECT s.* FROM sessions s
    INNER JOIN workspace_members actor ON actor.workspace_id = s.workspace_id AND actor.user_id = ?
    INNER JOIN workspace_members owner ON owner.workspace_id = s.workspace_id AND owner.user_id = s.owner_id
    INNER JOIN users actor_user ON actor_user.id = actor.user_id
    INNER JOIN users owner_user ON owner_user.id = owner.user_id
    INNER JOIN agent_versions pinned_agent ON pinned_agent.id = s.agent_version_id
    INNER JOIN models session_model ON session_model.id = pinned_agent.model_id
    WHERE s.id = ? AND (? = 1 OR (actor_user.auth_kind <> 'test' AND owner_user.auth_kind <> 'test' AND session_model.provider <> 'faux'))`)
    .bind(actorId, sessionId, testMode(env) ? 1 : 0).first<SessionRow>();
  if (!row) return null;
  if (row.owner_id === actorId) return { row, permissions: [...permissions] };
  const grant = await env.DB.prepare('SELECT permissions_json FROM session_grants WHERE session_id = ? AND user_id = ?')
    .bind(sessionId, actorId).first<{ permissions_json: string }>();
  if (!grant) return null;
  const grants = normalizePermissions(JSON.parse(grant.permissions_json));
  if (!grants.length) return null;
  return { row, permissions: hasPermission(grants, 'read') && !grants.includes('read') ? ['read', ...grants] : grants };
}
export async function requireSession(c: AppContext, sessionId: string, permission: Permission): Promise<SessionAccess> {
  const access = await sessionAccess(c.env, sessionId, c.get('auth').userId);
  if (!access) fail(404, 'not_found', 'Session not found.');
  if (!hasPermission(access.permissions, permission)) fail(403, 'forbidden', `Session ${permission} permission is required.`);
  if (access.row.status === 'archived' && permission !== 'read') fail(409, 'session_archived', 'Session is archived.');
  return access;
}
export function auditStatement(env: Env, actorId: string | null, action: string, workspaceId: string | null = null, sessionId: string | null = null, detail: Record<string, unknown> = {}): D1PreparedStatement {
  // Callers supply metadata, never prompts, credentials, environment values, or operation bodies.
  return env.DB.prepare('INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id(), workspaceId, sessionId, actorId, action, JSON.stringify(detail), now());
}
