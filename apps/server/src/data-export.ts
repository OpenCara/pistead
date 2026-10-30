import type { Hono } from 'hono';
import type {
  AgentVersion, BackupLocation, ModelDefinition, PushIdentity, SessionRecord, WorkspaceDatabase, WorkspaceRole,
} from '../../../packages/shared/src/types.js';
import type { NetworkPolicy } from '../../../packages/shared/src/network.js';
import type { WorkspaceRepository } from '../../../packages/shared/src/repositories.js';
import type { Database, SqlValue } from './db/types.js';
import type { AgentRow, ModelRow, PushIdentityRow, SessionRow, WorkerEnv, WorkspaceRow } from './types.js';
import { agentVersion, auditStatement, modelDefinition, requireMember, requireSession, sessionRecord, workspaceSessionAccess } from './db.js';
import { fail, identifier, now } from './http.js';
import { publicRepository, repositorySettingsSelect, type RepositorySettingsRow } from './repositories.js';
import { workspaceNetworkPolicy } from './network.js';
import { publicIdentity } from './push/identities.js';
import { publicWorkspaceDatabase, type WorkspaceDatabaseRow } from './workspace-databases/store.js';

/*
 * Exports ("dumps") of what the control plane's database holds about a session or a workspace, as JSON. Columns are
 * chosen one by one: tokens, ciphertexts, credential digests, restore bindings (with the owner's personal environment)
 * and storage keys never appear. Session owners and workspace owners/admins download them from the web app; the
 * operator dumps from the database with `--dump-session` / `--dump-workspace` (main.ts).
 */

export const sessionExportFormat = 'pistead-session-export-v1';
export const workspaceExportFormat = 'pistead-workspace-export-v1';

export interface AuditEntry { id: string; actorId: string | null; action: string; detail: unknown; createdAt: string }

/** Everything the control plane keeps about one session. Its conversation lives on the host and in its backups. */
export interface SessionData {
  session: SessionRecord & { archivedStatus: string | null };
  grants: { userId: string; permissions: unknown; createdAt: string }[];
  toolGrants: { tool: string; callId: string; approvalId: string; grantedBy: string; createdAt: string }[];
  backups: { id: string; size: number; sha256: string; createdAt: string; location: BackupLocation; conversationOnly?: true }[];
  restores: {
    id: string; sourceSessionId: string; backupId: string; targetSessionId: string; title: string | null; status: string;
    createdAt: string; completedAt: string | null;
  }[];
  approvals: { approvalId: string; requestedBy: string; source: string; operation: unknown; createdAt: string }[];
  pushes: {
    id: string; approvalId: string; requestedBy: string; kind: string; bindingId: string; operation: unknown; automatic: boolean;
    createdAt: string; completedAt: string | null; outcome: string | null; tip: string | null; pullRequestUrl: string | null;
  }[];
  audit: AuditEntry[];
}

export interface SessionExport extends SessionData {
  format: typeof sessionExportFormat;
  exportedAt: string;
  /** null when the operator dumped it from the database. */
  exportedBy: string | null;
}

export interface WorkspaceExport {
  format: typeof workspaceExportFormat;
  exportedAt: string;
  /** null when the operator dumped it from the database. */
  exportedBy: string | null;
  workspace: { id: string; name: string; ownerId: string; createdAt: string };
  members: { userId: string; displayName: string; githubLogin: string | null; role: WorkspaceRole; createdAt: string }[];
  models: (ModelDefinition & { available: boolean; createdAt: string })[];
  /** Agent versions published to the workspace. */
  agents: AgentVersion[];
  repositories: WorkspaceRepository[];
  pushIdentities: PushIdentity[];
  networkPolicy: NetworkPolicy;
  database: WorkspaceDatabase | null;
  /** Workspace activity not tied to a session; each session's activity is in its own entry. */
  audit: AuditEntry[];
  /** Sessions exported in full: the exporter's own, or every session of the workspace in the operator's dump. */
  sessions: SessionData[];
  /** The other sessions the exporter can view, as their records with the exporter's permissions. */
  otherSessions: SessionRecord[];
}

/** Stored JSON columns are written by the server; anything unreadable is kept as its text rather than dropped. */
function parsed(json: string): unknown {
  try { return JSON.parse(json); } catch { return json; }
}

/** A backup with a workspace_database_backups row was saved in the workspace's database. */
function backupLocation(storedIn: string | null): BackupLocation {
  return storedIn === null ? 'server' : 'workspace-database';
}

