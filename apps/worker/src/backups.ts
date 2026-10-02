import type { Hono } from 'hono';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import type { RunnerBinding } from '../../../packages/shared/src/types.js';
import type { WorkerEnv } from './types.js';
import { auditStatement, requireSession } from './db.js';
import { fail, id, identifier, now } from './http.js';
import { boundedResponseText, runnerRequest } from './runner.js';

interface BackupRow { id: string; session_id: string; owner_id: string; object_key: string; sha256: string; size: number; created_at: string }
interface RunnerBackup {
  format: 'pi-runner-backup-v1';
  binding: RunnerBinding;
  manifest: unknown;
  sqlite: string;
  files: { path: string; data: string; mode: number }[];
  createdAt: string;
}
function backupInfo(row: BackupRow) {
  return { id: row.id, sessionId: row.session_id, size: row.size, sha256: row.sha256, createdAt: row.created_at };
}

export function registerBackups(app: Hono<WorkerEnv>): void {
  app.post('/api/sessions/:id/backup', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (!c.env.BUCKET) fail(503, 'backup_unavailable', 'Durable R2 backup storage is not configured.');
    const response = await runnerRequest(c, row, 'backup', '', {});
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      fail(502, 'invalid_backup', 'The runner returned an invalid backup format.');
    }
    // A bounded snapshot avoids exhausting the Worker heap. The execution authority checkpoints it first.
    const bytes = await boundedResponseText(response, 24 * 1024 * 1024);
    let snapshot: RunnerBackup;
    try { snapshot = JSON.parse(bytes) as RunnerBackup; } catch { fail(502, 'invalid_backup', 'The runner returned an unreadable backup.'); }
    if (snapshot?.format !== 'pi-runner-backup-v1' || snapshot.binding?.session?.id !== row.id ||
        snapshot.binding?.session?.ownerId !== row.owner_id || snapshot.binding?.owner?.id !== row.owner_id ||
        snapshot.binding?.session?.agentVersionId !== row.agent_version_id || typeof snapshot.sqlite !== 'string' ||
        !snapshot.sqlite || !Array.isArray(snapshot.files) || !snapshot.manifest) {
      fail(502, 'invalid_backup', 'The backup does not match the immutable session binding.');
    }
    await requireSession(c, row.id, 'manage');
    const backupId = id();
    const record: BackupRow = { id: backupId, session_id: row.id, owner_id: row.owner_id,
      object_key: `sessions/${row.owner_id}/${row.id}/${backupId}.json`, sha256: await sha256(bytes),
      size: new TextEncoder().encode(bytes).byteLength, created_at: now() };
    let stored: R2Object | null;
    try {
      stored = await c.env.BUCKET.put(record.object_key, bytes, {
        httpMetadata: { contentType: 'application/json', contentDisposition: `attachment; filename="session-${row.id}-${backupId}.json"` },
        customMetadata: { ownerId: row.owner_id, sessionId: row.id, sha256: record.sha256, format: 'pi-runner-backup-v1' },
      });
    } catch { fail(503, 'backup_unavailable', 'Durable backup storage is unavailable.'); }
    if (!stored) fail(503, 'backup_unavailable', 'The backup could not be stored durably.');
    // An orphaned private object on DB failure is safer than a downloadable DB row with no object.
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO backups (id, session_id, owner_id, object_key, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(record.id, record.session_id, record.owner_id, record.object_key, record.sha256, record.size, record.created_at),
      auditStatement(c.env, c.get('auth').userId, 'backup.created', row.workspace_id, row.id, { backupId, sha256: record.sha256, size: record.size }),
    ]);
    return c.json({ backup: backupInfo(record) }, 201);
  });
  app.get('/api/sessions/:id/backups', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const result = await c.env.DB.prepare('SELECT * FROM backups WHERE session_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(row.id, row.owner_id).all<BackupRow>();
    return c.json({ backups: result.results.map(backupInfo) });
  });
  app.get('/api/sessions/:id/backups/:backupId/download', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can download its backups.');
    if (!c.env.BUCKET) fail(503, 'backup_unavailable', 'Durable backup storage is not configured.');
    const record = await c.env.DB.prepare('SELECT * FROM backups WHERE id = ? AND session_id = ? AND owner_id = ?')
      .bind(identifier(c.req.param('backupId'), 'backupId'), row.id, row.owner_id).first<BackupRow>();
    if (!record) fail(404, 'not_found', 'Backup not found.');
    const object = await c.env.BUCKET.get(record.object_key);
    if (!object) fail(404, 'not_found', 'Backup object is unavailable.');
    await auditStatement(c.env, c.get('auth').userId, 'backup.downloaded', row.workspace_id, row.id, { backupId: record.id }).run();
    return new Response(object.body, { headers: {
      'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="session-${row.id}-${record.id}.json"`,
      'Content-Length': String(object.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Backup-SHA256': record.sha256,
    } });
  });
}
