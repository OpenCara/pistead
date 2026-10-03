import type { Hono, MiddlewareHandler } from 'hono';
import type { AuthorizationResult, Permission } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import type { AppContext, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, getUser, sessionAccess } from './db.js';
import { fail, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { parseOperation } from './operations.js';
import { decryptToken } from './vault.js';
import { authenticateConnector, requireConnectorSession } from './connectors.js';
import { legacyRestoreDownload } from './restore-routes.js';
import { requireBrokerReview } from './approval-reviews.js';
import { repositoryDownload } from './repositories.js';

const internalAuthentication: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  const configured = c.env.RUNNER_SHARED_SECRET;
  const authorization = c.req.header('authorization');
  if (!configured || configured.length < 32) fail(503, 'internal_unavailable', 'Internal authorization is not configured.');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 512 || !constantTimeEqual(authorization.slice(7), configured)) {
    fail(401, 'unauthorized', 'Internal authentication is required.');
  }
  await next();
};

export function registerInternal(app: Hono<WorkerEnv>): void {
  app.use('/api/internal/*', internalAuthentication);
  app.post('/api/internal/authorize', c => authorizeSession(c, null));
  app.post('/api/internal/github/comment', c => githubComment(c, null));
  app.post('/api/internal/restores/:restoreId/download', legacyRestoreDownload);
  app.post('/api/internal/repositories/:bindingId/download', c => repositoryDownload(c, null));
}

