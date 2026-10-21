import type { Permission, RunnerAction, RunnerTicket } from '../../../packages/shared/src/types.js';
import { sha256, signToken } from '../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import { sessionAccess } from './db.js';
import type { AppContext, SessionRow } from './types.js';
import { fail, id, testMode } from './http.js';
import { connectorRequest, type ConnectionPin } from './connector-transport.js';

const actionPermissions: Record<RunnerAction, Permission> = {
  create: 'write', view: 'read', events: 'read', submit: 'write', ask: 'ask',
  operations: 'write', approve: 'approve', backup: 'manage', restart: 'manage', restore: 'write',
};

export async function runnerRequest(c: AppContext, row: SessionRow, action: RunnerAction, suffix = '', body?: unknown, pin?: ConnectionPin): Promise<Response> {
  return actorRequest(c, c.get('auth').userId, row, action, suffix, body, pin);
}

/**
 * The committed view as the session owner sees it, for a share link the caller has just checked. This read is the only
 * request ever made as the owner on someone else's behalf; the owner's own access is still checked here and on the host.
 */
export function ownerViewRequest(c: AppContext, row: SessionRow): Promise<Response> {
  return actorRequest(c, row.owner_id, row, 'view');
}

/** What every runner request checks first: the actor may still do `action` on the session, and no restore is under way. */
export async function requireRunnerAccess(c: AppContext, actorId: string, row: SessionRow, action: RunnerAction): Promise<SessionRow> {
  const access = await sessionAccess(c.env, row.id, actorId);
  if (!access || !hasPermission(access.permissions, actionPermissions[action]) || access.row.owner_id !== row.owner_id) {
    fail(403, 'permission_revoked', 'Session access is no longer authorized.');
  }
  if (access.row.status === 'archived' && action !== 'view' && action !== 'events') fail(409, 'session_archived', 'Session is archived.');
  if (['create', 'restart', 'restore', 'backup'].includes(action) && actorId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can perform this operation.');
  if (action !== 'restore' && await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(row.id).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  return access.row;
}

async function actorRequest(c: AppContext, actorId: string, row: SessionRow, action: RunnerAction, suffix = '', body?: unknown, pin?: ConnectionPin): Promise<Response> {
  const current = await requireRunnerAccess(c, actorId, row, action);
  if (current.connector_id) return connectorRequest(c, current, action, suffix, body, actorId, pin);
  const secret = c.env.RUNNER_SHARED_SECRET;
  if (!secret || secret.length < 32 || !c.env.RUNNER_URL) fail(503, 'runner_unavailable', 'The external runner is not configured.');
  let base: URL;
  try { base = new URL(c.env.RUNNER_URL); } catch { fail(503, 'runner_unavailable', 'The external runner is not configured.'); }
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(testMode(c.env) && base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    fail(503, 'runner_unavailable', 'The external runner URL is not configured securely.');
  }
  const paths: Record<RunnerAction, string> = {
    create: '/v1/sessions', view: `/v1/sessions/${row.id}/view${suffix ? `/${encodeURIComponent(suffix)}` : ''}`, events: `/v1/sessions/${row.id}/events`,
    submit: `/v1/sessions/${row.id}/submit`, ask: `/v1/sessions/${row.id}/ask`, operations: `/v1/sessions/${row.id}/operations`,
    approve: `/v1/sessions/${row.id}/approvals/${encodeURIComponent(suffix)}`, backup: `/v1/sessions/${row.id}/backup`, restart: `/v1/sessions/${row.id}/restart`,
    restore: `/v1/sessions/${row.id}/restore`,
  };
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const issuedAt = Math.floor(Date.now() / 1000);
  const ticket: RunnerTicket = { aud: 'runner', sessionId: row.id, actorId, ownerId: row.owner_id, action,
    policyVersion: current.policy_version, iat: issuedAt, exp: issuedAt + 60, jti: id(), bodyHash: await sha256(serialized) };
  const authorization = await signToken(ticket, secret);
  let response: Response;
  try {
    // Do not forward the browser abort signal: a disconnected SSE consumer must not cancel a run.
    response = await fetch(new URL(paths[action], base), {
      method: action === 'view' || action === 'events' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${authorization}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : serialized,
      redirect: 'manual',
      ...(action === 'events' ? {} : { signal: AbortSignal.timeout(action === 'backup' || action === 'restore' ? 90000 : 30000) }),
    });
  } catch {
    fail(503, 'runner_unavailable', 'The external runner is unavailable. An accepted operation may still be running; inspect the session before retrying.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const status = [400, 403, 404, 409, 413, 422, 429, 503, 504].includes(response.status) ? response.status : 502;
    const message = status === 409 ? 'The session is busy or the operation conflicts with its current state.'
      : status === 403 ? 'The runner rejected the operation because access changed.'
      : status === 503 || status === 504 ? 'The external runner is unavailable.' : 'The external runner could not complete the operation.';
    fail(status as 400 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503 | 504, 'runner_error', message);
  }
  return response;
}

export async function runnerJSON<T>(response: Response, limit = 8 * 1024 * 1024): Promise<T> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    fail(502, 'invalid_runner_response', 'The runner returned an invalid response.');
  }
  const raw = await boundedResponseText(response, limit);
  try { return JSON.parse(raw) as T; } catch { fail(502, 'invalid_runner_response', 'The runner returned invalid JSON.'); }
}
export async function boundedResponseText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) fail(502, 'invalid_runner_response', 'The runner response was empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      fail(502, 'runner_response_too_large', 'The runner response exceeds the configured backup or response limit.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
