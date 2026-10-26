import { egressGrant, gitRelay } from './network.js';
import { withHostToolCapabilities } from './host-capabilities.js';
import type { Hono } from 'hono';
import type { ConnectorCapabilities, ConnectorInfo, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { gpuKinds, type GpuKind } from '../../../packages/shared/src/host-config.js';
import { sessionActivities, thinkingLevels, type SessionActivity, type ThinkingLevel } from '../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import type { Query } from './db/types.js';
import { auditStatement, requireMember } from './db.js';
import { appOrigin, fail, id, identifier, jsonObject, now, randomToken, requireOrigin, testMode, text } from './http.js';
import { authorizeSession } from './internal.js';
import { markSessionChanged } from './session-changes.js';
import { githubComment, githubIssue, githubMerge, githubRead } from './github-broker.js';
import { pushComplete, pushCredential } from './push/broker.js';
import { connectorRestoreDownload } from './restore-routes.js';
import { legacyRepositoryFixture, requireConfiguredWorkspace } from './repositories.js';
import { connectorAdmins, connectorHostGrants, managedConnector, requireManagedWorkspace, viewerHostCommands } from './host-access.js';
import { connectorHostConfig } from './host-config.js';

export interface ConnectorRow {
  id: string; owner_id: string; name: string; credential_hash: string; revoked_at: string | null;
  created_at: string; last_seen_at: string | null; connection_hash: string | null;
  models_json: string; capabilities_json: string; removed_at: string | null;
}

function onlyFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) fail(400, 'invalid_metadata', 'Only model and capability metadata is accepted.');
}
export function parseManifest(input: Record<string, unknown>, env: Env): { models: LocalModelSummary[]; capabilities: ConnectorCapabilities } {
  if (!Array.isArray(input.models) || input.models.length > 200) fail(400, 'invalid_manifest', 'At most 200 models may be advertised.');
  const seen = new Set<string>();
  const models = input.models.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_manifest', 'Invalid model metadata.');
    onlyFields(value, ['provider', 'modelId', 'name', 'thinkingLevels', 'thinkingLevel']);
    const provider = text(value.provider, 'provider', 80);
    const modelId = text(value.modelId, 'modelId', 200);
    const name = text(value.name, 'name', 120);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || /[\x00-\x1f\x7f]/.test(modelId + name)) fail(400, 'invalid_manifest', 'Invalid model metadata.');
    if (provider === 'faux' && !testMode(env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
    const key = JSON.stringify([provider, modelId]);
    if (seen.has(key)) fail(400, 'invalid_manifest', 'Duplicate model metadata.');
    seen.add(key);
    const levels = value.thinkingLevels;
    if (levels !== undefined && (!Array.isArray(levels) || !levels.length || levels.some(level => !thinkingLevels.includes(level))
      || new Set(levels).size !== levels.length)) fail(400, 'invalid_manifest', 'Invalid reasoning levels.');
    // The level the host's Pi starts the model at must be one the model offers.
    const level = value.thinkingLevel;
    if (level !== undefined && (!thinkingLevels.includes(level as ThinkingLevel) || (levels && !levels.includes(level)))) fail(400, 'invalid_manifest', 'Invalid reasoning levels.');
    return { provider, modelId, name, ...(levels ? { thinkingLevels: [...levels] as ThinkingLevel[] } : {}), ...(level ? { thinkingLevel: level as ThinkingLevel } : {}) };
  });
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_manifest', 'Capabilities are required.');
  const cap = value as Record<string, unknown>;
  onlyFields(cap, ['platform', 'sandbox', 'productionShell', 'unsandboxed', 'chatOptions', 'chatImages', 'gitProviders', 'gitPush', 'gitCredentials', 'github', 'githubIssues', 'repositoryCache', 'hostMigration', 'plainGit', 'cloneBackups', 'sessionBranches', 'conversationBackups', 'hostConfig', 'gpu']);
  const platform = text(cap.platform, 'platform', 40);
  if (!/^[a-zA-Z0-9._-]+$/.test(platform) || typeof cap.sandbox !== 'boolean' || typeof cap.productionShell !== 'boolean' || (cap.productionShell && !cap.sandbox)
    || (cap.unsandboxed !== undefined && typeof cap.unsandboxed !== 'boolean') || (cap.unsandboxed && cap.sandbox)
    || (cap.chatOptions !== undefined && typeof cap.chatOptions !== 'boolean') || (cap.gitProviders !== undefined && typeof cap.gitProviders !== 'boolean')
    || (cap.chatImages !== undefined && typeof cap.chatImages !== 'boolean')
    || (cap.gitPush !== undefined && typeof cap.gitPush !== 'boolean')
    || (cap.gitCredentials !== undefined && typeof cap.gitCredentials !== 'boolean') || (cap.gitCredentials && !cap.gitPush)
    || (cap.github !== undefined && typeof cap.github !== 'boolean')
    || (cap.githubIssues !== undefined && typeof cap.githubIssues !== 'boolean')
    || (cap.repositoryCache !== undefined && typeof cap.repositoryCache !== 'boolean')
    || (cap.hostMigration !== undefined && typeof cap.hostMigration !== 'boolean')
    || (cap.plainGit !== undefined && typeof cap.plainGit !== 'boolean')
    || (cap.cloneBackups !== undefined && typeof cap.cloneBackups !== 'boolean') || (cap.cloneBackups && (!cap.plainGit || cap.unsandboxed))
    || (cap.sessionBranches !== undefined && typeof cap.sessionBranches !== 'boolean') || (cap.sessionBranches && !cap.plainGit)
    || (cap.conversationBackups !== undefined && typeof cap.conversationBackups !== 'boolean')
    || (cap.hostConfig !== undefined && typeof cap.hostConfig !== 'boolean')
    // Unsandboxed commands already run on the host itself; a GPU is lent only to sandboxed ones.
    || (cap.gpu !== undefined && (!gpuKinds.includes(cap.gpu as GpuKind) || cap.unsandboxed))) fail(400, 'invalid_manifest', 'Invalid capabilities.');
  return { models, capabilities: { platform, sandbox: cap.sandbox, productionShell: cap.productionShell, ...(cap.unsandboxed ? { unsandboxed: true } : {}), ...(cap.chatOptions ? { chatOptions: true } : {}),
    ...(cap.chatImages ? { chatImages: true } : {}), ...(cap.gitProviders ? { gitProviders: true } : {}), ...(cap.gitPush ? { gitPush: true } : {}), ...(cap.gitCredentials ? { gitCredentials: true } : {}),
    ...(cap.github ? { github: true } : {}), ...(cap.githubIssues ? { githubIssues: true } : {}), ...(cap.repositoryCache ? { repositoryCache: true } : {}),
    ...(cap.hostMigration ? { hostMigration: true } : {}), ...(cap.plainGit ? { plainGit: true } : {}), ...(cap.cloneBackups ? { cloneBackups: true } : {}),
    ...(cap.sessionBranches ? { sessionBranches: true } : {}), ...(cap.conversationBackups ? { conversationBackups: true } : {}),
    ...(cap.hostConfig ? { hostConfig: true } : {}), ...(cap.gpu ? { gpu: cap.gpu as GpuKind } : {}) } };
}