async function callbackScope(c: AppContext, row: SessionRow, connectorId: string | null): Promise<void> {
  if (connectorId) {
    const connector = await authenticateConnector(c);
    if (connector.id !== connectorId) fail(403, 'connector_binding_mismatch', 'Connector scope changed.');
    await requireConnectorSession(c.env, connectorId, row, connector.connection_hash!);
  } else if (row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped callback.');
}

export async function authorizeSession(c: AppContext, connectorId: string | null): Promise<Response> {
    const input = await jsonObject(c, 4096);
    const sessionId = identifier(input.sessionId, 'sessionId');
    const actorId = userIdentifier(input.actorId, 'actorId');
    const ownerId = userIdentifier(input.ownerId, 'ownerId');
    if (!permissions.includes(input.permission as Permission)) fail(400, 'invalid_permission', 'Invalid permission.');
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (access) await callbackScope(c, access.row, connectorId);
    const allowed = !!access && access.row.owner_id === ownerId && access.row.status !== 'archived' && hasPermission(access.permissions, input.permission as Permission);
    const result: AuthorizationResult = { allowed, policyVersion: access?.row.policy_version ?? 0, ownerId: access?.row.owner_id ?? '' };
    return c.json(result);
}

export async function githubComment(c: AppContext, connectorId: string | null): Promise<Response> {
    const input = await jsonObject(c);
    const sessionId = identifier(input.sessionId, 'sessionId');
    const actorId = userIdentifier(input.actorId, 'actorId');
    const approvalId = identifier(input.approvalId, 'approvalId');
    const capability = text(input.capability, 'capability', 128);
    const operation = parseOperation({ kind: 'github.comment', repository: input.repository, issue: input.issue, body: input.body });
    if (operation.kind !== 'github.comment') fail(400, 'invalid_operation', 'Only GitHub comments are supported.');
    const tokenHash = await sha256(capability);
    const stored = await c.env.DB.prepare(`SELECT session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, consumed_at
      FROM broker_capabilities WHERE token_hash = ?`).bind(tokenHash).first<{
        session_id: string; approval_id: string; actor_id: string; requested_by: string; operation_hash: string; expires_at: number; consumed_at: string | null;
      }>();
    if (!stored || stored.session_id !== sessionId || stored.approval_id !== approvalId || stored.actor_id !== actorId ||
        !constantTimeEqual(stored.operation_hash, await sha256(JSON.stringify(operation)))) {
      fail(403, 'invalid_capability', 'This operation does not match its approval capability.');
    }
    if (stored.consumed_at) fail(409, 'capability_consumed', 'This approved operation has already been attempted; do not retry the external effect.');
    if (stored.expires_at <= Math.floor(Date.now() / 1000)) fail(403, 'capability_expired', 'The approval capability has expired.');
    const [approver, writer] = await Promise.all([
      sessionAccess(c.env, sessionId, actorId), sessionAccess(c.env, sessionId, stored.requested_by),
    ]);
    if (!approver || !writer || approver.row.owner_id !== writer.row.owner_id || approver.row.policy_version !== writer.row.policy_version ||
        approver.row.status === 'archived' || !hasPermission(approver.permissions, 'approve') || !hasPermission(writer.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The operation requester or approver is no longer authorized.');
    }
    await callbackScope(c, approver.row, connectorId);
    await requireBrokerReview(c.env, approver.row, approvalId, stored.requested_by, operation);
    if (await c.env.DB.prepare("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(sessionId).first()) {
      fail(409, 'restore_pending', 'Session restoration is not complete.');
    }
    const owner = await getUser(c.env, approver.row.owner_id);
    if (!owner || owner.auth_kind !== 'github' || !owner.github_id) fail(409, 'github_not_connected', 'The session owner has no real GitHub connection.');
    const vault = await c.env.DB.prepare('SELECT ciphertext FROM github_tokens WHERE user_id = ?').bind(owner.id).first<{ ciphertext: string }>();
    if (!vault) fail(409, 'github_not_connected', 'The session owner has no GitHub connection.');
    const accessToken = await decryptToken(c.env, owner.id, vault.ciphertext);
    await callbackScope(c, approver.row, connectorId);
    // Consume before the network effect. A timeout is ambiguous, not permission to replay a comment.
    const consumed = await c.env.DB.prepare(`UPDATE broker_capabilities SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> ?)
      RETURNING token_hash`).bind(now(), tokenHash, Math.floor(Date.now() / 1000), sessionId, owner.id, approver.row.policy_version, 'archived').first();
    if (!consumed) fail(409, 'capability_consumed', 'This capability was consumed, expired, or revoked. Do not retry the external effect.');
    await auditStatement(c.env, actorId, 'github.comment.attempted', approver.row.workspace_id, sessionId, { approvalId, requestedBy: stored.requested_by, actingAs: owner.id }).run();
    // An audit write is an await boundary too: refresh both human and host authority before the effect.
    const [freshApprover, freshWriter] = await Promise.all([
      sessionAccess(c.env, sessionId, actorId), sessionAccess(c.env, sessionId, stored.requested_by),
    ]);
    if (!freshApprover || !freshWriter || freshApprover.row.status === 'archived' ||
        freshApprover.row.policy_version !== approver.row.policy_version ||
        freshWriter.row.policy_version !== approver.row.policy_version ||
        !hasPermission(freshApprover.permissions, 'approve') || !hasPermission(freshWriter.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Operation authority changed. The capability remains consumed.');
    }
    await callbackScope(c, freshApprover.row, connectorId);
    await requireBrokerReview(c.env, freshApprover.row, approvalId, stored.requested_by, operation);
    const [repositoryOwner, repositoryName] = operation.repository.split('/');
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/issues/${operation.issue}/comments`);
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), headers: {
        Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCara-Agent-Workspace',
      }, body: JSON.stringify({ body: operation.body }) });
    } catch {
      await auditStatement(c.env, actorId, 'github.comment.ambiguous', approver.row.workspace_id, sessionId, { approvalId }).run();
      fail(502, 'github_outcome_unknown', 'GitHub could not confirm the outcome. The capability remains consumed; inspect GitHub before making a new request.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      await auditStatement(c.env, actorId, 'github.comment.failed', approver.row.workspace_id, sessionId, { approvalId, status: response.status }).run();
      fail(502, 'github_rejected', 'GitHub rejected the approved comment. The capability cannot be reused.');
    }
    let result: unknown;
    try { result = await response.json(); } catch { fail(502, 'github_outcome_unknown', 'GitHub returned an unreadable result. Inspect GitHub before retrying.'); }
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'number' || !('html_url' in result) || typeof result.html_url !== 'string') {
      fail(502, 'github_outcome_unknown', 'GitHub returned an unexpected result. Inspect GitHub before retrying.');
    }
    let resultURL: URL;
    try { resultURL = new URL(result.html_url); } catch { fail(502, 'github_outcome_unknown', 'GitHub returned an unexpected result.'); }
    if (resultURL.protocol !== 'https:' || resultURL.hostname !== 'github.com') fail(502, 'github_outcome_unknown', 'GitHub returned an unexpected result.');
    await auditStatement(c.env, actorId, 'github.comment.completed', approver.row.workspace_id, sessionId, { approvalId, commentId: result.id, actingAs: owner.id }).run();
    // Never return the upstream body, headers, vault ciphertext, or plaintext credentials.
    return c.json({ id: result.id, url: resultURL.href });
}
