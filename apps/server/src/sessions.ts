import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ApprovalRecord, ChatOptions, Permission, RunnerBinding, SessionView, SubmitResult } from '../../../packages/shared/src/types.js';
import { accessModes, permissions, thinkingLevels } from '../../../packages/shared/src/types.js';
import type { ConnectorCapabilities, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { hasPermission, normalizePermissions, validateUserEnv } from '../../../packages/shared/src/policy.js';
import type { AgentRow, AppContext, ModelRow, SessionRow, WorkerEnv } from './types.js';
import { agentVersion, auditStatement, getUser, listSessionAccess, modelDefinition, requireMember, requireSession, runnerSessionRecord, sessionAccess, sessionRecord, userProfile } from './db.js';
import { fail, id, identifier, jsonObject, now, randomToken, testMode, text, userIdentifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { parseOperation } from './operations.js';
import { requireConnectorSession } from './connectors.js';
import { presentApprovals, requireOperationTool, reviewedApproval } from './approval-reviews.js';
import { issueRunAdmission } from './run-admissions.js';
import { legacyRepositoryFixture, resolveWorkspaceRepositories } from './repositories.js';
import { chatAgentVersion, requireModel } from './catalog.js';

/**
 * Per-message model, reasoning and access. The model must be one the session's own host advertises; auto-approve is the
 * owner's alone. The runner re-checks all of it, but only the Worker can say whether the host understands options at all.
 */
async function chatOptions(c: AppContext, row: SessionRow, mode: 'submit' | 'ask', value: unknown): Promise<ChatOptions | undefined> {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_options', 'Invalid chat options.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['model', 'thinkingLevel', 'access'].includes(key))) fail(400, 'invalid_options', 'Invalid chat options.');
  if (!Object.keys(input).length) return undefined;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot change model, reasoning or access.');
  const host = await c.env.DB.query<{ models_json: string; capabilities_json: string }>('SELECT models_json, capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(row.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if ((JSON.parse(host.capabilities_json) as ConnectorCapabilities).chatOptions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pistead@latest connect) to choose model, reasoning or access.');
  }
  const options: ChatOptions = {};
  if (input.model !== undefined) {
    const model = input.model as Record<string, unknown>;
    if (!model || typeof model !== 'object' || Array.isArray(model) || Object.keys(model).some(key => key !== 'provider' && key !== 'modelId')) fail(400, 'invalid_options', 'Invalid model choice.');
    const provider = text(model.provider, 'provider', 80);
    const modelId = text(model.modelId, 'modelId', 200);
    const advertised = (JSON.parse(host.models_json) as LocalModelSummary[]).find(item => item.provider === provider && item.modelId === modelId);
    if (!advertised) fail(403, 'model_not_on_host', 'Only models offered by this session\'s host can be chosen.');
    if (input.thinkingLevel !== undefined && advertised.thinkingLevels && !advertised.thinkingLevels.includes(input.thinkingLevel as never)) {
      fail(400, 'invalid_options', 'The model does not support this reasoning level.');
    }
    options.model = { provider, modelId };
  }
  if (input.thinkingLevel !== undefined) {
    if (!thinkingLevels.includes(input.thinkingLevel as never)) fail(400, 'invalid_options', 'Invalid reasoning level.');
    options.thinkingLevel = input.thinkingLevel as ChatOptions['thinkingLevel'];
  }
  if (input.access !== undefined) {
    if (mode !== 'submit' || !accessModes.includes(input.access as never)) fail(400, 'invalid_options', 'Side asks are always read-only.');
    if (input.access === 'auto' && c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can auto-approve commands.');
    options.access = input.access as ChatOptions['access'];
  }
  return options;
}

