import type { Hono } from 'hono';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import type { RunnerBinding } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import type { ConnectorCapabilities, RestoreInput } from '../../../packages/shared/src/connector.js';
import type { AgentRow, AppContext, SessionRow, WorkerEnv } from './types.js';
import { agentVersion, auditStatement, modelDefinition, requireNoMigration, requireSessionCreator, requireUnfrozen, runnerSessionRecord, sessionAccess, sessionCreatorSQL, sessionRecord, successorBranch } from './db.js';
import { fail, id, identifier, jsonObject, now, randomToken, testMode, text } from './http.js';
import { bindingForSession } from './sessions.js';
import { authenticateConnector, requireConnectorSession } from './connectors.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { boundedSnapshotText, MAX_BACKUP_BYTES, repositoryIdentity, validateSnapshot } from './restore-snapshot.js';
import { migratedAgentVersion, requireModel } from './catalog.js';
import { ConstraintError } from './db/types.js';

/**
 * Moving a session to another host while both are connected. The source host's live snapshot (the same one a backup
 * saves) is held in the migration receipt, never in backup storage, so no STORAGE_URL is needed. The target host restores
 * it into a successor session bound to that host and one of its models, exactly as it restores a backup, and the source
 * is archived once the target confirms. Until then both sessions only accept reads, so nothing said to the source after
 * its snapshot is lost; a move that can't finish is retried with the same requestId, or cancelled.
 */
interface MigrationJob {
  id: string; request_id: string; owner_id: string; workspace_id: string;
  source_session_id: string; source_connector_id: string;
  target_session_id: string; target_connector_id: string; target_model_id: string; request_title: string | null;
  sha256: string; size: number; snapshot: string | null; binding_json: string;
  status: 'pending' | 'completed' | 'cancelled';
  download_token_hash: string | null; download_expires_at: number; lease_until: number;
  created_at: string; completed_at: string | null;
}

function readJob(c: AppContext, ownerId: string, requestId: string): Promise<MigrationJob | null> {
  return c.env.DB.query<MigrationJob>('SELECT * FROM host_migrations WHERE owner_id = ? AND request_id = ?').bind(ownerId, requestId).first();
}

/** The owner's own, unarchived, connected session; `host` also requires its host to still serve it. */
async function sourceAuthority(c: AppContext, sessionId: string, ownerId: string, host = true): Promise<SessionRow> {
  const access = await sessionAccess(c.env, sessionId, ownerId);
  if (!access || access.row.owner_id !== ownerId) fail(404, 'not_found', 'Source session not found.');
  if (access.row.status === 'archived') fail(409, 'session_archived', 'Source session is archived.');
  if (!access.row.connector_id) fail(400, 'connector_required', 'Only sessions on a connected host can move to another host.');
  if (host) await requireConnectorSession(c.env, access.row.connector_id, access.row);
  return access.row;
}

/** The successor exactly as the receipt pinned it. */
async function jobTarget(c: AppContext, job: MigrationJob): Promise<SessionRow> {
  const target = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(job.target_session_id).first();
  const binding = JSON.parse(job.binding_json) as RunnerBinding;
  if (!target || target.id === job.source_session_id || target.owner_id !== job.owner_id || target.workspace_id !== job.workspace_id ||
      target.agent_version_id !== binding.session.agentVersionId || (target.connector_id ?? null) !== job.target_connector_id ||
      (binding.session.connectorId ?? null) !== job.target_connector_id ||
      (target.connector_owner_id ?? null) !== (binding.session.connectorOwnerId ?? null) ||
      repositoryIdentity(sessionRecord(target).repositories) !== repositoryIdentity(binding.session.repositories)) {
    fail(409, 'invalid_migration', 'The move target binding does not match.');
  }
  return target;
}

function migrationInfo(job: MigrationJob) {
  return { id: job.id, status: job.status, sourceSessionId: job.source_session_id, targetSessionId: job.target_session_id,
    sourceConnectorId: job.source_connector_id, targetConnectorId: job.target_connector_id };
}

