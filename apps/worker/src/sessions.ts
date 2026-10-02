import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ApprovalRecord, Permission, RunnerBinding, SessionView, SubmitResult } from '../../../packages/shared/src/types.js';
import { permissions } from '../../../packages/shared/src/types.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { hasPermission, normalizePermissions, validateUserEnv } from '../../../packages/shared/src/policy.js';
import type { AgentRow, AppContext, ModelRow, SessionRow, WorkerEnv } from './types.js';
import { agentVersion, auditStatement, getUser, modelDefinition, requireMember, requireSession, sessionAccess, sessionRecord, userProfile } from './db.js';
import { fail, id, identifier, jsonObject, now, randomToken, testMode, text, userIdentifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { parseOperation } from './operations.js';
import { requireConnectorSession } from './connectors.js';
import { presentApprovals, requireOperationTool, reviewedApproval } from './approval-reviews.js';
import { issueRunAdmission } from './run-admissions.js';

export async function bindingForSession(c: AppContext, row: SessionRow): Promise<RunnerBinding> {
  const [owner, agent] = await Promise.all([
    getUser(c.env, row.owner_id),
    c.env.DB.prepare('SELECT * FROM agent_versions WHERE id = ?').bind(row.agent_version_id).first<AgentRow>(),
  ]);
  if (!owner || !agent) fail(409, 'invalid_binding', 'Session binding is incomplete.');
  const model = await c.env.DB.prepare('SELECT * FROM models WHERE id = ? AND workspace_id = ?').bind(agent.model_id, row.workspace_id).first<ModelRow>();
  if (!model) fail(409, 'invalid_binding', 'The session model is not available.');
  if ((model.connector_id ?? null) !== (row.connector_id ?? null) || (model.connector_owner_id ?? null) !== (row.connector_owner_id ?? null)) {
    fail(409, 'invalid_binding', 'Session connector binding is inconsistent.');
  }
  if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
  if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are available only in the explicitly enabled test environment.');
  const profile = userProfile(owner);
  // Published definitions never contribute the author's identity or environment.
  profile.env = validateUserEnv(profile.env);
  return { session: sessionRecord(row), owner: profile, agent: agentVersion(agent), model: modelDefinition(model) };
}

function pollingEvents(c: AppContext, row: SessionRow): Response {
  const response = streamSSE(c, async stream => {
    let releaseStop!: () => void;
    const stopped = new Promise<undefined>(resolve => { releaseStop = () => resolve(undefined); });
    const abort = () => stream.abort();
    let cancelPause = () => {};
    stream.onAbort(releaseStop);
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    // Independent of fetch, D1, and write backpressure; never abort an underlying agent run.
    const deadline = setTimeout(abort, 8000);
    // Connected snapshots perform additional host/generation checks; keep the invocation below Free-plan D1 limits.
    const snapshots = row.connector_id ? 2 : 4;
    try {
      if (c.req.raw.signal.aborted) abort();
      for (let snapshot = 0; snapshot < snapshots && !stream.aborted; snapshot++) {
        const result = await Promise.race([
          runnerRequest(c, row, 'view').then(response => runnerJSON<{ view: SessionView }>(response)),
          stopped,
        ]);
        if (!result || stream.aborted) break;
        if (result.view?.sessionId !== row.id || result.view.owner?.id !== row.owner_id) {
          abort();
          break;
        }
        result.view.approvals = await presentApprovals(c, row, result.view.approvals);
        // Never emit a snapshot fetched before a grant was revoked without a fresh policy check.
        const access = await Promise.race([requireSession(c, row.id, 'read'), stopped]);
        if (!access || stream.aborted) break;
        if (access.row.connector_id) await requireConnectorSession(c.env, access.row.connector_id, access.row);
        if (stream.aborted) break;
        await Promise.race([stream.writeSSE({ event: 'view', data: JSON.stringify(result) }), stopped]);
        if (snapshot < snapshots - 1 && !stream.aborted) {
          await Promise.race([new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 1000);
            cancelPause = () => clearTimeout(timer);
          }), stopped]);
        }
      }
      await Promise.race([stream.close(), stopped]);
    } catch {
      // Policy and upstream failures close the stream without leaking an error or stale payload.
      abort();
    } finally {
      clearTimeout(deadline);
      cancelPause();
      c.req.raw.signal.removeEventListener('abort', abort);
    }
  });
  response.headers.set('Cache-Control', 'private, no-store, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
}

