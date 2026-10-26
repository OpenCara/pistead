import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ApprovalRecord, ChatOptions, Permission, RunnerBinding, SessionRole, SessionView, SubmitResult, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { accessModes, permissions, sessionRoles, thinkingLevels } from '../../../packages/shared/src/types.js';
import { connectorLimits, type ConnectorCapabilities, type LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { parseChatImages, type ChatImage } from '../../../packages/shared/src/chat-images.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { isRevision } from '../../../packages/shared/src/view-patch.js';
import { hasPermission, normalizePermissions, roleSessionCeiling, sessionRoleOf, sessionRolePermissions, validateUserEnv } from '../../../packages/shared/src/policy.js';
import { redactApproval } from '../../../packages/shared/src/redaction.js';
import type { AgentRow, AppContext, ModelRow, SessionRow, WorkerEnv } from './types.js';
import { agentVersion, auditStatement, getUser, listSessionAccess, modelDefinition, requireMember, requireSession, requireSessionCreator, sessionCreatorSQL, requireUnfrozen, runnerSessionRecord, sessionAccess, sessionRecord, userProfile } from './db.js';
import { sessionBranchName } from '../../../packages/shared/src/git-push.js';
import { fail, id, identifier, jsonObject, now, randomToken, testMode, text, userIdentifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { connectorUtf8Bytes } from './connector-transport.js';
import { parseOperation } from './operations.js';
import { hostSessionsSupported, requireConnectorSession } from './connectors.js';
import { connectorHostConfig } from './host-config.js';
import { permissionCall, presentApprovals, requireOperationTool, reviewedApproval } from './approval-reviews.js';
import { issueRunAdmission } from './run-admissions.js';
import { cloneRepositories, legacyRepositoryFixture } from './repositories.js';
import { chatAgentVersion, requireModel } from './catalog.js';
import { isLinkShared } from './session-links.js';
import { mayDecideHostCommands } from './host-access.js';
import { disabledModelKeys, isModelDisabled, modelEnabledSQL, requireEnabledModel } from './host-models.js';
import { earlierEntries, invalidateSessionView, sessionView, transcriptDisplay, viewChanges } from './view-feed.js';
import { toolOutputs, transcriptPage, type ToolOutput } from '../../../packages/shared/src/transcript-display.js';

/**
 * Per-message model, reasoning and access. The model must be one the session's own host offers: one it advertises that its
 * owner or an admin didn't disable. Auto-approve is the owner's alone. The runner re-checks all of it except the disabled
 * models, which only the Worker knows, and only the Worker can say whether the host understands options at all.
 */
async function chatOptions(c: AppContext, row: SessionRow, mode: 'submit' | 'ask', value: unknown): Promise<ChatOptions | undefined> {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_options', 'Invalid chat options.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['model', 'thinkingLevel', 'access', 'autoMerge'].includes(key))) fail(400, 'invalid_options', 'Invalid chat options.');
  if (!Object.keys(input).length) return undefined;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot change model, reasoning or access.');
  const host = await c.env.DB.query<{ models_json: string; capabilities_json: string }>('SELECT models_json, capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(row.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  const capabilities = JSON.parse(host.capabilities_json) as ConnectorCapabilities;
  if (capabilities.chatOptions !== true) {
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
    if (isModelDisabled(await disabledModelKeys(c.env, row.connector_id), advertised)) {
      fail(403, 'model_disabled', `${advertised.name} is disabled on this session's host. Choose another model.`);
    }
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
  // Auto-approve covers merges on hosts that run GitHub effects automatically (`automaticGitHub`), which merge without
  // asking only in a message marked `autoMerge`, as the broker does only for an admission marked so (see
  // issueRunAdmission). The apps mark each Auto-approve message to such a host, once its owner confirmed there that it
  // merges; apps from when that was a separate Auto-merge option mark only the messages that chose it. Other hosts would
  // refuse the mark and ask before every GitHub effect anyway, so it is left off, as when an app's picture of the host is
  // out of date. `false` is the same as leaving it out.
  if (input.autoMerge !== undefined) {
    if (typeof input.autoMerge !== 'boolean') fail(400, 'invalid_options', 'Invalid auto-merge choice.');
    if (input.autoMerge && options.access !== 'auto') fail(400, 'invalid_options', 'Auto-merge needs Auto-approve.');
    if (input.autoMerge && capabilities.automaticGitHub === true) options.autoMerge = true;
  }
  return options;
}

/**
 * The images pasted into a message, in the shape and within the bounds every host takes. Only a host that gives them to
 * the model gets them: an older connector would drop them and run the text alone. An empty list is the same as none.
 */
async function chatImages(c: AppContext, row: SessionRow, value: unknown): Promise<ChatImage[] | undefined> {
  if (value === undefined) return undefined;
  const parsed = parseChatImages(value);
  if ('error' in parsed) fail(400, 'invalid_images', parsed.error);
  if (!parsed.images.length) return undefined;
  if (!row.connector_id) fail(400, 'images_unsupported', 'This session\'s runner cannot take images.');
  const host = await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(row.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if ((JSON.parse(host.capabilities_json) as ConnectorCapabilities).chatImages !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pistead@latest connect) to send images.');
  }
  return parsed.images;
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

/**
 * Snapshots of the session's view. A client that passes `since` (empty when it holds no view yet) understands patches:
 * after a whole `view` event it gets `patch` events with only what changed since the revision it holds, and a patch
 * with no changes while nothing did. Clients without `since` get the whole view every time, as before patches.
 */
function pollingEvents(c: AppContext, row: SessionRow): Response {
  const since = c.req.query('since');
  let held = isRevision(since) ? since : undefined;
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
        // Read with every snapshot: one session has one feed, so a stream left on settings someone just changed would
        // keep replacing the feed of everyone reading with the new ones. The first view after a change is a whole one.
        const display = await Promise.race([transcriptDisplay(c, row), stopped]);
        if (!display || stream.aborted) break;
        // The view is checked against the session, presented and redacted by the feed.
        const shown = await Promise.race([sessionView(c, row, { display }), stopped]);
        if (!shown || stream.aborted) break;
        // Never emit a snapshot fetched before a grant was revoked without a fresh policy check.
        const access = await Promise.race([requireSession(c, row.id, 'read'), stopped]);
        if (!access || stream.aborted) break;
        if (access.row.connector_id) await requireConnectorSession(c.env, access.row.connector_id, access.row);
        if (stream.aborted) break;
        const patch = since === undefined ? null : viewChanges(c, row, held, shown, display);
        held = shown.revision;
        await Promise.race([stream.writeSSE(patch ? { event: 'patch', data: JSON.stringify({ patch }) }
          : { event: 'view', data: JSON.stringify(since === undefined ? { view: shown.view } : { view: shown.view, revision: shown.revision }) }), stopped]);
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

/**
 * Why a session's agent can't run shell commands on its host, and so can't clone the workspace's repositories; undefined
 * when it can. Such a session works in an empty worktree.
 */
export function cloneUnavailable(capabilities: ConnectorCapabilities, hostOwnerId: string | null, ownerId: string, tools: readonly string[]): string | undefined {
  if (!tools.includes('bash')) return 'This session\'s agent doesn\'t have the bash tool, so it can\'t clone the workspace\'s repositories and works in an empty worktree.';
  if (capabilities.productionShell !== true && hostOwnerId !== ownerId) {
    return 'This session\'s host runs shell commands only for its owner, as it has no resource limits, so the agent can\'t clone the workspace\'s repositories and works in an empty worktree.';
  }
  return undefined;
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
    // A session starts from a model, with a chat agent of its own.
    if (input.agentVersionId !== undefined) fail(400, 'invalid_input', 'Sessions start from a model; agents were removed.');
    const title = text(input.title ?? 'Untitled session', 'title', 200);
    const visibility = sessionVisibility(input.visibility === undefined ? 'workspace' : input.visibility);
    const ownerId = c.get('auth').userId;
    await requireSessionCreator(c.env, workspaceId, ownerId);
    // A live check: a model of the owner's own host here, or of a host shared here.
    const model = await requireModel(c.env, identifier(input.modelId, 'modelId'), ownerId);
    if (model.workspace_id !== workspaceId) fail(404, 'not_found', 'Model not found.');
    if (model.provider === 'faux' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
    const syntheticLegacy = model.provider === 'faux' && await legacyRepositoryFixture(c.env, ownerId);
    if (!model.connector_id && !syntheticLegacy) fail(400, 'connector_required', 'New sessions require a connected model.');
    if (model.connector_id && model.connector_owner_id !== ownerId && input.trustedConnectorId !== model.connector_id) {
      fail(400, 'connector_trust_required', 'Explicitly acknowledge that this host can access this session before continuing.');
    }
    const session = { id: id(), workspace_id: workspaceId, owner_id: ownerId, title, visibility, policy_version: 1, status: 'provisioning' as const,
      created_at: now(), connector_id: model.connector_id ?? null, connector_owner_id: model.connector_owner_id ?? null };
    const host = session.connector_id
      ? await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(session.connector_id).first()
      : null;
    const capabilities = JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities;
    // Every session clones its repositories with plain Git; a connector from before that can't run one.
    if (session.connector_id && capabilities.plainGit !== true) {
      fail(409, 'connector_update_required', 'Update the host\'s connector (npx pistead@latest connect): sessions now clone their repositories with plain Git.');
    }
    // A session may run directly on its host, without the sandbox: only the host's owner starts one, only where the host's
    // configuration accepts that, and only on a connector that runs it there. Anything else is refused, never quietly
    // sandboxed, so the owner never believes a session is somewhere it isn't.
    if (input.hostEnvironment !== undefined && typeof input.hostEnvironment !== 'boolean') fail(400, 'invalid_input', 'hostEnvironment must be true or false.');
    const onHost = input.hostEnvironment === true;
    if (onHost) {
      if (!session.connector_id || session.connector_owner_id !== ownerId) {
        fail(403, 'host_owner_required', 'Only a host\'s owner starts sessions that run directly on it.');
      }
      if (capabilities.unsandboxed === true) fail(400, 'host_unsandboxed', 'This host runs every session without the sandbox already.');
      if (!hostSessionsSupported(capabilities)) {
        fail(409, 'connector_update_required', 'Update the host\'s connector (npx pistead@latest connect) to run sessions directly on it.');
      }
      if (!(await connectorHostConfig(c.env, session.connector_id)).hostSessions) {
        fail(409, 'host_sessions_off', 'This host doesn\'t accept sessions that run directly on it. Turn that on under Settings → Hosts → the host → Configuration.');
      }
    }
    // Every session starts empty, pinning nothing: its agent clones the workspace's repositories with plain Git, through
    // the host's egress proxy on a sandboxed host or with the host's own Git where its owner runs it unsandboxed. An
    // agent that can't run shell commands there can't clone, and works in an empty worktree (cloneUnavailable says why).
    const resolved = await cloneRepositories(c.env, workspaceId, ownerId);
    // Created only once the start is otherwise admissible, so a refused start leaves no chat agent behind. It offers only
    // the tools this host can carry, so an older connector never gets one it can't run.
    const agent = await chatAgentVersion(c.env, ownerId, model, capabilities);
    // Its own branch is named for its work, on a connector that pushes the name its binding carries.
    const row: SessionRow & { repositories_json: string } = { ...session, agent_version_id: agent.id, repositories_json: '[]', repository_mode: 'clone',
      branch: capabilities.sessionBranches === true ? sessionBranchName(title, session.id) : null, host_environment: onHost ? 1 : 0 };
    const gitPush = row.connector_id && (JSON.parse(agent.tools_json) as unknown[]).includes('git_push') ? 1 : 0;
    const notice = row.connector_id ? cloneUnavailable(capabilities, row.connector_owner_id ?? null, ownerId, JSON.parse(agent.tools_json) as string[]) : undefined;
    await requireSessionCreator(c.env, workspaceId, ownerId);
    if (row.connector_id) await requireConnectorSession(c.env, row.connector_id, row);
    // Admit the session only while its workspace's repositories, membership and host are as they were checked.
    const inserted = await c.env.DB.query(`INSERT INTO sessions
      (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id, repositories_json, visibility, repository_mode, branch,
        host_environment)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ${sessionCreatorSQL('?')}
      AND (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories WHERE workspace_id = ?) = json(?)
      AND EXISTS (SELECT 1 FROM users session_owner WHERE session_owner.id = ? AND session_owner.suspended_at IS NULL
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
        WHERE host.id = ? AND host.owner_id = ? AND host.revoked_at IS NULL AND host_user.suspended_at IS NULL AND association.workspace_id = ?
          AND (host.owner_id = ? OR EXISTS (SELECT 1 FROM connector_shares share
            WHERE share.connector_id = host.id AND share.workspace_id = association.workspace_id))
          AND m.available = 1 AND m.connector_id = host.id AND m.connector_owner_id = host.owner_id AND ${modelEnabledSQL('host.id', 'm')}
          AND (? = 1 OR (host_user.auth_kind <> 'test' AND m.provider <> 'faux'))
          AND (? = 0 OR json_type(host.capabilities_json, '$.gitPush') = 'true')
          AND EXISTS (SELECT 1 FROM json_each(host.models_json) local
            WHERE json_extract(local.value, '$.provider') = m.provider AND json_extract(local.value, '$.modelId') = m.model_id)
      ))
      AND (? = 0 OR EXISTS (SELECT 1 FROM connector_configs accepted WHERE accepted.connector_id = ? AND accepted.host_sessions = 1))
      RETURNING id`)
      .bind(row.id, row.workspace_id, row.owner_id, row.agent_version_id, row.title, row.policy_version, row.status, row.created_at,
        row.connector_id ?? null, row.connector_owner_id ?? null, row.repositories_json, row.visibility ?? 'private', row.repository_mode ?? null, row.branch ?? null,
        row.host_environment ?? 0,
        workspaceId, ownerId, workspaceId, resolved.bindingIds,
        // A workspace without repositories admits only the synthetic legacy fixture that cloneRepositories allowed.
        ownerId, resolved.bindingIds === '[]' ? 0 : 1, resolved.githubAuthority === null && testMode(c.env) ? 1 : 0,
        resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.ciphertext ?? null,
        JSON.stringify(resolved.credentials), ownerId, resolved.credentials.length,
        row.connector_id ?? null, model.id, row.connector_id ?? null, row.connector_owner_id ?? null, workspaceId, ownerId,
        testMode(c.env) ? 1 : 0, gitPush,
        // Its host still accepts sessions on its own environment as the write lands.
        onHost ? 1 : 0, row.connector_id ?? null).first();
    if (!inserted) fail(409, 'session_configuration_changed', 'Workspace repositories, Git account access, membership, or connector authority changed. Try again.');
    await auditStatement(c.env, ownerId, 'session.created', workspaceId, row.id, { agentVersionId: agent.id, ...(onHost ? { hostEnvironment: true } : {}) }).run();
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
    return c.json({ session: { ...sessionRecord(row, [...permissions]), ...(notice ? { cloneUnavailable: notice } : {}) } }, 201);
  });

  app.get('/api/sessions/:id', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'read');
    // Readers who cannot see a private host in the catalog still learn that it runs without isolation.
    const host = access.row.connector_id
      ? await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(access.row.connector_id).first()
      : null;
    const capabilities: unknown = host ? JSON.parse(host.capabilities_json) : null;
    // A session that runs directly on its host is as unsandboxed as one on an unsandboxed host.
    const hostUnsandboxed = (typeof capabilities === 'object' && capabilities !== null && 'unsandboxed' in capabilities && capabilities.unsandboxed === true)
      || Number(access.row.host_environment ?? 0) === 1;
    // A clone session whose agent can't run shell commands on its host learns why it can't clone.
    const agent = access.row.repository_mode === 'clone' && access.row.connector_id && capabilities
      ? await c.env.DB.query<{ tools_json: string }>('SELECT tools_json FROM agent_versions WHERE id = ?').bind(access.row.agent_version_id).first() : null;
    const notice = agent ? cloneUnavailable(capabilities as ConnectorCapabilities, access.row.connector_owner_id ?? null, access.row.owner_id, JSON.parse(agent.tools_json) as string[]) : undefined;
    // Everyone who can view the session learns that its shared conversation is also visible to anyone with its link.
    const linkShared = await isLinkShared(c.env, access.row.id);
    return c.json({ session: { ...sessionRecord(access.row, access.permissions), ...(hostUnsandboxed ? { hostUnsandboxed } : {}), ...(linkShared ? { linkShared } : {}),
      ...(notice ? { cloneUnavailable: notice } : {}) } });
  });
  app.patch('/api/sessions/:id', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const ownerId = c.get('auth').userId;
    const input = await jsonObject(c, 4096);
    const keys = Object.keys(input);
    // A rename and tool output are cosmetic and a visibility change is policy; each is its own request, never mixed.
    if (keys.length === 1 && keys[0] === 'toolOutput') {
      if (row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can change how it shows tool output.');
      if (!toolOutputs.includes(input.toolOutput as ToolOutput)) fail(400, 'invalid_tool_output', 'Tool output is either full or brief.');
      const toolOutput = input.toolOutput as ToolOutput;
      // Display only: not part of the runner binding or policy, so the policy version stays.
      const updated = await c.env.DB.query<SessionRow>(`UPDATE sessions SET tool_output = ?
        WHERE id = ? AND owner_id = ?
          AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = sessions.workspace_id AND user_id = ?)
        RETURNING *`).bind(toolOutput, row.id, ownerId, ownerId).first();
      if (!updated) fail(409, 'policy_changed', 'Session membership changed; reload and retry.');
      await auditStatement(c.env, ownerId, 'session.tool_output.updated', row.workspace_id, row.id, { toolOutput }).run();
      invalidateSessionView(c, row.id);
      return c.json({ session: sessionRecord(updated, [...permissions]) });
    }
    if (keys.length === 1 && keys[0] === 'title') {
      if (row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can rename it.');
      const title = text(input.title, 'title', 200).trim();
      if (!title || /[\r\n]/.test(title)) fail(400, 'invalid_title', 'The title must be a single non-empty line.');
      // The title is not part of the runner binding or policy, so it does not bump the policy version.
      const renamed = await c.env.DB.query<SessionRow>(`UPDATE sessions SET title = ?
        WHERE id = ? AND owner_id = ? AND status <> 'archived'
          AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = sessions.workspace_id AND user_id = ?)
        RETURNING *`).bind(title, row.id, ownerId, ownerId).first();
      if (!renamed) fail(409, 'policy_changed', 'Session membership or status changed; reload and retry.');
      await auditStatement(c.env, ownerId, 'session.renamed', row.workspace_id, row.id).run();
      return c.json({ session: sessionRecord(renamed, [...permissions]) });
    }
    if (row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can change its visibility.');
    if (keys.some(key => key !== 'visibility')) fail(400, 'invalid_input', 'Change the session title, its visibility or its tool output, one at a time.');
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
  // Archiving makes a session read-only for everyone (see requireSession and runnerRequest) and hides it from default
  // lists. It never contacts the host or deletes anything, so the owner can unarchive it to its exact previous status.
  app.post('/api/sessions/:id/archive', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const ownerId = c.get('auth').userId;
    if (row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can archive it.');
    // A policy version bump invalidates runner tickets and broker capabilities issued before archiving.
    const archived = await c.env.DB.query<SessionRow>(`UPDATE sessions SET archived_status = status, status = 'archived', policy_version = policy_version + 1
      WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> 'archived'
      RETURNING *`).bind(row.id, ownerId, row.policy_version).first();
    if (!archived) fail(409, 'policy_changed', 'Session status or permissions changed; reload and retry.');
    await auditStatement(c.env, ownerId, 'session.archived', row.workspace_id, row.id, { previousStatus: row.status }).run();
    return c.json({ session: sessionRecord(archived, [...permissions]) });
  });
  app.post('/api/sessions/:id/unarchive', async c => {
    // Archived sessions only admit read access; ownership is what authorizes bringing one back.
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const ownerId = c.get('auth').userId;
    if (row.owner_id !== ownerId) fail(403, 'owner_required', 'Only the session owner can unarchive it.');
    if (row.status !== 'archived') fail(409, 'session_not_archived', 'Session is not archived.');
    const restored = await c.env.DB.query<SessionRow>(`UPDATE sessions SET status = COALESCE(archived_status, 'ready'), archived_status = NULL,
        policy_version = policy_version + 1
      WHERE id = ? AND owner_id = ? AND policy_version = ? AND status = 'archived'
      RETURNING *`).bind(row.id, ownerId, row.policy_version).first();
    if (!restored) fail(409, 'policy_changed', 'Session status or permissions changed; reload and retry.');
    await auditStatement(c.env, ownerId, 'session.unarchived', row.workspace_id, row.id, { status: restored.status }).run();
    return c.json({ session: sessionRecord(restored, [...permissions]) });
  });
  app.get('/api/sessions/:id/view', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const shown = await sessionView(c, row, { latest: true, display: await transcriptDisplay(c, row) });
    const fresh = await requireSession(c, row.id, 'read');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    // The revision lets the client's next /events stream send only what changed.
    return c.json({ view: shown.view, revision: shown.revision });
  });
  // Earlier entries of one conversation, for a view that holds only its latest ones (a workspace that pages transcripts),
  // presented and redacted as views are. 409 when the conversation no longer has `before`, e.g. after a compaction.
  app.get('/api/sessions/:id/entries', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const conversation = c.req.query('conversation') ?? '';
    const before = c.req.query('before') ?? '';
    const limitText = c.req.query('limit') ?? String(transcriptPage.size);
    const limit = Number(limitText);
    // Only compared with the view's own ids, so any short text without control characters will do.
    const name = /^[^\u0000-\u001f\u007f]{1,300}$/;
    if (!name.test(conversation) || !name.test(before)) fail(400, 'invalid_input', 'Name a conversation and the entry to read before.');
    if (!/^\d{1,4}$/.test(limitText) || limit < 1 || limit > transcriptPage.max) fail(400, 'invalid_input', `The limit must be 1 to ${transcriptPage.max}.`);
    const page = await earlierEntries(c, row, await transcriptDisplay(c, row), conversation, before, limit);
    // Never answer with entries read before access was revoked.
    const fresh = await requireSession(c, row.id, 'read');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    if (!page) fail(409, 'entries_changed', 'The transcript changed. Scroll up again to load earlier messages.');
    return c.json(page, 200, { 'Cache-Control': 'private, no-store' });
  });
  app.get('/api/sessions/:id/events', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    // Review commitments must be persisted before any approval reaches a browser, including legacy sessions.
    return pollingEvents(c, row);
  });

  for (const mode of ['submit', 'ask'] as const) {
    app.post(`/api/sessions/:id/${mode}`, async c => {
      const { row } = await requireSession(c, identifier(c.req.param('id')), mode === 'ask' ? 'ask' : 'write');
      // Before an admission is issued: a read-only session runs nothing.
      requireUnfrozen(row);
      // Pasted images make a message about as large as its host takes in one request; a little more is read, so a message
      // just over that is told why below rather than refused unread.
      const input = await jsonObject(c, connectorLimits.requestBytes + 256 * 1024);
      if ('admissionId' in input) fail(400, 'server_owned_admission', 'Write admissions are assigned by the server.');
      const images = await chatImages(c, row, input.images);
      // A message of images alone has no text.
      const content = text(input.content, 'content', 60000, images ? 0 : 1);
      const requestId = text(input.requestId, 'requestId', 128);
      const options = await chatOptions(c, row, mode, input.options);
      // A message that names no model must not run on one its host's owner or an admin disabled.
      await requireEnabledModel(c, row, options);
      // Said before an admission is issued, in words the sender can act on; the host request is checked again as it goes.
      if (images && connectorUtf8Bytes(JSON.stringify({ content, requestId, admissionId: 'x'.repeat(43), options, images })) > connectorLimits.requestBytes) {
        fail(413, 'message_too_large', 'This message and its images are too large to send together. Remove an image or shorten the message.');
      }
      const admissionId = mode === 'submit' ? await issueRunAdmission(c, row, content, requestId, options?.access, images, options?.autoMerge === true) : undefined;
      const result = await runnerJSON<SubmitResult>(await runnerRequest(c, row, mode, '', { content, requestId, ...(admissionId ? { admissionId } : {}), ...(options ? { options } : {}),
        ...(images ? { images } : {}) }));
      invalidateSessionView(c, row.id);
      if (typeof result?.submissionId !== 'string' || typeof result.conversationId !== 'string' || typeof result.status !== 'string') fail(502, 'invalid_runner_response', 'The runner returned an invalid submission.');
      await auditStatement(c.env, c.get('auth').userId, `session.${mode}`, row.workspace_id, row.id, { submissionId: result.submissionId, ...(options ? { options } : {}),
        ...(images ? { images: images.length } : {}) }).run();
      return c.json(result, 202);
    });
  }

  app.post('/api/sessions/:id/operations', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    requireUnfrozen(row);
    const operation = parseOperation(await jsonObject(c));
    if (operation.kind === 'permission') fail(400, 'invalid_operation', 'Permission requests come only from tool calls.');
    await requireOperationTool(c.env, row, operation);
    const result = await runnerJSON<{ approval: ApprovalRecord }>(await runnerRequest(c, row, 'operations', '', { operation }));
    invalidateSessionView(c, row.id);
    if (!result?.approval || result.approval.sessionId !== row.id || result.approval.requestedBy !== c.get('auth').userId) fail(502, 'invalid_runner_response', 'The runner returned an invalid approval request.');
    [result.approval] = await presentApprovals(c, row, [result.approval], { operation, requestedBy: c.get('auth').userId });
    await auditStatement(c.env, c.get('auth').userId, 'approval.requested', row.workspace_id, row.id, { approvalId: result.approval.id, kind: operation.kind }).run();
    const fresh = await requireSession(c, row.id, 'write');
    if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
    return c.json({ ...result, approval: redactApproval(result.approval) }, 201);
  });

  app.post('/api/sessions/:id/approvals/:approvalId', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'approve');
    requireUnfrozen(row);
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
    // The host's owner decides host commands, as does a member they (or a host admin) granted host commands to.
    if (operation.kind === 'host.bash' && (!row.connector_id || !await mayDecideHostCommands(c.env, row, c.get('auth').userId))) {
      fail(403, 'host_owner_required', 'Only the host owner, or a member granted host commands on this host, can decide host commands. Grant them approve access to this session first.');
    }
    // A session that runs directly on its host runs its commands there, as host commands: they are decided the same way.
    if (operation.kind === 'bash' && Number(row.host_environment ?? 0) === 1 && (!row.connector_id || !await mayDecideHostCommands(c.env, row, c.get('auth').userId))) {
      fail(403, 'host_owner_required', 'This session runs directly on its host: only the host owner, or a member granted host commands on this host, decides its commands.');
    }
    // A permission request lets a tool call do more than the session allows, so only its owner decides it.
    if (operation.kind === 'permission') {
      if (c.get('auth').userId !== row.owner_id) fail(403, 'owner_required', 'Only the session owner can allow more than the session allows.');
      if (operation.needs.includes('unbounded-shell') && row.connector_owner_id !== row.owner_id) {
        fail(403, 'host_owner_required', 'Only the host\'s owner can allow a shell without resource limits.');
      }
      // Each host command runs outside the sandbox, so its permission covers that one call only.
      if (input.scope === 'session' && operation.tool === 'host_bash') fail(400, 'invalid_decision', 'Host commands can only be allowed once.');
    } else if (input.scope !== undefined) fail(400, 'invalid_decision', 'Only permission requests take a scope.');
    const scope = operation.kind === 'permission' ? (input.scope === 'session' ? 'session' : 'call') : undefined;
    let brokerCapability: string | undefined;
    if (input.decision === 'approve') {
      const writer = await sessionAccess(c.env, row.id, review.requested_by);
      if (!writer || !hasPermission(writer.permissions, 'write')) fail(403, 'requester_revoked', 'The operation requester no longer has write permission.');
      await reviewedApproval(c, row, approvalId, input.reviewHash);
      const fresh = await requireSession(c, row.id, 'approve');
      if (fresh.row.connector_id) await requireConnectorSession(c.env, fresh.row.connector_id, fresh.row);
      if (operation.kind === 'github.comment' || operation.kind === 'github.merge' || operation.kind === 'github.issue' || operation.kind === 'git.push') {
        const existing = await c.env.DB.query('SELECT token_hash FROM broker_capabilities WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first();
        if (existing) fail(409, 'approval_attempt_exists', 'This operation already has an approval attempt. Inspect its outcome before creating a new request.');
        brokerCapability = randomToken();
        await c.env.DB.query(`INSERT INTO broker_capabilities (token_hash, session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(await sha256(brokerCapability), row.id, approvalId, c.get('auth').userId,
          review.requested_by, await sha256(JSON.stringify(operation)), Math.floor(Date.now() / 1000) + 90, now()).run();
      }
      // Tool grants live here as well as on the host, so a host can't present commands, pushes or comments for a tool
      // the owner never allowed. A one-call grant covers the command approval of that same tool call; the review above
      // only admits permission requests that name their call.
      if (operation.kind === 'permission' && operation.needs.includes('tool')) {
        await c.env.DB.query(`INSERT INTO session_tool_grants (session_id, tool, call_id, approval_id, granted_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, tool, call_id) DO NOTHING`)
          .bind(row.id, operation.tool, scope === 'session' ? '' : permissionCall(approvalId)!, approvalId, c.get('auth').userId, now()).run();
      }
    }
    const decided = await runnerJSON<{ approval: ApprovalRecord }>(await runnerRequest(c, row, 'approve', approvalId, {
      approvalId, decision: input.decision, operation, ...(brokerCapability ? { brokerCapability } : {}), ...(scope ? { scope } : {}),
    }));
    invalidateSessionView(c, row.id);
    if (!decided?.approval || decided.approval.id !== approvalId || decided.approval.sessionId !== row.id) fail(502, 'invalid_runner_response', 'The runner returned an invalid approval result.');
    [decided.approval] = await presentApprovals(c, row, [decided.approval]);
    await auditStatement(c.env, c.get('auth').userId, `approval.${input.decision}`, row.workspace_id, row.id, { approvalId, kind: operation.kind, status: decided.approval.status, ...(scope ? { scope } : {}) }).run();
    return c.json({ ...decided, approval: redactApproval(decided.approval) });
  });

  app.get('/api/sessions/:id/grants', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    // The grantees and the owner, with each one's workspace role, read together.
    const rows = await c.env.DB.query<{ user_id: string; permissions_json: string | null; role: WorkspaceRole }>(`SELECT m.user_id, g.permissions_json, m.role
      FROM workspace_members m
      LEFT JOIN session_grants g ON g.session_id = ? AND g.user_id = m.user_id
      WHERE m.workspace_id = ? AND (g.user_id IS NOT NULL OR m.user_id = ?)`)
      .bind(row.id, row.workspace_id, row.owner_id).all();
    const ownerRole = rows.find(g => g.user_id === row.owner_id)?.role;
    const result = rows.filter((g): g is typeof g & { permissions_json: string } => g.permissions_json !== null);
    // A grant shows what it allows: a viewer's (one demoted after it was granted) is capped at read, as sessionAccess caps it.
    const effective = (grant: { permissions_json: string; role: WorkspaceRole }) => {
      const ceiling = roleSessionCeiling(grant.role);
      return normalizePermissions(JSON.parse(grant.permissions_json)).filter(permission => !ceiling || ceiling.includes(permission));
    };
    // Each grant also names the grantee's workspace role and the session tier it is, so a client offers only the tiers
    // that fit; a grant that matches no tier (one from before tiers) is custom (null).
    return c.json({ grants: [{ userId: row.owner_id, permissions: [...permissions], ...(ownerRole ? { workspaceRole: ownerRole } : {}), sessionRole: sessionRoleOf(permissions) }, ...result.filter(g => g.user_id !== row.owner_id)
      .map(g => { const held = effective(g); return { userId: g.user_id, permissions: held, workspaceRole: g.role, sessionRole: sessionRoleOf(held) }; })] });
  });
  app.post('/api/sessions/:id/grants', async c => {
    const access = await requireSession(c, identifier(c.req.param('id')), 'manage');
    const { row } = access;
    const input = await jsonObject(c);
    const userId = userIdentifier(input.userId);
    if (userId === row.owner_id) fail(400, 'owner_grant_immutable', 'The session owner always retains full authority.');
    const grantee = await requireMember(c.env, row.workspace_id, userId);
    // A grant is either one of the four session tiers (`role`) or, as before tiers, an explicit permission list.
    if ((input.role === undefined) === (input.permissions === undefined)) fail(400, 'invalid_grant', 'Give either a session role or permissions.');
    let grants: Permission[];
    if (input.role !== undefined) {
      if (typeof input.role !== 'string' || !(sessionRoles as readonly string[]).includes(input.role)) fail(400, 'invalid_session_role', 'Invalid session role.');
      grants = [...sessionRolePermissions[input.role as SessionRole]];
    } else {
      try { grants = normalizePermissions(input.permissions); } catch { fail(400, 'invalid_permissions', 'Invalid permissions.'); }
    }
    // sessionAccess caps a viewer at read whatever it is granted; refusing more here says so rather than storing it.
    const ceiling = roleSessionCeiling(grantee.role);
    if (ceiling && grants.some(permission => !ceiling.includes(permission))) fail(400, 'viewer_role', 'Viewers can only be granted read access.');
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
    return c.json({ grant: { userId, permissions: grants, workspaceRole: grantee.role, sessionRole: sessionRoleOf(grants) } });
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

  // Anyone who can write to the session can stop its work, as they can add to it.
  app.post('/api/sessions/:id/stop', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const result = await runnerJSON<{ stopped: number }>(await runnerRequest(c, row, 'stop', '', {}));
    invalidateSessionView(c, row.id);
    if (!Number.isSafeInteger(result?.stopped) || result.stopped < 0) fail(502, 'invalid_runner_response', 'The runner returned an invalid stop result.');
    await auditStatement(c.env, c.get('auth').userId, 'session.stopped', row.workspace_id, row.id, { stopped: result.stopped }).run();
    return c.json({ stopped: result.stopped });
  });

  app.post('/api/sessions/:id/restart', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'manage');
    if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can restart it.');
    const result = row.status === 'error' || row.status === 'provisioning'
      ? await runnerRequest(c, row, 'create', '', await bindingForSession(c, row))
      : await runnerRequest(c, row, 'restart', '', {});
    invalidateSessionView(c, row.id);
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