function requireConnectorTLS(env: Env, url: URL): void {
  if (url.protocol !== 'https:' && !(testMode(env) && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    fail(400, 'secure_transport_required', 'Connector credentials require HTTPS.');
  }
}

export async function authenticateConnector(c: AppContext, currentConnection = true): Promise<ConnectorRow> {
  requireConnectorTLS(c.env, new URL(c.req.url));
  const authorization = c.req.header('authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  return authenticateConnectorToken(c.env, authorization.slice(7), currentConnection ? c.req.header('x-connection-token') : undefined, currentConnection);
}
export async function authenticateConnectorToken(env: Env, token: string, connectionToken?: string, currentConnection = false): Promise<ConnectorRow> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  const row = await env.DB.query<ConnectorRow>(`SELECT c.* FROM connectors c JOIN users u ON u.id = c.owner_id
    WHERE c.credential_hash = ? AND c.revoked_at IS NULL AND u.suspended_at IS NULL AND (? = 1 OR u.auth_kind <> 'test')`)
    .bind(await sha256(token), testMode(env) ? 1 : 0).first();
  if (!row) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  if (currentConnection && (!connectionToken || !/^[A-Za-z0-9_-]{43}$/.test(connectionToken) || !row.connection_hash || !constantTimeEqual(await sha256(connectionToken), row.connection_hash))) {
    fail(401, 'stale_connection', 'A current connector connection is required.');
  }
  return row;
}

/**
 * Authenticates a `/api/connectors/socket` upgrade request before the HTTP server hands the
 * socket to the connector hub. Throws the same HTTPExceptions as the other connector routes;
 * the caller turns them into a plain HTTP response on the raw socket.
 */
export async function authenticateConnectorSocket(env: Env, headers: Headers, url: URL): Promise<{ connectorId: string; credentialHash: string }> {
  requireConnectorTLS(env, url);
  const origin = headers.get('origin');
  if (origin && origin !== appOrigin(env)) fail(403, 'invalid_origin', 'Request origin is not allowed.');
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') fail(403, 'invalid_origin', 'Cross-site requests are not allowed.');
  if (headers.get('cookie')) fail(401, 'connector_authentication_required', 'Use connector credentials, not a browser session.');
  const protocols = (headers.get('sec-websocket-protocol') ?? '').split(',').map(item => item.trim());
  if (protocols.length !== 2 || !protocols.includes('opencara-pi-v1')) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  const credential = protocols.find(item => item.startsWith('bearer.'))?.slice(7) ?? '';
  const row = await authenticateConnectorToken(env, credential);
  appOrigin(env);
  if (!env.CONNECTOR_HUB) fail(503, 'connector_unavailable', 'Connector relay is not configured.');
  return { connectorId: row.id, credentialHash: row.credential_hash };
}

export async function requireConnectorSession(env: Env, connectorId: string, row: SessionRow, expectedConnectionHash?: string): Promise<void> {
  if (row.connector_id !== connectorId || !row.connector_owner_id) fail(403, 'connector_binding_mismatch', 'Connector does not own this route.');
  const allowed = await env.DB.query(`SELECT c.id FROM connectors c
    JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = ?
    JOIN workspace_members host ON host.workspace_id = cw.workspace_id AND host.user_id = c.owner_id
    JOIN workspace_members owner ON owner.workspace_id = cw.workspace_id AND owner.user_id = ?
    JOIN users u ON u.id = c.owner_id
    JOIN users session_owner ON session_owner.id = owner.user_id
    JOIN agent_versions a ON a.id = ? JOIN models m ON m.id = a.model_id
    WHERE c.id = ? AND c.owner_id = ? AND c.revoked_at IS NULL AND u.suspended_at IS NULL AND session_owner.suspended_at IS NULL
      AND (c.owner_id = owner.user_id OR EXISTS (SELECT 1 FROM connector_shares sh
        WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
      AND m.connector_id = c.id AND m.connector_owner_id = c.owner_id AND m.workspace_id = cw.workspace_id
      AND EXISTS (SELECT 1 FROM json_each(c.models_json) local_model
        WHERE json_extract(local_model.value, '$.provider') = m.provider AND json_extract(local_model.value, '$.modelId') = m.model_id)
      AND m.available = 1 AND (? = 1 OR (u.auth_kind <> 'test' AND m.provider <> 'faux'))
      AND (? IS NULL OR c.connection_hash = ?)
      AND NOT EXISTS (SELECT 1 FROM sessions current_session WHERE current_session.id = ? AND current_session.policy_version <> ?)`)
    .bind(row.workspace_id, row.owner_id, row.agent_version_id, connectorId, row.connector_owner_id, testMode(env) ? 1 : 0,
      expectedConnectionHash ?? null, expectedConnectionHash ?? null, row.id, row.policy_version).first();
  if (!allowed) fail(403, 'connector_unavailable', 'The connector or its workspace sharing is no longer authorized.');
}

/**
 * A runner callback about `row` comes from the connector serving it over its current connection, or, for sessions
 * without a connector, through the shared-secret internal route.
 */
export async function requireCallbackScope(c: AppContext, row: SessionRow, connectorId: string | null): Promise<void> {
  if (connectorId) {
    const connector = await authenticateConnector(c);
    if (connector.id !== connectorId) fail(403, 'connector_binding_mismatch', 'Connector scope changed.');
    await requireConnectorSession(c.env, connectorId, row, connector.connection_hash!);
  } else if (row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped callback.');
}

/**
 * A connector reports what the agent of a session it serves is doing (see SessionActivity). Activity is display state,
 * neither binding nor policy: it bumps no policy version and leaves no audit entry.
 */
async function reportSessionActivity(c: AppContext, connectorId: string): Promise<Response> {
  const input = await jsonObject(c, 4096);
  const activity = input.activity as SessionActivity;
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'activity') || !sessionActivities.includes(activity)) {
    fail(400, 'invalid_activity', 'Invalid session activity.');
  }
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(input.sessionId, 'sessionId')).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  if (row.activity !== activity) {
    await c.env.DB.query('UPDATE sessions SET activity = ? WHERE id = ? AND connector_id = ?').bind(activity, row.id, connectorId).run();
    // An agent at work changes the session: the next automatic backup has something new to save.
    if (activity === 'working') await markSessionChanged(c.env, row.id);
  }
  return c.json({ ok: true });
}