async function auditEntries(db: Database, where: 'session_id = ?' | 'workspace_id = ? AND session_id IS NULL', value: string): Promise<AuditEntry[]> {
  const rows = await db.query<{ id: string; actor_id: string | null; action: string; detail_json: string; created_at: string }>(
    `SELECT id, actor_id, action, detail_json, created_at FROM audit WHERE ${where} ORDER BY created_at, id`).bind(value).all();
  return rows.map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, detail: parsed(row.detail_json), createdAt: row.created_at }));
}

export async function sessionData(db: Database, row: SessionRow): Promise<SessionData> {
  const all = <T>(sql: string, ...values: SqlValue[]) => db.query<T>(sql).bind(...values).all();
  const grants = await all<{ user_id: string; permissions_json: string; created_at: string }>(
    'SELECT user_id, permissions_json, created_at FROM session_grants WHERE session_id = ? ORDER BY created_at, user_id', row.id);
  const toolGrants = await all<{ tool: string; call_id: string; approval_id: string; granted_by: string; created_at: string }>(
    'SELECT tool, call_id, approval_id, granted_by, created_at FROM session_tool_grants WHERE session_id = ? ORDER BY created_at, tool, call_id', row.id);
  const backups = await all<{ id: string; size: number; sha256: string; created_at: string; conversation_only: number; stored_in: string | null }>(
    `SELECT b.id, b.size, b.sha256, b.created_at, b.conversation_only, l.workspace_id AS stored_in FROM backups b
      LEFT JOIN workspace_database_backups l ON l.backup_id = b.id WHERE b.session_id = ? ORDER BY b.created_at, b.id`, row.id);
  const restores = await all<{
    id: string; source_session_id: string; backup_id: string; target_session_id: string; request_title: string | null; status: string;
    created_at: string; completed_at: string | null;
  }>(`SELECT id, source_session_id, backup_id, target_session_id, request_title, status, created_at, completed_at FROM restore_jobs
    WHERE source_session_id = ? OR target_session_id = ? ORDER BY created_at, id`, row.id, row.id);
  const approvals = await all<{ approval_id: string; requested_by: string; source: string; operation_json: string; created_at: string }>(
    'SELECT approval_id, requested_by, source, operation_json, created_at FROM approval_reviews WHERE session_id = ? ORDER BY created_at, approval_id', row.id);
  const pushes = await all<{
    id: string; approval_id: string; requested_by: string; kind: string; binding_id: string; operation_json: string; automatic: number;
    created_at: string; completed_at: string | null; outcome: string | null; tip: string | null; pull_request_url: string | null;
  }>(`SELECT id, approval_id, requested_by, kind, binding_id, operation_json, automatic, created_at, completed_at, outcome, tip, pull_request_url
    FROM push_credentials WHERE session_id = ? ORDER BY created_at, id`, row.id);
  return {
    session: { ...sessionRecord(row), archivedStatus: row.archived_status ?? null },
    grants: grants.map(grant => ({ userId: grant.user_id, permissions: parsed(grant.permissions_json), createdAt: grant.created_at })),
    toolGrants: toolGrants.map(grant => ({ tool: grant.tool, callId: grant.call_id, approvalId: grant.approval_id, grantedBy: grant.granted_by,
      createdAt: grant.created_at })),
    backups: backups.map(backup => ({ id: backup.id, size: backup.size, sha256: backup.sha256, createdAt: backup.created_at,
      location: backupLocation(backup.stored_in), ...(backup.conversation_only ? { conversationOnly: true as const } : {}) })),
    restores: restores.map(restore => ({ id: restore.id, sourceSessionId: restore.source_session_id, backupId: restore.backup_id,
      targetSessionId: restore.target_session_id, title: restore.request_title, status: restore.status, createdAt: restore.created_at,
      completedAt: restore.completed_at })),
    approvals: approvals.map(review => ({ approvalId: review.approval_id, requestedBy: review.requested_by, source: review.source,
      operation: parsed(review.operation_json), createdAt: review.created_at })),
    pushes: pushes.map(push => ({ id: push.id, approvalId: push.approval_id, requestedBy: push.requested_by, kind: push.kind,
      bindingId: push.binding_id, operation: parsed(push.operation_json), automatic: push.automatic === 1, createdAt: push.created_at,
      completedAt: push.completed_at, outcome: push.outcome, tip: push.tip, pullRequestUrl: push.pull_request_url })),
    audit: await auditEntries(db, 'session_id = ?', row.id),
  };
}

async function sessionExport(db: Database, row: SessionRow, exportedBy: string | null): Promise<SessionExport> {
  return { format: sessionExportFormat, exportedAt: now(), exportedBy, ...await sessionData(db, row) };
}

/** One session in full, or null when it does not exist. */
export async function exportSession(db: Database, sessionId: string, exportedBy: string | null): Promise<SessionExport | null> {
  const row = await db.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  return row ? sessionExport(db, row, exportedBy) : null;
}

