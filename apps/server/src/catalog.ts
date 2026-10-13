import type { Hono } from 'hono';
import { defaultAgentName, toolNames } from '../../../packages/shared/src/types.js';
import type { Workspace, WorkspaceRole } from '../../../packages/shared/src/types.js';
import { agentVersion, auditStatement, modelDefinition, requireMember } from './db.js';
import { fail, id, identifier, jsonObject, now, testMode, text, userIdentifier } from './http.js';
import type { AgentRow, Env, ModelRow, WorkerEnv } from './types.js';
import { ConstraintError, type Query } from './db/types.js';

interface SafeMember {
  userId: string;
  displayName: string;
  githubLogin: string | null;
  role: WorkspaceRole;
}

interface AgentInput {
  name: string;
  description: string;
  instructions: string;
  toolsJson: string;
  modelId: string;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    fail(400, 'invalid_input', 'Unexpected request field.');
  }
}

function nameInput(value: unknown): string {
  const result = text(value, 'name', 200).trim();
  if (!result) fail(400, 'invalid_input', 'Invalid name.');
  return result;
}

function agentInput(body: Record<string, unknown>): AgentInput {
  onlyFields(body, ['name', 'description', 'instructions', 'tools', 'modelId']);
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length > toolNames.length ||
      !tools.every(tool => typeof tool === 'string' && toolNames.some(known => known === tool)) ||
      new Set(tools).size !== tools.length) {
    fail(400, 'invalid_input', 'Invalid tools.');
  }
  return {
    // Name, description and instructions may be omitted; a blank name stores the default.
    name: text(body.name ?? '', 'name', 200, 0).trim() || defaultAgentName,
    description: text(body.description ?? '', 'description', 4000, 0),
    instructions: text(body.instructions ?? '', 'instructions', 32000, 0),
    toolsJson: JSON.stringify(tools),
    modelId: identifier(body.modelId, 'modelId'),
  };
}

function membersStatement(env: Env, workspaceId: string, actorId: string): Query<SafeMember> {
  return env.DB.query<SafeMember>(`SELECT member.user_id AS userId, u.display_name AS displayName,
      u.github_login AS githubLogin, member.role
    FROM workspace_members member
    INNER JOIN users u ON u.id = member.user_id
    INNER JOIN workspace_members actor ON actor.workspace_id = member.workspace_id AND actor.user_id = ?
    WHERE member.workspace_id = ?
    ORDER BY member.created_at, member.user_id`).bind(actorId, workspaceId);
}

async function requireMemberManagement(
  env: Env, workspaceId: string, actorId: string, targetId: string, role?: 'member' | 'admin',
): Promise<WorkspaceRole | null> {
  const authority = await env.DB.query<{ ownerId: string; actorRole: WorkspaceRole; targetRole: WorkspaceRole | null }>(`SELECT w.owner_id AS ownerId, actor.role AS actorRole,
      target.role AS targetRole
    FROM workspaces w
    INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
    LEFT JOIN workspace_members target ON target.workspace_id = w.id AND target.user_id = ?
    WHERE w.id = ?`).bind(actorId, targetId, workspaceId)
    .first();
  if (!authority) fail(404, 'not_found', 'Workspace not found.');
  const owner = authority.actorRole === 'owner' && authority.ownerId === actorId;
  if (!owner && authority.actorRole !== 'admin') {
    fail(403, 'forbidden', 'Workspace administrator access is required.');
  }
  if (targetId === authority.ownerId || authority.targetRole === 'owner') {
    fail(403, 'forbidden', 'The workspace owner membership cannot be changed or removed.');
  }
  if (!owner && (role === 'admin' || authority.targetRole === 'admin')) {
    fail(403, 'forbidden', 'Only the workspace owner can manage administrators.');
  }
  return authority.targetRole;
}

