import type { Hono } from 'hono';
import type { Env, WorkerEnv, WorkspaceRow } from '../types.js';
import { auditStatement, requireMember } from '../db.js';
import { fail, id, identifier, jsonObject, now } from '../http.js';
import { assertVaultConfigured, encryptToken } from '../vault.js';
import { DumpImportError, importDump, maxUploadedDumpBytes, type ImportSummary } from './import.js';
import { databaseConsented } from '../backups.js';
import { isAutomaticBackupInterval } from '../automatic-backups.js';
import { databaseSettings, maxCaCertificateLength } from './settings.js';
import {
  databaseSecretContext, publicWorkspaceDatabase, workspaceDatabaseFailure, workspaceDatabaseRow, type WorkspaceDatabaseRow,
} from './store.js';

/** Workspace owner authority, re-checked inside every write (binds workspace id, user id). */
const ownerSql = `EXISTS (SELECT 1 FROM workspaces w
  JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = w.owner_id
  WHERE w.id = ? AND w.owner_id = ? AND m.role = 'owner')`;

/**
 * Only the workspace owner decides where its sessions are saved: every member's backups of the workspace go there, and
 * whoever can read that database can read them.
 */
async function requireWorkspaceOwner(env: Env, workspaceId: string, actorId: string): Promise<void> {
  const member = await requireMember(env, workspaceId, actorId);
  const workspace = await env.DB.query<{ owner_id: string }>('SELECT owner_id FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (member.role !== 'owner' || workspace?.owner_id !== actorId) {
    fail(403, 'owner_required', "Only the workspace owner manages the workspace's database.");
  }
}

