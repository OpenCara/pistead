import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bindingRemote, gitProviderNames } from '../../../packages/shared/src/repositories.js';
import { defaultNetworkPolicy, egressGitServices, packageRegistryDomains, parseNetworkPolicy,
  type EgressGitService, type EgressGrant, type NetworkPolicy } from '../../../packages/shared/src/network.js';
import type { AppContext, RepositoryRow, SessionRow, WorkerEnv } from './types.js';
import type { Database } from './db/types.js';
import { auditStatement, requireMember, sessionAccess } from './db.js';
import { fail, identifier, jsonObject, now } from './http.js';
import { authenticateConnector, requireCallbackScope, requireConnectorSession, type ConnectorRow } from './connectors.js';
import { recheckAccess, repositoryAccess, verifyRepository } from './repositories.js';
import { ownerGitAuthorization } from './push/targets.js';

/** Owner/admin authority, re-checked inside the write (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;
/** A fetch request lists the objects wanted and had; even huge repositories stay far below this. */
const uploadRequestBytes = 64 * 1024 * 1024;
/** Upstream answers start within this; the pack itself may stream for as long as the session's command runs. */
const relayTimeout = 60 * 60 * 1000;
const gitTypes: Record<EgressGitService, string> = {
  'info-refs': 'application/x-git-upload-pack-advertisement',
  'upload-pack': 'application/x-git-upload-pack-result',
};

interface PolicyRow { mode: NetworkPolicy['mode']; domains_json: string; package_registries: number }

export async function workspaceNetworkPolicy(db: Database, workspaceId: string): Promise<NetworkPolicy> {
  const row = await db.query<PolicyRow>('SELECT mode, domains_json, package_registries FROM workspace_network_policies WHERE workspace_id = ?')
    .bind(workspaceId).first();
  if (!row) return { ...defaultNetworkPolicy, domains: [] };
  return { mode: row.mode, domains: JSON.parse(row.domains_json) as string[], packageRegistries: row.package_registries === 1 };
}

export function registerNetworkPolicies(app: Hono<WorkerEnv>): void {
  // Every member may see what their sessions can reach; owners and admins change it.
  app.get('/api/workspaces/:id/network-policy', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ policy: await workspaceNetworkPolicy(c.env.DB, workspaceId), packageRegistryDomains });
  });
  app.put('/api/workspaces/:id/network-policy', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    let policy: NetworkPolicy;
    try { policy = parseNetworkPolicy(await jsonObject(c, 16 * 1024)); }
    catch (error) { return fail(400, 'invalid_network_policy', error instanceof Error ? error.message : 'Invalid network policy.'); }
    const saved = await c.env.DB.query(`INSERT INTO workspace_network_policies (workspace_id, mode, domains_json, package_registries, updated_by, updated_at)
      SELECT ?,?,?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET mode = excluded.mode, domains_json = excluded.domains_json,
        package_registries = excluded.package_registries, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING workspace_id`)
      .bind(workspaceId, policy.mode, JSON.stringify(policy.domains), policy.packageRegistries ? 1 : 0, actor, now(), workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.network_policy.updated', workspaceId, null, { ...policy }).run();
    return c.json({ policy, packageRegistryDomains });
  });
}

/**
 * What one session's egress proxy may do: the workspace's network policy and its repositories. Hosts ask again every
 * minute, so a changed policy or a removed repository reaches running sessions without a restart.
 */
export async function egressGrant(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => key !== 'sessionId')) fail(400, 'invalid_egress_request', 'Only the session is accepted.');
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(input.sessionId, 'sessionId')).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  if (row.status === 'archived') fail(403, 'session_archived', 'Archived sessions have no network access.');
  const repositories = await c.env.DB.query<RepositoryRow>('SELECT * FROM workspace_repositories WHERE workspace_id = ? ORDER BY id')
    .bind(row.workspace_id).all();
  const grant: EgressGrant = {
    policy: await workspaceNetworkPolicy(c.env.DB, row.workspace_id),
    repositories: repositories.map(repository => ({ bindingId: repository.id, provider: repository.provider, host: repository.host,
      repositoryId: repository.repository_id, fullName: repository.full_name })),
  };
  return c.json(grant, 200, { 'Cache-Control': 'private, no-store' });
}