// Keep discovery and atomic version writes on the same live model authorization.
// The two bindings are the test-mode flag (provider, then connector owner).
function modelAccessSQL(actor: 'member.user_id' | 'actor.user_id' | 'a.author_id'): string {
  return `m.available = 1 AND (? = 1 OR m.provider <> 'faux')
    AND (m.connector_id IS NULL OR EXISTS (
      SELECT 1 FROM connectors c
      JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = m.workspace_id
      JOIN workspace_members host ON host.workspace_id = cw.workspace_id AND host.user_id = c.owner_id
      JOIN users host_user ON host_user.id = c.owner_id
      WHERE c.id = m.connector_id AND c.owner_id = m.connector_owner_id AND c.revoked_at IS NULL
        AND (? = 1 OR host_user.auth_kind <> 'test')
        AND (c.owner_id = ${actor} OR EXISTS (SELECT 1 FROM connector_shares sh
          WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
        AND EXISTS (SELECT 1 FROM json_each(c.models_json) local_model
          WHERE json_extract(local_model.value, '$.provider') = m.provider
            AND json_extract(local_model.value, '$.modelId') = m.model_id)
    ))`;
}

export async function requireModel(env: Env, modelId: string, actorId: string): Promise<ModelRow> {
  const model = await env.DB.query<ModelRow>(`SELECT m.* FROM models m
    INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = ?
    WHERE m.id = ? AND ${modelAccessSQL('member.user_id')}`)
    .bind(actorId, modelId, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0).first();
  if (!model) fail(404, 'not_found', 'Model not found.');
  return model;
}

async function requireAuthor(env: Env, agentId: string, actorId: string): Promise<void> {
  // Chat agents belong to one session each: never revised or published.
  const agent = await env.DB.query<{ id: string }>('SELECT id FROM agents WHERE id = ? AND author_id = ? AND chat = 0')
    .bind(agentId, actorId).first();
  if (!agent) fail(404, 'not_found', 'Agent not found.');
}