export function registerSessions(app: Hono<WorkerEnv>): void {
  app.get('/api/sessions', async c => {
    const actorId = c.get('auth').userId;
    const result = await c.env.DB.prepare(`SELECT DISTINCT s.id FROM sessions s
      INNER JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = ?
      LEFT JOIN session_grants g ON g.session_id = s.id AND g.user_id = ?
      WHERE s.owner_id = ? OR g.user_id IS NOT NULL ORDER BY s.created_at DESC LIMIT 500`)
      .bind(actorId, actorId, actorId).all<{ id: string }>();
    const sessions = [];
    for (const row of result.results) {
      const access = await sessionAccess(c.env, row.id, actorId);
      if (access && hasPermission(access.permissions, 'read')) sessions.push(sessionRecord(access.row, access.permissions));
    }
    return c.json({ sessions });
  });

  app.post('/api/sessions', async c => {
    const input = await jsonObject(c);
    if ('ownerId' in input || 'permissions' in input || 'githubId' in input) fail(400, 'server_owned_identity', 'Session identity and permissions are assigned by the server.');
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    const versionId = identifier(input.agentVersionId, 'agentVersionId');
    const title = text(input.title ?? 'Untitled session', 'title', 200);
    const ownerId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, ownerId);
    const agent = await c.env.DB.prepare('SELECT * FROM agent_versions WHERE id = ? AND (author_id = ? OR workspace_id = ?)')
      .bind(versionId, ownerId, workspaceId).first<AgentRow>();
    if (!agent || (agent.workspace_id !== null && agent.workspace_id !== workspaceId)) fail(404, 'not_found', 'Agent version not found in this workspace.');
    const model = await c.env.DB.prepare('SELECT * FROM models WHERE id = ? AND workspace_id = ?').bind(agent.model_id, workspaceId).first<ModelRow>();
    if (!model) fail(400, 'model_workspace_mismatch', 'The agent model must belong to the session workspace.');
    if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
    if (!model.connector_id && !testMode(c.env)) fail(400, 'connector_required', 'New sessions require a connected model.');
    if (model.connector_id && model.connector_owner_id !== ownerId && input.trustedConnectorId !== model.connector_id) {
      fail(400, 'connector_trust_required', 'Explicitly acknowledge that this host can access this session before continuing.');
    }
    const row: SessionRow = { id: id(), workspace_id: workspaceId, owner_id: ownerId, agent_version_id: versionId,
      title, policy_version: 1, status: 'provisioning', created_at: now(),
      connector_id: model.connector_id ?? null, connector_owner_id: model.connector_owner_id ?? null };
    if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.workspace_id, row.owner_id, row.agent_version_id, row.title, row.policy_version, row.status, row.created_at, row.connector_id ?? null, row.connector_owner_id ?? null),
      auditStatement(c.env, ownerId, 'session.created', workspaceId, row.id, { agentVersionId: versionId }),
    ]);
    try {
      const binding = await bindingForSession(c, row);
      const response = await runnerRequest(c, row, 'create', '', binding);
      await response.body?.cancel();
      await c.env.DB.prepare('UPDATE sessions SET status = ? WHERE id = ?').bind('ready', row.id).run();
      row.status = 'ready';
    } catch (error) {
      await c.env.DB.prepare('UPDATE sessions SET status = ? WHERE id = ?').bind('error', row.id).run();
      await auditStatement(c.env, ownerId, 'session.provision_failed', workspaceId, row.id).run();
      throw error;
    }
    return c.json({ session: sessionRecord(row, [...permissions]) }, 201);
  });

  app.get('/api/sessions/:id', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'read');
    return c.json({ session: sessionRecord(access.row, access.permissions) });
  });
  app.get('/api/sessions/:id/view', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const result = await runnerJSON<{ view: SessionView }>(await runnerRequest(c, row, 'view'));
    if (!result?.view || result.view.sessionId !== row.id || result.view.owner?.id !== row.owner_id) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session binding.');
    result.view.approvals = await presentApprovals(c, row, result.view.approvals);
    const fresh = await requireSession(c, row.id, 'read');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    return c.json(result);
  });
  app.get('/api/sessions/:id/events', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    // Review commitments must be persisted before any approval reaches a browser, including legacy sessions.
    return pollingEvents(c, row);
  });

  for (const mode of ['submit', 'ask'] as const) {
    app.post(`/api/sessions/:id/${mode}`, async c => {
      const { row } = await requireSession(c, identifier(c.req.param('id')), mode === 'ask' ? 'ask' : 'write');
      const input = await jsonObject(c);
      if ('admissionId' in input) fail(400, 'server_owned_admission', 'Write admissions are assigned by the server.');
      const content = text(input.content, 'content', 60000);
      const requestId = text(input.requestId, 'requestId', 128);
      const admissionId = mode === 'submit' ? await issueRunAdmission(c, row, content, requestId) : undefined;
      const result = await runnerJSON<SubmitResult>(await runnerRequest(c, row, mode, '', { content, requestId, ...(admissionId ? { admissionId } : {}) }));
      if (typeof result?.submissionId !== 'string' || typeof result.conversationId !== 'string' || typeof result.status !== 'string') fail(502, 'invalid_runner_response', 'The runner returned an invalid submission.');
      await auditStatement(c.env, c.get('auth').userId, `session.${mode}`, row.workspace_id, row.id, { submissionId: result.submissionId }).run();
      return c.json(result, 202);
    });
  }

  app.post('/api/sessions/:id/operations', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const operation = parseOperation(await jsonObject(c));
    await requireOperationTool(c.env, row, operation);
    const result = await runnerJSON<{ approval: ApprovalRecord }>(await runnerRequest(c, row, 'operations', '', { operation }));
    if (!result?.approval || result.approval.sessionId !== row.id || result.approval.requestedBy !== c.get('auth').userId) fail(502, 'invalid_runner_response', 'The runner returned an invalid approval request.');
    [result.approval] = await presentApprovals(c, row, [result.approval], { operation, requestedBy: c.get('auth').userId });
    await auditStatement(c.env, c.get('auth').userId, 'approval.requested', row.workspace_id, row.id, { approvalId: result.approval.id, kind: operation.kind }).run();
    const fresh = await requireSession(c, row.id, 'write');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    return c.json(result, 201);
  });

  app.post('/api/sessions/:id/approvals/:approvalId', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'approve');
    const approvalId = identifier(c.req.param('approvalId'), 'approvalId');
    const input = await jsonObject(c);
    if (input.decision !== 'approve' && input.decision !== 'deny') fail(400, 'invalid_decision', 'Expected approve or deny.');
    // The browser echoes its displayed commitment. A later runtime view can only confirm it, never replace it.
    const review = await reviewedApproval(c, row, approvalId, input.reviewHash);
    const result = await runnerJSON<{ view: SessionView }>(await runnerRequest(c, row, 'view'));
    if (!result?.view || result.view.sessionId !== row.id || result.view.owner?.id !== row.owner_id || !Array.isArray(result.view.approvals)) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session view.');
    const candidate = result.view.approvals.find(item => item.id === approvalId && item.sessionId === row.id);
    const approval = candidate ? (await presentApprovals(c, row, [candidate]))[0] : undefined;
    if (!approval) fail(404, 'not_found', 'Approval request not found.');
    if (approval.status !== 'pending') fail(409, 'approval_already_decided', 'This approval request is no longer pending.');
    const operation = review.operation;
    let brokerCapability: string | undefined;
    if (input.decision === 'approve') {
      const writer = await sessionAccess(c.env, row.id, review.requested_by);
      if (!writer || !hasPermission(writer.permissions, 'write')) fail(403, 'requester_revoked', 'The operation requester no longer has write permission.');
      await reviewedApproval(c, row, approvalId, input.reviewHash);
      const fresh = await requireSession(c, row.id, 'approve');
      if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
      if (operation.kind === 'github.comment') {
        const existing = await c.env.DB.prepare('SELECT token_hash FROM broker_capabilities WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first();
        if (existing) fail(409, 'approval_attempt_exists', 'This operation already has an approval attempt. Inspect its outcome before creating a new request.');
        brokerCapability = randomToken();
        await c.env.DB.prepare(`INSERT INTO broker_capabilities (token_hash, session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(await sha256(brokerCapability), row.id, approvalId, c.get('auth').userId,
          review.requested_by, await sha256(JSON.stringify(operation)), Math.floor(Date.now() / 1000) + 90, now()).run();
      }
    }
    const decided = await runnerJSON<{ approval: ApprovalRecord }>(await runnerRequest(c, row, 'approve', approvalId, {
      approvalId, decision: input.decision, operation, ...(brokerCapability ? { brokerCapability } : {}),
    }));
    if (!decided?.approval || decided.approval.id !== approvalId || decided.approval.sessionId !== row.id) fail(502, 'invalid_runner_response', 'The runner returned an invalid approval result.');
    [decided.approval] = await presentApprovals(c, row, [decided.approval]);
    await auditStatement(c.env, c.get('auth').userId, `approval.${input.decision}`, row.workspace_id, row.id, { approvalId, kind: operation.kind, status: decided.approval.status }).run();
    return c.json(decided);
  });

  app.get('/api/sessions/:id/grants', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const result = await c.env.DB.prepare(`SELECT g.user_id, g.permissions_json FROM session_grants g
      INNER JOIN workspace_members m ON m.workspace_id = ? AND m.user_id = g.user_id WHERE g.session_id = ?`)
      .bind(row.workspace_id, row.id).all<{ user_id: string; permissions_json: string }>();
    return c.json({ grants: [{ userId: row.owner_id, permissions: [...permissions] }, ...result.results.filter(g => g.user_id !== row.owner_id)
      .map(g => ({ userId: g.user_id, permissions: normalizePermissions(JSON.parse(g.permissions_json)) }))] });
  });
  app.post('/api/sessions/:id/grants', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const { row } = access;
    const input = await jsonObject(c);
    const userId = userIdentifier(input.userId);
    if (userId === row.owner_id) fail(400, 'owner_grant_immutable', 'The session owner always retains full authority.');
    await requireMember(c.env, row.workspace_id, userId);
    let grants: Permission[];
    try { grants = normalizePermissions(input.permissions); } catch { fail(400, 'invalid_permissions', 'Invalid permissions.'); }
    if (!grants.length) fail(400, 'empty_grant', 'Use DELETE to revoke a grant.');
    if (grants.some(permission => !hasPermission(access.permissions, permission))) fail(403, 'grant_escalation', 'You cannot grant permissions you do not hold.');
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO session_grants (session_id, user_id, permissions_json, created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)
          AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET permissions_json = excluded.permissions_json`)
        .bind(row.id, userId, JSON.stringify(grants), now(), row.id, row.policy_version, row.workspace_id, userId),
      c.env.DB.prepare('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ? AND policy_version = ?').bind(row.id, row.policy_version),
      auditStatement(c.env, c.get('auth').userId, 'grant.updated', row.workspace_id, row.id, { userId, permissions: grants }),
    ]);
    if (!result[0].meta.changes) fail(409, 'policy_changed', 'Session membership or permissions changed; reload and retry.');
    return c.json({ grant: { userId, permissions: grants } });
  });
  app.delete('/api/sessions/:id/grants/:userId', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const userId = userIdentifier(c.req.param('userId'));
    if (userId === row.owner_id) fail(400, 'owner_grant_immutable', 'The session owner cannot be revoked.');
    const results = await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM session_grants WHERE session_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)')
        .bind(row.id, userId, row.id, row.policy_version),
      c.env.DB.prepare('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ? AND policy_version = ?').bind(row.id, row.policy_version),
      auditStatement(c.env, c.get('auth').userId, 'grant.revoked', row.workspace_id, row.id, { userId }),
    ]);
    if (!results[1].meta.changes) fail(409, 'policy_changed', 'Session permissions changed; reload and retry.');
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/restart', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can restart it.');
    const result = row.status === 'error' || row.status === 'provisioning'
      ? await runnerRequest(c, row, 'create', '', await bindingForSession(c, row))
      : await runnerRequest(c, row, 'restart', '', {});
    await result.body?.cancel();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE sessions SET status = ? WHERE id = ?').bind('ready', row.id),
      auditStatement(c.env, c.get('auth').userId, 'session.restarted', row.workspace_id, row.id),
    ]);
    return c.json({ ok: true, sessionId: row.id });
  });

  app.get('/api/sessions/:id/audit', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const rows = await c.env.DB.prepare('SELECT id, actor_id, action, detail_json, created_at FROM audit WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
      .bind(row.id).all<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>();
    return c.json({ events: rows.results.map(event => ({ id: event.id, actorId: event.actor_id, action: event.action, detail: JSON.parse(event.detail_json), createdAt: event.created_at })) });
  });
}