/** The request body, read whole within `limit`: Git's fetch requests are small, and the upstream wants a length. */
async function boundedRequest(c: AppContext, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > limit) fail(413, 'body_too_large', 'The Git request is too large.');
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, 'body_too_large', 'The Git request is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Relays one Git read of a workspace repository for a session's egress proxy, with the session OWNER's own credential.
 * The credential never leaves the control plane; the host sees only the Git protocol. Only the ref advertisement and
 * fetches are relayed: pushes keep going through the approved push broker.
 */
export async function gitRelay(c: AppContext, connector: ConnectorRow | null): Promise<Response> {
  const bindingId = identifier(c.req.param('bindingId'), 'bindingId');
  const service = c.req.param('service') as EgressGitService;
  if (!egressGitServices.includes(service)) fail(404, 'not_found', 'Unknown Git service.');
  const sessionId = identifier(c.req.query('sessionId'), 'sessionId');
  const original = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!original) fail(404, 'not_found', 'Session not found.');
  const authorize = async () => {
    const fresh = await sessionAccess(c.env, sessionId, original.owner_id);
    if (!fresh || fresh.row.status === 'archived' || fresh.row.owner_id !== original.owner_id || fresh.row.workspace_id !== original.workspace_id) {
      fail(403, 'repository_authority_changed', 'Session repository access is no longer authorized.');
    }
    if (connector) {
      const current = await authenticateConnector(c);
      if (current.id !== connector.id || current.connection_hash !== connector.connection_hash) fail(401, 'stale_connection', 'The connector connection changed.');
      await requireConnectorSession(c.env, connector.id, fresh.row, connector.connection_hash!);
    } else if (fresh.row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped Git relay.');
  };
  await authorize();
  const binding = await c.env.DB.query<RepositoryRow>('SELECT * FROM workspace_repositories WHERE id = ? AND workspace_id = ?')
    .bind(bindingId, original.workspace_id).first();
  if (!binding) fail(404, 'repository_not_bound', 'This repository is not bound to the session\'s workspace.');
  const access = await repositoryAccess(c.env, original.owner_id, binding.provider, binding.host, binding.full_name);
  // Renames and transfers fail closed, on every request: nothing makes a sandboxed client fetch only after an advertisement.
  await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
  const remote = bindingRemote({ provider: binding.provider, host: binding.host, fullName: binding.full_name });
  const agent = c.req.header('user-agent');
  const protocol = c.req.header('git-protocol');
  const headers: Record<string, string> = {
    Authorization: ownerGitAuthorization(access),
    'User-Agent': agent && /^git\/[\x21-\x7e]{1,120}$/.test(agent) ? agent : 'git/2 (pistead)',
    ...(protocol && /^[A-Za-z0-9=:._-]{1,256}$/.test(protocol) ? { 'Git-Protocol': protocol } : {}),
  };
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (service === 'upload-pack') {
    if (c.req.header('content-type') !== 'application/x-git-upload-pack-request') fail(415, 'unsupported_media_type', 'Expected a Git upload-pack request.');
    const encoding = c.req.header('content-encoding');
    if (encoding && encoding !== 'gzip') fail(415, 'unsupported_media_type', 'Unsupported Git request encoding.');
    body = await boundedRequest(c, uploadRequestBytes);
    headers['Content-Type'] = 'application/x-git-upload-pack-request';
    headers.Accept = 'application/x-git-upload-pack-result';
    if (encoding) headers['Content-Encoding'] = encoding;
  }
  await recheckAccess(c.env, access);
  await authorize();
  const url = service === 'info-refs' ? `${remote}/info/refs?service=git-upload-pack` : `${remote}/git-upload-pack`;
  let upstream: Response;
  try {
    upstream = await fetch(url, { method: body ? 'POST' : 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(relayTimeout) });
  } catch {
    return fail(502, 'git_unavailable', `${gitProviderNames[binding.provider]} could not be reached.`);
  }
  const type = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (upstream.status !== 200 || type !== gitTypes[service] || !upstream.body) {
    await upstream.body?.cancel();
    const status: ContentfulStatusCode = [401, 403, 404].includes(upstream.status) ? 403 : 502;
    return fail(status, status === 403 ? 'repository_unavailable' : 'git_unavailable', status === 403
      ? `${gitProviderNames[binding.provider]} did not let the session owner's account read ${binding.full_name}.`
      : `${gitProviderNames[binding.provider]} could not complete the Git request.`);
  }
  return new Response(upstream.body, { headers: { 'Content-Type': gitTypes[service], 'Cache-Control': 'private, no-store' } });
}
