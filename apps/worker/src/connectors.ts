import type { Hono } from 'hono';
import type { ConnectorCapabilities, ConnectorInfo, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { requireMember } from './db.js';
import { appOrigin, fail, id, identifier, jsonObject, now, randomToken, requireOrigin, testMode, text } from './http.js';
import { authorizeSession, githubComment } from './internal.js';
import { connectorRestoreDownload } from './restore-routes.js';
import { legacyRepositoryFixture, repositoryDownload, requireConfiguredWorkspace } from './repositories.js';

export interface ConnectorRow {
  id: string; owner_id: string; name: string; credential_hash: string; revoked_at: string | null;
  created_at: string; last_seen_at: string | null; connection_hash: string | null;
  models_json: string; capabilities_json: string;
}

function onlyFields(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) fail(400, 'invalid_metadata', 'Only model and capability metadata is accepted.');
}
export function parseManifest(input: Record<string, unknown>, env: Env): { models: LocalModelSummary[]; capabilities: ConnectorCapabilities } {
  if (!Array.isArray(input.models) || input.models.length > 200) fail(400, 'invalid_manifest', 'At most 200 models may be advertised.');
  const seen = new Set<string>();
  const models = input.models.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_manifest', 'Invalid model metadata.');
    onlyFields(value, ['provider', 'modelId', 'name']);
    const provider = text(value.provider, 'provider', 80);
    const modelId = text(value.modelId, 'modelId', 200);
    const name = text(value.name, 'name', 120);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || /[\x00-\x1f\x7f]/.test(modelId + name)) fail(400, 'invalid_manifest', 'Invalid model metadata.');
    if (provider === 'faux' && !testMode(env)) fail(403, 'test_mode_disabled', 'Faux models are disabled.');
    const key = JSON.stringify([provider, modelId]);
    if (seen.has(key)) fail(400, 'invalid_manifest', 'Duplicate model metadata.');
    seen.add(key);
    return { provider, modelId, name };
  });
  const value = input.capabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_manifest', 'Capabilities are required.');
  const cap = value as Record<string, unknown>;
  onlyFields(cap, ['platform', 'sandbox', 'productionShell']);
  const platform = text(cap.platform, 'platform', 40);
  if (!/^[a-zA-Z0-9._-]+$/.test(platform) || typeof cap.sandbox !== 'boolean' || typeof cap.productionShell !== 'boolean' || (cap.productionShell && !cap.sandbox)) fail(400, 'invalid_manifest', 'Invalid capabilities.');
  return { models, capabilities: { platform, sandbox: cap.sandbox, productionShell: cap.productionShell } };
}

