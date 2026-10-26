import type { Hono } from 'hono';
import type { BackupLocation } from '../../../packages/shared/src/types.js';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { bindingForSession } from './sessions.js';
import type { AppContext, Env, SessionRow, WorkerEnv, WorkspaceRow } from './types.js';
import { auditStatement, requireSession, sessionRecord } from './db.js';
import { fail, id, identifier, jsonObject, now } from './http.js';
import { runnerRequest } from './runner.js';
import { boundedSnapshotText, loadBackupSnapshot, validateSnapshot, type BackupRow } from './restore-snapshot.js';
import {
  workspaceDatabaseFailure, workspaceDatabaseRow, workspaceDatabasesDisabled, workspaceDatabaseTarget, type WorkspaceDatabaseRow,
} from './workspace-databases/store.js';

const snapshotFormat = 'pi-runner-backup-v1';

function backupInfo(row: BackupRow, location: BackupLocation) {
  return { id: row.id, sessionId: row.session_id, size: row.size, sha256: row.sha256, createdAt: row.created_at, location,
    ...(row.automatic ? { automatic: true } : {}), ...(row.conversation_only ? { conversationOnly: true } : {}) };
}

/**
 * Whether the session's host can take a conversation-only backup. A connector says so in its capabilities; an older one
 * would take a full backup instead. The configured external runner is trusted to, and its snapshot is checked either way.
 */
async function conversationBackupsSupported(env: Env, row: SessionRow): Promise<boolean> {
  if (!row.connector_id) return true;
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(row.connector_id).first();
  try { return (JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities).conversationBackups === true; }
  catch { return false; }
}

/** Whether `userId` gave their standing confirmation of this workspace database (see workspace_database_consents). */
export async function databaseConsented(env: Env, databaseId: string, userId: string): Promise<boolean> {
  return !!await env.DB.query('SELECT 1 AS ok FROM workspace_database_consents WHERE database_id = ? AND user_id = ?')
    .bind(databaseId, userId).first();
}

interface BackupDestination {
  location: BackupLocation;
  workspace: WorkspaceRow;
  database: WorkspaceDatabaseRow | null;
  /**
   * A snapshot carries the session's prompts, output and files, and its owner's personal environment values. Saving one
   * where someone else can read it takes the session owner's explicit confirmation of that database, unless they are
   * the workspace owner who connected it or gave their standing confirmation of that same database.
   */
  confirm: boolean;
  /** The session owner gave their standing confirmation of this database (workspace_database_consents). */
  consented: boolean;
}

/** Where new backups of a session go: the database its workspace's owner connected, else the server's backup storage. */
async function backupDestination(env: Env, row: SessionRow): Promise<BackupDestination> {
  const workspace = await env.DB.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?').bind(row.workspace_id).first();
  if (!workspace) fail(404, 'not_found', 'Workspace not found.');
  const database = await workspaceDatabaseRow(env, row.workspace_id);
  const consented = !!database && row.owner_id !== workspace.owner_id && await databaseConsented(env, database.id, row.owner_id);
  const confirm = !!database && row.owner_id !== workspace.owner_id && !consented;
  return { location: database ? 'workspace-database' : 'server', workspace, database, confirm, consented };
}

/**
 * Whether this server can save a new backup at `location`: in its own storage only when the operator set STORAGE_URL, and
 * in a workspace's database only while WORKSPACE_DATABASES is on. Creating a backup refuses the same cases, with reasons.
 */
function canSave(env: Env, location: BackupLocation): boolean {
  return location === 'workspace-database' ? Boolean(env.WORKSPACE_DATABASES) : Boolean(env.BUCKET);
}

/**
 * Whether this server can read back a backup saved at `stored`, to download or restore it: from its own storage only with
 * STORAGE_URL, and from the workspace's database only while workspace databases are on and that database is connected.
 */
function canRead(env: Env, stored: BackupLocation, database: WorkspaceDatabaseRow | null): boolean {
  return canSave(env, stored) && (stored === 'server' || database !== null);
}

/** A session's automatic backups (automatic-backups.ts), as its owner sees them in the backup listing. */
export interface AutomaticBackupState {
  /** When the last automatic attempt ran, and what it did. */
  attemptedAt: string | null;
  backupId: string | null;
  error: string | null;
  /** Something changed since the last automatic backup. */
  pending: boolean;
}

export async function automaticBackupState(env: Env, sessionId: string): Promise<AutomaticBackupState | null> {
  const row = await env.DB.query<{ changed_at: string | null; attempted_at: string | null; backup_id: string | null; error: string | null }>(
    'SELECT changed_at, attempted_at, backup_id, error FROM automatic_backups WHERE session_id = ?').bind(sessionId).first();
  return row ? { attemptedAt: row.attempted_at, backupId: row.backup_id, error: row.error, pending: row.changed_at !== null } : null;
}

