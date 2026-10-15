import type { Hono } from 'hono';
import type { Env, WorkerEnv } from '../types.js';
import { auditStatement, requireMember } from '../db.js';
import { fail, id, identifier, jsonObject, now } from '../http.js';
import { assertVaultConfigured, encryptToken } from '../vault.js';
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
    fail(403, 'owner_required', 'Only the workspace owner can connect or disconnect its database.');
  }
}

export function registerWorkspaceDatabases(app: Hono<WorkerEnv>): void {
  // Every member sees where backups of the workspace's sessions go before creating one; the password never leaves the server.
  app.get('/api/workspaces/:id/database', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const row = await workspaceDatabaseRow(c.env, workspaceId);
    const provider = c.env.WORKSPACE_DATABASES;
    return c.json({ available: !!provider, privateHosts: provider?.privateHosts ?? false, database: row ? publicWorkspaceDatabase(row) : null });
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

  // Works even when the operator turned workspace databases off, so the owner can return to the server's backup storage.
  // Snapshots already saved stay in that database; they can be read again once it is connected again.
  app.delete('/api/workspaces/:id/database', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actor = c.get('auth').userId;
    await requireWorkspaceOwner(c.env, workspaceId, actor);
    const removed = await c.env.DB.query<Pick<WorkspaceDatabaseRow, 'id' | 'host' | 'port' | 'database_name'>>(`DELETE FROM workspace_databases
      WHERE workspace_id = ? AND ${ownerSql} RETURNING id, host, port, database_name`).bind(workspaceId, workspaceId, actor).first();
    if (!removed) fail(404, 'not_found', 'No database is connected to this workspace.');
    await auditStatement(c.env, actor, 'workspace.database.disconnected', workspaceId, null,
      { databaseId: removed.id, host: removed.host, port: removed.port, database: removed.database_name }).run();
    return c.body(null, 204);
  });
}
