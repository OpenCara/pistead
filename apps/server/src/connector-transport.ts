import { HTTPException } from 'hono/http-exception';
import { connectorLimits, type ConnectorRpcRequest } from '../../../packages/shared/src/connector.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { isRevision } from '../../../packages/shared/src/view-patch.js';
import type { Permission, RunnerAction, RunnerTicket } from '../../../packages/shared/src/types.js';
import { requireConnectorSession } from './connectors.js';
import { sessionAccess } from './db.js';
import { mayRequestAction } from './host-access.js';
import { fail, id } from './http.js';
import type { AppContext, Env, SessionRow } from './types.js';

export const connectorPermissions: Record<RunnerAction, Permission> = {
  create: 'write', view: 'read', events: 'read', submit: 'write', ask: 'ask',
  operations: 'write', approve: 'approve', backup: 'manage', restart: 'manage', restore: 'manage', stop: 'write', files: 'write',
  revert: 'write', fork: 'write',
};
export const connectorRequestFrameBytes = connectorLimits.requestBytes * 6 + 16384;
export interface ConnectorConnection {
  id: string;
  credential_hash: string;
  connection_hash: string | null;
  revoked_at: string | null;
}
export interface ConnectorRelayEnvelope {
  connectorId: string;
  credentialHash: string;
  connectionHash: string;
  request: ConnectorRpcRequest;
}

export function connectorPath(action: RunnerAction, sessionId: string, suffix = ''): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) fail(400, 'invalid_session', 'Invalid session identifier.');
  const base = `/v1/sessions/${sessionId}`;
  switch (action) {
    case 'create': return '/v1/sessions';
    case 'approve':
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffix)) fail(400, 'invalid_approval', 'Invalid approval identifier.');
      return `${base}/approvals/${suffix}`;
    case 'view':
      if (!suffix) return `${base}/view`;
      if (!isRevision(suffix)) fail(400, 'invalid_revision', 'Invalid view revision.');
      return `${base}/view/${suffix}`;
    case 'events': case 'submit': case 'ask': case 'operations': case 'backup': case 'restart': case 'restore': case 'stop': case 'files': case 'revert': case 'fork':
      return `${base}/${action}`;
    default: return fail(400, 'invalid_action', 'Invalid connector action.');
  }
}

export async function currentConnector(env: Env, connectorId: string): Promise<ConnectorConnection> {
  // A suspended owner's host stays paired but is refused like a revoked one until the account is restored.
  const row = await env.DB.query<ConnectorConnection & { suspended_at: string | null }>(`SELECT c.id, c.credential_hash, c.connection_hash, c.revoked_at,
    u.suspended_at FROM connectors c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`).bind(connectorId).first();
  if (!row || row.revoked_at || row.suspended_at) fail(403, 'connector_revoked', 'The connector is no longer authorized.');
  return row;
}

export async function requireConnectorGeneration(env: Env, connectorId: string, credentialHash: string, connectionHash: string): Promise<void> {
  const row = await currentConnector(env, connectorId);
  if (!connectionHash || row.credential_hash !== credentialHash || row.connection_hash !== connectionHash) {
    fail(503, 'connector_replaced', 'The connector connection changed. Inspect the session before retrying.');
  }
}

export async function authorizeConnectorTicket(env: Env, ticket: RunnerTicket, connectionHash?: string): Promise<SessionRow> {
  const permission = connectorPermissions[ticket.action];
  if (!permission || !Object.hasOwn(connectorPermissions, ticket.action) || !ticket.connectorId) fail(403, 'invalid_ticket', 'Invalid connector ticket.');
  const access = await sessionAccess(env, ticket.sessionId, ticket.actorId);
  if (!access || access.row.owner_id !== ticket.ownerId || access.row.connector_id !== ticket.connectorId ||
      access.row.policy_version !== ticket.policyVersion || !await mayRequestAction(env, access, ticket.actorId, ticket.action, permission)) {
    fail(403, 'permission_revoked', 'Session access is no longer authorized.');
  }
  if (access.row.status === 'archived' && ticket.action !== 'view' && ticket.action !== 'events') fail(409, 'session_archived', 'Session is archived.');
  if (['create', 'restart', 'restore', 'backup', 'fork'].includes(ticket.action) && ticket.actorId !== ticket.ownerId) fail(403, 'owner_required', 'Only the session owner can perform this operation.');
  await requireConnectorSession(env, ticket.connectorId, access.row, connectionHash);
  return access.row;
}

