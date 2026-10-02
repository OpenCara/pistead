import { sha256 } from '../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import { requireConnectorSession } from './connectors.js';
import { sessionAccess } from './db.js';
import { fail, now, randomToken, testMode, text } from './http.js';
import type { AppContext, SessionRow } from './types.js';

const ADMISSION_TTL_SECONDS = 3600;
const MAX_SESSION_ACTOR_PENDING = 1000;
const MAX_ACTOR_PENDING = 1000;
const MAX_OWNER_PENDING = 5000;

interface RunAdmissionRow {
  id: string;
  session_id: string;
  actor_id: string;
  mode: string;
  request_id: string;
  content_hash: string;
  expires_at: number;
}

// Recheck authority in each statement, including replays after a racing revocation.
const ELIGIBLE_SESSION = `SELECT s.id FROM sessions s
  JOIN workspace_members actor ON actor.workspace_id = s.workspace_id AND actor.user_id = ?
  JOIN workspace_members owner ON owner.workspace_id = s.workspace_id AND owner.user_id = s.owner_id
  JOIN users actor_user ON actor_user.id = actor.user_id
  JOIN users owner_user ON owner_user.id = owner.user_id
  JOIN agent_versions a ON a.id = s.agent_version_id
  JOIN models m ON m.id = a.model_id AND m.workspace_id = s.workspace_id
  WHERE s.id = ? AND s.workspace_id = ? AND s.owner_id = ? AND s.agent_version_id = ?
    AND s.policy_version = ? AND s.connector_id IS ? AND s.connector_owner_id IS ?
    AND s.status <> 'archived'
    AND m.connector_id IS s.connector_id AND m.connector_owner_id IS s.connector_owner_id
    AND (? = 1 OR (actor_user.auth_kind <> 'test' AND owner_user.auth_kind <> 'test' AND m.provider <> 'faux'))
    AND (s.owner_id = actor.user_id OR EXISTS (
      SELECT 1 FROM session_grants g, json_each(g.permissions_json) permission
      WHERE g.session_id = s.id AND g.user_id = actor.user_id AND permission.value = 'write'
    ))
    AND NOT EXISTS (SELECT 1 FROM restore_jobs r WHERE r.target_session_id = s.id AND r.status <> 'completed')
    AND ((s.connector_id IS NULL AND s.connector_owner_id IS NULL) OR EXISTS (
      SELECT 1 FROM connectors connector
      JOIN connector_shares share ON share.connector_id = connector.id AND share.workspace_id = s.workspace_id
      JOIN workspace_members host ON host.workspace_id = s.workspace_id AND host.user_id = connector.owner_id
      JOIN users host_user ON host_user.id = host.user_id
      WHERE connector.id = s.connector_id AND connector.owner_id = s.connector_owner_id
        AND connector.revoked_at IS NULL AND m.available = 1
        AND (? = 1 OR host_user.auth_kind <> 'test')
        AND EXISTS (SELECT 1 FROM json_each(connector.models_json) local_model
          WHERE json_extract(local_model.value, '$.provider') = m.provider
            AND json_extract(local_model.value, '$.modelId') = m.model_id)
    ))`;

async function admissionStorage<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch { fail(503, 'admission_unavailable', 'Run admission storage is temporarily unavailable.'); }
}