export interface CreateBackupOptions {
  /** The database the session owner confirmed for this backup, when it goes to one someone else can read. */
  trustedDatabaseId?: unknown;
  /** Taken on the workspace's schedule (automatic-backups.ts): saved only in the workspace's database, and marked so. */
  automatic?: boolean;
  /** Keep only the session's conversation (Pi's SQLite and the runner's state), not its files or clones. */
  conversationOnly?: boolean;
}

/**
 * Saves a new backup of `row` as the request's actor, who must be the session owner: the host's snapshot goes to the
 * workspace's database when one is connected, else to the server's storage.
 */
export async function createBackup(c: AppContext, row: SessionRow, options: CreateBackupOptions = {}) {
  if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can create its backups.');
  const { location: destination, workspace, database: chosen, confirm } = await backupDestination(c.env, row);
  const provider = c.env.WORKSPACE_DATABASES;
  const bucket = c.env.BUCKET;
  // A workspace that keeps its sessions in its own database never falls back to the server's storage.
  if (destination === 'workspace-database' && !provider) workspaceDatabasesDisabled();
  if (destination === 'server' && !bucket) fail(503, 'backup_unavailable', 'Durable backup storage is not configured.');
  // An automatic backup goes only where the workspace keeps its sessions, never into the server's storage instead.
  if (options.automatic && !chosen) fail(409, 'workspace_database_required', 'Automatic backups are saved only in a workspace database.');
  if (chosen && confirm && options.trustedDatabaseId !== chosen.id) {
    fail(409, 'workspace_database_trust_required', `Backups of this session are saved in the database the workspace owner connected (${chosen.host}/${chosen.database_name}). Whoever can read it can read this session, including your personal environment values. Confirm that database to save a backup.`);
  }
  const conversationOnly = options.conversationOnly === true;
  if (conversationOnly && !await conversationBackupsSupported(c.env, row)) {
    fail(409, 'connector_update_required', 'Update this session\'s host connector (npx pistead@latest connect) to back up its conversation only.');
  }
  const response = await runnerRequest(c, row, 'backup', '', conversationOnly ? { conversationOnly: true } : {});
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    fail(502, 'invalid_backup', 'The runner returned an invalid backup format.');
  }
  // A bounded snapshot avoids exhausting the server heap. The execution authority checkpoints it first.
  const bytes = await boundedSnapshotText(response);
  validateSnapshot(bytes, await bindingForSession(c, row), { conversationOnly });
  const { row: current } = await requireSession(c, row.id, 'manage');
  const backupId = id();
  const encoded = new TextEncoder().encode(bytes);
  const record: BackupRow = { id: backupId, session_id: row.id, owner_id: row.owner_id,
    object_key: `sessions/${row.owner_id}/${row.id}/${backupId}.json`, sha256: await sha256(bytes),
    size: encoded.byteLength, created_at: now(), automatic: options.automatic ? 1 : 0, conversation_only: conversationOnly ? 1 : 0 };
  // The owner may have connected, replaced or disconnected the workspace database while the host prepared the snapshot;
  // then it would not be stored where it was meant to go. The same database with rotated credentials keeps its id.
  const database = await workspaceDatabaseRow(c.env, row.workspace_id);
  if ((database?.id ?? null) !== (chosen?.id ?? null)) {
    fail(409, 'workspace_database_changed', 'The workspace database changed while the backup was prepared. Try again.');
  }
  if (database) {
    if (!provider) workspaceDatabasesDisabled();
    const target = await workspaceDatabaseTarget(c.env, database);
    try {
      await provider.save(target, {
        workspace: { id: workspace.id, name: workspace.name, ownerId: workspace.owner_id },
        session: { id: current.id, workspaceId: current.workspace_id, ownerId: current.owner_id, title: current.title,
          status: current.status, visibility: current.visibility ?? 'private', createdAt: current.created_at, record: sessionRecord(current) },
        backup: { id: record.id, format: snapshotFormat, sha256: record.sha256, size: record.size, createdAt: record.created_at },
        snapshot: encoded,
      });
    } catch (error) {
      workspaceDatabaseFailure(error, 'use');
    }
  } else {
    if (!bucket) fail(503, 'backup_unavailable', 'Durable backup storage is not configured.');
    try {
      await bucket.put(record.object_key, encoded, {
        contentType: 'application/json',
        custom: { ownerId: row.owner_id, sessionId: row.id, sha256: record.sha256, format: snapshotFormat },
      });
    } catch { fail(503, 'backup_unavailable', 'Durable backup storage is unavailable.'); }
  }
  // An orphaned private object (or workspace database row) on DB failure is safer than a downloadable DB row with no object.
  const insert = c.env.DB.query(`INSERT INTO backups (id, session_id, owner_id, object_key, sha256, size, created_at, automatic, conversation_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.id, record.session_id, record.owner_id, record.object_key, record.sha256, record.size, record.created_at, record.automatic ?? 0,
      record.conversation_only ?? 0);
  const audit = auditStatement(c.env, c.get('auth').userId, 'backup.created', row.workspace_id, row.id,
    { backupId, sha256: record.sha256, size: record.size, location: destination, ...(options.automatic ? { automatic: true } : {}),
      ...(conversationOnly ? { conversationOnly: true } : {}) });
  await c.env.DB.batch(destination === 'workspace-database'
    ? [insert, c.env.DB.query('INSERT INTO workspace_database_backups (backup_id, workspace_id, created_at) VALUES (?, ?, ?)')
      .bind(record.id, row.workspace_id, record.created_at), audit]
    : [insert, audit]);
  return { backup: backupInfo(record, destination) };
}

export function registerBackups(app: Hono<WorkerEnv>): void {
  app.post('/api/sessions/:id/backup', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can create its backups.');
    // The body is optional: only a backup to someone else's database, or of the conversation only, needs one.
    const input: Record<string, unknown> = c.req.header('content-type') ? await jsonObject(c, 1024) : {};
    if (Object.keys(input).some(key => key !== 'trustedDatabaseId' && key !== 'conversationOnly')) {
      fail(400, 'invalid_input', 'Backups accept only trustedDatabaseId and conversationOnly.');
    }
    if (input.conversationOnly !== undefined && typeof input.conversationOnly !== 'boolean') fail(400, 'invalid_input', 'conversationOnly must be a boolean.');
    return c.json(await createBackup(c, row, { trustedDatabaseId: input.trustedDatabaseId, conversationOnly: input.conversationOnly === true }), 201);
  });

  app.get('/api/sessions/:id/backups', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can list its backups.');
    const result = await c.env.DB.query<BackupRow & { stored_in: string | null }>(`SELECT b.*, l.workspace_id AS stored_in FROM backups b
      LEFT JOIN workspace_database_backups l ON l.backup_id = b.id
      WHERE b.session_id = ? AND b.owner_id = ? ORDER BY b.created_at DESC LIMIT 100`)
      .bind(row.id, row.owner_id).all();
    const { location, database, confirm, consented } = await backupDestination(c.env, row);
    return c.json({
      backups: result.map(({ stored_in, ...backup }) => {
        const stored: BackupLocation = stored_in === null ? 'server' : 'workspace-database';
        // Still listed when this server can't read its store now, marked so the web app doesn't offer a refused download.
        return { ...backupInfo(backup, stored), ...(canRead(c.env, stored, database) ? {} : { unavailable: true }) };
      }),
      // Shown before the next backup is created: whoever can read a workspace database can read the sessions saved there.
      destination: location,
      // False when no new backup can be saved, so the web app turns backups off instead of offering one that is refused.
      enabled: canSave(c.env, location),
      // False when the session's host would take a full backup instead (an older connector).
      conversationOnlySupported: await conversationBackupsSupported(c.env, row),
      ...(database ? { workspaceDatabase: { id: database.id, host: database.host, port: database.port, database: database.database_name, confirm,
        ...(consented ? { consented: true } : {}) } } : {}),
      // The workspace's schedule; `included`: this session's owner confirmed the database (or connected it), so it takes part.
      ...(database?.automatic_backup_minutes ? { automaticBackups: { minutes: database.automatic_backup_minutes, included: !confirm,
        ...(await automaticBackupState(c.env, row.id) ?? { attemptedAt: null, backupId: null, error: null, pending: false }) } } : {}),
    });
  });
  app.get('/api/sessions/:id/backups/:backupId/download', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can download its backups.');
    const record = await c.env.DB.query<BackupRow>('SELECT * FROM backups WHERE id = ? AND session_id = ? AND owner_id = ?')
      .bind(identifier(c.req.param('backupId'), 'backupId'), row.id, row.owner_id).first();
    if (!record) fail(404, 'not_found', 'Backup not found.');
    // Reads the snapshot from the server's storage or the workspace database, wherever this backup was saved.
    const bytes = await loadBackupSnapshot(c.env, record, await bindingForSession(c, row));
    await requireSession(c, row.id, 'manage');
    await auditStatement(c.env, c.get('auth').userId, 'backup.downloaded', row.workspace_id, row.id, { backupId: record.id }).run();
    return new Response(bytes, { headers: {
      'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="session-${row.id}-${record.id}.json"`,
      'Content-Length': String(record.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Backup-SHA256': record.sha256,
    } });
  });
}