export async function bindingForSession(c: AppContext, row: SessionRow): Promise<RunnerBinding> {
  const [owner, agent] = await Promise.all([
    getUser(c.env, row.owner_id),
    c.env.DB.query<AgentRow>('SELECT * FROM agent_versions WHERE id = ?').bind(row.agent_version_id).first(),
  ]);
  if (!owner || !agent) fail(409, 'invalid_binding', 'Session binding is incomplete.');
  const model = await c.env.DB.query<ModelRow>('SELECT * FROM models WHERE id = ? AND workspace_id = ?').bind(agent.model_id, row.workspace_id).first();
  if (!model) fail(409, 'invalid_binding', 'The session model is not available.');
  if ((model.connector_id ?? null) !== (row.connector_id ?? null) || (model.connector_owner_id ?? null) !== (row.connector_owner_id ?? null)) {
    fail(409, 'invalid_binding', 'Session connector binding is inconsistent.');
  }
  if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
  if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are available only in the explicitly enabled test environment.');
  const profile = userProfile(owner);
  // Published definitions never contribute the author's identity or environment.
  profile.env = validateUserEnv(profile.env);
  return { session: runnerSessionRecord(row), owner: profile, agent: agentVersion(agent), model: modelDefinition(model) };
}

function sessionVisibility(value: unknown): 'private' | 'workspace' {
  if (value !== 'private' && value !== 'workspace') fail(400, 'invalid_visibility', 'Visibility must be private or workspace.');
  return value;
}