export function registerWorkspaceDatabases(app: Hono<WorkerEnv>): void {
  // Every member sees where backups of the workspace's sessions go before creating one; the password never leaves the server.
  app.get('/api/workspaces/:id/database', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const row = await workspaceDatabaseRow(c.env, workspaceId);
    const provider = c.env.WORKSPACE_DATABASES;
    // backupStorage says whether backups have anywhere to go without a database, so the settings don't promise storage the server lacks.
    // automaticBackups: the owner's schedule, and whether the caller gave their standing confirmation of this database.
    const automaticBackups = row ? { minutes: row.automatic_backup_minutes ?? null,
      consented: await databaseConsented(c.env, row.id, c.get('auth').userId) } : null;
    return c.json({ available: !!provider, privateHosts: provider?.privateHosts ?? false, backupStorage: !!c.env.BUCKET,
      database: row ? publicWorkspaceDatabase(row) : null, automaticBackups });
  });

  // The owner chooses how often the workspace's sessions are backed up into its database on their own: 15, 60, 360 or
  // 1440 minutes, or null for never. Members' sessions take part only once their owner confirms the database.
  app.put('/api/workspaces/:id/database/automatic-backups', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireWorkspaceOwner(c.env, workspaceId, actor);
    const input = await jsonObject(c, 1024);
    const minutes = input.minutes === null ? null : isAutomaticBackupInterval(input.minutes) ? input.minutes : undefined;
    if (minutes === undefined || Object.keys(input).some(key => key !== 'minutes')) {
      fail(400, 'invalid_input', 'Automatic backups take minutes: 15, 60, 360, 1440 or null.');
    }
    const row = await c.env.DB.query<Pick<WorkspaceDatabaseRow, 'id' | 'automatic_backup_minutes'>>(`UPDATE workspace_databases
      SET automatic_backup_minutes = ? WHERE workspace_id = ? AND ${ownerSql} RETURNING id, automatic_backup_minutes`)
      .bind(minutes, workspaceId, workspaceId, actor).first();
    if (!row) fail(409, 'workspace_database_required', 'Connect a database to this workspace before scheduling backups into it.');
    await auditStatement(c.env, actor, 'workspace.database.automatic_backups', workspaceId, null, { databaseId: row.id, minutes }).run();
    return c.json({ automaticBackups: { minutes: row.automatic_backup_minutes ?? null } });
  });

  // A member confirms the workspace database once for every backup of the sessions they own, automatic ones included.
  // databaseId names the database they were shown; another database (after the owner pointed the connection elsewhere)
  // is refused, so they confirm what they saw.
  app.put('/api/workspaces/:id/database/consent', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).some(key => key !== 'databaseId')) fail(400, 'invalid_input', 'Consent takes only databaseId.');
    const databaseId = identifier(input.databaseId, 'databaseId');
    const row = await workspaceDatabaseRow(c.env, workspaceId);
    if (!row) fail(404, 'not_found', 'No database is connected to this workspace.');
    if (row.id !== databaseId) fail(409, 'workspace_database_changed', 'The workspace database changed. Review it and confirm again.');
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO workspace_database_consents (database_id, workspace_id, user_id, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (database_id, user_id) DO NOTHING`).bind(row.id, workspaceId, actor, now()),
      auditStatement(c.env, actor, 'workspace.database.consented', workspaceId, null,
        { databaseId: row.id, host: row.host, port: row.port, database: row.database_name }),
    ]);
    return c.json({ consented: true });
  });

  app.delete('/api/workspaces/:id/database/consent', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor);
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM workspace_database_consents WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, actor),
      auditStatement(c.env, actor, 'workspace.database.consent_withdrawn', workspaceId, null, {}),
    ]);
    return c.body(null, 204);
  });

  app.put('/api/workspaces/:id/database', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireWorkspaceOwner(c.env, workspaceId, actor);
    const provider = c.env.WORKSPACE_DATABASES;
    if (!provider) fail(503, 'workspace_databases_disabled', 'This server does not connect to workspace databases.');
    const target = databaseSettings(await jsonObject(c, maxCaCertificateLength + 16_384));
    await assertVaultConfigured(c.env);
    // Connect before storing anything: the tables are created now, and settings that can't save sessions are refused.
    try {
      await provider.verify(target);
    } catch (error) {
      workspaceDatabaseFailure(error, 'verify');
    }
    await requireWorkspaceOwner(c.env, workspaceId, actor);
    // The id names the target database: new credentials or TLS settings for the same host, port and database keep it, so
    // members' confirmations still hold; another database gets a new id, and members confirm it before saving there.
    // The password's vault context is bound to the id.
    const existing = await c.env.DB.query<Pick<WorkspaceDatabaseRow, 'id' | 'host' | 'port' | 'database_name'>>(`SELECT id, host, port, database_name
      FROM workspace_databases WHERE workspace_id = ?`).bind(workspaceId).first();
    const sameDatabase = existing?.host === target.host && existing.port === target.port && existing.database_name === target.database;
    const databaseId = existing && sameDatabase ? existing.id : id();
    const ciphertext = await encryptToken(c.env, databaseSecretContext(databaseId), target.password);
    const timestamp = now();
    // Replaces only the connection read above, so a concurrent replacement is never overwritten with this ciphertext.
    const row = await c.env.DB.query<WorkspaceDatabaseRow>(`INSERT INTO workspace_databases
      (id, workspace_id, host, port, database_name, username, tls, ca_certificate, password_ciphertext, created_by, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${ownerSql}
      ON CONFLICT (workspace_id) DO UPDATE SET id = excluded.id, host = excluded.host, port = excluded.port,
        database_name = excluded.database_name, username = excluded.username, tls = excluded.tls, ca_certificate = excluded.ca_certificate,
        password_ciphertext = excluded.password_ciphertext, created_by = excluded.created_by, updated_at = excluded.updated_at
        WHERE workspace_databases.id = ?
      RETURNING *`)
      .bind(databaseId, workspaceId, target.host, target.port, target.database, target.user, target.tls, target.caCertificate,
        ciphertext, actor, timestamp, timestamp, workspaceId, actor, existing?.id ?? databaseId)
      .first();
    if (!row) fail(409, 'workspace_database_conflict', 'The workspace database or the workspace ownership changed. Try again.');
    await auditStatement(c.env, actor, 'workspace.database.connected', workspaceId, null,
      { databaseId: row.id, host: row.host, port: row.port, database: row.database_name, tls: row.tls }).run();
    return c.json({ database: publicWorkspaceDatabase(row) }, 201);
  });

  // The owner imports a session or workspace dump of this workspace into its database: its sessions' records and details,
  // their activity and the workspace's settings. Nothing changes in the control plane but the activity entry recording it.
  app.post('/api/workspaces/:id/database/import', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireWorkspaceOwner(c.env, workspaceId, actor);
    const provider = c.env.WORKSPACE_DATABASES;
    if (!provider) fail(503, 'workspace_databases_disabled', 'This server does not connect to workspace databases.');
    const database = await workspaceDatabaseRow(c.env, workspaceId);
    if (!database) fail(409, 'workspace_database_required', 'Connect a database to this workspace before importing a dump into it.');
    const document = await jsonObject(c, maxUploadedDumpBytes);
    const workspace = await c.env.DB.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
    if (!workspace) fail(404, 'not_found', 'Workspace not found.');
    let imported: ImportSummary;
    try {
      imported = await importDump(c.env, provider, workspace, database, document, actor);
    } catch (error) {
      if (error instanceof DumpImportError) fail(400, 'invalid_dump', error.message);
      workspaceDatabaseFailure(error, 'use');
    }
    return c.json({ imported });
  });

  // Works even when the operator turned workspace databases off, so the owner can return to the server's backup storage.
  // Snapshots already saved stay in that database; they can be read again once it is connected again.
  app.delete('/api/workspaces/:id/database', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireWorkspaceOwner(c.env, workspaceId, actor);
    const removed = await c.env.DB.query<Pick<WorkspaceDatabaseRow, 'id' | 'host' | 'port' | 'database_name'>>(`DELETE FROM workspace_databases
      WHERE workspace_id = ? AND ${ownerSql} RETURNING id, host, port, database_name`).bind(workspaceId, workspaceId, actor).first();
    if (!removed) fail(404, 'not_found', 'No database is connected to this workspace.');
    // Confirmations name that database; connecting it again gives it a new id, which members confirm again.
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM workspace_database_consents WHERE workspace_id = ?').bind(workspaceId),
      auditStatement(c.env, actor, 'workspace.database.disconnected', workspaceId, null,
        { databaseId: removed.id, host: removed.host, port: removed.port, database: removed.database_name }),
    ]);
    return c.body(null, 204);
  });
}