async function ownedConnector(c: AppContext): Promise<ConnectorRow> {
  const row = await c.env.DB.query<ConnectorRow>('SELECT * FROM connectors WHERE id = ? AND owner_id = ? AND removed_at IS NULL')
    .bind(identifier(c.req.param('id')), c.get('auth').userId).first();
  if (!row) fail(404, 'not_found', 'Connector not found.');
  return row;
}

type ConnectorInfoRow = ConnectorRow & { owner_name?: string; workspace_ids?: string; connected_workspace_ids?: string };
/**
 * Who reads the listing: `role` adds the host's admins and host command grants for its owner and admins; `workspaceId`
 * adds the viewer's own host command authority there.
 */
type InfoViewer = { userId: string; role?: 'owner' | 'admin'; workspaceId?: string };
async function connectorInfo(env: Env, row: ConnectorInfoRow, viewer?: InfoViewer): Promise<ConnectorInfo> {
  const ownerName = row.owner_name ?? (await env.DB.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?')
    .bind(row.owner_id).first())?.display_name ?? '';
  const workspaceIds: string[] = row.workspace_ids !== undefined ? JSON.parse(row.workspace_ids) :
    (await env.DB.query<{ workspace_id: string }>(`SELECT s.workspace_id FROM connector_shares s JOIN workspace_members m
      ON m.workspace_id = s.workspace_id AND m.user_id = ? WHERE s.connector_id = ? ORDER BY s.workspace_id LIMIT 50`)
      .bind(row.owner_id, row.id).all()).map(item => item.workspace_id);
  const connectedWorkspaceIds: string[] = row.connected_workspace_ids !== undefined ? JSON.parse(row.connected_workspace_ids) :
    (await env.DB.query<{ workspace_id: string }>(`SELECT cw.workspace_id FROM connector_workspaces cw JOIN workspace_members m
      ON m.workspace_id = cw.workspace_id AND m.user_id = ? WHERE cw.connector_id = ? ORDER BY cw.workspace_id`)
      .bind(row.owner_id, row.id).all()).map(item => item.workspace_id);
  let online = false;
  if (!row.revoked_at && env.CONNECTOR_HUB) {
    try {
      online = await env.CONNECTOR_HUB.status(row.id, 2000);
    } catch { /* Offline is safe metadata; do not expose transport errors. */ }
  }
  const [admins, grants, config, hostCommandAccess, memberships] = await Promise.all([
    viewer?.role ? connectorAdmins(env, row.id) : undefined,
    viewer?.role ? connectorHostGrants(env, row.id) : undefined,
    viewer?.role ? connectorHostConfig(env, row.id) : undefined,
    viewer?.workspaceId ? viewerHostCommands(env, row, viewer.workspaceId, viewer.userId) : undefined,
    // An admin sees the owner's workspaces only where they are a member too.
    viewer?.role === 'admin' ? env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_members WHERE user_id = ?')
      .bind(viewer.userId).all().then(items => new Set(items.map(item => item.workspace_id))) : undefined,
  ]);
  const visible = (workspaceId: string) => !memberships || memberships.has(workspaceId);
  const hostGrants = grants?.filter(grant => visible(grant.workspaceId));
  return { id: row.id, ownerId: row.owner_id, ownerName, name: row.name,
    createdAt: row.created_at, revokedAt: row.revoked_at, online, models: JSON.parse(row.models_json),
    workspaceIds: workspaceIds.filter(visible), connectedWorkspaceIds: connectedWorkspaceIds.filter(visible), capabilities: JSON.parse(row.capabilities_json),
    ...(viewer?.role ? { role: viewer.role, admins, hostGrants, config } : {}), ...(hostCommandAccess ? { hostCommandAccess } : {}) };
}