/**
 * One workspace, or null when it does not exist. `exporter` names a member and the sessions their export covers; without
 * one (the operator's dump) every session of the workspace is exported in full.
 */
export async function exportWorkspace(db: Database, workspaceId: string,
  exporter: { userId: string; sessions: SessionRow[]; otherSessions: SessionRecord[] } | null): Promise<WorkspaceExport | null> {
  const workspace = await db.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (!workspace) return null;
  const members = await db.query<{ user_id: string; display_name: string; github_login: string | null; role: WorkspaceRole; created_at: string }>(
    `SELECT m.user_id, u.display_name, u.github_login, m.role, m.created_at FROM workspace_members m
      JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at, m.user_id`).bind(workspaceId).all();
  const models = await db.query<ModelRow>('SELECT * FROM models WHERE workspace_id = ? ORDER BY created_at, id').bind(workspaceId).all();
  const agents = await db.query<AgentRow>('SELECT * FROM agent_versions WHERE workspace_id = ? ORDER BY created_at, agent_id, version')
    .bind(workspaceId).all();
  const repositories = await db.query<RepositorySettingsRow>(`${repositorySettingsSelect}
    WHERE r.workspace_id = ? ORDER BY r.created_at, r.id`).bind(workspaceId).all();
  const identities = await db.query<PushIdentityRow>('SELECT * FROM push_identities WHERE workspace_id = ? ORDER BY provider, host, scope, id')
    .bind(workspaceId).all();
  const database = await db.query<WorkspaceDatabaseRow>('SELECT * FROM workspace_databases WHERE workspace_id = ?').bind(workspaceId).first();
  const rows = exporter?.sessions
    ?? await db.query<SessionRow>('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at, id').bind(workspaceId).all();
  const sessions: SessionData[] = [];
  for (const row of rows) sessions.push(await sessionData(db, row));
  return {
    format: workspaceExportFormat, exportedAt: now(), exportedBy: exporter?.userId ?? null,
    workspace: { id: workspace.id, name: workspace.name, ownerId: workspace.owner_id, createdAt: workspace.created_at },
    members: members.map(member => ({ userId: member.user_id, displayName: member.display_name, githubLogin: member.github_login,
      role: member.role, createdAt: member.created_at })),
    models: models.map(model => ({ ...modelDefinition(model), available: model.available !== 0, createdAt: model.created_at })),
    agents: agents.map(agentVersion),
    repositories: repositories.map(repository => publicRepository(repository)),
    pushIdentities: identities.map(identity => publicIdentity(identity)),
    networkPolicy: await workspaceNetworkPolicy(db, workspaceId),
    database: database ? publicWorkspaceDatabase(database) : null,
    audit: await auditEntries(db, 'workspace_id = ? AND session_id IS NULL', workspaceId),
    sessions,
    otherSessions: exporter?.otherSessions ?? [],
  };
}

function attachment(document: unknown, filename: string): Response {
  return new Response(`${JSON.stringify(document, null, 2)}\n`, { headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}

export function registerDataExports(app: Hono<WorkerEnv>): void {
  // The session owner's copy of the session's records, also while it is archived.
  app.get('/api/sessions/:id/export', async c => {
    const actor = c.get('auth').userId;
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    if (row.owner_id !== actor) fail(403, 'owner_required', 'Only the session owner can export it.');
    const document = await sessionExport(c.env.DB, row, actor);
    await auditStatement(c.env, actor, 'session.exported', row.workspace_id, row.id).run();
    return attachment(document, `pistead-session-${row.id}.json`);
  });

  // Owners and admins: the workspace's settings and activity, their own sessions in full and the records of the other
  // sessions they can view, which is every session there since they manage them all. Each other session's full data
  // stays with its owner's own export.
  app.get('/api/workspaces/:id/export', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    // Oldest first, like the operator's dump.
    const accessible = (await workspaceSessionAccess(c.env, workspaceId, actor)).reverse();
    const document = await exportWorkspace(c.env.DB, workspaceId, {
      userId: actor,
      sessions: accessible.filter(access => access.row.owner_id === actor).map(access => access.row),
      otherSessions: accessible.filter(access => access.row.owner_id !== actor).map(access => sessionRecord(access.row, access.permissions)),
    });
    if (!document) fail(404, 'not_found', 'Workspace not found.');
    await auditStatement(c.env, actor, 'workspace.exported', workspaceId, null,
      { sessions: document.sessions.length, otherSessions: document.otherSessions.length }).run();
    return attachment(document, `pistead-workspace-${workspaceId}.json`);
  });
}