function pollingEvents(c: AppContext, row: SessionRow): Response {
  const response = streamSSE(c, async stream => {
    let releaseStop!: () => void;
    const stopped = new Promise<undefined>(resolve => { releaseStop = () => resolve(undefined); });
    const abort = () => stream.abort();
    let cancelPause = () => {};
    stream.onAbort(releaseStop);
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    // Independent of fetch, database, and write backpressure; never abort an underlying agent run.
    const deadline = setTimeout(abort, 8000);
    // Connected snapshots perform additional host/generation checks; keep the invocation cheap.
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
    const sessions = (await listSessionAccess(c.env, actorId))
      .map(access => sessionRecord(access.row, access.permissions));
    return c.json({ sessions });
  });

  app.post('/api/sessions', async c => {
    const input = await jsonObject(c);
    if (['ownerId', 'permissions', 'githubId', 'repositories', 'repositories_json', 'pins'].some(key => key in input)) fail(400, 'server_owned_identity', 'Session identity, repository pins, and permissions are assigned by the server.');
    const workspaceId = identifier(input.workspaceId, 'workspaceId');
    // A session runs a chosen agent version, or starts from a model with a chat agent of its own.
    if ((input.agentVersionId === undefined) === (input.modelId === undefined)) fail(400, 'invalid_input', 'Choose either an agent version or a model.');
    const title = text(input.title ?? 'Untitled session', 'title', 200);
    const visibility = sessionVisibility(input.visibility === undefined ? 'workspace' : input.visibility);
    const ownerId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, ownerId);
    let agent: AgentRow | null = null;
    let model: ModelRow | null;
    if (input.agentVersionId !== undefined) {
      agent = await c.env.DB.query<AgentRow>('SELECT * FROM agent_versions WHERE id = ? AND (author_id = ? OR workspace_id = ?)')
        .bind(identifier(input.agentVersionId, 'agentVersionId'), ownerId, workspaceId).first();
      if (!agent || (agent.workspace_id !== null && agent.workspace_id !== workspaceId)) fail(404, 'not_found', 'Agent version not found in this workspace.');
      model = await c.env.DB.query<ModelRow>('SELECT * FROM models WHERE id = ? AND workspace_id = ?').bind(agent.model_id, workspaceId).first();
      if (!model) fail(400, 'model_workspace_mismatch', 'The agent model must belong to the session workspace.');
    } else {
      // The same live check as choosing an agent's model: the owner's own host here, or a host shared here.
      model = await requireModel(c.env, identifier(input.modelId, 'modelId'), ownerId);
      if (model.workspace_id !== workspaceId) fail(404, 'not_found', 'Model not found.');
    }
    if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
    const syntheticLegacy = model.provider === 'faux' && await legacyRepositoryFixture(c.env, ownerId);
    if (!model.connector_id && !syntheticLegacy) fail(400, 'connector_required', 'New sessions require a connected model.');
    if (model.connector_id && model.connector_owner_id !== ownerId && input.trustedConnectorId !== model.connector_id) {
      fail(400, 'connector_trust_required', 'Explicitly acknowledge that this host can access this session before continuing.');
    }
    const session = { id: id(), workspace_id: workspaceId, owner_id: ownerId, title, visibility, policy_version: 1, status: 'provisioning' as const,
      created_at: now(), connector_id: model.connector_id ?? null, connector_owner_id: model.connector_owner_id ?? null };
    if (agent && session.connector_id) await requireConnectorSession(c.env, session.connector_id, { ...session, agent_version_id: agent.id });
    // Older connectors only understand GitHub pins; refuse before contacting any provider.
    const host = session.connector_id
      ? await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(session.connector_id).first()
      : null;
    const capabilities = JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities;
    const gitProviders = !session.connector_id || capabilities.gitProviders === true;
    // Older connectors cannot carry approved pushes; refuse agents that would offer git_push.
    if (agent && session.connector_id && (JSON.parse(agent.tools_json) as unknown[]).includes('git_push') && capabilities.gitPush !== true) {
      fail(409, 'connector_update_required', 'Update the host\'s connector (npx pistead@latest connect) to use git_push.');
    }
    const resolved = await resolveWorkspaceRepositories(c.env, workspaceId, ownerId, { gitProviders });
    // Created only once the start is otherwise admissible, so a refused start leaves no chat agent behind.
    agent ??= await chatAgentVersion(c.env, ownerId, model, capabilities.gitPush === true);
    const row: SessionRow & { repositories_json: string } = { ...session, agent_version_id: agent.id, repositories_json: JSON.stringify(resolved.repositories) };
    const gitPush = row.connector_id && (JSON.parse(agent.tools_json) as unknown[]).includes('git_push') ? 1 : 0;
    const providerPins = resolved.repositories.some(repository => 'provider' in repository) ? 1 : 0;
    await requireMember(c.env, workspaceId, ownerId);
    if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
    // Admit pins only while every exact owner credential used to resolve them is still current.
    const inserted = await c.env.DB.query(`INSERT INTO sessions
      (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id, repositories_json, visibility)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
      AND (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories WHERE workspace_id = ?) = json(?)
      AND EXISTS (SELECT 1 FROM users session_owner WHERE session_owner.id = ?
        AND ((? = 1 AND session_owner.auth_kind = 'github') OR (? = 1 AND session_owner.auth_kind = 'test'))
        AND (? IS NULL OR (session_owner.auth_kind = 'github' AND session_owner.github_id = ?
          AND EXISTS (SELECT 1 FROM github_tokens WHERE user_id = session_owner.id AND ciphertext = ?))))
      AND (SELECT COUNT(*) FROM json_each(?) used JOIN git_credentials credential
        ON credential.id = json_extract(used.value, '$.id') AND credential.ciphertext = json_extract(used.value, '$.ciphertext')
        AND credential.user_id = ?) = ?
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM connectors host JOIN connector_workspaces association ON association.connector_id = host.id
        JOIN workspace_members member ON member.workspace_id = association.workspace_id AND member.user_id = host.owner_id
        JOIN users host_user ON host_user.id = host.owner_id
        JOIN models m ON m.id = ?
        WHERE host.id = ? AND host.owner_id = ? AND host.revoked_at IS NULL AND association.workspace_id = ?
          AND (host.owner_id = ? OR EXISTS (SELECT 1 FROM connector_shares share
            WHERE share.connector_id = host.id AND share.workspace_id = association.workspace_id))
          AND m.available = 1 AND m.connector_id = host.id AND m.connector_owner_id = host.owner_id
          AND (? = 1 OR (host_user.auth_kind <> 'test' AND m.provider <> 'faux'))
          AND (? = 0 OR json_type(host.capabilities_json, '$.gitProviders') = 'true')
          AND (? = 0 OR json_type(host.capabilities_json, '$.gitPush') = 'true')
          AND EXISTS (SELECT 1 FROM json_each(host.models_json) local
            WHERE json_extract(local.value, '$.provider') = m.provider AND json_extract(local.value, '$.modelId') = m.model_id)
      )) RETURNING id`)
      .bind(row.id, row.workspace_id, row.owner_id, row.agent_version_id, row.title, row.policy_version, row.status, row.created_at,
        row.connector_id ?? null, row.connector_owner_id ?? null, row.repositories_json, row.visibility ?? 'private',
        workspaceId, ownerId, workspaceId, resolved.bindingIds,
        // Real owners need pinned repositories; legacy empty sessions are synthetic test-mode fixtures only.
        ownerId, resolved.repositories.length ? 1 : 0, resolved.githubAuthority === null && testMode(c.env) ? 1 : 0,
        resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.ciphertext ?? null,
        JSON.stringify(resolved.credentials), ownerId, resolved.credentials.length,
        row.connector_id ?? null, model.id, row.connector_id ?? null, row.connector_owner_id ?? null, workspaceId, ownerId,
        testMode(c.env) ? 1 : 0, providerPins, gitPush).first();
    if (!inserted) fail(409, 'session_configuration_changed', 'Workspace repositories, Git account access, membership, or connector authority changed. Try again.');
    await auditStatement(c.env, ownerId, 'session.created', workspaceId, row.id, { agentVersionId: agent.id }).run();
    try {
      const binding = await bindingForSession(c, row);
      const response = await runnerRequest(c, row, 'create', '', binding);
      await response.body?.cancel();
      await c.env.DB.query('UPDATE sessions SET status = ? WHERE id = ?').bind('ready', row.id).run();
      row.status = 'ready';
    } catch (error) {
      await c.env.DB.query('UPDATE sessions SET status = ? WHERE id = ?').bind('error', row.id).run();
      await auditStatement(c.env, ownerId, 'session.provision_failed', workspaceId, row.id).run();
      throw error;
    }
    return c.json({ session: sessionRecord(row, [...permissions]) }, 201);
  });

  app.get('/api/sessions/:id', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'read');
    // Readers who cannot see a private host in the catalog still learn that it runs without isolation.
    const host = access.row.connector_id
      ? await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(access.row.connector_id).first()
      : null;
    const capabilities: unknown = host ? JSON.parse(host.capabilities_json) : null;
    const hostUnsandboxed = typeof capabilities === 'object' && capabilities !== null && 'unsandboxed' in capabilities && capabilities.unsandboxed === true;
    return c.json({ session: { ...sessionRecord(access.row, access.permissions), ...(hostUnsandboxed ? { hostUnsandboxed } : {}) } });
  });
  app.patch('/api/sessions/:id', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const ownerId = c.get('auth').userId;
    if (row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can change its visibility.');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => key !== 'visibility')) fail(400, 'invalid_input', 'Only session visibility can be changed.');
    const visibility = sessionVisibility(input.visibility);
    const updated = await c.env.DB.query<SessionRow>(`UPDATE sessions SET visibility = ?, policy_version = policy_version + 1
      WHERE id = ? AND owner_id = ? AND policy_version = ?
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = sessions.workspace_id AND user_id = ?)
        AND EXISTS (SELECT 1 FROM users owner JOIN agent_versions a ON a.id = sessions.agent_version_id
          JOIN models m ON m.id = a.model_id WHERE owner.id = sessions.owner_id
            AND (? = 1 OR (owner.auth_kind <> 'test' AND m.provider <> 'faux')))
      RETURNING *`).bind(visibility, row.id, ownerId, row.policy_version, ownerId, testMode(c.env) ? 1 : 0).first();
    if (!updated) fail(409, 'policy_changed', 'Session membership or permissions changed; reload and retry.');
    await auditStatement(c.env, ownerId, 'session.visibility.updated', row.workspace_id, row.id, { visibility }).run();
    return c.json({ session: sessionRecord(updated, [...permissions]) });
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
      const options = await chatOptions(c, row, mode, input.options);
      const admissionId = mode === 'submit' ? await issueRunAdmission(c, row, content, requestId, options?.access) : undefined;
      const result = await runnerJSON<SubmitResult>(await runnerRequest(c, row, mode, '', { content, requestId, ...(admissionId ? { admissionId } : {}), ...(options ? { options } : {}) }));
      if (typeof result?.submissionId !== 'string' || typeof result.conversationId !== 'string' || typeof result.status !== 'string') fail(502, 'invalid_runner_response', 'The runner returned an invalid submission.');
      await auditStatement(c.env, c.get('auth').userId, `session.${mode}`, row.workspace_id, row.id, { submissionId: result.submissionId, ...(options ? { options } : {}) }).run();
      return c.json(result, 202);
    });
  }

  app.post('/api/sessions/:id/operations', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const operation = parseOperation(await jsonObject(c));
    if (operation.kind === 'permission') fail(400, 'invalid_operation', 'Permission requests come only from tool calls.');
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
    if (input.scope !== undefined && input.scope !== 'call' && input.scope !== 'session') fail(400, 'invalid_decision', 'Expected the call or session scope.');
    // The browser echoes its displayed commitment. A later runtime view can only confirm it, never replace it.
    const review = await reviewedApproval(c, row, approvalId, input.reviewHash);
    const result = await runnerJSON<{ view: SessionView }>(await runnerRequest(c, row, 'view'));
    if (!result?.view || result.view.sessionId !== row.id || result.view.owner?.id !== row.owner_id || !Array.isArray(result.view.approvals)) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session view.');
    const candidate = result.view.approvals.find(item => item.id === approvalId && item.sessionId === row.id);
    const approval = candidate ? (await presentApprovals(c, row, [candidate]))[0] : undefined;
    if (!approval) fail(404, 'not_found', 'Approval request not found.');
    if (approval.status !== 'pending') fail(409, 'approval_already_decided', 'This approval request is no longer pending.');
    const operation = review.operation;
    // A permission request lets a tool call do more than the session allows, so only its owner decides it.
    if (operation.kind === 'permission') {
      if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can allow more than the session allows.');
      if (operation.needs.includes('unbounded-shell') && row.connector_owner_id !== row.owner_id) {
        fail(403, 'host_owner_required', 'Only the host\'s owner can allow a shell without resource limits.');
      }
    } else if (input.scope !== undefined) fail(400, 'invalid_decision', 'Only permission requests take a scope.');
    const scope = operation.kind === 'permission' ? (input.scope === 'session' ? 'session' : 'call') : undefined;
    let brokerCapability: string | undefined;
    if (input.decision === 'approve') {
      const writer = await sessionAccess(c.env, row.id, review.requested_by);
      if (!writer || !hasPermission(writer.permissions, 'write')) fail(403, 'requester_revoked', 'The operation requester no longer has write permission.');
      await reviewedApproval(c, row, approvalId, input.reviewHash);
      const fresh = await requireSession(c, row.id, 'approve');
      if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
      if (operation.kind === 'github.comment' || operation.kind === 'git.push') {
        const existing = await c.env.DB.query('SELECT token_hash FROM broker_capabilities WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first();
        if (existing) fail(409, 'approval_attempt_exists', 'This operation already has an approval attempt. Inspect its outcome before creating a new request.');
        brokerCapability = randomToken();
        await c.env.DB.query(`INSERT INTO broker_capabilities (token_hash, session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(await sha256(brokerCapability), row.id, approvalId, c.get('auth').userId,
          review.requested_by, await sha256(JSON.stringify(operation)), Math.floor(Date.now() / 1000) + 90, now()).run();
      }
      // Tool grants live here as well as on the host, so a host can't present commands, pushes or comments for a tool
      // the owner never allowed. A one-call grant covers the command approval of that same tool call.
      if (operation.kind === 'permission' && operation.needs.includes('tool')) {
        await c.env.DB.query(`INSERT INTO session_tool_grants (session_id, tool, call_id, approval_id, granted_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, tool, call_id) DO NOTHING`)
          .bind(row.id, operation.tool, scope === 'session' ? '' : approvalId.replace(/^permission-/, ''), approvalId, c.get('auth').userId, now()).run();
      }
    }
    const decided = await runnerJSON<{ approval: ApprovalRecord }>(await runnerRequest(c, row, 'approve', approvalId, {
      approvalId, decision: input.decision, operation, ...(brokerCapability ? { brokerCapability } : {}), ...(scope ? { scope } : {}),
    }));
    if (!decided?.approval || decided.approval.id !== approvalId || decided.approval.sessionId !== row.id) fail(502, 'invalid_runner_response', 'The runner returned an invalid approval result.');
    [decided.approval] = await presentApprovals(c, row, [decided.approval]);
    await auditStatement(c.env, c.get('auth').userId, `approval.${input.decision}`, row.workspace_id, row.id, { approvalId, kind: operation.kind, status: decided.approval.status, ...(scope ? { scope } : {}) }).run();
    return c.json(decided);
  });

  app.get('/api/sessions/:id/grants', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const result = await c.env.DB.query<{ user_id: string; permissions_json: string }>(`SELECT g.user_id, g.permissions_json FROM session_grants g
      INNER JOIN workspace_members m ON m.workspace_id = ? AND m.user_id = g.user_id WHERE g.session_id = ?`)
      .bind(row.workspace_id, row.id).all();
    return c.json({ grants: [{ userId: row.owner_id, permissions: [...permissions] }, ...result.filter(g => g.user_id !== row.owner_id)
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
      c.env.DB.query(`INSERT INTO session_grants (session_id, user_id, permissions_json, created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)
          AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET permissions_json = excluded.permissions_json`)
        .bind(row.id, userId, JSON.stringify(grants), now(), row.id, row.policy_version, row.workspace_id, userId),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ? AND policy_version = ?').bind(row.id, row.policy_version),
      auditStatement(c.env, c.get('auth').userId, 'grant.updated', row.workspace_id, row.id, { userId, permissions: grants }),
    ]);
    if (!result[0].changes) fail(409, 'policy_changed', 'Session membership or permissions changed; reload and retry.');
    return c.json({ grant: { userId, permissions: grants } });
  });
  app.delete('/api/sessions/:id/grants/:userId', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const userId = userIdentifier(c.req.param('userId'));
    if (userId === row.owner_id) fail(400, 'owner_grant_immutable', 'The session owner cannot be revoked.');
    const results = await c.env.DB.batch([
      c.env.DB.query('DELETE FROM session_grants WHERE session_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND policy_version = ?)')
        .bind(row.id, userId, row.id, row.policy_version),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ? AND policy_version = ?').bind(row.id, row.policy_version),
      auditStatement(c.env, c.get('auth').userId, 'grant.revoked', row.workspace_id, row.id, { userId }),
    ]);
    if (!results[1].changes) fail(409, 'policy_changed', 'Session permissions changed; reload and retry.');
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
      c.env.DB.query('UPDATE sessions SET status = ? WHERE id = ?').bind('ready', row.id),
      auditStatement(c.env, c.get('auth').userId, 'session.restarted', row.workspace_id, row.id),
    ]);
    return c.json({ ok: true, sessionId: row.id });
  });

  app.get('/api/sessions/:id/audit', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const rows = await c.env.DB.query<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>('SELECT id, actor_id, action, detail_json, created_at FROM audit WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
      .bind(row.id).all();
    return c.json({ events: rows.map(event => ({ id: event.id, actorId: event.actor_id, action: event.action, detail: JSON.parse(event.detail_json), createdAt: event.created_at })) });
  });
}
