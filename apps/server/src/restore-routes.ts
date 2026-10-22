import type { Hono } from 'hono';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import type { RunnerBinding } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import type { RestoreInput } from '../../../packages/shared/src/connector.js';
import type { AppContext, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, runnerSessionRecord, sessionAccess, sessionRecord } from './db.js';
import { fail, id, identifier, jsonObject, now, randomToken, text } from './http.js';
import { bindingForSession } from './sessions.js';
import { authenticateConnector, requireConnectorSession } from './connectors.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { bindingIdentity, loadBackupSnapshot, repositoryIdentity, type BackupRow } from './restore-snapshot.js';
import { downloadMigrationSnapshot } from './host-migrations.js';

interface RestoreJob {
  id: string; request_id: string; owner_id: string; workspace_id: string;
  source_session_id: string; backup_id: string; target_session_id: string; request_title: string | null;
  sha256: string; size: number; binding_json: string; status: 'pending' | 'completed';
  download_token_hash: string | null; download_expires_at: number; lease_until: number;
  created_at: string; completed_at: string | null;
}

async function sourceAuthority(c: AppContext, sessionId: string, ownerId: string): Promise<SessionRow> {
  const access = await sessionAccess(c.env, sessionId, ownerId);
  if (!access || access.row.owner_id !== ownerId) fail(404, 'not_found', 'Source session not found.');
  if (access.row.status === 'archived') fail(409, 'session_archived', 'Source session is archived.');
  if (access.row.connector_id) await requireConnectorSession(c.env, access.row.connector_id, access.row);
  return access.row;
}

async function backupFor(c: AppContext, source: SessionRow, backupId: string): Promise<BackupRow> {
  const backup = await c.env.DB.query<BackupRow>('SELECT * FROM backups WHERE id = ? AND session_id = ? AND owner_id = ?')
    .bind(backupId, source.id, source.owner_id).first();
  if (!backup) fail(404, 'not_found', 'Backup not found.');
  return backup;
}

async function jobTarget(c: AppContext, job: RestoreJob): Promise<SessionRow> {
  const target = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(job.target_session_id).first();
  const binding = JSON.parse(job.binding_json) as RunnerBinding;
  if (!target || target.id === job.source_session_id || target.owner_id !== job.owner_id ||
      target.workspace_id !== job.workspace_id || target.agent_version_id !== binding.session.agentVersionId ||
      (target.connector_id ?? null) !== (binding.session.connectorId ?? null) ||
      (target.connector_owner_id ?? null) !== (binding.session.connectorOwnerId ?? null) ||
      repositoryIdentity(sessionRecord(target).repositories) !== repositoryIdentity(binding.session.repositories)) {
    fail(409, 'invalid_restore', 'The restore target binding does not match.');
  }
  return target;
}

function result(c: AppContext, job: RestoreJob, target: SessionRow, created: boolean): Response {
  return c.json({ session: sessionRecord(target, [...permissions]), restore: {
    id: job.id, status: job.status, sourceSessionId: job.source_session_id,
    backupId: job.backup_id, targetSessionId: job.target_session_id,
  } }, created ? 201 : 200);
}