async function connectorInfos(env: Env, rows: ConnectorInfoRow[], viewer?: (row: ConnectorInfoRow) => InfoViewer): Promise<ConnectorInfo[]> {
  const result: ConnectorInfo[] = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    result.push(...await Promise.all(rows.slice(offset, offset + 4).map(row => connectorInfo(env, row, viewer?.(row)))));
  }
  return result;
}

function modelStatements(env: Env, row: Pick<ConnectorRow, 'id' | 'models_json'>, workspaceId: string | null): Query<never>[] {
  // Import with two set-based statements, not one query per model or workspace.
  return [
    env.DB.query<never>(`UPDATE models SET available = 0 WHERE connector_id = ? AND (? IS NULL OR workspace_id = ?)
      AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND models_json = ? AND revoked_at IS NULL)`)
      .bind(row.id, workspaceId, workspaceId, row.id, row.models_json),
    env.DB.query<never>(`INSERT INTO models
      (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
      SELECT lower(hex(randomblob(16))), cw.workspace_id, json_extract(local.value, '$.name'),
        json_extract(local.value, '$.provider'), json_extract(local.value, '$.modelId'), ?, c.id, c.owner_id, 1
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN json_each(c.models_json) local
      WHERE c.id = ? AND c.revoked_at IS NULL AND c.models_json = ? AND (? IS NULL OR cw.workspace_id = ?)
      ON CONFLICT (workspace_id, connector_id, provider, model_id) DO UPDATE SET name = excluded.name, available = 1`)
      .bind(now(), row.id, row.models_json, workspaceId, workspaceId),
  ];
}