export async function validateConnectorRpc(envelope: ConnectorRelayEnvelope): Promise<void> {
  const request = envelope?.request;
  const ticket = request?.ticket;
  const now = Math.floor(Date.now() / 1000);
  if (!ticket || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.connectorId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.credentialHash) || !/^[A-Za-z0-9_-]{43}$/.test(envelope.connectionHash) ||
      request.type !== 'request' || typeof request.body !== 'string' || typeof request.id !== 'string' ||
      request.id !== ticket.jti || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id) || ticket.aud !== 'runner' ||
      ticket.connectorId !== envelope.connectorId || typeof ticket.actorId !== 'string' || ticket.actorId.length > 133 ||
      typeof ticket.ownerId !== 'string' || ticket.ownerId.length > 133 || !Number.isSafeInteger(ticket.policyVersion) ||
      !Number.isSafeInteger(ticket.iat) || !Number.isSafeInteger(ticket.exp) || ticket.iat > now + 5 ||
      ticket.exp <= now || ticket.exp - ticket.iat > 60 || ticket.exp <= ticket.iat ||
      !Object.hasOwn(connectorPermissions, ticket.action) || ticket.action === 'events') {
    fail(400, 'invalid_rpc', 'Invalid connector request.');
  }
  const parts = typeof request.path === 'string' ? request.path.split('/') : [];
  // An approval's id, or the revision a view request asks for changes since (/v1/sessions/<id>/view/<revision>).
  const suffix = ticket.action === 'approve' || (ticket.action === 'view' && parts.length === 6) ? parts.at(-1) ?? '' : '';
  if (request.path !== connectorPath(ticket.action, ticket.sessionId, suffix) ||
      request.method !== (ticket.action === 'view' ? 'GET' : 'POST') ||
      (request.method === 'GET' && request.body !== '') ||
      connectorUtf8Bytes(request.body) > connectorLimits.requestBytes ||
      await sha256(request.body) !== ticket.bodyHash) fail(400, 'invalid_rpc', 'Invalid connector request.');
}

/**
 * The connection a request goes to. A set `hash` must still be the current one or the request is refused, with
 * `replaced` set; either way `hash` ends up naming the connection the request went to.
 */
export interface ConnectionPin {
  hash?: string | null;
  replaced?: boolean;
}