function result(c: AppContext, job: MigrationJob, target: SessionRow, created: boolean): Response {
  return c.json({ session: sessionRecord(target, [...permissions]), migration: migrationInfo(job) }, created ? 201 : 200);
}

/** Takes the source host's live snapshot and records the successor and receipt in one transaction. */
async function startMigration(c: AppContext, input: { sourceId: string; requestId: string; modelId: string; title: string | null; trusted: string | null }): Promise<MigrationJob> {
  const ownerId = c.get('auth').userId;
  const access = await sessionAccess(c.env, input.sourceId, ownerId);
  if (!access) fail(404, 'not_found', 'Source session not found.');
  if (access.row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can move it to another host.');
  // A move creates the successor session, which a viewer can't.
  await requireSessionCreator(c.env, access.row.workspace_id, ownerId);
  const source = await sourceAuthority(c, input.sourceId, ownerId);
  requireUnfrozen(source);
  await requireNoMigration(c.env, source.id);
  const model = await requireModel(c.env, input.modelId, ownerId);
  if (model.workspace_id !== source.workspace_id) fail(404, 'not_found', 'Model not found.');
  if (!model.connector_id || !model.connector_owner_id) fail(400, 'connector_required', 'Choose a model on a connected host.');
  if (model.connector_id === source.connector_id) fail(400, 'same_host', 'The session already runs on this host. Choose a model on another host.');
  if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
  if (model.connector_owner_id !== ownerId && input.trusted !== model.connector_id) {
    fail(400, 'connector_trust_required', 'Explicitly acknowledge that this host can access this session before continuing.');
  }
  const host = await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(model.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The target host is no longer available.');
  const capabilities = JSON.parse(host.capabilities_json) as ConnectorCapabilities;
  if (capabilities.hostMigration !== true) {
    fail(409, 'connector_update_required', 'Update the target host\'s connector (npx pistead@latest connect, on Linux) to move sessions to it.');
  }
  // A clone session has no pins to carry: its successor needs a host where the agent can clone again, and that restores
  // its clones' local work from the snapshot.
  if (source.repository_mode === 'clone' && (capabilities.plainGit !== true || capabilities.cloneBackups !== true || capabilities.unsandboxed
    || (capabilities.productionShell !== true && model.connector_owner_id !== ownerId))) {
    fail(409, 'clone_host_required', 'This session clones its repositories with plain Git; move it to a host with an up-to-date connector, not running unsandboxed, that can run your shell commands.');
  }
  const sourceAgent = await c.env.DB.query<AgentRow>('SELECT * FROM agent_versions WHERE id = ?').bind(source.agent_version_id).first();
  if (!sourceAgent) fail(409, 'invalid_binding', 'Session binding is incomplete.');
  const sourceBinding = await bindingForSession(c, source);
  // The same idle, checkpointed snapshot a backup takes; the source host refuses it while work is queued or running.
  const response = await runnerRequest(c, source, 'backup', '', {});
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    fail(502, 'invalid_backup', 'The source host returned an invalid snapshot format.');
  }
  const snapshot = await boundedSnapshotText(response);
  validateSnapshot(snapshot, sourceBinding);
  const fresh = await sourceAuthority(c, source.id, ownerId);
  if (fresh.policy_version !== source.policy_version) fail(409, 'policy_changed', 'The session changed while its snapshot was taken. Try again.');
  // Created only once the move is otherwise admissible; a refused move leaves at most this unused session agent.
  const agent = await migratedAgentVersion(c.env, ownerId, sourceAgent, model, capabilities);
  const target: SessionRow = { id: id(), workspace_id: source.workspace_id, owner_id: ownerId, agent_version_id: agent.id,
    connector_id: model.connector_id, connector_owner_id: model.connector_owner_id, title: input.title ?? source.title,
    repositories_json: source.repositories_json ?? '[]', repository_mode: source.repository_mode ?? null, visibility: source.visibility ?? 'private', policy_version: 1,
    status: 'provisioning', created_at: now() };
  target.branch = successorBranch(target, capabilities);
  await requireConnectorSession(c.env, model.connector_id, target);
  const binding: RunnerBinding = { session: runnerSessionRecord(target), owner: sourceBinding.owner, agent: agentVersion(agent), model: modelDefinition(model) };
  const digest = await sha256(snapshot);
  const size = new TextEncoder().encode(snapshot).byteLength;
  if (size > MAX_BACKUP_BYTES) fail(502, 'invalid_backup', 'The snapshot exceeds its size limit.');
  const migrationId = id();
  // The successor is created only while the move is admissible. The receipt insert is unconditional, so a concurrent move
  // of the same source (or a racing retry of this requestId) violates its unique indexes and rolls the whole batch back,
  // even under Postgres READ COMMITTED: there is at most one move in flight and never an orphan successor.
  const admissible = `NOT EXISTS (SELECT 1 FROM host_migrations WHERE owner_id = ? AND request_id = ?)
    AND NOT EXISTS (SELECT 1 FROM host_migrations WHERE status = 'pending' AND (source_session_id = ? OR target_session_id = ?))
    AND EXISTS (SELECT 1 FROM sessions source WHERE source.id = ? AND source.owner_id = ? AND source.policy_version = ? AND source.status <> 'archived')
    AND ${sessionCreatorSQL('?')}`;
  const admissibleValues = [ownerId, input.requestId, source.id, source.id, source.id, ownerId, source.policy_version, source.workspace_id, ownerId];
  try {
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, connector_id,
        connector_owner_id, repositories_json, title, policy_version, status, created_at, visibility, repository_mode, branch)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${admissible}`)
        .bind(target.id, target.workspace_id, ownerId, target.agent_version_id, target.connector_id ?? null,
          target.connector_owner_id ?? null, target.repositories_json ?? '[]', target.title, 1, 'provisioning', target.created_at,
          target.visibility ?? 'private', target.repository_mode ?? null, target.branch ?? null, ...admissibleValues),
      c.env.DB.query(`INSERT INTO host_migrations (id, request_id, owner_id, workspace_id, source_session_id, source_connector_id,
        target_session_id, target_connector_id, target_model_id, request_title, sha256, size, snapshot, binding_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`)
        .bind(migrationId, input.requestId, ownerId, source.workspace_id, source.id, source.connector_id ?? null,
          target.id, model.connector_id, model.id, input.title, digest, size, snapshot, JSON.stringify(binding), target.created_at,
          target.id),
    ]);
  } catch (error) {
    // SQLite: 'UNIQUE constraint failed: host_migrations.source_session_id'; Postgres: '... "host_migrations_pending_source"'.
    if (!(error instanceof ConstraintError) || !/host_migrations/.test(error.constraint)) throw error;
    // Another move of this session, or of this requestId, committed first; a racing retry reads that receipt below.
  }
  const job = await readJob(c, ownerId, input.requestId);
  if (!job) fail(409, 'migration_changed', 'The session changed or is already moving to another host. Reload and try again.');
  if (job.id === migrationId) {
    await auditStatement(c.env, ownerId, 'session.migration_started', source.workspace_id, source.id,
      { migrationId, targetSessionId: target.id, targetConnectorId: model.connector_id, modelId: model.id }).run();
  }
  return job;
}

export function registerHostMigrations(app: Hono<WorkerEnv>): void {
  app.post('/api/sessions/:sourceId/migrate', async c => {
    const sourceId = identifier(c.req.param('sourceId'));
    const body = await jsonObject(c, 4096);
    if (Object.keys(body).some(key => !['requestId', 'modelId', 'title', 'trustedConnectorId'].includes(key))) {
      fail(400, 'invalid_input', 'A move accepts only requestId, modelId, title and trustedConnectorId.');
    }
    const input = {
      sourceId, requestId: identifier(body.requestId, 'requestId'), modelId: identifier(body.modelId, 'modelId'),
      title: body.title === undefined ? null : text(body.title, 'title', 200),
      trusted: body.trustedConnectorId === undefined ? null : identifier(body.trustedConnectorId, 'trustedConnectorId'),
    };
    const ownerId = c.get('auth').userId;
    let job = await readJob(c, ownerId, input.requestId);
    let created = false;
    if (!job) {
      job = await startMigration(c, input);
      created = true;
    }
    if (job.source_session_id !== sourceId || job.target_model_id !== input.modelId || job.request_title !== input.title) {
      fail(409, 'request_conflict', 'This requestId is already bound to a different move.');
    }
    if (job.status === 'completed') return result(c, job, await jobTarget(c, job), false);
    if (job.status === 'cancelled') fail(409, 'migration_cancelled', 'This move was cancelled. Start a new one to move the session.');
    const target = await jobTarget(c, job);
    if (target.status === 'archived') fail(409, 'session_archived', 'The move target is archived.');
    // The snapshot is held here, so a retry needs the target host, not the source host.
    const source = await sourceAuthority(c, sourceId, ownerId, false);
    if (source.connector_id !== job.source_connector_id) fail(409, 'invalid_migration', 'The source session binding has changed.');
    if (job.snapshot === null) fail(409, 'invalid_migration', 'The move snapshot is no longer held.');
    const binding = JSON.parse(job.binding_json) as RunnerBinding;
    const downloadToken = randomToken();
    const tokenHash = await sha256(downloadToken);
    const timestamp = Date.now();
    const claimed = await c.env.DB.query(`UPDATE host_migrations SET download_token_hash = ?, download_expires_at = ?, lease_until = ?
      WHERE id = ? AND status = 'pending' AND lease_until <= ?`)
      .bind(tokenHash, timestamp + 180_000, timestamp + 120_000, job.id, timestamp).run();
    if (!claimed.changes) {
      const latest = await c.env.DB.query<MigrationJob>('SELECT * FROM host_migrations WHERE id = ?').bind(job.id).first();
      if (latest?.status === 'completed') return result(c, latest, await jobTarget(c, latest), false);
      fail(409, 'migration_in_progress', 'This move is already in progress; retry the same requestId.');
    }
    try {
      const restoreInput: RestoreInput = { binding, restore: { id: job.id, sourceSessionId: sourceId, backupId: job.id,
        sha256: job.sha256, size: job.size, downloadToken, migration: true } };
      const response = await runnerRequest(c, target, 'restore', '', restoreInput);
      const receipt = await runnerJSON<{ restore?: { id: string; sha256: string; targetSessionId: string } }>(response, 65536);
      if (receipt.restore?.id !== job.id || receipt.restore.sha256 !== job.sha256 || receipt.restore.targetSessionId !== target.id) {
        fail(502, 'invalid_restore_receipt', 'The target host did not confirm the pinned move target.');
      }
      const held = `EXISTS (SELECT 1 FROM host_migrations WHERE id = ? AND status = 'pending' AND download_token_hash = ?)`;
      // A delayed response may not commit after another attempt has acquired the move. The source is archived, not
      // deleted: its history stays readable and its owner can unarchive it.
      await c.env.DB.batch([
        c.env.DB.query(`UPDATE sessions SET status = 'ready' WHERE id = ? AND status <> 'archived' AND ${held}`)
          .bind(target.id, job.id, tokenHash),
        c.env.DB.query(`UPDATE sessions SET archived_status = status, status = 'archived', policy_version = policy_version + 1
          WHERE id = ? AND status <> 'archived' AND ${held}`).bind(sourceId, job.id, tokenHash),
        c.env.DB.query(`UPDATE host_migrations SET status = 'completed', completed_at = ?, snapshot = NULL, download_token_hash = NULL,
          download_expires_at = 0, lease_until = 0 WHERE id = ? AND status = 'pending' AND download_token_hash = ?`)
          .bind(now(), job.id, tokenHash),
      ]);
      const completed = await c.env.DB.query<MigrationJob>('SELECT * FROM host_migrations WHERE id = ?').bind(job.id).first();
      if (completed?.status !== 'completed') fail(409, 'migration_in_progress', 'Retry the same requestId to reconcile this move.');
      const detail = { migrationId: job.id, sourceSessionId: sourceId, targetSessionId: target.id,
        sourceConnectorId: job.source_connector_id, targetConnectorId: job.target_connector_id };
      await c.env.DB.batch([
        auditStatement(c.env, ownerId, 'session.migrated', job.workspace_id, sourceId, detail),
        auditStatement(c.env, ownerId, 'session.migrated', job.workspace_id, target.id, detail),
      ]);
      return result(c, completed, await jobTarget(c, completed), created);
    } catch (error) {
      // Unknown outcomes keep the exact successor and receipt; only the target's durable restore marker reconciles a retry.
      await c.env.DB.batch([
        c.env.DB.query(`UPDATE sessions SET status = 'error' WHERE id = ? AND status <> 'archived'
          AND EXISTS (SELECT 1 FROM host_migrations WHERE id = ? AND status = 'pending' AND download_token_hash = ?)`)
          .bind(target.id, job.id, tokenHash),
        c.env.DB.query(`UPDATE host_migrations SET lease_until = 0 WHERE id = ? AND status = 'pending' AND download_token_hash = ?`)
          .bind(job.id, tokenHash),
      ]);
      throw error;
    }
  });

  // The owner's move in flight from this session, so the web app can retry or cancel it after a reload.
  app.get('/api/sessions/:sourceId/migrations', async c => {
    const sourceId = identifier(c.req.param('sourceId'));
    const ownerId = c.get('auth').userId;
    const access = await sessionAccess(c.env, sourceId, ownerId);
    if (!access || access.row.owner_id !== ownerId) fail(404, 'not_found', 'Session not found.');
    const rows = await c.env.DB.query<Omit<MigrationJob, 'snapshot'>>(`SELECT id, request_id, owner_id, workspace_id, source_session_id,
      source_connector_id, target_session_id, target_connector_id, target_model_id, request_title, sha256, size, binding_json, status,
      download_token_hash, download_expires_at, lease_until, created_at, completed_at FROM host_migrations
      WHERE owner_id = ? AND (source_session_id = ? OR target_session_id = ?) ORDER BY created_at DESC, id DESC LIMIT 20`)
      .bind(ownerId, sourceId, sourceId).all();
    return c.json({ migrations: rows.map(row => ({ ...migrationInfo({ ...row, snapshot: null }), requestId: row.request_id,
      modelId: row.target_model_id, title: row.request_title, createdAt: row.created_at, completedAt: row.completed_at })) });
  });

  // Gives up on a move that can't finish. The successor is archived (its host may already hold the restored copy); the
  // source accepts work again, and nothing said to it was lost.
  app.post('/api/sessions/:sourceId/migrations/:migrationId/cancel', async c => {
    const sourceId = identifier(c.req.param('sourceId'));
    const migrationId = identifier(c.req.param('migrationId'), 'migrationId');
    const ownerId = c.get('auth').userId;
    const job = await c.env.DB.query<MigrationJob>('SELECT * FROM host_migrations WHERE id = ? AND owner_id = ? AND source_session_id = ?')
      .bind(migrationId, ownerId, sourceId).first();
    if (!job) fail(404, 'not_found', 'Move not found.');
    if (job.status === 'completed') fail(409, 'migration_completed', 'This move has already completed.');
    if (job.status === 'pending') {
      const timestamp = Date.now();
      await c.env.DB.batch([
        c.env.DB.query(`UPDATE host_migrations SET status = 'cancelled', completed_at = ?, snapshot = NULL, download_token_hash = NULL,
          download_expires_at = 0, lease_until = 0 WHERE id = ? AND status = 'pending' AND lease_until <= ?`)
          .bind(now(), job.id, timestamp),
        c.env.DB.query(`UPDATE sessions SET archived_status = 'error', status = 'archived', policy_version = policy_version + 1
          WHERE id = ? AND status <> 'archived' AND EXISTS (SELECT 1 FROM host_migrations WHERE id = ? AND status = 'cancelled')`)
          .bind(job.target_session_id, job.id),
      ]);
      const latest = await c.env.DB.query<MigrationJob>('SELECT * FROM host_migrations WHERE id = ?').bind(job.id).first();
      if (latest?.status === 'completed') fail(409, 'migration_completed', 'This move has already completed.');
      if (latest?.status !== 'cancelled') fail(409, 'migration_in_progress', 'This move is in progress. Try again in a few minutes.');
      await auditStatement(c.env, ownerId, 'session.migration_cancelled', job.workspace_id, sourceId,
        { migrationId: job.id, targetSessionId: job.target_session_id }).run();
      return c.json({ migration: migrationInfo(latest) });
    }
    return c.json({ migration: migrationInfo(job) });
  });
}

/**
 * The target host's download of a move snapshot, through the restore download routes (the connector asks for it as a
 * restore). Null when `migrationId` names no move, so the caller handles it as a backup restore.
 */
export async function downloadMigrationSnapshot(c: AppContext, expectedConnectorId: string | null, migrationId: string,
  input: Record<string, unknown>, token: string): Promise<Response | null> {
  const job = await c.env.DB.query<MigrationJob>('SELECT * FROM host_migrations WHERE id = ?').bind(migrationId).first();
  if (!job) return null;
  if (job.status !== 'pending' || input.targetSessionId !== job.target_session_id || input.sourceSessionId !== job.source_session_id ||
      input.backupId !== job.id || job.snapshot === null || !job.download_token_hash || job.download_expires_at <= Date.now() ||
      !constantTimeEqual(await sha256(token), job.download_token_hash)) {
    fail(403, 'invalid_restore_grant', 'The restore download grant is invalid or expired.');
  }
  // Moves are between connected hosts only; the legacy shared-secret runner never receives one.
  if (expectedConnectorId === null || job.target_connector_id !== expectedConnectorId) {
    fail(403, 'invalid_restore_grant', 'This runtime does not own the move target.');
  }
  const target = await jobTarget(c, job);
  if (target.connector_id !== expectedConnectorId || target.status === 'archived') fail(403, 'invalid_restore_grant', 'This runtime does not own the move target.');
  await requireConnectorSession(c.env, expectedConnectorId, target);
  // The source's own host need not serve it any more: moving away from a host is the point.
  const source = await sourceAuthority(c, job.source_session_id, job.owner_id, false);
  if (source.connector_id !== job.source_connector_id) fail(409, 'invalid_migration', 'The source session binding has changed.');
  const raw = job.snapshot;
  if (new TextEncoder().encode(raw).byteLength !== job.size || await sha256(raw) !== job.sha256) {
    fail(502, 'invalid_backup', 'The move snapshot does not match its receipt.');
  }
  const connector = await authenticateConnector(c, true);
  if (connector.id !== expectedConnectorId) fail(403, 'invalid_restore_grant', 'The authenticated connection has changed.');
  await requireConnectorSession(c.env, expectedConnectorId, target, connector.connection_hash!);
  const current = await c.env.DB.query(`SELECT id FROM host_migrations WHERE id = ? AND status = 'pending'
    AND download_token_hash = ? AND download_expires_at > ?`).bind(job.id, job.download_token_hash, Date.now()).first();
  if (!current) fail(403, 'invalid_restore_grant', 'The restore download grant has expired.');
  return new Response(raw, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(job.size),
    'X-Backup-SHA256': job.sha256, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