export function registerRestoreRoutes(app: Hono<WorkerEnv>): void {
  app.post('/api/sessions/:sourceId/backups/:backupId/restore', async c => {
    const sourceId = identifier(c.req.param('sourceId'));
    const backupId = identifier(c.req.param('backupId'), 'backupId');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => key !== 'requestId' && key !== 'title')) {
      fail(400, 'invalid_input', 'Restore accepts only requestId and title.');
    }
    const requestId = identifier(input.requestId, 'requestId');
    const title = input.title === undefined ? null : text(input.title, 'title', 200);
    const ownerId = c.get('auth').userId;
    const access = await sessionAccess(c.env, sourceId, ownerId);
    if (!access) fail(404, 'not_found', 'Source session not found.');
    if (access.row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the original session owner can restore its backups.');
    const source = await sourceAuthority(c, sourceId, ownerId);
    let job = await c.env.DB.query<RestoreJob>('SELECT * FROM restore_jobs WHERE owner_id = ? AND request_id = ?')
      .bind(ownerId, requestId).first();
    let created = false;
    if (!job) {
      const backup = await backupFor(c, source, backupId);
      const sourceBinding = await bindingForSession(c, source);
      // Validate before creating any target; downloads independently repeat this check at use time.
      await loadBackupSnapshot(c.env, backup, sourceBinding);
      await sourceAuthority(c, sourceId, ownerId);
      const target: SessionRow = { id: id(), workspace_id: source.workspace_id, owner_id: ownerId,
        agent_version_id: source.agent_version_id, connector_id: source.connector_id ?? null,
        connector_owner_id: source.connector_owner_id ?? null, title: title ?? `Restored: ${source.title}`.slice(0, 200),
        repositories_json: source.repositories_json, repository_mode: source.repository_mode ?? null, visibility: 'private', policy_version: 1,
        status: 'provisioning', created_at: now() };
      const binding: RunnerBinding = { ...sourceBinding, session: runnerSessionRecord(target) };
      const restoreId = id();
      // Batches are transactional. The conditional insert prevents a losing concurrent
      // request from leaving an orphan target; the unique receipt selects one winner.
      await c.env.DB.batch([
        c.env.DB.query(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, connector_id,
          connector_owner_id, repositories_json, title, policy_version, status, created_at, visibility, repository_mode)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?
          WHERE NOT EXISTS (SELECT 1 FROM restore_jobs WHERE owner_id = ? AND request_id = ?)`)
          .bind(target.id, target.workspace_id, ownerId, target.agent_version_id, target.connector_id ?? null,
            target.connector_owner_id ?? null, target.repositories_json ?? '[]', target.title, 1, 'provisioning', target.created_at,
            target.repository_mode ?? null, ownerId, requestId),
        c.env.DB.query(`INSERT INTO restore_jobs (id, request_id, owner_id, workspace_id, source_session_id,
          backup_id, target_session_id, request_title, sha256, size, binding_json, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM restore_jobs WHERE owner_id = ? AND request_id = ?)`)
          .bind(restoreId, requestId, ownerId, source.workspace_id, sourceId, backupId, target.id, title,
            backup.sha256, backup.size, JSON.stringify(binding), target.created_at, ownerId, requestId),
      ]);
      job = await c.env.DB.query<RestoreJob>('SELECT * FROM restore_jobs WHERE owner_id = ? AND request_id = ?')
        .bind(ownerId, requestId).first();
      if (!job) fail(503, 'restore_unavailable', 'The restore receipt could not be persisted.');
      created = job.id === restoreId;
    }
    if (job.source_session_id !== sourceId || job.backup_id !== backupId || job.request_title !== title) {
      fail(409, 'request_conflict', 'This requestId is already bound to different restore inputs.');
    }
    const target = await jobTarget(c, job);
    if (job.status === 'completed') return result(c, job, target, false);
    if (target.status === 'archived') fail(409, 'session_archived', 'The restore target is archived.');
    const binding = JSON.parse(job.binding_json) as RunnerBinding;
    if (bindingIdentity(binding) !== bindingIdentity(await bindingForSession(c, source))) {
      fail(409, 'invalid_restore', 'The source binding has changed.');
    }
    const downloadToken = randomToken();
    const tokenHash = await sha256(downloadToken);
    const timestamp = Date.now();
    const claimed = await c.env.DB.query(`UPDATE restore_jobs SET download_token_hash = ?, download_expires_at = ?, lease_until = ?
      WHERE id = ? AND status = 'pending' AND lease_until <= ?`)
      .bind(tokenHash, timestamp + 180_000, timestamp + 120_000, job.id, timestamp).run();
    if (!claimed.changes) {
      const latest = await c.env.DB.query<RestoreJob>('SELECT * FROM restore_jobs WHERE id = ?').bind(job.id).first();
      if (latest?.status === 'completed') return result(c, latest, await jobTarget(c, latest), false);
      fail(409, 'restore_in_progress', 'This restore is already in progress; retry the same requestId.');
    }
    try {
      await sourceAuthority(c, sourceId, ownerId);
      const body: RestoreInput = { binding, restore: { id: job.id, sourceSessionId: sourceId,
        backupId, sha256: job.sha256, size: job.size, downloadToken } };
      const response = await runnerRequest(c, target, 'restore', '', body);
      const receipt = await runnerJSON<{ restore?: { id: string; sha256: string; targetSessionId: string } }>(response, 65536);
      if (receipt.restore?.id !== job.id || receipt.restore.sha256 !== job.sha256 || receipt.restore.targetSessionId !== target.id) {
        fail(502, 'invalid_restore_receipt', 'The runner did not confirm the pinned restore target.');
      }
      // A delayed response may not commit after another attempt has acquired the job.
      await c.env.DB.batch([
        c.env.DB.query(`UPDATE sessions SET status = 'ready' WHERE id = ? AND status <> 'archived'
          AND EXISTS (SELECT 1 FROM restore_jobs WHERE id = ? AND status = 'pending' AND download_token_hash = ?)`)
          .bind(target.id, job.id, tokenHash),
        c.env.DB.query(`UPDATE restore_jobs SET status = 'completed', completed_at = ?, download_token_hash = NULL,
          download_expires_at = 0, lease_until = 0 WHERE id = ? AND status = 'pending' AND download_token_hash = ?`)
          .bind(now(), job.id, tokenHash),
      ]);
      const completed = await c.env.DB.query<RestoreJob>('SELECT * FROM restore_jobs WHERE id = ?').bind(job.id).first();
      if (completed?.status !== 'completed') fail(409, 'restore_in_progress', 'Retry the same requestId to reconcile this restore.');
      await auditStatement(c.env, ownerId, 'session.restored', source.workspace_id, target.id,
        { restoreId: job.id, sourceSessionId: sourceId, backupId }).run();
      return result(c, completed, await jobTarget(c, completed), created);
    } catch (error) {
      // Unknown outcomes retain the exact target and receipt. Only the same durable
      // runner restore marker can reconcile a retry; never provision a replacement.
      await c.env.DB.batch([
        c.env.DB.query(`UPDATE sessions SET status = 'error' WHERE id = ? AND status <> 'archived'
          AND EXISTS (SELECT 1 FROM restore_jobs WHERE id = ? AND status = 'pending' AND download_token_hash = ?)`)
          .bind(target.id, job.id, tokenHash),
        c.env.DB.query(`UPDATE restore_jobs SET lease_until = 0 WHERE id = ? AND status = 'pending' AND download_token_hash = ?`)
          .bind(job.id, tokenHash),
      ]);
      throw error;
    }
  });
}

// Register ONLY behind connector bearer + CURRENT connection-token authentication,
// or the legacy shared-secret middleware. null means strictly legacy routing.
export async function downloadRestoreSnapshot(c: AppContext, expectedConnectorId: string | null): Promise<Response> {
  if (expectedConnectorId !== null) {
    const connector = await authenticateConnector(c, true);
    if (connector.id !== expectedConnectorId) fail(403, 'invalid_restore_grant', 'The authenticated connector does not match.');
  } else {
    const secret = c.env.RUNNER_SHARED_SECRET;
    const authorization = c.req.header('authorization');
    if (!secret || secret.length < 32 || !authorization?.startsWith('Bearer ') ||
        authorization.length > 512 || !constantTimeEqual(authorization.slice(7), secret)) {
      fail(401, 'unauthorized', 'Internal authentication is required.');
    }
  }
  const restoreId = identifier(c.req.param('restoreId'), 'restoreId');
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['targetSessionId', 'sourceSessionId', 'backupId', 'downloadToken'].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected restore download field.');
  }
  const token = text(input.downloadToken, 'downloadToken', 43, 43);
  const job = await c.env.DB.query<RestoreJob>('SELECT * FROM restore_jobs WHERE id = ?').bind(restoreId).first();
  if (!job) {
    // A host asks for a session moved to it the same way it asks for a backup it restores.
    const moved = await downloadMigrationSnapshot(c, expectedConnectorId, restoreId, input, token);
    if (moved) return moved;
  }
  if (!job || job.status !== 'pending' || input.targetSessionId !== job.target_session_id ||
      input.sourceSessionId !== job.source_session_id || input.backupId !== job.backup_id ||
      !job.download_token_hash || job.download_expires_at <= Date.now() ||
      !constantTimeEqual(await sha256(token), job.download_token_hash)) {
    fail(403, 'invalid_restore_grant', 'The restore download grant is invalid or expired.');
  }
  const target = await jobTarget(c, job);
  if ((target.connector_id ?? null) !== expectedConnectorId || target.status === 'archived') {
    fail(403, 'invalid_restore_grant', 'This runtime does not own the restore target.');
  }
  const source = await sourceAuthority(c, job.source_session_id, job.owner_id);
  if ((source.connector_id ?? null) !== expectedConnectorId) fail(403, 'invalid_restore_grant', 'The source runtime does not match.');
  if (expectedConnectorId) await requireConnectorSession(c.env, expectedConnectorId, target);
  const sourceBinding = await bindingForSession(c, source);
  if (bindingIdentity(sourceBinding) !== bindingIdentity(JSON.parse(job.binding_json) as RunnerBinding)) {
    fail(409, 'invalid_restore', 'The source binding no longer matches the restore receipt.');
  }
  const backup = await backupFor(c, source, job.backup_id);
  if (backup.sha256 !== job.sha256 || backup.size !== job.size) fail(409, 'invalid_restore', 'The backup no longer matches the restore receipt.');
  const raw = await loadBackupSnapshot(c.env, backup, sourceBinding);
  await sourceAuthority(c, job.source_session_id, job.owner_id);
  if (expectedConnectorId !== null) {
    const connector = await authenticateConnector(c, true);
    if (connector.id !== expectedConnectorId) fail(403, 'invalid_restore_grant', 'The authenticated connection has changed.');
    await requireConnectorSession(c.env, expectedConnectorId, target, connector.connection_hash!);
  }
  const current = await c.env.DB.query(`SELECT id FROM restore_jobs WHERE id = ? AND status = 'pending'
    AND download_token_hash = ? AND download_expires_at > ?`).bind(job.id, job.download_token_hash, Date.now()).first();
  if (!current) fail(403, 'invalid_restore_grant', 'The restore download grant has expired.');
  return new Response(raw, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(job.size),
    'X-Backup-SHA256': job.sha256, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export const registerRestores = registerRestoreRoutes;
export const connectorRestoreDownload = downloadRestoreSnapshot;
export function legacyRestoreDownload(c: AppContext): Promise<Response> { return downloadRestoreSnapshot(c, null); }