export async function connectorRequest(c: AppContext, row: SessionRow, action: RunnerAction, suffix = '', body?: unknown,
  actorId: string = c.get('auth').userId, pin?: ConnectionPin): Promise<Response> {
  if (!row.connector_id || !c.env.CONNECTOR_HUB) fail(503, 'connector_unavailable', 'The connector transport is unavailable.');
  const serialized = body === undefined ? '' : JSON.stringify(body);
  if (typeof serialized !== 'string' || connectorUtf8Bytes(serialized) > connectorLimits.requestBytes) fail(413, 'body_too_large', 'The connector request is too large.');
  const issuedAt = Math.floor(Date.now() / 1000);
  const ticket: RunnerTicket = { aud: 'runner', sessionId: row.id, actorId,
    ownerId: row.owner_id, connectorId: row.connector_id, action, policyVersion: row.policy_version,
    iat: issuedAt, exp: issuedAt + 60, jti: id(), bodyHash: await sha256(serialized) };
  await authorizeConnectorTicket(c.env, ticket);
  const connection = await currentConnector(c.env, row.connector_id);
  if (!connection.connection_hash) fail(503, 'connector_offline', 'The connector is offline.');
  if (pin) {
    if (pin.hash !== undefined && pin.hash !== connection.connection_hash) {
      pin.replaced = true;
      fail(503, 'connector_replaced', 'The connector connection changed.');
    }
    pin.hash = connection.connection_hash;
  }
  const envelope: ConnectorRelayEnvelope = { connectorId: row.connector_id, credentialHash: connection.credential_hash,
    connectionHash: connection.connection_hash, request: { type: 'request', id: ticket.jti,
      method: action === 'view' || action === 'events' ? 'GET' : 'POST', path: connectorPath(action, row.id, suffix), body: serialized, ticket } };
  await validateConnectorRpc(envelope);
  let response: Response;
  try {
    // Never retry ambiguous effects, and do not tie admitted work to the browser's abort signal.
    response = await c.env.CONNECTOR_HUB.rpc(row.connector_id, envelope);
  } catch {
    fail(503, 'connector_unavailable', 'The connector is unavailable. An accepted operation may still be running; inspect the session before retrying.');
  }
  try {
    // A dropped or replaced connection must be reported as such, not as lost session authority.
    await requireConnectorGeneration(c.env, envelope.connectorId, envelope.credentialHash, envelope.connectionHash);
    await authorizeConnectorTicket(c.env, ticket, envelope.connectionHash);
    if (!response.ok) {
      const status = [400, 403, 404, 409, 413, 422, 429, 503, 504].includes(response.status) ? response.status : 502;
      // 422 carries a fixed, runner-authored reason (e.g. a repository limit); other runner text is not shown.
      const reason = response.status === 422 ? await runnerReason(response) : '';
      fail(status as 400 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503 | 504, 'runner_error',
        reason ? `The connector could not complete the operation: ${reason}` : 'The connector could not complete the operation. Inspect the session before retrying.');
    }
    return response;
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
}

/** Reads a runner 422 `{error}` message for display: one short line of plain words, or nothing. */
async function runnerReason(response: Response): Promise<string> {
  try {
    const parsed: unknown = JSON.parse((await response.clone().text()).slice(0, 2048));
    const message = parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : '';
    return /^[\w .,:'()-]{1,300}$/.test(message) ? message : '';
  } catch {
    return '';
  }
}

export function connectorError(error: unknown): Response {
  if (error instanceof HTTPException) return error.getResponse();
  return Response.json({ error: 'The connector is unavailable. Inspect the session before retrying.', code: 'connector_unavailable' }, { status: 503 });
}

// Size strings without allocating a second, potentially multi-megabyte UTF-8 buffer.
export function connectorUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

// Validate JSON syntax without constructing another object tree from an untrusted reply.
export function connectorJsonValid(text: string, maxDepth = 128, maxNodes = 1000000): boolean {
  let at = 0;
  let nodes = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function whitespace(): void {
    while (at < text.length && (text[at] === ' ' || text[at] === '\n' || text[at] === '\r' || text[at] === '\t')) at++;
  }
  function string(): boolean {
    if (text[at++] !== '"') return false;
    while (at < text.length) {
      const code = text.charCodeAt(at++);
      if (code === 34) return true;
      if (code < 32) return false;
      if (code !== 92) continue;
      const escape = text[at++];
      if (escape === 'u') {
        for (let i = 0; i < 4; i++) {
          const hex = text.charCodeAt(at++);
          if (!(hex >= 48 && hex <= 57) && !(hex >= 65 && hex <= 70) && !(hex >= 97 && hex <= 102)) return false;
        }
      } else if (!escape || !'"\\/bfnrt'.includes(escape)) return false;
    }
    return false;
  }
  function value(depth: number): boolean {
    if (depth > maxDepth || ++nodes > maxNodes) return false;
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      at++;
      const end = char === '{' ? '}' : ']';
      whitespace();
      if (text[at] === end) { at++; return true; }
      while (at < text.length) {
        if (char === '{') {
          if (!string()) return false;
          whitespace();
          if (text[at++] !== ':') return false;
        }
        if (!value(depth + 1)) return false;
        whitespace();
        if (text[at] === end) { at++; return true; }
        if (text[at++] !== ',') return false;
        whitespace();
      }
      return false;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) { at += literal.length; return true; }
    }
    number.lastIndex = at;
    if (!number.test(text)) return false;
    at = number.lastIndex;
    return true;
  }
  const valid = value(0);
  whitespace();
  return valid && at === text.length;
}