function auditAfterChange(
  env: Env, actorId: string, action: string, workspaceId: string | null,
  detail: Record<string, unknown>, auditId = id(),
): Query<never> {
  // This must immediately follow a single-row mutation in the same atomic batch.
  return env.DB.query<never>(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
    SELECT ?, ?, NULL, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(auditId, workspaceId, actorId, action, JSON.stringify(detail), now());
}

function privateVersionStatement(
  env: Env, actorId: string, agentId: string, versionId: string, input: AgentInput, createdAt: string,
): Query<AgentRow> {
  // Allocate the sequence in the INSERT, not from a potentially stale application read.
  return env.DB.query<AgentRow>(`INSERT INTO agent_versions
      (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    SELECT ?, a.id, a.author_id, NULL,
      (SELECT COALESCE(MAX(version), 0) + 1 FROM agent_versions WHERE agent_id = a.id),
      ?, ?, ?, ?, m.id, ?
    FROM agents a
    INNER JOIN models m ON m.id = ?
    INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = a.author_id
    WHERE a.id = ? AND a.author_id = ?
      AND ${modelAccessSQL('a.author_id')}
    RETURNING *`).bind(versionId, input.name, input.description, input.instructions, input.toolsJson,
      createdAt, input.modelId, agentId, actorId, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0);
}

// SQLite: 'UNIQUE constraint failed: agent_versions.agent_id, agent_versions.version';
// Postgres: 'duplicate key value violates unique constraint "agent_versions_agent_id_version_key"'.
const VERSION_CONFLICT = /agent_versions\.agent_id,\s*agent_versions\.version|agent_versions_agent_id_version_key/;

function versionConflict(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof ConstraintError && VERSION_CONFLICT.test(error.constraint)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

async function versionBatch(env: Env, statements: Query<AgentRow>[], versionIndex: number): Promise<AgentRow> {
  try {
    const results = await env.DB.batch<AgentRow>(statements);
    const row = results[versionIndex].results[0];
    if (!row) fail(409, 'catalog_changed', 'Agent, model, or membership changed. Refresh and try again.');
    return row;
  } catch (error) {
    if (versionConflict(error)) fail(409, 'version_conflict', 'Another agent version was created. Refresh and try again.');
    throw error;
  }
}

/**
 * The agent of a session started from a model instead of a chosen agent: every tool the host can carry, since the
 * message's access mode still gates writes, commands and pushes, and no instructions beyond the runner's own context.
 * Each such session gets its own chat agent, which stays out of the author's catalog.
 */
export async function chatAgentVersion(env: Env, ownerId: string, model: ModelRow, gitPush: boolean): Promise<AgentRow> {
  const agentId = id();
  const createdAt = now();
  const tools = toolNames.filter(tool => gitPush || tool !== 'git_push');
  const input: AgentInput = { name: model.name, description: '', instructions: '', toolsJson: JSON.stringify(tools), modelId: model.id };
  return versionBatch(env, [
    env.DB.query<never>(`INSERT INTO agents (id, author_id, created_at, chat)
      SELECT ?, ?, ?, 1 FROM models m
      INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = ?
      WHERE m.id = ? AND ${modelAccessSQL('member.user_id')}`)
      .bind(agentId, ownerId, createdAt, ownerId, model.id, testMode(env) ? 1 : 0, testMode(env) ? 1 : 0),
    privateVersionStatement(env, ownerId, agentId, id(), input, createdAt),
  ], 1);
}

export function registerCatalog(app: Hono<WorkerEnv>): void {
  app.get('/api/workspaces', async c => {
    const result = await c.env.DB.query<Workspace>(`SELECT w.id, w.name, w.owner_id AS ownerId, member.role
      FROM workspaces w
      INNER JOIN workspace_members member ON member.workspace_id = w.id AND member.user_id = ?
      ORDER BY w.created_at, w.id`).bind(c.get('auth').userId).all();
    return c.json({ workspaces: result });
  });

  app.post('/api/workspaces', async c => {
    const body = await jsonObject(c);
    onlyFields(body, ['name']);
    const workspace = { id: id(), name: nameInput(body.name), ownerId: c.get('auth').userId, role: 'owner' as const };
    const createdAt = now();
    await c.env.DB.batch([
      c.env.DB.query('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(workspace.id, workspace.name, workspace.ownerId, createdAt),
      c.env.DB.query<never>("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
        .bind(workspace.id, workspace.ownerId, createdAt),
      auditStatement(c.env, workspace.ownerId, 'workspace.create', workspace.id),
    ]);
    return c.json({ workspace }, 201);
  });

  app.get('/api/workspaces/:id/members', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId);
    const members = await membersStatement(c.env, workspaceId, actorId).all();
    return c.json({ members });
  });

  app.post('/api/workspaces/:id/members', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    const body = await jsonObject(c);
    onlyFields(body, ['userId', 'role']);
    const targetId = userIdentifier(body.userId);
    const role = body.role;
    if (role !== 'member' && role !== 'admin') fail(400, 'invalid_input', 'Invalid role.');
    await requireMemberManagement(c.env, workspaceId, actorId, targetId, role);
    const user = await c.env.DB.query<{ id: string }>('SELECT id FROM users WHERE id = ?').bind(targetId).first();
    if (!user) fail(404, 'not_found', 'User not found.');
    const result = await c.env.DB.batch<SafeMember>([
      c.env.DB.query<never>(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
        SELECT w.id, u.id, ?, ?
        FROM workspaces w
        INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
        INNER JOIN users u ON u.id = ?
        LEFT JOIN workspace_members target ON target.workspace_id = w.id AND target.user_id = u.id
        WHERE w.id = ? AND u.id <> w.owner_id AND (target.role IS NULL OR target.role <> 'owner')
          AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
            OR (actor.role = 'admin' AND ? = 'member' AND (target.role IS NULL OR target.role = 'member')))
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`)
        .bind(role, now(), actorId, targetId, workspaceId, role),
      auditAfterChange(c.env, actorId, 'workspace.member.upsert', workspaceId, { userId: targetId, role }),
      membersStatement(c.env, workspaceId, actorId),
    ]);
    if (result[0].changes !== 1) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    return c.json({ members: result[2].results });
  });

  app.delete('/api/workspaces/:id/members/:userId', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    const targetRole = await requireMemberManagement(c.env, workspaceId, actorId, targetId);
    if (!targetRole) fail(404, 'not_found', 'Membership not found.');
    const auditId = id();
    const result = await c.env.DB.batch([
      c.env.DB.query(`DELETE FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'
          AND EXISTS (SELECT 1 FROM workspaces w
            INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
            WHERE w.id = workspace_members.workspace_id AND w.owner_id <> workspace_members.user_id
              AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
                OR (actor.role = 'admin' AND workspace_members.role = 'member')))`)
        .bind(workspaceId, targetId, actorId),
      auditAfterChange(c.env, actorId, 'workspace.member.remove', workspaceId, { userId: targetId }, auditId),
      // The audit marker gates cleanup on a successful, authorized removal in this transaction.
      c.env.DB.query(`DELETE FROM session_grants WHERE user_id = ?
        AND session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(targetId, workspaceId, auditId),
      c.env.DB.query(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`)
        .bind(workspaceId, auditId),
    ]);
    if (result[0].changes !== 1) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    // Never reassign owned sessions; sessionAccess also requires their owner's live membership.
    return c.body(null, 204);
  });

  app.get('/api/workspaces/:id/models', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId);
    const result = await c.env.DB.query<ModelRow>(`SELECT m.* FROM models m
      INNER JOIN workspace_members actor ON actor.workspace_id = m.workspace_id AND actor.user_id = ?
      WHERE m.workspace_id = ? AND ${modelAccessSQL('actor.user_id')}
      ORDER BY m.created_at, m.id LIMIT 1000`)
      .bind(actorId, workspaceId, testMode(c.env) ? 1 : 0, testMode(c.env) ? 1 : 0).all();
    return c.json({ models: result.map(modelDefinition) });
  });

  app.post('/api/workspaces/:id/models', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId, ['owner', 'admin']);
    const body = await jsonObject(c);
    onlyFields(body, ['name', 'provider', 'modelId']);
    const name = nameInput(body.name);
    const provider = body.provider;
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'faux') {
      fail(400, 'invalid_input', 'Invalid provider.');
    }
    if (provider === 'faux' && !testMode(c.env)) fail(400, 'invalid_input', 'The faux provider requires test mode.');
    const providerModelId = text(body.modelId, 'modelId', 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(providerModelId)) fail(400, 'invalid_input', 'Invalid modelId.');
    const modelId = id();
    const result = await c.env.DB.batch<ModelRow>([
      c.env.DB.query<ModelRow>(`INSERT INTO models (id, workspace_id, name, provider, model_id, created_at)
        SELECT ?, member.workspace_id, ?, ?, ?, ? FROM workspace_members member
        WHERE member.workspace_id = ? AND member.user_id = ? AND member.role IN ('owner', 'admin')
        RETURNING *`).bind(modelId, name, provider, providerModelId, now(), workspaceId, actorId),
      auditAfterChange(c.env, actorId, 'model.create', workspaceId, { modelId, provider }),
    ]);
    const model = result[0].results[0];
    if (!model) fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    return c.json({ model: modelDefinition(model) }, 201);
  });

  app.get('/api/agents', async c => {
    const result = await c.env.DB.query<AgentRow>(`SELECT v.* FROM agent_versions v
      INNER JOIN agents a ON a.id = v.agent_id AND a.author_id = v.author_id
      WHERE a.author_id = ? AND a.chat = 0 ORDER BY v.created_at DESC, v.agent_id, v.version DESC`)
      .bind(c.get('auth').userId).all();
    return c.json({ agents: result.map(agentVersion) });
  });

  app.get('/api/workspaces/:id/agents', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actorId);
    const result = await c.env.DB.query<AgentRow>(`SELECT v.* FROM agent_versions v
      INNER JOIN workspace_members member ON member.workspace_id = v.workspace_id AND member.user_id = ?
      WHERE v.workspace_id = ? ORDER BY v.created_at DESC, v.agent_id, v.version DESC`)
      .bind(actorId, workspaceId).all();
    return c.json({ agents: result.map(agentVersion) });
  });

  app.post('/api/agents', async c => {
    const actorId = c.get('auth').userId;
    const input = agentInput(await jsonObject(c));
    await requireModel(c.env, input.modelId, actorId);
    const agentId = id();
    const versionId = id();
    const createdAt = now();
    const row = await versionBatch(c.env, [
      c.env.DB.query<never>(`INSERT INTO agents (id, author_id, created_at)
        SELECT ?, ?, ? FROM models m
        INNER JOIN workspace_members member ON member.workspace_id = m.workspace_id AND member.user_id = ?
        WHERE m.id = ? AND ${modelAccessSQL('member.user_id')}`)
        .bind(agentId, actorId, createdAt, actorId, input.modelId, testMode(c.env) ? 1 : 0, testMode(c.env) ? 1 : 0),
      privateVersionStatement(c.env, actorId, agentId, versionId, input, createdAt),
      auditAfterChange(c.env, actorId, 'agent.create', null, { agentId, agentVersionId: versionId }),
    ], 1);
    return c.json({ agent: agentVersion(row) }, 201);
  });

  app.post('/api/agents/:id/versions', async c => {
    const agentId = identifier(c.req.param('id'), 'agentId');
    const actorId = c.get('auth').userId;
    await requireAuthor(c.env, agentId, actorId);
    const input = agentInput(await jsonObject(c));
    await requireModel(c.env, input.modelId, actorId);
    const versionId = id();
    const row = await versionBatch(c.env, [
      privateVersionStatement(c.env, actorId, agentId, versionId, input, now()),
      auditAfterChange(c.env, actorId, 'agent.version.create', null, { agentId, agentVersionId: versionId }),
    ], 0);
    return c.json({ agent: agentVersion(row) }, 201);
  });

  app.post('/api/agents/:id/publish', async c => {
    const agentId = identifier(c.req.param('id'), 'agentId');
    const actorId = c.get('auth').userId;
    await requireAuthor(c.env, agentId, actorId);
    const body = await jsonObject(c);
    onlyFields(body, ['workspaceId']);
    const workspaceId = identifier(body.workspaceId, 'workspaceId');
    await requireMember(c.env, workspaceId, actorId);
    const source = await c.env.DB.query<AgentRow>(`SELECT * FROM agent_versions
      WHERE agent_id = ? AND author_id = ? AND workspace_id IS NULL
      ORDER BY version DESC LIMIT 1`).bind(agentId, actorId).first();
    if (!source) fail(404, 'not_found', 'Private agent version not found.');
    const model = await requireModel(c.env, source.model_id, actorId);
    if (model.workspace_id !== workspaceId) {
      fail(400, 'model_workspace_mismatch', 'The agent model must belong to the publishing workspace.');
    }
    const versionId = id();
    const row = await versionBatch(c.env, [
      c.env.DB.query<AgentRow>(`INSERT INTO agent_versions
          (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
        SELECT ?, a.id, a.author_id, target.workspace_id,
          (SELECT COALESCE(MAX(version), 0) + 1 FROM agent_versions WHERE agent_id = a.id),
          source.name, source.description, source.instructions, source.tools_json, source.model_id, ?
        FROM agents a
        INNER JOIN agent_versions source ON source.agent_id = a.id AND source.author_id = a.author_id
        INNER JOIN models m ON m.id = source.model_id
        INNER JOIN workspace_members model_member ON model_member.workspace_id = m.workspace_id
          AND model_member.user_id = a.author_id
        INNER JOIN workspace_members target ON target.workspace_id = ? AND target.user_id = a.author_id
        WHERE a.id = ? AND a.author_id = ? AND source.id = ? AND source.workspace_id IS NULL
          AND m.workspace_id = target.workspace_id
          AND ${modelAccessSQL('a.author_id')}
          AND source.id = (SELECT id FROM agent_versions WHERE agent_id = a.id AND workspace_id IS NULL
            ORDER BY version DESC LIMIT 1)
        RETURNING *`).bind(versionId, now(), workspaceId, agentId, actorId, source.id,
          testMode(c.env) ? 1 : 0, testMode(c.env) ? 1 : 0),
      auditAfterChange(c.env, actorId, 'agent.publish', workspaceId,
        { agentId, agentVersionId: versionId, sourceVersionId: source.id }),
    ], 0);
    return c.json({ agent: agentVersion(row) }, 201);
  });
}