async function syncModels(env: Env, row: ConnectorRow, workspaceId: string | null): Promise<void> {
  await env.DB.batch(modelStatements(env, row, workspaceId));
}

/**
 * A host belongs to its owner, not to one workspace: it is connected, for the owner's private use, to every workspace
 * they belong to. These statements connect `userId`'s hosts to `workspaceId` and import their models there, once the
 * user is a member of it (a workspace they create or join); without that membership they change nothing.
 */
export function ownerHostStatements(env: Env, userId: string, workspaceId: string): Query<never>[] {
  const createdAt = now();
  return [
    env.DB.query<never>(`INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
      SELECT c.id, m.workspace_id, ? FROM connectors c
      JOIN workspace_members m ON m.user_id = c.owner_id AND m.workspace_id = ?
      WHERE c.owner_id = ? AND c.revoked_at IS NULL
      ON CONFLICT (connector_id, workspace_id) DO NOTHING`)
      .bind(createdAt, workspaceId, userId),
    env.DB.query<never>(`UPDATE models SET available = 0 WHERE workspace_id = ? AND connector_owner_id = ?
      AND connector_id IN (SELECT id FROM connectors WHERE owner_id = ? AND revoked_at IS NULL)`)
      .bind(workspaceId, userId, userId),
    env.DB.query<never>(`INSERT INTO models
      (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
      SELECT lower(hex(randomblob(16))), cw.workspace_id, json_extract(local.value, '$.name'),
        json_extract(local.value, '$.provider'), json_extract(local.value, '$.modelId'), ?, c.id, c.owner_id, 1
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = ?
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN json_each(c.models_json) local
      WHERE c.owner_id = ? AND c.revoked_at IS NULL
      ON CONFLICT (workspace_id, connector_id, provider, model_id) DO UPDATE SET name = excluded.name, available = 1`)
      .bind(createdAt, workspaceId, userId),
  ];
}