export async function issueRunAdmission(c: AppContext, row: SessionRow, content: string, requestId: string): Promise<string> {
  // Authentication middleware derives this identity from the cookie, never the submit body.
  const actorId = c.get('auth')?.userId;
  if (!actorId) fail(401, 'unauthorized', 'Authentication is required.');
  text(content, 'content', 60000);
  text(requestId, 'requestId', 128);

  const access = await sessionAccess(c.env, row.id, actorId);
  if (!access) fail(404, 'not_found', 'Session not found.');
  if (!hasPermission(access.permissions, 'write')) fail(403, 'forbidden', 'Session write permission is required.');
  const current = access.row;
  if (current.workspace_id !== row.workspace_id || current.owner_id !== row.owner_id ||
      current.agent_version_id !== row.agent_version_id || current.policy_version !== row.policy_version ||
      (current.connector_id ?? null) !== (row.connector_id ?? null) ||
      (current.connector_owner_id ?? null) !== (row.connector_owner_id ?? null)) {
    fail(409, 'policy_changed', 'Session binding or permissions changed; reload and retry.');
  }
  if (current.status === 'archived') fail(409, 'session_archived', 'Session is archived.');
  if (current.connector_id) await requireConnectorSession(c.env, current.connector_id, current);

  const contentHash = await sha256(content);
  const createdAt = now();
  const issuedAt = Math.floor(Date.parse(createdAt) / 1000);
  const allowTest = testMode(c.env) ? 1 : 0;
  const guardBindings = [actorId, current.id, current.workspace_id, current.owner_id, current.agent_version_id,
    current.policy_version, current.connector_id ?? null, current.connector_owner_id ?? null, allowTest, allowTest];

  // Tenant-local quotas share the insertion statement; one account cannot consume a global gate.
  // Never delete proof rows or renew their expiry, including after ambiguous dispatches.
  await admissionStorage(c.env.DB.prepare(`WITH eligible AS (${ELIGIBLE_SESSION})
    INSERT INTO run_admissions (id, session_id, actor_id, mode, request_id, content_hash, expires_at, created_at)
    SELECT ?, eligible.id, ?, 'write', ?, ?, ?, ? FROM eligible
    WHERE (SELECT COUNT(*) FROM (
      SELECT 1 FROM run_admissions WHERE session_id = ? AND actor_id = ? AND expires_at > ? LIMIT ?
    )) < ?
      AND (SELECT COUNT(*) FROM (
        SELECT 1 FROM run_admissions WHERE actor_id = ? AND expires_at > ? LIMIT ?
      )) < ?
      AND (SELECT COUNT(*) FROM (
        SELECT 1 FROM sessions owned JOIN run_admissions admission ON admission.session_id = owned.id
        WHERE owned.owner_id = ? AND admission.expires_at > ? LIMIT ?
      )) < ?
    ON CONFLICT(session_id, actor_id, request_id) DO NOTHING`)
    .bind(...guardBindings, randomToken(), actorId, requestId, contentHash, issuedAt + ADMISSION_TTL_SECONDS, createdAt,
      current.id, actorId, issuedAt, MAX_SESSION_ACTOR_PENDING, MAX_SESSION_ACTOR_PENDING,
      actorId, issuedAt, MAX_ACTOR_PENDING, MAX_ACTOR_PENDING,
      current.owner_id, issuedAt, MAX_OWNER_PENDING, MAX_OWNER_PENDING).run());

  // Read the winner rather than the candidate token; a retry never extends the original expiry.
  const admission = await admissionStorage(c.env.DB.prepare(`WITH eligible AS (${ELIGIBLE_SESSION})
    SELECT admission.* FROM run_admissions admission JOIN eligible ON eligible.id = admission.session_id
    WHERE admission.session_id = ? AND admission.actor_id = ? AND admission.request_id = ?`)
    .bind(...guardBindings, current.id, actorId, requestId).first<RunAdmissionRow>());
  if (!admission) fail(409, 'admission_unavailable', 'Run admission could not be issued; reload or try again later.');
  if (admission.session_id !== current.id || admission.actor_id !== actorId || admission.request_id !== requestId ||
      admission.mode !== 'write' || admission.content_hash !== contentHash ||
      !/^[A-Za-z0-9_-]{43}$/.test(admission.id) || !Number.isSafeInteger(admission.expires_at) ||
      admission.expires_at <= Math.floor(Date.now() / 1000)) {
    fail(409, 'admission_conflict', 'The request ID cannot be reused for this submission.');
  }
  return admission.id;
}