function requireConnectorTLS(c: AppContext): void {
  const url = new URL(c.req.url);
  if (url.protocol !== 'https:' && !(testMode(c.env) && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    fail(400, 'secure_transport_required', 'Connector credentials require HTTPS.');
  }
}

export async function authenticateConnector(c: AppContext, currentConnection = true): Promise<ConnectorRow> {
  requireConnectorTLS(c);
  const authorization = c.req.header('authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  return authenticateConnectorToken(c.env, authorization.slice(7), currentConnection ? c.req.header('x-connection-token') : undefined, currentConnection);
}
export async function authenticateConnectorToken(env: Env, token: string, connectionToken?: string, currentConnection = false): Promise<ConnectorRow> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  const row = await env.DB.prepare(`SELECT c.* FROM connectors c JOIN users u ON u.id = c.owner_id
    WHERE c.credential_hash = ? AND c.revoked_at IS NULL AND (? = 1 OR u.auth_kind <> 'test')`)
    .bind(await sha256(token), testMode(env) ? 1 : 0).first<ConnectorRow>();
  if (!row) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
  if (currentConnection && (!connectionToken || !/^[A-Za-z0-9_-]{43}$/.test(connectionToken) || !row.connection_hash || !constantTimeEqual(await sha256(connectionToken), row.connection_hash))) {
    fail(401, 'stale_connection', 'A current connector connection is required.');
  }
  return row;
}

export async function requireConnectorSession(env: Env, connectorId: string, row: SessionRow, expectedConnectionHash?: string): Promise<void> {
  if (row.connector_id !== connectorId || !row.connector_owner_id) fail(403, 'connector_binding_mismatch', 'Connector does not own this route.');
  const allowed = await env.DB.prepare(`SELECT c.id FROM connectors c
    JOIN connector_workspaces cw ON cw.connector_id = c.id AND cw.workspace_id = ?
    JOIN workspace_members host ON host.workspace_id = cw.workspace_id AND host.user_id = c.owner_id
    JOIN workspace_members owner ON owner.workspace_id = cw.workspace_id AND owner.user_id = ?
    JOIN users u ON u.id = c.owner_id
    JOIN agent_versions a ON a.id = ? JOIN models m ON m.id = a.model_id
    WHERE c.id = ? AND c.owner_id = ? AND c.revoked_at IS NULL
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

async function ownedConnector(c: AppContext): Promise<ConnectorRow> {
  const row = await c.env.DB.prepare('SELECT * FROM connectors WHERE id = ? AND owner_id = ?')
    .bind(identifier(c.req.param('id')), c.get('auth').userId).first<ConnectorRow>();
  if (!row) fail(404, 'not_found', 'Connector not found.');
  return row;
}

type ConnectorInfoRow = ConnectorRow & { owner_name?: string; workspace_ids?: string; connected_workspace_ids?: string };
async function connectorInfo(env: Env, row: ConnectorInfoRow): Promise<ConnectorInfo> {
  const ownerName = row.owner_name ?? (await env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(row.owner_id).first<{ display_name: string }>())?.display_name ?? '';
  const workspaceIds: string[] = row.workspace_ids !== undefined ? JSON.parse(row.workspace_ids) :
    (await env.DB.prepare(`SELECT s.workspace_id FROM connector_shares s JOIN workspace_members m
      ON m.workspace_id = s.workspace_id AND m.user_id = ? WHERE s.connector_id = ? ORDER BY s.workspace_id LIMIT 50`)
      .bind(row.owner_id, row.id).all<{ workspace_id: string }>()).results.map(item => item.workspace_id);
  const connectedWorkspaceIds: string[] = row.connected_workspace_ids !== undefined ? JSON.parse(row.connected_workspace_ids) :
    (await env.DB.prepare(`SELECT cw.workspace_id FROM connector_workspaces cw JOIN workspace_members m
      ON m.workspace_id = cw.workspace_id AND m.user_id = ? WHERE cw.connector_id = ? ORDER BY cw.workspace_id`)
      .bind(row.owner_id, row.id).all<{ workspace_id: string }>()).results.map(item => item.workspace_id);
  let online = false;
  if (!row.revoked_at && env.CONNECTOR_HUB) {
    try {
      const response = await env.CONNECTOR_HUB.get(env.CONNECTOR_HUB.idFromName(row.id))
        .fetch('https://connector.internal/status', { signal: AbortSignal.timeout(2000) });
      if (response.ok) online = (await response.json() as { online?: boolean }).online === true;
    } catch { /* Offline is safe metadata; do not expose transport errors. */ }
  }
  return { id: row.id, ownerId: row.owner_id, ownerName, name: row.name,
    createdAt: row.created_at, revokedAt: row.revoked_at, online, models: JSON.parse(row.models_json),
    workspaceIds, connectedWorkspaceIds, capabilities: JSON.parse(row.capabilities_json) };
}

async function connectorInfos(env: Env, rows: ConnectorInfoRow[]): Promise<ConnectorInfo[]> {
  const result: ConnectorInfo[] = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    result.push(...await Promise.all(rows.slice(offset, offset + 4).map(row => connectorInfo(env, row))));
  }
  return result;
}

function modelStatements(env: Env, row: Pick<ConnectorRow, 'id' | 'models_json'>, workspaceId: string | null): D1PreparedStatement[] {
  // Import with two set-based statements, not one D1 query per model or workspace.
  return [
    env.DB.prepare(`UPDATE models SET available = 0 WHERE connector_id = ? AND (? IS NULL OR workspace_id = ?)
      AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND models_json = ? AND revoked_at IS NULL)`)
      .bind(row.id, workspaceId, workspaceId, row.id, row.models_json),
    env.DB.prepare(`INSERT INTO models
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

export function registerConnectorCredentials(app: Hono<WorkerEnv>): void {
  app.post('/api/connectors/pairings/:id/claim', async c => {
    requireConnectorTLS(c);
    requireOrigin(c);
    const input = await jsonObject(c, 128 * 1024);
    onlyFields(input, ['code', 'models', 'capabilities']);
    const manifest = parseManifest(input, c.env);
    const pairingId = identifier(c.req.param('id'));
    const code = text(input.code, 'code', 128);
    const controlPlaneUrl = appOrigin(c.env);
    const codeHash = await sha256(code);
    const pairing = await c.env.DB.prepare(`SELECT owner_id, name, workspace_id FROM connector_pairings
      WHERE id = ? AND code_hash = ? AND claimed_at IS NULL AND expires_at > ?`)
      .bind(pairingId, codeHash, Math.floor(Date.now() / 1000))
      .first<{ owner_id: string; name: string; workspace_id: string | null }>();
    if (!pairing) fail(403, 'invalid_pairing', 'Pairing is expired, used, or invalid.');
    const legacy = testMode(c.env) && await legacyRepositoryFixture(c.env, pairing.owner_id);
    if (pairing.workspace_id !== null) {
      await requireMember(c.env, pairing.workspace_id, pairing.owner_id);
      await requireConfiguredWorkspace(c.env, pairing.workspace_id, pairing.owner_id);
    } else if (!legacy) {
      fail(403, 'invalid_pairing', 'Pairing requires a configured workspace.');
    }
    const connectorId = id();
    const token = randomToken();
    const credentialHash = await sha256(token);
    const createdAt = now();
    // Consume the code, create the connector and its private association in one transaction.
    // INSERT rechecks authority after the asynchronous preflight and token hashing.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO connectors (id,owner_id,name,credential_hash,created_at,models_json,capabilities_json)
        SELECT ?, p.owner_id, p.name, ?, ?, ?, ? FROM connector_pairings p
        JOIN users u ON u.id = p.owner_id
        WHERE p.id = ? AND p.code_hash = ? AND p.claimed_at IS NULL AND p.expires_at > ?
        AND p.owner_id = ? AND p.workspace_id IS ?
        AND (? = 1 OR u.auth_kind <> 'test')
        AND (SELECT COUNT(*) FROM connectors WHERE owner_id = p.owner_id AND revoked_at IS NULL) < 20
        AND ((p.workspace_id IS NULL AND ? = 1 AND u.auth_kind = 'test')
          OR (p.workspace_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = p.workspace_id AND user_id = p.owner_id)
            AND (EXISTS (SELECT 1 FROM workspace_repositories WHERE workspace_id = p.workspace_id)
              OR (? = 1 AND u.auth_kind = 'test'))))
        RETURNING *`)
        .bind(connectorId, credentialHash, createdAt, JSON.stringify(manifest.models), JSON.stringify(manifest.capabilities),
          pairingId, codeHash, Math.floor(Date.now() / 1000), pairing.owner_id, pairing.workspace_id,
          testMode(c.env) ? 1 : 0, legacy && testMode(c.env) ? 1 : 0, legacy && testMode(c.env) ? 1 : 0),
      c.env.DB.prepare(`UPDATE connector_pairings SET claimed_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND credential_hash = ?)`)
        .bind(createdAt, pairingId, connectorId, credentialHash),
      c.env.DB.prepare(`INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
        SELECT id, ?, ? FROM connectors WHERE id = ? AND ? IS NOT NULL`)
        .bind(pairing.workspace_id, createdAt, connectorId, pairing.workspace_id),
      ...modelStatements(c.env, { id: connectorId, models_json: JSON.stringify(manifest.models) }, pairing.workspace_id),
    ]);
    const created = results[0].results[0] as ConnectorRow | undefined;
    if (!created) fail(403, 'invalid_pairing', 'Pairing is expired, used, invalid, or its workspace is no longer available.');
    return c.json({ credentials: { connectorId, token, controlPlaneUrl } }, 201);
  });
  app.get('/api/connectors/socket', async c => {
    requireConnectorTLS(c);
    requireOrigin(c);
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') fail(400, 'websocket_required', 'WebSocket upgrade is required.');
    if (c.req.header('cookie')) fail(401, 'connector_authentication_required', 'Use connector credentials, not a browser session.');
    const protocols = (c.req.header('sec-websocket-protocol') ?? '').split(',').map(item => item.trim());
    if (protocols.length !== 2 || !protocols.includes('opencara-pi-v1')) fail(401, 'connector_authentication_required', 'Connector authentication is required.');
    const credential = protocols.find(item => item.startsWith('bearer.'))?.slice(7) ?? '';
    const row = await authenticateConnectorToken(c.env, credential);
    appOrigin(c.env);
    if (!c.env.CONNECTOR_HUB) fail(503, 'connector_unavailable', 'Connector relay is not configured.');
    const headers = new Headers({ Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'opencara-pi-v1',
      'X-Connector-Id': row.id, 'X-Connector-Credential-Hash': row.credential_hash });
    return c.env.CONNECTOR_HUB.get(c.env.CONNECTOR_HUB.idFromName(row.id)).fetch(new Request('https://connector.internal/socket', { headers }));
  });
  app.post('/api/connectors/self/manifest', async c => {
    const row = await authenticateConnector(c);
    const input = await jsonObject(c, 128 * 1024);
    onlyFields(input, ['models', 'capabilities']);
    const manifest = parseManifest(input, c.env);
    const updated = await c.env.DB.prepare(`UPDATE connectors SET models_json = ?, capabilities_json = ? WHERE id = ?
      AND revoked_at IS NULL AND connection_hash = ? RETURNING *`)
      .bind(JSON.stringify(manifest.models), JSON.stringify(manifest.capabilities), row.id, row.connection_hash).first<ConnectorRow>();
    if (!updated) fail(401, 'stale_connection', 'Connection has been replaced.');
    await syncModels(c.env, updated, null);
    return c.json({ ok: true });
  });
  app.post('/api/connectors/self/authorize', async c => authorizeSession(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/github/comment', async c => githubComment(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/restores/:restoreId/download', async c => connectorRestoreDownload(c, (await authenticateConnector(c)).id));
  app.post('/api/connectors/self/repositories/:bindingId/download', async c => repositoryDownload(c, await authenticateConnector(c)));
}

export function registerConnectors(app: Hono<WorkerEnv>): void {
  app.post('/api/connectors/pairings', async c => {
    const input = await jsonObject(c, 4096);
    onlyFields(input, ['name', 'workspaceId']);
    const name = text(input.name, 'name', 120);
    const ownerId = c.get('auth').userId;
    const legacy = testMode(c.env) && await legacyRepositoryFixture(c.env, ownerId);
    const workspaceId = input.workspaceId === undefined && legacy ? null : identifier(input.workspaceId, 'workspaceId');
    if (workspaceId !== null) {
      await requireMember(c.env, workspaceId, ownerId);
      await requireConfiguredWorkspace(c.env, workspaceId, ownerId);
    }
    const pairingId = id(); const code = randomToken(); const expires = Math.floor(Date.now() / 1000) + 600;
    await c.env.DB.prepare('DELETE FROM connector_pairings WHERE owner_id = ? AND expires_at <= ?').bind(ownerId, Math.floor(Date.now() / 1000)).run();
    const created = await c.env.DB.prepare(`INSERT INTO connector_pairings (id,owner_id,name,code_hash,expires_at,created_at,workspace_id)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM connector_pairings WHERE owner_id = ?) < 5
      AND (SELECT COUNT(*) FROM connectors WHERE owner_id = ? AND revoked_at IS NULL) < 20
      AND ((? IS NULL AND ? = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_kind = 'test'))
        OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?)
          AND (EXISTS (SELECT 1 FROM workspace_repositories WHERE workspace_id = ?)
            OR (? = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_kind = 'test'))))) RETURNING id`)
      .bind(pairingId, ownerId, name, await sha256(code), expires, now(), workspaceId, ownerId, ownerId,
        workspaceId, legacy && testMode(c.env) ? 1 : 0, ownerId, workspaceId, workspaceId, ownerId,
        workspaceId, legacy && testMode(c.env) ? 1 : 0, ownerId).first();
    if (!created) fail(429, 'pairing_limit', 'Too many active pairings or connectors.');
    return c.json({ pairing: { id: pairingId, code, expiresAt: new Date(expires * 1000).toISOString() } }, 201);
  });
  app.get('/api/connectors', async c => {
    const rows = await c.env.DB.prepare(`SELECT c.*, u.display_name AS owner_name,
      (SELECT json_group_array(s.workspace_id) FROM connector_shares s JOIN workspace_members m
        ON m.workspace_id = s.workspace_id AND m.user_id = c.owner_id WHERE s.connector_id = c.id) AS workspace_ids,
      (SELECT json_group_array(cw.workspace_id) FROM connector_workspaces cw JOIN workspace_members m
        ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id WHERE cw.connector_id = c.id) AS connected_workspace_ids
      FROM connectors c JOIN users u ON u.id = c.owner_id WHERE c.owner_id = ? ORDER BY c.created_at DESC LIMIT 100`)
      .bind(c.get('auth').userId).all<ConnectorInfoRow>();
    return c.json({ connectors: await connectorInfos(c.env, rows.results) });
  });
  app.get('/api/workspaces/:id/connectors', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const rows = await c.env.DB.prepare(`SELECT c.*, u.display_name AS owner_name,
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
      .bind(c.get('auth').userId, workspaceId, testMode(c.env) ? 1 : 0).all<ConnectorInfoRow>();
    return c.json({ connectors: await connectorInfos(c.env, rows.results) });
  });
  app.put('/api/connectors/:id/shares/:workspaceId', async c => {
    const row = await ownedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const workspaceId = identifier(c.req.param('workspaceId'));
    await requireMember(c.env, workspaceId, row.owner_id);
    await requireConfiguredWorkspace(c.env, workspaceId, row.owner_id);
    const legacy = testMode(c.env) && await legacyRepositoryFixture(c.env, row.owner_id);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO connector_shares (connector_id,workspace_id,created_at)
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
      c.env.DB.prepare(`INSERT INTO connector_workspaces (connector_id,workspace_id,created_at)
        SELECT ?,?,? WHERE changes() = 1
        ON CONFLICT (connector_id, workspace_id) DO NOTHING`).bind(row.id, workspaceId, now()),
    ]);
    const shared = results[0].results[0];
    if (!shared) {
      const atLimit = await c.env.DB.prepare(`SELECT 1 WHERE
        (SELECT COUNT(*) FROM connector_shares WHERE connector_id = ?) >= 50
        AND NOT EXISTS (SELECT 1 FROM connector_shares WHERE connector_id = ? AND workspace_id = ?)`)
        .bind(row.id, row.id, workspaceId).first();
      if (atLimit) fail(429, 'share_limit', 'Connector share limit reached.');
      fail(409, 'share_unavailable', 'Connector or workspace authority changed.');
    }
    await syncModels(c.env, row, workspaceId);
    return c.json({ connector: await connectorInfo(c.env, row) });
  });
  app.delete('/api/connectors/:id/shares/:workspaceId', async c => {
    const row = await ownedConnector(c);
    const workspaceId = identifier(c.req.param('workspaceId'));
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM connector_shares WHERE connector_id = ? AND workspace_id = ?').bind(row.id, workspaceId),
      c.env.DB.prepare(`UPDATE sessions SET policy_version = policy_version + 1
        WHERE connector_id = ? AND workspace_id = ? AND owner_id <> ?`).bind(row.id, workspaceId, row.owner_id),
    ]);
    return c.body(null, 204);
  });
  app.delete('/api/connectors/:id', async c => {
    const row = await ownedConnector(c);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE connectors SET revoked_at = COALESCE(revoked_at, ?), connection_hash = NULL WHERE id = ?').bind(now(), row.id),
      c.env.DB.prepare('UPDATE sessions SET policy_version = policy_version + 1 WHERE connector_id = ?').bind(row.id),
    ]);
    if (c.env.CONNECTOR_HUB) {
      try {
        await c.env.CONNECTOR_HUB.get(c.env.CONNECTOR_HUB.idFromName(row.id)).fetch('https://connector.internal/revoke',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectorId: row.id }) });
      } catch { /* D1 revocation already fences all authority. */ }
    }
    return c.body(null, 204);
  });
}