export function registerConnectorCredentials(app: Hono<WorkerEnv>): void {
  app.post('/api/connectors/pairings/:id/claim', async c => {
    requireConnectorTLS(c.env, new URL(c.req.url));
    requireOrigin(c);
    const input = await jsonObject(c, 128 * 1024);
    onlyFields(input, ['code', 'models', 'capabilities']);
    const manifest = withHostToolCapabilities(input, base => parseManifest(base, c.env));
    const pairingId = identifier(c.req.param('id'));
    const code = text(input.code, 'code', 128);
    const controlPlaneUrl = appOrigin(c.env);
    const codeHash = await sha256(code);
    const pairing = await c.env.DB.query<{ owner_id: string }>(`SELECT owner_id FROM connector_pairings
      WHERE id = ? AND code_hash = ? AND claimed_at IS NULL AND expires_at > ?`)
      .bind(pairingId, codeHash, Math.floor(Date.now() / 1000))
      .first();
    if (!pairing) fail(403, 'invalid_pairing', 'Pairing is expired, used, or invalid.');
    const connectorId = id();
    const token = randomToken();
    const credentialHash = await sha256(token);
    const createdAt = now();
    // Consume the code, create the connector and connect it privately to its owner's workspaces in one transaction.
    // A pairing names no workspace: the host is its owner's, wherever they work (ownerHostStatements).
    // INSERT rechecks authority after the asynchronous preflight and token hashing.
    const results = await c.env.DB.batch<ConnectorRow>([
      c.env.DB.query<ConnectorRow>(`INSERT INTO connectors (id,owner_id,name,credential_hash,created_at,models_json,capabilities_json)
        SELECT ?, p.owner_id, p.name, ?, ?, ?, ? FROM connector_pairings p
        JOIN users u ON u.id = p.owner_id
        WHERE p.id = ? AND p.code_hash = ? AND p.claimed_at IS NULL AND p.expires_at > ?
        AND p.owner_id = ?
        AND (? = 1 OR u.auth_kind <> 'test')
        AND (SELECT COUNT(*) FROM connectors WHERE owner_id = p.owner_id AND revoked_at IS NULL) < 20
        RETURNING *`)
        .bind(connectorId, credentialHash, createdAt, JSON.stringify(manifest.models), JSON.stringify(manifest.capabilities),
          pairingId, codeHash, Math.floor(Date.now() / 1000), pairing.owner_id, testMode(c.env) ? 1 : 0),
      c.env.DB.query<never>(`UPDATE connector_pairings SET claimed_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND credential_hash = ?)`)
        .bind(createdAt, pairingId, connectorId, credentialHash),
      c.env.DB.query<never>(`INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
        SELECT c.id, m.workspace_id, ? FROM connectors c JOIN workspace_members m ON m.user_id = c.owner_id
        WHERE c.id = ? ON CONFLICT (connector_id, workspace_id) DO NOTHING`)
        .bind(createdAt, connectorId),
      ...modelStatements(c.env, { id: connectorId, models_json: JSON.stringify(manifest.models) }, null),
    ]);
    const created = results[0].results[0];
    if (!created) fail(403, 'invalid_pairing', 'Pairing is expired, used, or invalid.');
    return c.json({ credentials: { connectorId, token, controlPlaneUrl } }, 201);
  });
  // The upgrade itself is completed by the HTTP server (`main.ts`) with `authenticateConnectorSocket`;
  // a plain request to the socket path cannot be upgraded inside Hono.
  app.get('/api/connectors/socket', () => fail(426, 'upgrade_required', 'WebSocket upgrade is required.'));
  app.post('/api/connectors/self/manifest', async c => {
    const row = await authenticateConnector(c);
    const input = await jsonObject(c, 128 * 1024);
    onlyFields(input, ['models', 'capabilities']);
    const manifest = withHostToolCapabilities(input, base => parseManifest(base, c.env));
    const updated = await c.env.DB.query<ConnectorRow>(`UPDATE connectors SET models_json = ?, capabilities_json = ? WHERE id = ?
      AND revoked_at IS NULL AND connection_hash = ? RETURNING *`)
      .bind(JSON.stringify(manifest.models), JSON.stringify(manifest.capabilities), row.id, row.connection_hash).first();
    if (!updated) fail(401, 'stale_connection', 'Connection has been replaced.');
    await syncModels(c.env, updated, null);
    return c.json({ ok: true });
  });
  app.post('/api/connectors/self/authorize', async c => authorizeSession(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/activity', async c => reportSessionActivity(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/comment', async c => githubComment(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/read', async c => githubRead(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/merge', async c => githubMerge(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/issue', async c => githubIssue(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/git/push/credential', async c => pushCredential(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/git/push/complete', async c => pushComplete(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/restores/:restoreId/download', async c => connectorRestoreDownload(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/network', async c => egressGrant(c, (await authenticateConnector(c)).id));
  // How the host runs its sessions, as its owner and admins set it; the connector asks when it connects and every minute.
  app.post('/api/connectors/self/config', async c => c.json({ config: await connectorHostConfig(c.env, (await authenticateConnector(c)).id) }));
  app.post('/api/connectors/self/git/relay/:bindingId/:service', async c => gitRelay(c, await authenticateConnector(c)));
}

export function registerConnectors(app: Hono<WorkerEnv>): void {
  app.post('/api/connectors/pairings', async c => {
    const input = await jsonObject(c, 4096);
    // `workspaceId` is accepted, and ignored, from pages that predate it: a host is no longer paired into a workspace.
    onlyFields(input, ['name', 'workspaceId']);
    const name = text(input.name, 'name', 120);
    const ownerId = c.get('auth').userId;
    const pairingId = id(); const code = randomToken(); const expires = Math.floor(Date.now() / 1000) + 600;
    await c.env.DB.query('DELETE FROM connector_pairings WHERE owner_id = ? AND expires_at <= ?').bind(ownerId, Math.floor(Date.now() / 1000)).run();
    const created = await c.env.DB.query(`INSERT INTO connector_pairings (id,owner_id,name,code_hash,expires_at,created_at,workspace_id)
      SELECT ?,?,?,?,?,?,NULL WHERE (SELECT COUNT(*) FROM connector_pairings WHERE owner_id = ?) < 5
      AND (SELECT COUNT(*) FROM connectors WHERE owner_id = ? AND revoked_at IS NULL) < 20
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND (? = 1 OR auth_kind <> 'test')) RETURNING id`)
      .bind(pairingId, ownerId, name, await sha256(code), expires, now(), ownerId, ownerId, ownerId, testMode(c.env) ? 1 : 0).first();
    if (!created) {
      // The write refuses a test user once test mode is off: a refusal, not a limit, so tell them apart.
      const testUser = await c.env.DB.query('SELECT 1 FROM users WHERE id = ? AND auth_kind = \'test\'').bind(ownerId).first();
      if (testUser && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Test users can pair hosts only while test mode is on.');
      fail(429, 'pairing_limit', 'Too many active pairings or connectors.');
    }
    return c.json({ pairing: { id: pairingId, code, expiresAt: new Date(expires * 1000).toISOString() } }, 201);
  });
  app.get('/api/connectors', async c => {
    const rows = await c.env.DB.query<ConnectorInfoRow>(`SELECT c.*, u.display_name AS owner_name,
      (SELECT json_group_array(s.workspace_id) FROM connector_shares s JOIN workspace_members m
        ON m.workspace_id = s.workspace_id AND m.user_id = c.owner_id WHERE s.connector_id = c.id) AS workspace_ids,
      (SELECT json_group_array(cw.workspace_id) FROM connector_workspaces cw JOIN workspace_members m
        ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id WHERE cw.connector_id = c.id) AS connected_workspace_ids
      FROM connectors c JOIN users u ON u.id = c.owner_id WHERE c.removed_at IS NULL
        AND (c.owner_id = ? OR EXISTS (SELECT 1 FROM connector_admins a WHERE a.connector_id = c.id AND a.user_id = ?))
      ORDER BY c.created_at DESC LIMIT 100`)
      .bind(c.get('auth').userId, c.get('auth').userId).all();
    const userId = c.get('auth').userId;
    // Owners and admins see its admins and grants; an admin's listing names the owner's shares, which they manage.
    return c.json({ connectors: await connectorInfos(c.env, rows, row => ({ userId, role: row.owner_id === userId ? 'owner' : 'admin' })) });
  });
  app.get('/api/workspaces/:id/connectors', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const rows = await c.env.DB.query<ConnectorInfoRow>(`SELECT c.*, u.display_name AS owner_name,
      CASE WHEN EXISTS (SELECT 1 FROM connector_shares sh WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id)
        THEN json_array(cw.workspace_id) ELSE json_array() END AS workspace_ids,
      json_array(cw.workspace_id) AS connected_workspace_ids
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN workspace_members actor ON actor.workspace_id = cw.workspace_id AND actor.user_id = ?
      JOIN users u ON u.id = c.owner_id WHERE cw.workspace_id = ? AND c.revoked_at IS NULL
      AND (c.owner_id = actor.user_id OR EXISTS (SELECT 1 FROM connector_shares sh
        WHERE sh.connector_id = c.id AND sh.workspace_id = cw.workspace_id))
      AND (? = 1 OR u.auth_kind <> 'test') ORDER BY c.created_at DESC LIMIT 30`)
      .bind(c.get('auth').userId, workspaceId, testMode(c.env) ? 1 : 0).all();
    const userId = c.get('auth').userId;
    return c.json({ connectors: await connectorInfos(c.env, rows, () => ({ userId, workspaceId })) });
  });
  // Its owner or an admin shares a host, into a workspace both they and the owner belong to.
  app.put('/api/connectors/:id/shares/:workspaceId', async c => {
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const workspaceId = identifier(c.req.param('workspaceId'));
    await requireManagedWorkspace(c.env, row, workspaceId, c.get('auth').userId);
    await requireMember(c.env, workspaceId, row.owner_id);
    await requireConfiguredWorkspace(c.env, workspaceId, row.owner_id);
    const legacy = testMode(c.env) && await legacyRepositoryFixture(c.env, row.owner_id);
    const results = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO connector_shares (connector_id,workspace_id,created_at)
      SELECT ?,?,? WHERE ((SELECT COUNT(*) FROM connector_shares WHERE connector_id = ?) < 50
        OR EXISTS (SELECT 1 FROM connector_shares WHERE connector_id = ? AND workspace_id = ?))
      AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND owner_id = ? AND revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
      AND (EXISTS (SELECT 1 FROM workspace_repositories WHERE workspace_id = ?)
        OR (? = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_kind = 'test')))
      ON CONFLICT (connector_id, workspace_id) DO UPDATE SET created_at = connector_shares.created_at
      RETURNING connector_id`)
      .bind(row.id, workspaceId, now(), row.id, row.id, workspaceId, row.id, row.owner_id, workspaceId, row.owner_id,
        workspaceId, legacy && testMode(c.env) ? 1 : 0, row.owner_id),
      c.env.DB.query(`INSERT INTO connector_workspaces (connector_id,workspace_id,created_at)
        SELECT ?,?,? WHERE changes() = 1
        ON CONFLICT (connector_id, workspace_id) DO NOTHING`).bind(row.id, workspaceId, now()),
    ]);
    const shared = results[0].results[0];
    if (!shared) {
      const atLimit = await c.env.DB.query(`SELECT 1 WHERE
        (SELECT COUNT(*) FROM connector_shares WHERE connector_id = ?) >= 50
        AND NOT EXISTS (SELECT 1 FROM connector_shares WHERE connector_id = ? AND workspace_id = ?)`)
        .bind(row.id, row.id, workspaceId).first();
      if (atLimit) fail(429, 'share_limit', 'Connector share limit reached.');
      fail(409, 'share_unavailable', 'Connector or workspace authority changed.');
    }
    await syncModels(c.env, row, workspaceId);
    await auditStatement(c.env, c.get('auth').userId, 'connector.share.added', workspaceId, null, { connectorId: row.id }).run();
    return c.json({ connector: await connectorInfo(c.env, row) });
  });
  // Unsharing also ends the workspace's host command grants. An admin unshares only where they are a member.
  app.delete('/api/connectors/:id/shares/:workspaceId', async c => {
    const row = await managedConnector(c);
    const workspaceId = identifier(c.req.param('workspaceId'));
    await requireManagedWorkspace(c.env, row, workspaceId, c.get('auth').userId);
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM connector_shares WHERE connector_id = ? AND workspace_id = ?').bind(row.id, workspaceId),
      c.env.DB.query('DELETE FROM connector_host_grants WHERE connector_id = ? AND workspace_id = ?').bind(row.id, workspaceId),
      auditStatement(c.env, c.get('auth').userId, 'connector.share.removed', workspaceId, null, { connectorId: row.id }),
      c.env.DB.query(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE connector_id = ? AND workspace_id = ? AND owner_id <> ?`).bind(row.id, workspaceId, row.owner_id),
    ]);
    return c.body(null, 204);
  });
  app.delete('/api/connectors/:id/permanent', async c => {
    const row = await ownedConnector(c);
    const timestamp = now();
    // Keep a revoked tombstone for immutable session and model bindings.
    await c.env.DB.batch([
      c.env.DB.query(`UPDATE connectors SET removed_at = ?, revoked_at = COALESCE(revoked_at, ?),
        connection_hash = NULL, credential_hash = ?, name = 'Removed host', models_json = '[]', capabilities_json = '{}'
        WHERE id = ?`).bind(timestamp, timestamp, await sha256(randomToken()), row.id),
      c.env.DB.query('DELETE FROM connector_shares WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_workspaces WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_host_grants WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('DELETE FROM connector_admins WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('UPDATE models SET available = 0 WHERE connector_id = ?').bind(row.id),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE connector_id = ?').bind(row.id),
    ]);
    if (c.env.CONNECTOR_HUB) {
      try { await c.env.CONNECTOR_HUB.revoke(row.id); }
      catch { /* Database revocation already fences all authority. */ }
    }
    return c.body(null, 204);
  });
  app.delete('/api/connectors/:id', async c => {
    const row = await ownedConnector(c);
    await c.env.DB.batch([
      c.env.DB.query('UPDATE connectors SET revoked_at = COALESCE(revoked_at, ?), connection_hash = NULL WHERE id = ?').bind(now(), row.id),
      c.env.DB.query('UPDATE sessions SET policy_version = policy_version + 1 WHERE connector_id = ?').bind(row.id),
    ]);
    if (c.env.CONNECTOR_HUB) {
      try {
        await c.env.CONNECTOR_HUB.revoke(row.id);
      } catch { /* Database revocation already fences all authority. */ }
    }
    return c.body(null, 204);
  });
}
