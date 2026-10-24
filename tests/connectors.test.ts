import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { app } from '../apps/server/src/index.js';
import { authenticateConnectorSocket } from '../apps/server/src/connectors.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import type { Env } from '../apps/server/src/types.js';
import { encryptToken } from '../apps/server/src/vault.js';
import { fakeHub, seedAgentVersion, seedSavedAgentSession, testDatabase, type FakeHub } from './helpers/control-plane.js';
import type { ConnectorCredentials, ConnectorInfo, ConnectorPairing } from '../packages/shared/src/connector.js';
import type { AgentVersion, ApprovalRecord, GitHubIssueView, ModelDefinition, Operation, RunnerBinding, SessionRecord, SessionView } from '../packages/shared/src/types.js';
import { retiredToolNames, toolNames } from '../packages/shared/src/types.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { diffView } from '../packages/shared/src/view-patch.js';

const origin = 'http://localhost:8787';
const testSecret = 'connectors-test-secret-not-for-deployment';
const internalSecret = 'connectors-internal-secret-not-for-deployment';
const githubToken = 'github-vault-secret-never-in-connector-metadata';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, plainGit: true },
};
const token = () => Buffer.from(randomBytes(32)).toString('base64url');
const changedToken = (value: string) => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client {
  user: { id: string };
  cookie: string;
  csrf: string;
  request: ApiRequest;
}
interface Fixture {
  sqlite: DatabaseSync;
  env: Env;
  request: ApiRequest;
  client(name: string): Promise<Client>;
  githubClient(): Promise<Client>;
  queryCount(): number;
  setBeforeQuery(hook?: (sql: string) => void): void;
}
type Connected = ConnectorCredentials & { connectionToken: string; pairing: ConnectorPairing };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  const body = await json<{ code: string }>(response, status);
  assert.equal(body.code, code);
}

async function fixture(t: TestContext): Promise<Fixture> {
  const { db, sqlite, queryCount, setBeforeQuery } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    RUNNER_SHARED_SECRET: internalSecret, VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function browser(user: { id: string }, cookie: string): Promise<Client> {
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, cookie, csrf: csrfToken,
      request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        return request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers });
      } };
  }
  async function client(name: string) {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name,
      gitEmail: `${name}@example.test` }, { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    return browser(user, response.headers.get('set-cookie')!.split(';')[0]);
  }
  async function githubClient() {
    // Seed a real account and cookie without mocking OAuth or weakening broker checks.
    const id = 'github:7'; const createdAt = new Date().toISOString(); const cookieToken = token();
    sqlite.prepare('INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, '7', 'creator', 'Creator', 'Creator', 'creator@example.test', 'github', createdAt);
    sqlite.prepare('INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(await sha256(cookieToken), id, token(), Date.now() + 3600000, createdAt);
    sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)')
      .run(id, await encryptToken(env, id, githubToken), createdAt);
    return browser({ id }, `test-auth=${cookieToken}`);
  }
  return { sqlite, env, request, client, githubClient, queryCount, setBeforeQuery };
}

async function pairing(owner: Client, name = 'Local Pi', workspaceId?: string) {
  return (await json<{ pairing: ConnectorPairing }>(await owner.request('POST', '/api/connectors/pairings', { name, workspaceId }), 201)).pairing;
}

function claim(f: Fixture, pending: ConnectorPairing, body: unknown = { code: pending.code, ...manifest }, headers: Record<string, string> = {}) {
  return f.request('POST', `/api/connectors/pairings/${pending.id}/claim`, body, headers);
}

async function connect(f: Fixture, owner: Client, workspaceId?: string): Promise<Connected> {
  const pending = await pairing(owner, 'Local Pi', workspaceId);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await claim(f, pending), 201);
  const connectionToken = token();
  // The socket hub normally installs this generation. These tests exercise HTTP routes, not WebSockets.
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  return { ...credentials, connectionToken, pairing: pending };
}

function self(f: Fixture, connector: Connected, path: string, body: unknown, connection: string | null = connector.connectionToken) {
  return f.request('POST', `/api/connectors/self/${path}`, body, { Authorization: `Bearer ${connector.token}`,
    ...(connection === null ? {} : { 'X-Connection-Token': connection }) });
}

async function workspace(owner: Client) {
  return (await json<{ workspace: { id: string } }>(await owner.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
}

async function addMember(admin: Client, workspaceId: string, member: Client) {
  await json(await admin.request('POST', `/api/workspaces/${workspaceId}/members`, { userId: member.user.id, role: 'member' }));
}

function provisionHub(f: Fixture) {
  const requests: ConnectorRelayEnvelope[] = [];
  const unexpected: string[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ rpc(connectorId, envelope) {
    requests.push(envelope);
    if (envelope.connectorId === connectorId && envelope.request.ticket.action === 'create') return Response.json({ ok: true }, { status: 201 });
    unexpected.push(`rpc ${connectorId} ${envelope.request.ticket.action}`);
    return Response.json({ error: 'Unsupported test relay request' }, { status: 503 });
  } });
  return { requests, unexpected };
}

function rpcHub(f: Fixture, connector: Connected, respond: (envelope: ConnectorRelayEnvelope) => Response | Promise<Response>) {
  const requests: ConnectorRelayEnvelope[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ async rpc(connectorId, envelope) {
    assert.equal(connectorId, connector.connectorId);
    requests.push(envelope);
    assert.equal(envelope.connectorId, connector.connectorId);
    assert.equal(envelope.connectionHash, await sha256(connector.connectionToken));
    return respond(envelope);
  } });
  return requests;
}

/** A host shared with the workspace, on which another member, the creator, starts sessions from its model. */
async function sharedHost(f: Fixture) {
  const admin = await f.client('admin'); const host = await f.client('host'); const creator = await f.githubClient();
  const team = await workspace(admin);
  await addMember(admin, team.id, host); await addMember(admin, team.id, creator);
  f.sqlite.prepare(`INSERT INTO workspace_repositories
    (id, workspace_id, repository_id, full_name, ref, private, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('shared-repository', team.id, '7', 'owner/repo', 'main', 1, new Date().toISOString());
  const creatorRequest = creator.request;
  creator.request = async (method, path, body, headers) => {
    if (method !== 'POST' || path !== '/api/sessions') return creatorRequest(method, path, body, headers);
    // Scope resolution to session creation so existing broker fetch mocks keep their exact call counts.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== 'https://api.github.com/repos/owner/repo' &&
          url !== 'https://api.github.com/repos/owner/repo/commits/main') return previousFetch(input, init);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
      assert.equal(init?.redirect, 'manual');
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json(url.endsWith('/commits/main') ? { sha: 'a'.repeat(40) } :
        { id: 7, full_name: 'owner/repo', default_branch: 'main', private: true });
    };
    try { return await creatorRequest(method, path, body, headers); }
    finally { globalThis.fetch = previousFetch; }
  };
  const connector = await connect(f, host);
  await json(await host.request('PUT', `/api/connectors/${connector.connectorId}/shares/${team.id}`));
  const { models } = await json<{ models: ModelDefinition[] }>(await creator.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(models.length, 1);
  const model = models[0];
  const hub = provisionHub(f);
  const input = { workspaceId: team.id, modelId: model.id, title: 'Creator session' };
  return { admin, host, creator, team, connector, model, hub, input };
}

/**
 * The creator's session on the shared host, as one started from an agent the host published before agents were removed:
 * it runs `tools` only, and any other tool asks the session owner. The session the creator starts here, from the
 * host's model, is provisioned as usual; the returned one is its copy that runs the saved agent.
 */
async function sharedSession(f: Fixture, tools: AgentVersion['tools'] = ['identity', 'github_comment']) {
  const setup = await sharedHost(f);
  const { session: started } = await json<{ session: SessionRecord }>(await setup.creator.request('POST', '/api/sessions', {
    ...setup.input, trustedConnectorId: setup.connector.connectorId,
  }), 201);
  assert.equal(started.status, 'ready');
  // Sessions pin nothing: the agent clones the workspace's repositories.
  assert.deepEqual(started.repositories, []);
  assert.equal(started.repositoryMode, 'clone');
  assert.equal(setup.hub.requests.length, 1);
  assert.deepEqual(setup.hub.unexpected, []);
  const agent = seedAgentVersion(f.sqlite, { authorId: setup.host.user.id, workspaceId: setup.team.id, modelId: setup.model.id, tools,
    name: 'Published local agent' });
  const session: SessionRecord = { ...started, id: seedSavedAgentSession(f.sqlite, started.id, agent), agentVersionId: agent.id };
  return { ...setup, agent, session };
}

async function privateWorkspace(f: Fixture) {
  const owner = await f.client('private-owner'); const member = await f.client('private-member');
  const outsider = await f.client('private-outsider'); const team = await workspace(owner);
  await addMember(owner, team.id, member);
  const connector = await connect(f, owner, team.id);
  const { models } = await json<{ models: ModelDefinition[] }>(await owner.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(models.length, 1);
  const model = models[0];
  const hub = provisionHub(f);
  const input = { workspaceId: team.id, modelId: model.id, title: 'Workspace-readable own session' };
  return { owner, member, outsider, team, connector, model, hub, input };
}

async function privateHostSession(f: Fixture) {
  const setup = await privateWorkspace(f);
  const { session } = await json<{ session: SessionRecord }>(await setup.owner.request('POST', '/api/sessions', setup.input), 201);
  assert.equal(session.status, 'ready');
  const view: SessionView = {
    sessionId: session.id,
    owner: { id: setup.owner.user.id, displayName: 'Owner', gitName: 'Owner', gitEmail: 'owner@example.test', githubLogin: null },
    entries: [], approvals: [], conversations: [], busy: false,
  };
  return { ...setup, session, view };
}

function authorization(session: SessionRecord, actorId = session.ownerId) {
  return { sessionId: session.id, actorId, ownerId: session.ownerId, permission: 'write' };
}

/** A reviewed explicit approval of `operation` and its unconsumed broker capability, as a human approval mints them. */
async function approvedOperation(f: Fixture, session: SessionRecord, operation: Operation, actorId: string, requestedBy: string) {
  const capability = token(); const approvalId = Buffer.from(randomBytes(16)).toString('hex');
  const reviewHash = await sha256(JSON.stringify({ sessionId: session.id, approvalId, requestedBy, operation }));
  f.sqlite.prepare(`INSERT INTO approval_reviews
    (session_id,approval_id,requested_by,source,admission_id,operation_json,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(session.id, approvalId, requestedBy, 'explicit', null, JSON.stringify(operation), reviewHash, new Date().toISOString());
  f.sqlite.prepare('INSERT INTO broker_capabilities (token_hash,session_id,approval_id,actor_id,requested_by,operation_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(await sha256(capability), session.id, approvalId, actorId, requestedBy, await sha256(JSON.stringify(operation)),
      Math.floor(Date.now() / 1000) + 600, new Date().toISOString());
  return { sessionId: session.id, actorId, approvalId, capability };
}

async function brokerPayload(f: Fixture, session: SessionRecord, actorId = session.ownerId, requestedBy = session.ownerId) {
  const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
  return { ...await approvedOperation(f, session, operation, actorId, requestedBy), repository: operation.repository, issue: operation.issue, body: operation.body };
}

const headSha = 'c'.repeat(40);
const mergedSha = 'd'.repeat(40);

async function mergePayload(f: Fixture, session: SessionRecord, repository = 'owner/repo') {
  // Canonical key order, as parseOperation returns it.
  const operation = { kind: 'github.merge' as const, repository, pull: 5, sha: headSha, method: 'squash' as const };
  return { ...await approvedOperation(f, session, operation, session.ownerId, session.ownerId),
    repository, pull: operation.pull, sha: operation.sha, method: operation.method };
}

/** A merge as the session owner: the pin's identity check, then the merge PUT, answered by `merge`. Records each call. */
function mergeFetch(t: TestContext, merge: () => Response) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    if (url === 'https://api.github.com/repos/owner/repo') {
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json({ id: 7, full_name: 'owner/repo', default_branch: 'main', private: true });
    }
    assert.equal(url, 'https://api.github.com/repos/owner/repo/pulls/5/merge');
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init?.body)), { sha: headSha, merge_method: 'squash' });
    return merge();
  });
  return calls;
}

/** A run admission of `actorId` in the session, as a write (or ask) message mints it. */
function admit(f: Fixture, sessionId: string, actorId: string, options: { expiresAt?: number; mode?: 'write' | 'ask' } = {}) {
  const id = token();
  f.sqlite.prepare(`INSERT INTO run_admissions (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, actorId, options.mode ?? 'write', `request-${id}`, 'h'.repeat(43),
      options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
  return id;
}

function githubFetch(t: TestContext) {
  return t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.github.com/repos/owner/repo/issues/3/comments');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { body: 'Exactly approved text' });
    return Response.json({ id: 99, html_url: 'https://github.com/owner/repo/issues/3#issuecomment-99', secret: githubToken });
  });
}

for (const revoked of [false, true]) {
  test(`permanent host removal preserves history and fences access (revoked=${revoked})`, async t => {
    const f = await fixture(t);
    const s = await privateHostSession(f);
    const path = `/api/connectors/${s.connector.connectorId}/permanent`;
    await denied(await s.member.request('DELETE', path), 404, 'not_found');
    await denied(await f.request('DELETE', path, undefined, { Cookie: s.owner.cookie }), 403, 'invalid_csrf');
    await json(await s.owner.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`));
    if (revoked) assert.equal((await s.owner.request('DELETE', `/api/connectors/${s.connector.connectorId}`)).status, 204);
    delete f.env.CONNECTOR_HUB;
    assert.equal((await s.owner.request('DELETE', path)).status, 204);
    assert.deepEqual(await json(await s.owner.request('GET', '/api/connectors')), { connectors: [] });
    assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
    const row = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(s.connector.connectorId)!;
    assert.ok(row.removed_at);
    assert.ok(row.revoked_at);
    assert.equal(row.connection_hash, null);
    assert.notEqual(row.credential_hash, await sha256(s.connector.token));
    assert.equal(f.sqlite.prepare('SELECT connector_id FROM sessions WHERE id = ?').get(s.session.id)!.connector_id, s.connector.connectorId);
    assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 0);
    for (const table of ['connector_shares', 'connector_workspaces']) {
      assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = ?`).get(s.connector.connectorId)!.n, 0);
    }
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    await denied(await self(f, s.connector, 'manifest', manifest), 401, 'connector_authentication_required');
    await denied(await s.owner.request('DELETE', path), 404, 'not_found');
    await denied(await s.owner.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`), 404, 'not_found');
  });
}

test('pairings require a CSRF-protected cookie, retain its owner, are single-use, and hash secrets at rest', async t => {
  const f = await fixture(t); const alice = await f.client('alice'); const bob = await f.client('bob');
  await denied(await f.request('POST', '/api/connectors/pairings', { name: 'Pi' }), 401, 'unauthorized');
  await denied(await f.request('POST', '/api/connectors/pairings', { name: 'Pi' }, { Cookie: alice.cookie }), 403, 'invalid_csrf');
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Pi' }, { Origin: 'https://hostile.invalid' }), 403, 'invalid_origin');
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Pi', ownerId: bob.user.id }), 400, 'invalid_metadata');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings').get()!.n, 0);
  const pending = await pairing(alice);
  const row = f.sqlite.prepare('SELECT * FROM connector_pairings WHERE id = ?').get(pending.id)!;
  assert.equal(row.owner_id, alice.user.id);
  assert.equal(row.code_hash, await sha256(pending.code));
  assert.equal(row.claimed_at, null);
  assert.equal(row.expires_at, Date.parse(pending.expiresAt) / 1000);
  assert.ok(Date.parse(pending.expiresAt) > Date.now());
  assert.ok(Date.parse(pending.expiresAt) <= Date.now() + 600000);
  assert.ok(!JSON.stringify(row).includes(pending.code));
  await denied(await claim(f, pending, { code: changedToken(pending.code), ...manifest }), 403, 'invalid_pairing');
  await denied(await claim(f, { ...pending, id: 'unknown-pairing' }), 403, 'invalid_pairing');
  await denied(await claim(f, pending, undefined, { Origin: 'https://hostile.invalid' }), 403, 'invalid_origin');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
  // A claimant's ambient cookie cannot replace the owner of the cookie-issued pairing.
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await claim(f, pending, undefined, { Cookie: bob.cookie }), 201);
  assert.match(credentials.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(credentials.controlPlaneUrl, origin);
  const connector = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(credentials.connectorId)!;
  assert.equal(connector.owner_id, alice.user.id);
  assert.equal(connector.credential_hash, await sha256(credentials.token));
  assert.ok(!JSON.stringify(connector).includes(credentials.token));
  assert.ok(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at);
  await denied(await claim(f, pending), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 1);
  const listed = await json<{ connectors: ConnectorInfo[] }>(await alice.request('GET', '/api/connectors'));
  assert.equal(listed.connectors[0].ownerId, alice.user.id);
  assert.ok(!JSON.stringify(listed).includes(credentials.token));
  assert.ok(!JSON.stringify(listed).includes(String(connector.credential_hash)));
  assert.deepEqual(await json(await bob.request('GET', '/api/connectors')), { connectors: [] });
});

test('pairing expiry is enforced at claim time and the ten-minute per-owner bound includes claimed pairings', async t => {
  const f = await fixture(t); const alice = await f.client('alice'); const bob = await f.client('bob');
  const pending: ConnectorPairing[] = [];
  for (let i = 0; i < 5; i++) pending.push(await pairing(alice));
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Sixth' }), 429, 'pairing_limit');
  await pairing(bob);
  // No sleeps or timer races: make the persisted expiry unambiguously expired.
  f.sqlite.prepare('UPDATE connector_pairings SET expires_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 1, pending[0].id);
  await denied(await claim(f, pending[0]), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending[0].id)!.claimed_at, null);
  await pairing(alice);
  assert.equal(f.sqlite.prepare('SELECT id FROM connector_pairings WHERE id = ?').get(pending[0].id), undefined);
  await json(await claim(f, pending[1]), 201);
  await denied(await alice.request('POST', '/api/connectors/pairings', { name: 'Claimed still counts' }), 429, 'pairing_limit');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings WHERE owner_id = ?').get(alice.user.id)!.n, 5);
  f.sqlite.prepare('UPDATE connector_pairings SET expires_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - 1, pending[1].id);
  await pairing(alice);
  assert.equal(f.sqlite.prepare('SELECT id FROM connector_pairings WHERE id = ?').get(pending[1].id), undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_pairings WHERE owner_id = ?').get(alice.user.id)!.n, 5);
});

test('the active connector bound is checked again at claim and revocation releases capacity', async t => {
  const f = await fixture(t); const owner = await f.client('owner');
  const insert = f.sqlite.prepare('INSERT INTO connectors (id,owner_id,name,credential_hash,created_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 19; i++) insert.run(`existing-${i}`, owner.user.id, 'Existing', await sha256(token()), new Date().toISOString());
  const first = await pairing(owner); const second = await pairing(owner);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(await claim(f, first), 201);
  await denied(await claim(f, second), 403, 'invalid_pairing');
  assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(second.id)!.claimed_at, null);
  await denied(await owner.request('POST', '/api/connectors/pairings', { name: 'Over limit' }), 429, 'pairing_limit');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors WHERE revoked_at IS NULL').get()!.n, 20);
  assert.equal((await owner.request('DELETE', `/api/connectors/${credentials.connectorId}`)).status, 204);
  await json(await claim(f, second), 201);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors WHERE revoked_at IS NULL').get()!.n, 20);
});

test('claim and manifest updates reject malformed metadata and secret-bearing fields without storing them', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const pending = await pairing(owner); const secret = 'provider-credential-must-never-be-persisted';
  const invalid: { name: string; value: object; code: string }[] = [
    ...['apiKey', 'token', 'env', 'auth'].map(field => ({ name: `top-level ${field}`, value: { ...manifest, [field]: secret }, code: 'invalid_metadata' })),
    ...['apiKey', 'headers', 'baseUrl', 'credentials'].map(field => ({ name: `model ${field}`,
      value: { ...manifest, models: [{ ...manifest.models[0], [field]: secret }] }, code: 'invalid_metadata' })),
    ...['env', 'token'].map(field => ({ name: `capability ${field}`,
      value: { ...manifest, capabilities: { ...manifest.capabilities, [field]: secret } }, code: 'invalid_metadata' })),
    { name: 'duplicate models', value: { ...manifest, models: [manifest.models[0], manifest.models[0]] }, code: 'invalid_manifest' },
    { name: 'too many models', value: { ...manifest, models: Array.from({ length: 201 }, (_, i) => ({ ...manifest.models[0], modelId: `model-${i}` })) }, code: 'invalid_manifest' },
    { name: 'non-array models', value: { ...manifest, models: {} }, code: 'invalid_manifest' },
    { name: 'null model', value: { ...manifest, models: [null] }, code: 'invalid_manifest' },
    { name: 'provider syntax', value: { ...manifest, models: [{ ...manifest.models[0], provider: 'https://provider.invalid' }] }, code: 'invalid_manifest' },
    { name: 'control characters', value: { ...manifest, models: [{ ...manifest.models[0], name: 'model\nsecret' }] }, code: 'invalid_manifest' },
    { name: 'missing capabilities', value: { models: manifest.models }, code: 'invalid_manifest' },
    { name: 'platform syntax', value: { ...manifest, capabilities: { ...manifest.capabilities, platform: 'linux/secret' } }, code: 'invalid_manifest' },
    { name: 'non-boolean capability', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: 'true' } }, code: 'invalid_manifest' },
    { name: 'unsandboxed production shell', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: false, productionShell: true } }, code: 'invalid_manifest' },
    { name: 'sandboxed host claiming no sandbox', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: true, unsandboxed: true } }, code: 'invalid_manifest' },
    { name: 'non-boolean unsandboxed', value: { ...manifest, capabilities: { ...manifest.capabilities, sandbox: false, unsandboxed: 'yes' } }, code: 'invalid_manifest' },
    { name: 'unknown thinking level', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: ['off', 'extreme'] }] }, code: 'invalid_manifest' },
    { name: 'duplicate thinking level', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: ['off', 'off'] }] }, code: 'invalid_manifest' },
    { name: 'empty thinking levels', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: [] }] }, code: 'invalid_manifest' },
    { name: 'starting level the model lacks', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevels: ['low', 'high'], thinkingLevel: 'medium' }] }, code: 'invalid_manifest' },
    { name: 'unknown starting level', value: { ...manifest, models: [{ ...manifest.models[0], thinkingLevel: 'extreme' }] }, code: 'invalid_manifest' },
    { name: 'non-boolean chat options', value: { ...manifest, capabilities: { ...manifest.capabilities, chatOptions: 'true' } }, code: 'invalid_manifest' },
    { name: 'non-boolean git providers', value: { ...manifest, capabilities: { ...manifest.capabilities, gitProviders: 1 } }, code: 'invalid_manifest' },
    { name: 'git credentials without pushes', value: { ...manifest, capabilities: { ...manifest.capabilities, gitCredentials: true } }, code: 'invalid_manifest' },
  ];
  const before = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.connectorId);
  for (const entry of invalid) {
    await t.test(entry.name, async () => {
      await denied(await claim(f, pending, { code: pending.code, ...entry.value }), 400, entry.code);
      await denied(await self(f, connector, 'manifest', entry.value), 400, entry.code);
      assert.equal(f.sqlite.prepare('SELECT claimed_at FROM connector_pairings WHERE id = ?').get(pending.id)!.claimed_at, null);
      assert.deepEqual(f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.connectorId), before);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connectors').get()!.n, 1);
    });
  }
  await json(await claim(f, pending), 201);
  await json(await self(f, connector, 'manifest', manifest));
  const unsandboxed = { platform: 'darwin', sandbox: false, productionShell: false, unsandboxed: true, gitPush: true, gitCredentials: true };
  await json(await self(f, connector, 'manifest', { ...manifest, capabilities: unsandboxed }));
  assert.deepEqual(JSON.parse(String(f.sqlite.prepare('SELECT capabilities_json FROM connectors WHERE id = ?').get(connector.connectorId)!.capabilities_json)), unsandboxed,
    'an owner-disabled sandbox and owner-offered Git credentials must stay disclosed in stored host metadata');
  for (const table of ['connectors', 'connector_pairings', 'models', 'audit']) {
    assert.ok(!JSON.stringify(f.sqlite.prepare(`SELECT * FROM ${table}`).all()).includes(secret));
  }
});

test('connector bearer credentials cannot authenticate browser or internal APIs, and self routes require the current connection', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const headers = { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken };
  await denied(await f.request('GET', '/api/me', undefined, headers), 401, 'unauthorized');
  await denied(await f.request('POST', '/api/connectors/pairings', { name: 'Bearer only' }, headers), 401, 'unauthorized');
  for (const path of ['/api/internal/authorize', '/api/internal/github/comment', '/api/internal/github/read', '/api/internal/github/merge',
    '/api/internal/restores/unknown/download']) {
    await denied(await f.request('POST', path, {}, headers), 401, 'unauthorized');
  }
  for (const path of ['manifest', 'authorize', 'activity', 'github/comment', 'github/read', 'github/merge', 'restores/unknown/download']) {
    await denied(await owner.request('POST', `/api/connectors/self/${path}`, {}), 401, 'connector_authentication_required');
    await denied(await self(f, connector, path, {}, null), 401, 'stale_connection');
    await denied(await self(f, connector, path, {}, 'malformed'), 401, 'stale_connection');
    await denied(await self(f, connector, path, {}, changedToken(connector.connectionToken)), 401, 'stale_connection');
    await denied(await f.request('POST', `/api/connectors/self/${path}`, {}, { ...headers, Authorization: `Bearer ${internalSecret}` }), 401, 'connector_authentication_required');
  }
  await json(await self(f, connector, 'manifest', manifest));
  const oldConnection = connector.connectionToken;
  connector.connectionToken = token();
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connector.connectionToken), connector.connectorId);
  for (const path of ['manifest', 'authorize', 'activity', 'github/comment', 'github/read', 'github/merge', 'restores/unknown/download']) {
    await denied(await self(f, connector, path, {}, oldConnection), 401, 'stale_connection');
  }
  await json(await self(f, connector, 'manifest', manifest));
  const stored = f.sqlite.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.connectorId)!;
  assert.equal(stored.connection_hash, await sha256(connector.connectionToken));
  assert.ok(!JSON.stringify(stored).includes(connector.connectionToken));
});

test('sharing is connector-owner-only with live workspace membership and imports only safe catalog metadata', async t => {
  const f = await fixture(t); const admin = await f.client('admin'); const host = await f.client('host'); const outsider = await f.client('outsider');
  const team = await workspace(admin); const connector = await connect(f, host);
  const path = `/api/connectors/${connector.connectorId}/shares/${team.id}`;
  await denied(await admin.request('PUT', path), 404, 'not_found');
  await denied(await admin.request('DELETE', path), 404, 'not_found');
  await denied(await admin.request('DELETE', `/api/connectors/${connector.connectorId}`), 404, 'not_found');
  await denied(await host.request('PUT', path), 404, 'not_found');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models').get()!.n, 0);
  await addMember(admin, team.id, host);
  const shared = await json<{ connector: ConnectorInfo }>(await host.request('PUT', path));
  assert.deepEqual(Object.keys(shared.connector).sort(), ['id', 'ownerId', 'ownerName', 'name', 'createdAt', 'revokedAt', 'online', 'models', 'workspaceIds', 'connectedWorkspaceIds', 'capabilities'].sort());
  assert.deepEqual(shared.connector.models, manifest.models);
  assert.deepEqual(shared.connector.capabilities, manifest.capabilities);
  assert.deepEqual(shared.connector.workspaceIds, [team.id]);
  assert.deepEqual(shared.connector.connectedWorkspaceIds, [team.id]);
  await json(await host.request('PUT', path));
  const catalog = await json<{ models: ModelDefinition[] }>(await admin.request('GET', `/api/workspaces/${team.id}/models`));
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.deepEqual(model, { id: model.id, workspaceId: team.id, ...manifest.models[0], connectorId: connector.connectorId, connectorOwnerId: host.user.id });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models').get()!.n, 1);
  await denied(await outsider.request('GET', `/api/workspaces/${team.id}/connectors`), 404, 'not_found');
  await denied(await outsider.request('GET', `/api/workspaces/${team.id}/models`), 404, 'not_found');
  await denied(await admin.request('POST', `/api/workspaces/${team.id}/models`, {
    name: 'Forged', provider: 'openai', modelId: 'model', connectorId: connector.connectorId, connectorOwnerId: host.user.id,
  }), 400, 'invalid_input');
  const listed = await json<{ connectors: ConnectorInfo[] }>(await admin.request('GET', `/api/workspaces/${team.id}/connectors`));
  assert.deepEqual(listed.connectors, [shared.connector]);
  const visible = JSON.stringify({ shared, catalog, listed });
  for (const secret of [connector.token, connector.connectionToken, connector.pairing.code, await sha256(connector.token), await sha256(connector.connectionToken)]) {
    assert.ok(!visible.includes(secret));
  }
  await json(await self(f, connector, 'manifest', { ...manifest, models: [] }));
  assert.deepEqual(await json(await admin.request('GET', `/api/workspaces/${team.id}/models`)), { models: [] });
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(model.id)!.available, 0);
  await json(await self(f, connector, 'manifest', { ...manifest, models: [{ ...manifest.models[0], name: 'Renamed' }] }));
  const refreshed = await json<{ models: ModelDefinition[] }>(await admin.request('GET', `/api/workspaces/${team.id}/models`));
  assert.deepEqual(refreshed.models, [{ ...model, name: 'Renamed' }]);
  assert.equal((await admin.request('DELETE', `/api/workspaces/${team.id}/members/${encodeURIComponent(host.user.id)}`)).status, 204);
  await denied(await host.request('PUT', path), 404, 'not_found');
  assert.deepEqual(await json(await admin.request('GET', `/api/workspaces/${team.id}/connectors`)), { connectors: [] });
  assert.deepEqual(await json(await admin.request('GET', `/api/workspaces/${team.id}/models`)), { models: [] });
});

test('foreign-host sessions require exact trust and retain the creator identity in storage and the provisioning envelope', async t => {
  const f = await fixture(t); const s = await sharedHost(f);
  for (const trustedConnectorId of [undefined, 'another-connector', s.host.user.id]) {
    await denied(await s.creator.request('POST', '/api/sessions', { ...s.input, trustedConnectorId }), 400, 'connector_trust_required');
  }
  await denied(await s.creator.request('POST', '/api/sessions', {
    ...s.input, trustedConnectorId: s.connector.connectorId, ownerId: s.host.user.id,
  }), 400, 'server_owned_identity');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(s.hub.requests.length, 0);
  const { session } = await json<{ session: SessionRecord }>(await s.creator.request('POST', '/api/sessions', {
    ...s.input, trustedConnectorId: s.connector.connectorId, visibility: 'private',
  }), 201);
  assert.equal(session.status, 'ready');
  assert.equal(session.ownerId, s.creator.user.id);
  assert.equal(session.connectorId, s.connector.connectorId);
  assert.equal(session.connectorOwnerId, s.host.user.id);
  const stored = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id)!;
  assert.equal(stored.owner_id, s.creator.user.id);
  assert.equal(stored.agent_version_id, session.agentVersionId);
  assert.equal(stored.connector_id, s.connector.connectorId);
  assert.equal(stored.connector_owner_id, s.host.user.id);
  assert.equal(s.hub.requests.length, 1);
  const envelope = s.hub.requests[0]; const request = envelope.request;
  assert.equal(envelope.connectorId, s.connector.connectorId);
  assert.equal(envelope.credentialHash, await sha256(s.connector.token));
  assert.equal(envelope.connectionHash, await sha256(s.connector.connectionToken));
  assert.equal(request.type, 'request');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/sessions');
  assert.equal(request.id, request.ticket.jti);
  assert.equal(request.ticket.action, 'create');
  assert.equal(request.ticket.actorId, s.creator.user.id);
  assert.equal(request.ticket.ownerId, s.creator.user.id);
  assert.equal(request.ticket.connectorId, s.connector.connectorId);
  assert.equal(request.ticket.sessionId, session.id);
  assert.equal(request.ticket.policyVersion, session.policyVersion);
  assert.equal(request.ticket.bodyHash, await sha256(request.body));
  const binding = JSON.parse(request.body) as RunnerBinding;
  assert.equal(binding.owner.id, s.creator.user.id);
  assert.equal(binding.owner.gitEmail, 'creator@example.test');
  assert.equal(binding.session.ownerId, s.creator.user.id);
  // The session's agent is the creator's own, not the host owner's.
  assert.equal(binding.agent.authorId, s.creator.user.id);
  assert.equal(binding.agent.id, session.agentVersionId);
  assert.deepEqual(binding.model, s.model);
  for (const secret of [s.connector.token, s.connector.connectionToken, s.connector.pairing.code, githubToken]) assert.ok(!JSON.stringify(envelope).includes(secret));
  await denied(await s.host.request('GET', `/api/sessions/${session.id}`), 404, 'not_found');
  assert.equal((await s.creator.request('GET', `/api/sessions/${session.id}`)).status, 200);
  // The host's own session borrows nothing of the creator's: it pins nothing, and its reads go through the relay with
  // its own owner's accounts.
  const own = await json<{ session: SessionRecord }>(await s.host.request('POST', '/api/sessions', s.input), 201);
  assert.equal(own.session.ownerId, s.host.user.id);
  assert.deepEqual(own.session.repositories, []);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
  assert.equal(s.hub.requests.length, 2);
  assert.deepEqual(s.hub.unexpected, []);
});

test('API-created model and session routing bindings cannot be rewritten through the database', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const other = await connect(f, s.host);
  const modelBefore = f.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(s.model.id);
  for (const [column, value] of [
    ['workspace_id', 'different-workspace'], ['provider', 'different-provider'], ['model_id', 'different-model'],
    ['connector_id', other.connectorId], ['connector_owner_id', s.creator.user.id], ['connector_id', null], ['connector_owner_id', null],
  ] as const) {
    assert.throws(() => f.sqlite.prepare(`UPDATE models SET ${column} = ? WHERE id = ?`).run(value, s.model.id), /model identity is immutable/);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(s.model.id), modelBefore);
  const sessionBefore = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id);
  for (const [column, value] of [
    ['owner_id', s.host.user.id], ['workspace_id', 'different-workspace'], ['agent_version_id', 'different-version'],
    ['connector_id', other.connectorId], ['connector_owner_id', s.creator.user.id], ['connector_id', null], ['connector_owner_id', null],
  ] as const) {
    assert.throws(() => f.sqlite.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, s.session.id), /immutable/);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id), sessionBefore);
  assert.throws(() => f.sqlite.prepare('UPDATE agent_versions SET model_id = ? WHERE id = ?').run('another-model', s.agent.id), /immutable/);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
});

test('callbacks are scoped to the exact session connector, not merely its owner or a shared workspace', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  const sameHost = await connect(f, s.host); const otherHost = await connect(f, s.admin);
  const payload = await brokerPayload(f, s.session);
  for (const [connector, owner] of [[sameHost, s.host], [otherHost, s.admin]] as const) {
    await json(await owner.request('PUT', `/api/connectors/${connector.connectorId}/shares/${s.team.id}`));
    await denied(await self(f, connector, 'authorize', authorization(s.session)), 403, 'connector_binding_mismatch');
    await denied(await self(f, connector, 'github/comment', payload), 403, 'connector_binding_mismatch');
  }
  for (const [path, body] of [['authorize', authorization(s.session)], ['github/comment', payload]] as const) {
    await denied(await f.request('POST', `/api/internal/${path}`, body, { Authorization: `Bearer ${internalSecret}` }), 403, 'connector_scope_required');
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', { ...authorization(s.session), ownerId: s.host.user.id }))).allowed, false);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session, s.host.user.id)))).allowed, false);
  assert.equal((await self(f, s.connector, 'github/comment', payload)).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(s.hub.unexpected, []);
});

for (const mutation of ['revoke', 'unshare', 'remove-host', 'remove-owner', 'remove-approver', 'remove-requester'] as const) {
  test(`${mutation} immediately denies existing connector callbacks and unconsumed broker capabilities`, async t => {
    const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
    const collaborator = await f.client('collaborator');
    await addMember(s.admin, s.team.id, collaborator);
    await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: collaborator.user.id, permissions: ['write', 'approve'] }));
    const actorId = mutation === 'remove-approver' ? collaborator.user.id : s.creator.user.id;
    const requestedBy = mutation === 'remove-requester' ? collaborator.user.id : s.creator.user.id;
    const auth = authorization(s.session, mutation === 'remove-requester' ? collaborator.user.id : actorId);
    assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', auth))).allowed, true);
    const first = await brokerPayload(f, s.session, actorId, requestedBy);
    assert.equal((await self(f, s.connector, 'github/comment', first)).status, 200);
    assert.equal(fetch.mock.callCount(), 1);
    const pending = await brokerPayload(f, s.session, actorId, requestedBy);
    const versionBefore = Number(f.sqlite.prepare('SELECT policy_version FROM sessions WHERE id = ?').get(s.session.id)!.policy_version);
    // Authorization must fail from live database state even without a hub available to close the socket.
    delete f.env.CONNECTOR_HUB;
    if (mutation === 'revoke') {
      assert.equal((await s.host.request('DELETE', `/api/connectors/${s.connector.connectorId}`)).status, 204);
      const row = f.sqlite.prepare('SELECT revoked_at,connection_hash FROM connectors WHERE id = ?').get(s.connector.connectorId)!;
      assert.ok(row.revoked_at); assert.equal(row.connection_hash, null);
    } else if (mutation === 'unshare') {
      assert.equal((await s.host.request('DELETE', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`)).status, 204);
    } else {
      const removed = mutation === 'remove-host' ? s.host : mutation === 'remove-owner' ? s.creator : collaborator;
      assert.equal((await s.admin.request('DELETE', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(removed.user.id)}`)).status, 204);
    }
    const stored = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
    assert.equal(stored.owner_id, s.creator.user.id);
    assert.equal(stored.connector_id, s.connector.connectorId);
    assert.equal(stored.connector_owner_id, s.host.user.id);
    assert.equal(stored.policy_version, versionBefore + 1);
    if (mutation === 'revoke') {
      await denied(await self(f, s.connector, 'authorize', auth), 401, 'connector_authentication_required');
      await denied(await self(f, s.connector, 'github/comment', pending), 401, 'connector_authentication_required');
      await denied(await self(f, s.connector, 'manifest', manifest), 401, 'connector_authentication_required');
    } else if (mutation === 'unshare' || mutation === 'remove-host') {
      await denied(await self(f, s.connector, 'authorize', auth), 403, 'connector_unavailable');
      await denied(await self(f, s.connector, 'github/comment', pending), 403, 'connector_unavailable');
    } else {
      assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', auth))).allowed, false);
      await denied(await self(f, s.connector, 'github/comment', pending), 403, 'permission_revoked');
    }
    assert.equal(fetch.mock.callCount(), 1, 'Denied callbacks must not perform another external effect');
    assert.equal(f.sqlite.prepare('SELECT consumed_at FROM broker_capabilities WHERE token_hash = ?').get(await sha256(pending.capability))!.consumed_at, null);
    if (mutation === 'revoke' || mutation === 'unshare' || mutation === 'remove-host') {
      assert.deepEqual(await json(await s.admin.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
      assert.deepEqual(await json(await s.admin.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
    }
    assert.deepEqual(s.hub.unexpected, []);
  });
}

test('broker authentication and approval capabilities require exact tokens and payloads before any fetch', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  const payload = await brokerPayload(f, s.session);
  for (const secret of [internalSecret.slice(1), `${internalSecret}-suffix`, changedToken(internalSecret)]) {
    await denied(await f.request('POST', '/api/internal/github/comment', payload, { Authorization: `Bearer ${secret}` }), 401, 'unauthorized');
  }
  for (const capability of [payload.capability.slice(1), `${payload.capability}-suffix`, changedToken(payload.capability), await sha256(payload.capability)]) {
    await denied(await self(f, s.connector, 'github/comment', { ...payload, capability }), 403, 'invalid_capability');
  }
  for (const mismatch of [
    { sessionId: 'another-session' }, { approvalId: 'another-approval' }, { actorId: s.host.user.id },
    { repository: 'owner/other-repo' }, { issue: payload.issue + 1 }, { body: `${payload.body} ` },
  ]) {
    await denied(await self(f, s.connector, 'github/comment', { ...payload, ...mismatch }), 403, 'invalid_capability');
  }
  assert.equal(fetch.mock.callCount(), 0);
  const hash = await sha256(payload.capability);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM broker_capabilities WHERE token_hash = ?').get(hash)!.consumed_at, null);
  const result = await json(await self(f, s.connector, 'github/comment', payload));
  assert.deepEqual(result, { id: 99, url: 'https://github.com/owner/repo/issues/3#issuecomment-99' });
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(f.sqlite.prepare('SELECT consumed_at FROM broker_capabilities WHERE token_hash = ?').get(hash)!.consumed_at);
  await denied(await self(f, s.connector, 'github/comment', payload), 409, 'capability_consumed');
  assert.equal(fetch.mock.callCount(), 1);
});

test('connector shares are bounded at fifty, idempotent at the limit, and unsharing releases a slot', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const createdAt = new Date().toISOString();
  // Seed the existing population; exercise both sides of the boundary through the API.
  for (let i = 0; i < 51; i++) {
    const workspaceId = `workspace-${i}`;
    f.sqlite.prepare('INSERT INTO workspaces (id,name,owner_id,created_at) VALUES (?,?,?,?)')
      .run(workspaceId, 'Team', owner.user.id, createdAt);
    f.sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
      .run(workspaceId, owner.user.id, 'owner', createdAt);
    if (i < 49) f.sqlite.prepare('INSERT INTO connector_shares (connector_id,workspace_id,created_at) VALUES (?,?,?)')
      .run(connector.connectorId, workspaceId, createdAt);
  }
  const base = `/api/connectors/${connector.connectorId}/shares`;
  await json(await owner.request('PUT', `${base}/workspace-49`));
  await json(await owner.request('PUT', `${base}/workspace-49`));
  await denied(await owner.request('PUT', `${base}/workspace-50`), 429, 'share_limit');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares WHERE connector_id = ?').get(connector.connectorId)!.n, 50);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM models WHERE workspace_id = ?').get('workspace-50')!.n, 0);
  assert.equal((await owner.request('DELETE', `${base}/workspace-0`)).status, 204);
  await json(await owner.request('PUT', `${base}/workspace-50`));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares WHERE connector_id = ?').get(connector.connectorId)!.n, 50);
  const { models } = await json<{ models: ModelDefinition[] }>(await owner.request('GET', '/api/workspaces/workspace-50/models'));
  assert.equal(models.length, 1);
  assert.equal(models[0].connectorId, connector.connectorId);
});

test('callbacks require both an available imported model and its exact provider/model in the live manifest', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  const payload = await brokerPayload(f, s.session);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  await json(await self(f, s.connector, 'manifest', { ...manifest, models: [] }));
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 0);
  await denied(await self(f, s.connector, 'authorize', authorization(s.session)), 403, 'connector_unavailable');
  await denied(await self(f, s.connector, 'github/comment', payload), 403, 'connector_unavailable');
  // A stale imported row cannot authorize a model no longer advertised by this host.
  for (const models of [[], [{ ...manifest.models[0], provider: 'other-provider' }], [{ ...manifest.models[0], modelId: 'other-model' }]]) {
    f.sqlite.prepare('UPDATE connectors SET models_json = ? WHERE id = ?').run(JSON.stringify(models), s.connector.connectorId);
    f.sqlite.prepare('UPDATE models SET available = 1 WHERE id = ?').run(s.model.id);
    await denied(await self(f, s.connector, 'authorize', authorization(s.session)), 403, 'connector_unavailable');
    await denied(await self(f, s.connector, 'github/comment', payload), 403, 'connector_unavailable');
  }
  f.sqlite.prepare('UPDATE connectors SET models_json = ? WHERE id = ?').run(JSON.stringify(manifest.models), s.connector.connectorId);
  f.sqlite.prepare('UPDATE models SET available = 0 WHERE id = ?').run(s.model.id);
  await denied(await self(f, s.connector, 'authorize', authorization(s.session)), 403, 'connector_unavailable');
  await denied(await self(f, s.connector, 'github/comment', payload), 403, 'connector_unavailable');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM broker_capabilities WHERE token_hash = ?').get(await sha256(payload.capability))!.consumed_at, null);
  await json(await self(f, s.connector, 'manifest', manifest));
  const restored = await json<{ models: ModelDefinition[] }>(await s.creator.request('GET', `/api/workspaces/${s.team.id}/models`));
  assert.deepEqual(restored.models, [s.model], 'Reimport must retain the model identity pinned by the existing session');
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  assert.equal((await self(f, s.connector, 'github/comment', payload)).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
});

test('claim, socket, and self routes require TLS except for explicitly enabled loopback tests', async t => {
  const f = await fixture(t); const owner = await f.githubClient(); const team = await workspace(owner);
  f.sqlite.prepare(`INSERT INTO workspace_repositories
    (id, workspace_id, repository_id, full_name, ref, private, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run('tls-repository', team.id, '7', 'owner/repo', 'main', 1, new Date().toISOString());
  const connector = await connect(f, owner, team.id);
  const pending = await pairing(owner, 'Local Pi', team.id);
  const claimBody = { code: pending.code, ...manifest };
  const headers = { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken };
  const routes = [
    { method: 'POST', path: `/api/connectors/pairings/${pending.id}/claim`, body: claimBody },
    { method: 'POST', path: '/api/connectors/self/manifest', body: manifest },
  ];
  const socketHeaders = new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${connector.token}` });
  f.env.CONNECTOR_HUB = fakeHub();
  for (const route of routes) {
    await denied(await f.request(route.method, `http://remote.invalid${route.path}`, route.body, headers), 400, 'secure_transport_required');
  }
  await socketDenied(f, socketHeaders, new URL('http://remote.invalid/api/connectors/socket'), 400, 'secure_transport_required');
  await json(await self(f, connector, 'manifest', manifest));
  assert.deepEqual(await authenticateConnectorSocket(f.env, socketHeaders, new URL(`${origin}/api/connectors/socket`)),
    { connectorId: connector.connectorId, credentialHash: await sha256(connector.token) });
  f.env.TEST_AUTH_ENABLED = 'false';
  f.env.APP_ORIGIN = 'https://workspace.example.test';
  for (const route of routes) {
    await denied(await f.request(route.method, `${origin}${route.path}`, route.body, headers), 400, 'secure_transport_required');
  }
  await socketDenied(f, socketHeaders, new URL(`${origin}/api/connectors/socket`), 400, 'secure_transport_required');
  const secureHeaders = { ...headers, Origin: f.env.APP_ORIGIN };
  await json(await f.request('POST', `${f.env.APP_ORIGIN}/api/connectors/pairings/${pending.id}/claim`, claimBody, secureHeaders), 201);
  await json(await f.request('POST', `${f.env.APP_ORIGIN}/api/connectors/self/manifest`, manifest, secureHeaders));
  assert.deepEqual(await authenticateConnectorSocket(f.env, socketHeaders, new URL(`${f.env.APP_ORIGIN}/api/connectors/socket`)),
    { connectorId: connector.connectorId, credentialHash: await sha256(connector.token) });
});

async function socketDenied(f: Fixture, headers: Headers, url: URL, status: number, code: string) {
  let response: Response | undefined;
  await assert.rejects(authenticateConnectorSocket(f.env, headers, url), (error: unknown) => {
    assert.ok(error instanceof HTTPException);
    response = error.getResponse();
    return true;
  });
  assert.ok(response);
  await denied(response, status, code);
}

test('socket upgrades are authenticated outside Hono with the connector credential subprotocol', async t => {
  const f = await fixture(t); const owner = await f.client('owner'); const connector = await connect(f, owner);
  const url = new URL(`${origin}/api/connectors/socket`);
  const valid = () => new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${connector.token}` });
  await denied(await f.request('GET', '/api/connectors/socket', undefined, { Upgrade: 'websocket' }), 426, 'upgrade_required');
  await socketDenied(f, valid(), url, 503, 'connector_unavailable');
  f.env.CONNECTOR_HUB = fakeHub();
  assert.deepEqual(await authenticateConnectorSocket(f.env, valid(), url), { connectorId: connector.connectorId, credentialHash: await sha256(connector.token) });
  const hostile = valid(); hostile.set('Origin', 'https://evil.example.test');
  await socketDenied(f, hostile, url, 403, 'invalid_origin');
  const crossSite = valid(); crossSite.set('Sec-Fetch-Site', 'cross-site');
  await socketDenied(f, crossSite, url, 403, 'invalid_origin');
  const browser = valid(); browser.set('Cookie', 'test-auth=abc');
  await socketDenied(f, browser, url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': `bearer.${connector.token}` }), url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${connector.token}, extra` }), url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': `opencara-pi-v1, bearer.${'x'.repeat(43)}` }), url, 401, 'connector_authentication_required');
  await socketDenied(f, new Headers({ 'Sec-WebSocket-Protocol': 'opencara-pi-v1, chat' }), url, 401, 'connector_authentication_required');
  assert.equal((await owner.request('DELETE', `/api/connectors/${connector.connectorId}`)).status, 204);
  assert.deepEqual((f.env.CONNECTOR_HUB as FakeHub).revoked, [connector.connectorId]);
  await socketDenied(f, valid(), url, 401, 'connector_authentication_required');
});

test('production session creation rejects a legacy non-connector model even for an authenticated GitHub owner', async t => {
  const f = await fixture(t); const owner = await f.githubClient(); const team = await workspace(owner);
  const { model } = await json<{ model: ModelDefinition }>(await owner.request('POST', `/api/workspaces/${team.id}/models`, {
    name: 'Legacy model', provider: 'openai', modelId: 'legacy-model',
  }), 201);
  assert.equal(f.sqlite.prepare('SELECT connector_id FROM models WHERE id = ?').get(model.id)!.connector_id, null);
  f.env.TEST_AUTH_ENABLED = 'false';
  f.env.APP_ORIGIN = 'https://workspace.example.test';
  const headers = { Cookie: owner.cookie.replace(/^test-auth=/, '__Host-auth='), Origin: f.env.APP_ORIGIN, 'X-CSRF-Token': owner.csrf };
  const profile = await json<{ user: { id: string } }>(await f.request('GET', `${f.env.APP_ORIGIN}/api/me`, undefined, headers));
  assert.equal(profile.user.id, owner.user.id);
  await denied(await f.request('POST', `${f.env.APP_ORIGIN}/api/sessions`, {
    workspaceId: team.id, modelId: model.id, title: 'No legacy provisioning in production',
  }, headers), 400, 'connector_required');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
});

test('connected SSE emits only two authoritative snapshots within the fifty-query budget', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['read'] }));
  const view: SessionView = {
    sessionId: s.session.id,
    owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
    entries: [], approvals: [], conversations: [], busy: false,
  };
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'view');
    assert.equal(envelope.request.ticket.actorId, s.admin.user.id);
    assert.equal(envelope.request.method, 'GET');
    assert.equal(envelope.request.path, `/v1/sessions/${s.session.id}/view`);
    return Response.json({ view });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = f.queryCount();
  const response = await s.admin.request('GET', `/api/sessions/${s.session.id}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  let body = '';
  for (let snapshot = 0; snapshot < 2; snapshot++) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += new TextDecoder().decode(chunk.value);
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  assert.equal((await reader.read()).done, true);
  assert.equal(requests.length, 2);
  assert.equal((body.match(/event: view/g) ?? []).length, 2);
  const data = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(data, [{ view }, { view }]);
  const queries = f.queryCount() - before;
  assert.ok(queries > 0, 'Count the real control-plane authorization queries, not only relay calls');
  assert.ok(queries + requests.length <= 50, `Connected polling used ${queries} database queries plus ${requests.length} relay calls`);
});

test('a host is asked for what changed only on the connection that reported the revision', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const view: SessionView = {
    sessionId: s.session.id,
    owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
    entries: [{ id: '0:1', kind: 'message', role: 'user', text: 'hello' }], approvals: [], conversations: [], busy: false,
  };
  const busy: SessionView = { ...view, busy: true };
  const [first, second] = ['a'.repeat(32), 'b'.repeat(32)];
  const seen: { path: string; connection: string }[] = [];
  f.env.CONNECTOR_HUB = fakeHub({ async rpc(_connectorId, envelope) {
    seen.push({ path: envelope.request.path, connection: envelope.connectionHash });
    if (envelope.request.path.endsWith(`/view/${first}`)) return Response.json({ patch: diffView(view, busy, first, second) });
    return Response.json({ view, revision: first });
  } });
  const read = async () => (await json<{ view: SessionView }>(await s.creator.request('GET', `/api/sessions/${s.session.id}/view`))).view;
  assert.deepEqual(await read(), view);
  assert.deepEqual(await read(), busy);
  const base = `/v1/sessions/${s.session.id}/view`;
  assert.deepEqual(seen.map(item => item.path), [base, `${base}/${first}`]);
  // The host reconnects, perhaps as an older connector that would drop the connection on the unknown path.
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(token()), s.connector.connectorId);
  assert.deepEqual(await read(), view);
  assert.equal(seen[2]!.path, base);
  assert.notEqual(seen[2]!.connection, seen[1]!.connection);
});

for (const mutation of ['operation', 'requester'] as const) {
  test(`a reviewed explicit approval rejects a host ${mutation} swap before capability minting`, async t => {
    const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
    await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, {
      userId: s.admin.user.id, permissions: ['write'],
    }));
    const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
    const original: ApprovalRecord = {
      id: 'reviewed-approval', sessionId: s.session.id, requestedBy: s.creator.user.id, operation,
      status: 'pending', createdAt: new Date().toISOString(), reviewHash: 'untrusted-host-review-hash',
    };
    let advertised = original;
    const requests = rpcHub(f, s.connector, envelope => {
      const action = envelope.request.ticket.action;
      if (action === 'view') return Response.json({ view: {
        sessionId: s.session.id,
        owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
        entries: [], approvals: [advertised], conversations: [], busy: false,
      } });
      if (action === 'operations') {
        assert.deepEqual(JSON.parse(envelope.request.body), { operation });
        return Response.json({ approval: advertised }, { status: 201 });
      }
      // A vulnerable Worker would mint a capability and reach this success response.
      assert.equal(action, 'approve');
      return Response.json({ approval: { ...advertised, status: 'approved' } });
    });
    const path = `/api/sessions/${s.session.id}`;
    const created = await json<{ approval: ApprovalRecord }>(await s.creator.request('POST', `${path}/operations`, operation), 201);
    const presented = (await json<{ view: SessionView }>(await s.creator.request('GET', `${path}/view`))).view.approvals[0];
    const reviewHash = presented.reviewHash;
    assert.ok(reviewHash);
    assert.match(reviewHash, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(reviewHash, original.reviewHash, 'Only the Worker commitment may be returned to the browser');
    assert.equal(created.approval.reviewHash, reviewHash);
    assert.deepEqual(presented.operation, operation);
    assert.equal(presented.requestedBy, s.creator.user.id);
    const pinned = f.sqlite.prepare('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?')
      .get(s.session.id, original.id)!;
    assert.equal(pinned.review_hash, reviewHash);
    assert.equal(pinned.requested_by, s.creator.user.id);
    assert.equal(pinned.source, 'explicit');
    assert.equal(pinned.admission_id, null);
    assert.deepEqual(JSON.parse(String(pinned.operation_json)), operation);
    for (const invalidHash of [undefined, 'malformed', changedToken(reviewHash)]) {
      await denied(await s.creator.request('POST', `${path}/approvals/${original.id}`, {
        decision: 'approve', reviewHash: invalidHash,
      }), 409, 'approval_review_required');
    }
    // Both requesters are authorized writers, so this must fail on the reviewed binding, not permissions.
    advertised = mutation === 'operation'
      ? { ...original, operation: { ...operation, body: 'Host substituted an unreviewed external effect' } }
      : { ...original, requestedBy: s.admin.user.id };
    await denied(await s.creator.request('POST', `${path}/approvals/${original.id}`, {
      decision: 'approve', reviewHash,
    }), 502, 'approval_changed');
    assert.equal(requests[0].request.ticket.action, 'operations');
    assert.equal(requests[1].request.ticket.action, 'view');
    assert.equal(requests.at(-1)!.request.ticket.action, 'view', 'The denial must compare the newly fetched host approval');
    assert.equal(requests.filter(envelope => envelope.request.ticket.action === 'approve').length, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broker_capabilities').get()!.n, 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?')
      .get(s.session.id, original.id), pinned, 'A conflicting host reread must not overwrite the reviewed operation or requester');
    assert.throws(() => f.sqlite.prepare('UPDATE approval_reviews SET requested_by = ? WHERE session_id = ? AND approval_id = ?')
      .run(s.admin.user.id, s.session.id, original.id), /immutable/);
    assert.throws(() => f.sqlite.prepare('DELETE FROM approval_reviews WHERE session_id = ? AND approval_id = ?')
      .run(s.session.id, original.id), /immutable|must be retained/);
  });
}

test('a read-only approver cannot turn an unadmitted host candidate into a reviewed operation or broker capability', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, {
    userId: s.admin.user.id, permissions: ['read', 'approve'],
  }));
  const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
  const forged: ApprovalRecord = {
    id: 'unadmitted-approval', sessionId: s.session.id, requestedBy: s.creator.user.id,
    operation, status: 'pending', createdAt: new Date().toISOString(),
  };
  const forgedHash = await sha256(JSON.stringify({
    sessionId: s.session.id, approvalId: forged.id, requestedBy: s.creator.user.id, operation,
  }));
  let advertised: ApprovalRecord = { ...forged, reviewHash: forgedHash };
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'view');
    return Response.json({ view: {
      sessionId: s.session.id,
      owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
      entries: [], approvals: [advertised], conversations: [], busy: false,
    } });
  });
  const path = `/api/sessions/${s.session.id}`;
  await denied(await s.admin.request('POST', `${path}/submit`, { content: 'Create an external effect', requestId: 'forged-write' }), 403, 'forbidden');
  await denied(await s.admin.request('POST', `${path}/operations`, operation), 403, 'forbidden');
  assert.equal(requests.length, 0);
  for (const admissionId of [undefined, token()]) {
    advertised = { ...forged, admissionId, reviewHash: forgedHash };
    const { view } = await json<{ view: SessionView }>(await s.admin.request('GET', `${path}/view`));
    assert.equal(view.approvals.length, 1);
    assert.equal(view.approvals[0].id, forged.id);
    assert.equal(view.approvals[0].status, 'interrupted');
    assert.equal(Object.hasOwn(view.approvals[0], 'reviewHash'), false, 'A host-supplied commitment is not proof of a human write admission');
    await denied(await s.admin.request('POST', `${path}/approvals/${forged.id}`, {
      decision: 'approve', reviewHash: forgedHash,
    }), 409, 'approval_review_required');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM approval_reviews').get()!.n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broker_capabilities').get()!.n, 0);
  }
  assert.equal(requests.length, 2, 'Only display reads may reach the host; no approval or write may be relayed');
  assert.equal(fetch.mock.callCount(), 0);
});

test('only a Worker-issued write admission produces an approvable model review and the exact broker effect', async t => {
  const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, {
    userId: s.admin.user.id, permissions: ['read', 'approve'],
  }));
  const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
  const candidate: ApprovalRecord = {
    id: 'model-approval', sessionId: s.session.id, requestedBy: s.creator.user.id,
    operation, status: 'pending', createdAt: new Date().toISOString(),
  };
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  let capability = '';
  const requests = rpcHub(f, s.connector, envelope => {
    const action = envelope.request.ticket.action;
    if (action === 'submit') {
      const input = JSON.parse(envelope.request.body) as { content: string; requestId: string; admissionId: string };
      assert.equal(input.content, 'Please draft the approved comment');
      assert.equal(input.requestId, 'human-write');
      assert.match(input.admissionId, /^[A-Za-z0-9_-]{43}$/);
      candidate.admissionId = input.admissionId;
      return Response.json(receipt, { status: 202 });
    }
    if (action === 'ask') {
      assert.deepEqual(JSON.parse(envelope.request.body), { content: 'Read-only question', requestId: 'human-ask' });
      return Response.json(receipt, { status: 202 });
    }
    if (action === 'view') return Response.json({ view: {
      sessionId: s.session.id,
      owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
      entries: [], approvals: [candidate], conversations: [], busy: false,
    } });
    assert.equal(action, 'approve');
    const input = JSON.parse(envelope.request.body) as { approvalId: string; decision: string; operation: unknown; brokerCapability: string };
    assert.equal(input.approvalId, candidate.id);
    assert.equal(input.decision, 'approve');
    assert.deepEqual(input.operation, operation);
    assert.match(input.brokerCapability, /^[A-Za-z0-9_-]{43}$/);
    capability = input.brokerCapability;
    return Response.json({ approval: { ...candidate, status: 'approved' } });
  });
  const path = `/api/sessions/${s.session.id}`;
  for (const mode of ['submit', 'ask']) {
    await denied(await s.creator.request('POST', `${path}/${mode}`, {
      content: 'Forged admission', requestId: `forged-${mode}`, admissionId: token(),
    }), 400, 'server_owned_admission');
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await json(await s.creator.request('POST', `${path}/ask`, {
    content: 'Read-only question', requestId: 'human-ask',
  }), 202), receipt);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 0);
  const submitted = await json(await s.creator.request('POST', `${path}/submit`, {
    content: 'Please draft the approved comment', requestId: 'human-write',
  }), 202);
  assert.deepEqual(submitted, receipt);
  const admissionId = candidate.admissionId;
  assert.ok(admissionId);
  assert.ok(!JSON.stringify(submitted).includes(admissionId));
  const admission = f.sqlite.prepare('SELECT * FROM run_admissions WHERE id = ?').get(admissionId)!;
  assert.equal(admission.session_id, s.session.id);
  assert.equal(admission.actor_id, s.creator.user.id);
  assert.equal(admission.mode, 'write');
  assert.equal(admission.request_id, 'human-write');
  assert.equal(admission.content_hash, await sha256('Please draft the approved comment'));
  assert.ok(Number(admission.expires_at) > Math.floor(Date.now() / 1000));
  assert.ok(!JSON.stringify(admission).includes('Please draft the approved comment'));
  const { view } = await json<{ view: SessionView }>(await s.admin.request('GET', `${path}/view`));
  const reviewHash = view.approvals[0].reviewHash;
  assert.equal(reviewHash, await sha256(JSON.stringify({
    sessionId: s.session.id, approvalId: candidate.id, requestedBy: s.creator.user.id, operation,
  })));
  assert.equal(view.approvals[0].status, 'pending');
  assert.equal(Object.hasOwn(view.approvals[0], 'admissionId'), false);
  const review = f.sqlite.prepare('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?').get(s.session.id, candidate.id)!;
  assert.equal(review.source, 'model');
  assert.equal(review.admission_id, admissionId);
  assert.equal(review.requested_by, s.creator.user.id);
  const approved = await json<{ approval: ApprovalRecord }>(await s.admin.request('POST', `${path}/approvals/${candidate.id}`, {
    decision: 'approve', reviewHash,
  }));
  assert.equal(approved.approval.status, 'approved');
  assert.equal(approved.approval.reviewHash, reviewHash);
  assert.equal(Object.hasOwn(approved.approval, 'admissionId'), false);
  assert.ok(!JSON.stringify(approved).includes(capability));
  assert.equal(fetch.mock.callCount(), 0, 'Human approval only mints the exact capability; the host callback performs the effect');
  const broker = f.sqlite.prepare('SELECT * FROM broker_capabilities WHERE token_hash = ?').get(await sha256(capability))!;
  assert.equal(broker.actor_id, s.admin.user.id);
  assert.equal(broker.requested_by, s.creator.user.id);
  assert.equal(broker.operation_hash, await sha256(JSON.stringify(operation)));
  await json(await self(f, s.connector, 'github/comment', {
    sessionId: s.session.id, actorId: s.admin.user.id, approvalId: candidate.id, capability,
    repository: operation.repository, issue: operation.issue, body: operation.body,
  }));
  assert.equal(fetch.mock.callCount(), 1);
});

test('only the session owner answers a permission request, for one call or the session, and only allowed tools reach review', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['read', 'approve'] }));
  const path = `/api/sessions/${s.session.id}`;
  const pending = (id: string, operation: Operation): ApprovalRecord => ({
    id, sessionId: s.session.id, requestedBy: s.creator.user.id, operation, status: 'pending', createdAt: new Date().toISOString(),
  });
  const once = pending('permission-call-1', { kind: 'permission', tool: 'bash', target: 'npm test', needs: ['tool'] });
  const always = pending('permission-call-2', { kind: 'permission', tool: 'git_commit', target: 'Fix it', needs: ['tool'] });
  const unlimited = pending('permission-call-3', { kind: 'permission', tool: 'bash', target: 'make', needs: ['unbounded-shell'] });
  // Without its call, allowing it once would grant the tool for the whole session.
  const unnamed = pending('permission-', { kind: 'permission', tool: 'github_comment', target: 'owner/repo#3', needs: ['tool'] });
  // Operations of tools outside the agent, as a host could present them before or without the owner's permission.
  const command = pending('tool-call-1', { kind: 'bash', command: 'npm test' });
  const otherCommand = pending('tool-call-4', { kind: 'bash', command: 'npm test' });
  const commit = pending('tool-call-5', { kind: 'git.commit', message: 'Fix it' });
  let approvals = [once, always, unlimited, unnamed, command, otherCommand, commit];
  const decisions: unknown[] = [];
  rpcHub(f, s.connector, envelope => {
    const action = envelope.request.ticket.action;
    if (action === 'submit') {
      const { admissionId } = JSON.parse(envelope.request.body) as { admissionId: string };
      approvals = approvals.map(approval => ({ ...approval, admissionId }));
      return Response.json({ submissionId: 'submission', conversationId: 'conversation', status: 'queued' }, { status: 202 });
    }
    if (action === 'view') return Response.json({ view: {
      sessionId: s.session.id,
      owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
      entries: [], approvals, conversations: [], busy: true,
    } });
    assert.equal(action, 'approve');
    const input = JSON.parse(envelope.request.body) as { approvalId: string; decision: string; operation: Operation; scope?: 'call' | 'session' };
    decisions.push({ approvalId: input.approvalId, decision: input.decision, scope: input.scope });
    const decided: ApprovalRecord = { ...approvals.find(approval => approval.id === input.approvalId)!, status: 'approved', decidedBy: envelope.request.ticket.actorId, ...(input.scope ? { scope: input.scope } : {}) };
    approvals = approvals.map(approval => approval.id === decided.id ? decided : approval);
    return Response.json({ approval: decided });
  });
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Run the tests', requestId: 'permission-write' }), 202);
  const present = async () => new Map((await json<{ view: SessionView }>(await s.creator.request('GET', `${path}/view`))).view.approvals.map(approval => [approval.id, approval]));
  let presented = await present();
  for (const id of [unnamed.id, command.id, otherCommand.id, commit.id]) {
    assert.equal(presented.get(id)!.status, 'interrupted');
    assert.equal(Object.hasOwn(presented.get(id)!, 'reviewHash'), false);
  }
  const decide = (client: typeof s.creator, id: string, body: Record<string, unknown>) =>
    client.request('POST', `${path}/approvals/${id}`, { decision: 'approve', reviewHash: presented.get(id)!.reviewHash, ...body });
  await denied(await decide(s.admin, once.id, { scope: 'call' }), 403, 'owner_required');
  await denied(await decide(s.creator, once.id, { scope: 'forever' }), 400, 'invalid_decision');
  // The creator's session runs on the host's machine, and only the host's owner can lift the limits it lacks.
  await denied(await decide(s.creator, unlimited.id, {}), 403, 'host_owner_required');
  assert.deepEqual(decisions, []);
  const allowed = await json<{ approval: ApprovalRecord }>(await decide(s.creator, once.id, { scope: 'call' }));
  assert.equal(allowed.approval.status, 'approved');
  assert.equal(allowed.approval.scope, 'call');
  await json(await decide(s.creator, always.id, { scope: 'session' }));
  assert.deepEqual(decisions, [{ approvalId: once.id, decision: 'approve', scope: 'call' }, { approvalId: always.id, decision: 'approve', scope: 'session' }]);
  presented = await present();
  // The one-call permission covers that call's command only; the session permission covers every commit.
  assert.equal(presented.get(command.id)!.status, 'pending');
  assert.ok(presented.get(command.id)!.reviewHash);
  assert.equal(presented.get(otherCommand.id)!.status, 'interrupted');
  assert.equal(presented.get(commit.id)!.status, 'pending');
  assert.ok(presented.get(commit.id)!.reviewHash);
  assert.equal(presented.get(always.id)!.scope, 'session');
  // Only permission requests take a scope, and nobody can request a permission directly.
  await denied(await decide(s.admin, command.id, { scope: 'session' }), 400, 'invalid_decision');
  await denied(await s.creator.request('POST', `${path}/operations`, { kind: 'permission', tool: 'bash', target: '', needs: ['tool'] }), 400, 'invalid_operation');
});

test('per-message chat options are checked against the session host, mode and owner before reaching the runtime', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['read', 'ask', 'write'] }));
  const receipt = { submissionId: 'submission', conversationId: 'conversation', status: 'queued' };
  const requests = rpcHub(f, s.connector, () => Response.json(receipt, { status: 202 }));
  const path = `/api/sessions/${s.session.id}`;
  const model = { provider: manifest.models[0].provider, modelId: manifest.models[0].modelId };
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'outdated', options: { access: 'read' } }), 409, 'connector_update_required');
  // An empty choice is the same as none, so it still works against an outdated host.
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'empty', options: {} }), 202);
  assert.equal(Object.hasOwn(JSON.parse(requests.at(-1)!.request.body), 'options'), false);
  await json(await self(f, s.connector, 'manifest', {
    models: [{ ...manifest.models[0], thinkingLevels: ['off', 'high'] }], capabilities: { ...manifest.capabilities, chatOptions: true },
  }));
  const before = requests.length;
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'foreign', options: { model: { provider: 'local-native', modelId: 'not-on-host' } } }), 403, 'model_not_on_host');
  await denied(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'level', options: { model, thinkingLevel: 'xhigh' } }), 400, 'invalid_options');
  await denied(await s.creator.request('POST', `${path}/ask`, { content: 'Hi', requestId: 'ask-access', options: { access: 'read' } }), 400, 'invalid_options');
  await denied(await s.admin.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'writer-auto', options: { access: 'auto' } }), 403, 'owner_required');
  assert.equal(requests.length, before, 'rejected choices never reach the host');
  await json(await s.admin.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'writer-read', options: { access: 'read' } }), 202);
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, { access: 'read' });
  const options = { model, thinkingLevel: 'high', access: 'auto' };
  await json(await s.creator.request('POST', `${path}/submit`, { content: 'Hi', requestId: 'owner-auto', options }), 202);
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, options);
  await json(await s.creator.request('POST', `${path}/ask`, { content: 'Hi', requestId: 'ask-model', options: { model, thinkingLevel: 'off' } }), 202);
  assert.equal(requests.at(-1)!.request.ticket.action, 'ask');
  assert.deepEqual(JSON.parse(requests.at(-1)!.request.body).options, { model, thinkingLevel: 'off' });
});

test('automatic approvals are shown only for the owner\'s own decided commands, never comments or pending work', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const owner = s.creator.user.id;
  const valid: ApprovalRecord = { id: 'auto-approval', sessionId: s.session.id, requestedBy: owner, decidedBy: owner, automatic: true,
    operation: { kind: 'bash', command: 'npm test' }, status: 'executed', result: 'ok', createdAt: new Date().toISOString() };
  let advertised = valid;
  rpcHub(f, s.connector, () => Response.json({ view: {
    sessionId: s.session.id,
    owner: { id: owner, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
    entries: [], approvals: [advertised], conversations: [], busy: false,
  } }));
  const path = `/api/sessions/${s.session.id}/view`;
  const { view } = await json<{ view: SessionView }>(await s.creator.request('GET', path));
  assert.equal(view.approvals[0].automatic, true);
  for (const forged of [
    { ...valid, requestedBy: s.admin.user.id },
    { ...valid, decidedBy: s.admin.user.id },
    { ...valid, status: 'pending' as const, decidedBy: undefined },
    { ...valid, operation: { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'text' } },
  ]) {
    advertised = forged;
    await denied(await s.creator.request('GET', path), 502, 'invalid_runner_response');
  }
});

test('a folded permission, older approvals and auto-approved calls reach people only in their exact shapes', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const owner = s.creator.user.id;
  const command: ApprovalRecord = { id: 'tool-1', sessionId: s.session.id, requestedBy: owner, decidedBy: owner, permission: { decidedBy: owner, scope: 'session' },
    operation: { kind: 'bash', command: 'npm test' }, status: 'denied', createdAt: new Date().toISOString() };
  let advertised: Record<string, unknown> = command as unknown as Record<string, unknown>;
  let olderApprovals: unknown = 7;
  const entry = { id: '1:2', kind: 'message', role: 'assistant', text: 'bash({"command":"ls"})', conversationId: '1', autoApproved: [{ tool: 'bash', status: 'executed' }] };
  rpcHub(f, s.connector, () => Response.json({ view: {
    sessionId: s.session.id,
    owner: { id: owner, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
    entries: [entry], approvals: [advertised], olderApprovals, conversations: [{ id: '1', mode: 'write' }], busy: false,
  } }));
  const path = `/api/sessions/${s.session.id}/view`;
  let { view } = await json<{ view: SessionView }>(await s.creator.request('GET', path));
  assert.deepEqual(view.approvals[0]!.permission, { decidedBy: owner, scope: 'session' });
  assert.equal(view.olderApprovals, 7);
  assert.deepEqual(view.entries[0]!.autoApproved, [{ tool: 'bash', status: 'executed' }]);
  for (const value of [-1, 1.5, '7', null]) {
    olderApprovals = value;
    ({ view } = await json<{ view: SessionView }>(await s.creator.request('GET', path)));
    assert.equal(view.olderApprovals, undefined, String(value));
  }
  for (const permission of [null, 'yes', { decidedBy: owner, scope: 'forever' }, { decidedBy: owner, extra: true }, { decidedBy: 'not an id!' }]) {
    advertised = { ...command, permission };
    await denied(await s.creator.request('GET', path), 502, 'invalid_runner_response');
  }
  // A permission request is never folded into another one.
  advertised = { ...command, id: 'permission-1', operation: { kind: 'permission', tool: 'bash', target: 'npm test', needs: ['tool'] } };
  await denied(await s.creator.request('GET', path), 502, 'invalid_runner_response');
});

for (const invalid of ['ask', 'expired', 'foreign-session', 'foreign-actor'] as const) {
  test(`${invalid} admission cannot authorize a model review while history remains readable`, async t => {
    const f = await fixture(t); const s = await sharedSession(f); const fetch = githubFetch(t);
    await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, {
      userId: s.admin.user.id, permissions: ['write'],
    }));
    let admissionSessionId = s.session.id;
    if (invalid === 'foreign-session') {
      const other = await json<{ session: SessionRecord }>(await s.creator.request('POST', '/api/sessions', {
        ...s.input, trustedConnectorId: s.connector.connectorId,
      }), 201);
      admissionSessionId = other.session.id;
    }
    const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
    const admissionId = token();
    const approval: ApprovalRecord = {
      id: 'invalid-admission-approval', sessionId: s.session.id, requestedBy: s.creator.user.id,
      operation, admissionId, status: 'pending', createdAt: new Date().toISOString(),
    };
    const reviewHash = await sha256(JSON.stringify({
      sessionId: s.session.id, approvalId: approval.id, requestedBy: s.creator.user.id, operation,
    }));
    f.sqlite.prepare(`INSERT INTO run_admissions
      (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(admissionId, admissionSessionId, invalid === 'foreign-actor' ? s.admin.user.id : s.creator.user.id,
        invalid === 'ask' ? 'ask' : 'write', 'prior-request', await sha256('Prior request'),
        Math.floor(Date.now() / 1000) + (invalid === 'expired' ? -1 : 600), new Date().toISOString());
    if (invalid === 'expired') {
      // Preserve an already-reviewed historical operation after its immutable admission expires.
      f.sqlite.prepare(`INSERT INTO approval_reviews
        (session_id,approval_id,requested_by,source,admission_id,operation_json,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(s.session.id, approval.id, s.creator.user.id, 'model', admissionId, JSON.stringify(operation), reviewHash, new Date().toISOString());
    }
    const requests = rpcHub(f, s.connector, envelope => {
      assert.equal(envelope.request.ticket.action, 'view');
      return Response.json({ view: {
        sessionId: s.session.id,
        owner: { id: s.creator.user.id, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
        entries: [{ id: 'history', kind: 'message', role: 'assistant', text: 'Prior conversation remains readable' }],
        approvals: [approval], conversations: [], busy: false,
      } });
    });
    const path = `/api/sessions/${s.session.id}`;
    const { view } = await json<{ view: SessionView }>(await s.creator.request('GET', `${path}/view`));
    assert.equal(view.entries[0].text, 'Prior conversation remains readable');
    assert.equal(view.approvals[0].status, 'interrupted');
    assert.equal(Object.hasOwn(view.approvals[0], 'reviewHash'), false);
    assert.equal(Object.hasOwn(view.approvals[0], 'admissionId'), false);
    await denied(await s.creator.request('POST', `${path}/approvals/${approval.id}`, {
      decision: 'approve', reviewHash,
    }), 409, invalid === 'expired' ? 'approval_admission_expired' : 'approval_review_required');
    assert.equal(requests.length, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM approval_reviews').get()!.n, invalid === 'expired' ? 1 : 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broker_capabilities').get()!.n, 0);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test('broker callbacks require github_comment in the immutable pinned agent even with a matching review and capability', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']); const fetch = githubFetch(t);
  assert.deepEqual(s.agent.tools, ['identity']);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  const payload = await brokerPayload(f, s.session);
  await denied(await self(f, s.connector, 'github/comment', payload), 403, 'tool_not_allowed');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM broker_capabilities WHERE token_hash = ?').get(await sha256(payload.capability))!.consumed_at, null);
});

test('the owner\'s Auto-approve message lets its tool calls use tools the agent lacks, and no other message does', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']); const fetch = githubFetch(t);
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['write', 'approve'] }));
  const owner = s.creator.user.id;
  const admission = (actorId: string, access: string | null) => {
    const id = token();
    f.sqlite.prepare(`INSERT INTO run_admissions (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at,access) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, s.session.id, actorId, 'write', `request-${id}`, 'h'.repeat(43), Math.floor(Date.now() / 1000) + 600, new Date().toISOString(), access);
    return id;
  };
  const operation = { kind: 'github.comment' as const, repository: 'owner/repo', issue: 3, body: 'Exactly approved text' };
  const approval = (id: string, requestedBy: string, admissionId: string): ApprovalRecord =>
    ({ id, sessionId: s.session.id, requestedBy, operation, admissionId, status: 'pending', createdAt: new Date().toISOString() });
  // The agent has neither github_comment nor any grant for it.
  const approvals = [
    approval('tool-auto', owner, admission(owner, 'auto')),
    approval('tool-asking', owner, admission(owner, 'approval')),
    approval('tool-teammate', s.admin.user.id, admission(s.admin.user.id, 'auto')),
  ];
  let capability = '';
  rpcHub(f, s.connector, envelope => {
    if (envelope.request.ticket.action === 'view') return Response.json({ view: {
      sessionId: s.session.id, owner: { id: owner, displayName: 'Creator', gitName: 'Creator', gitEmail: 'creator@example.test', githubLogin: 'creator' },
      entries: [], approvals, conversations: [], busy: false,
    } });
    const input: unknown = JSON.parse(envelope.request.body);
    assert.ok(input && typeof input === 'object' && 'brokerCapability' in input && typeof input.brokerCapability === 'string');
    capability = input.brokerCapability;
    return Response.json({ approval: { ...approvals[0], status: 'approved' } });
  });
  const path = `/api/sessions/${s.session.id}`;
  const { view } = await json<{ view: SessionView }>(await s.creator.request('GET', `${path}/view`));
  const presented = Object.fromEntries(view.approvals.map(item => [item.id, item]));
  // Only the owner's Auto-approve call is reviewable; a call of an asking message, or a teammate's, still needed a card.
  assert.equal(presented['tool-auto'].status, 'pending');
  assert.ok(presented['tool-auto'].reviewHash);
  for (const id of ['tool-asking', 'tool-teammate']) {
    assert.equal(presented[id].status, 'interrupted');
    assert.equal(presented[id].reviewHash, undefined);
  }
  // The comment itself still waits for a human, and that approval and the broker accept the tool.
  await json(await s.admin.request('POST', `${path}/approvals/tool-auto`, { decision: 'approve', reviewHash: presented['tool-auto'].reviewHash }));
  assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
  await json(await self(f, s.connector, 'github/comment', {
    sessionId: s.session.id, actorId: s.admin.user.id, approvalId: 'tool-auto', capability,
    repository: operation.repository, issue: operation.issue, body: operation.body,
  }));
  assert.equal(fetch.mock.callCount(), 1);
});

test('github merges need a pinned repository, consume their capability once, and tell GitHub refusals apart from unknown outcomes', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_merge']);
  let answer = () => Response.json({ merged: true, sha: mergedSha, message: 'Pull Request successfully merged' });
  const calls = mergeFetch(t, () => answer());
  const consumed = async (capability: string) =>
    f.sqlite.prepare('SELECT consumed_at FROM broker_capabilities WHERE token_hash = ?').get(await sha256(capability))!.consumed_at;
  const audits = (action: string) => Number(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?').get(action)!.n);

  // An approved merge of a repository this session never pinned stops before GitHub and keeps its capability.
  const unpinned = await mergePayload(f, s.session, 'owner/other');
  await denied(await self(f, s.connector, 'github/merge', unpinned), 403, 'repository_not_pinned');
  assert.deepEqual(calls, []);
  assert.equal(await consumed(unpinned.capability), null);

  const payload = await mergePayload(f, s.session);
  assert.deepEqual(await json(await self(f, s.connector, 'github/merge', payload)), { sha: mergedSha, url: 'https://github.com/owner/repo/pull/5' });
  assert.deepEqual(calls, ['GET https://api.github.com/repos/owner/repo', 'PUT https://api.github.com/repos/owner/repo/pulls/5/merge']);
  assert.ok(await consumed(payload.capability));
  assert.equal(audits('github.merge.attempted'), 1);
  assert.equal(audits('github.merge.completed'), 1);
  await denied(await self(f, s.connector, 'github/merge', payload), 409, 'capability_consumed');
  assert.equal(calls.length, 2);

  // GitHub's refusal is definite and carries its reason; the capability stays consumed.
  answer = () => Response.json({ message: 'Pull Request is not mergeable' }, { status: 405 });
  const refused = await mergePayload(f, s.session);
  const refusal = await json<{ code: string; error: string }>(await self(f, s.connector, 'github/merge', refused), 422);
  assert.equal(refusal.code, 'github_merge_refused');
  assert.ok(refusal.error.includes('Pull Request is not mergeable'), refusal.error);
  assert.ok(refusal.error.includes('owner/repo#5'), refusal.error);
  assert.ok(await consumed(refused.capability));
  assert.equal(audits('github.merge.failed'), 1);
  assert.equal(calls.length, 4);

  // A server error leaves the outcome unknown, never a refusal.
  answer = () => Response.json({ message: 'Server Error' }, { status: 502 });
  const unknown = await mergePayload(f, s.session);
  await denied(await self(f, s.connector, 'github/merge', unknown), 502, 'github_outcome_unknown');
  assert.ok(await consumed(unknown.capability));
  assert.equal(audits('github.merge.ambiguous'), 1);
  assert.equal(calls.length, 6);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all()).includes(githubToken));
});

test('github reads need the requester\'s live write admission, the github_read tool or the owner\'s grant, and a pinned repository before any GitHub call', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity']);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('GitHub must not be called'); });
  await json(await s.creator.request('POST', `/api/sessions/${s.session.id}/grants`, { userId: s.admin.user.id, permissions: ['write'] }));
  const owner = s.session.ownerId;
  const read = (admissionId: string, body: Record<string, unknown> = {}) => self(f, s.connector, 'github/read', {
    sessionId: s.session.id, actorId: owner, admissionId, callId: 'call-1', repository: 'owner/other', issue: 5, ...body,
  });
  for (const admissionId of [
    token(), admit(f, s.session.id, owner, { expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    admit(f, s.session.id, owner, { mode: 'ask' }), admit(f, s.session.id, s.admin.user.id),
  ]) {
    await denied(await read(admissionId), 403, 'github_read_not_admitted');
  }
  const admissionId = admit(f, s.session.id, owner);
  await denied(await read(admissionId), 403, 'tool_not_allowed');
  const grant = f.sqlite.prepare('INSERT INTO session_tool_grants (session_id,tool,call_id,approval_id,granted_by,created_at) VALUES (?,?,?,?,?,?)');
  // A grant of another tool, or for another call, does not allow this read.
  grant.run(s.session.id, 'github_comment', '', 'permission-any', owner, new Date().toISOString());
  grant.run(s.session.id, 'github_read', 'call-2', 'permission-call-2', owner, new Date().toISOString());
  await denied(await read(admissionId), 403, 'tool_not_allowed');
  grant.run(s.session.id, 'github_read', 'call-1', 'permission-call-1', owner, new Date().toISOString());
  // A one-call grant without the reviewed card it came from allows nothing.
  await denied(await read(admissionId), 403, 'tool_not_allowed');
  f.sqlite.prepare(`INSERT INTO approval_reviews (session_id,approval_id,requested_by,source,admission_id,operation_json,review_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(s.session.id, 'permission-call-1', owner, 'model', admissionId,
    JSON.stringify({ kind: 'permission', tool: 'github_read', target: 'owner/other#5', needs: ['tool'] }), token(), new Date().toISOString());
  await denied(await read(admissionId), 403, 'repository_not_pinned');
  // It covers only the read the card showed: not another number or repository, nor the same call id in a later message.
  for (const [admission, body] of [[admissionId, { issue: 6 }], [admissionId, { repository: 'owner/repo' }], [admit(f, s.session.id, owner), {}]] as const) {
    await denied(await read(admission, body), 403, 'tool_not_allowed');
  }
  await denied(await read(admissionId, { callId: 'call-3' }), 403, 'tool_not_allowed');
  // A grant for the rest of the session covers any call.
  grant.run(s.session.id, 'github_read', '', 'permission-call-4', owner, new Date().toISOString());
  await denied(await read(admissionId, { callId: 'call-3', issue: 6 }), 403, 'repository_not_pinned');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'github.read'").get()!.n, 0);
});

test('a github read returns the owner\'s view of a pull request with its reviews, review comments and checks, bounded and audited', async t => {
  const f = await fixture(t); const s = await sharedSession(f, ['identity', 'github_read']);
  const api = 'https://api.github.com/repos/owner/repo';
  const createdAt = '2026-10-01T00:00:00Z';
  const hunk = `${'h'.repeat(10)}${'line\n'.repeat(300)}`;
  const comments = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    id: from + index, user: { login: 'commenter' }, created_at: createdAt, body: `comment ${from + index}`, html_url: `https://github.com/owner/repo/pull/5#issuecomment-${from + index}`,
  }));
  const routes: Record<string, () => Response> = {
    [api]: () => Response.json({ id: 7, full_name: 'owner/repo', default_branch: 'main', private: true }),
    [`${api}/issues/5`]: () => Response.json({ html_url: 'https://github.com/owner/repo/pull/5', title: 'Fix it', state: 'open', user: { login: 'author' },
      created_at: createdAt, body: 'b'.repeat(16005), labels: [{ name: 'bug' }, 'plain'], pull_request: { url: `${api}/pulls/5` } }),
    // Three pages of comments: only the newest hundred stay.
    [`${api}/issues/5/comments?per_page=100&page=1`]: () => Response.json(comments(1, 100), { headers: {
      Link: `<https://api.github.com/repositories/7/issues/5/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/7/issues/5/comments?per_page=100&page=3>; rel="last"`,
    } }),
    [`${api}/issues/5/comments?per_page=100&page=2`]: () => Response.json(comments(101, 100)),
    [`${api}/issues/5/comments?per_page=100&page=3`]: () => Response.json(comments(201, 30)),
    [`${api}/pulls/5`]: () => Response.json({ draft: false, merged: false, mergeable: true, mergeable_state: 'clean',
      head: { ref: 'feature', sha: headSha, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: 'a'.repeat(40) } }),
    [`${api}/pulls/5/reviews?per_page=100&page=1`]: () => Response.json([{ id: 11, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED',
      submitted_at: createdAt, commit_id: headSha, body: 'Please fix', html_url: 'https://github.com/owner/repo/pull/5#pullrequestreview-11' }]),
    [`${api}/pulls/5/comments?per_page=100&page=1`]: () => Response.json([{ id: 21, user: { login: 'reviewer' }, created_at: createdAt,
      path: 'src/a.ts', line: 12, original_line: 10, commit_id: headSha, body: 'Off by one', diff_hunk: hunk,
      html_url: 'https://github.com/owner/repo/pull/5#discussion_r21' }]),
    // A failing check on the second page of check runs is still reported, ahead of the passing ones.
    [`${api}/commits/${headSha}/check-runs?per_page=100&page=1`]: () => Response.json({ total_count: 101,
      check_runs: Array.from({ length: 100 }, (_, index) => ({ name: `run-${index + 1}`, status: 'completed', conclusion: 'success' })) }),
    [`${api}/commits/${headSha}/check-runs?per_page=100&page=2`]: () => Response.json({ total_count: 101,
      check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }),
    [`${api}/commits/${headSha}/status?per_page=100&page=1`]: () => Response.json({ state: 'pending', total_count: 2, statuses: [
      { context: 'ci/legacy', state: 'pending' }, { context: 'ci/lint', state: 'success' },
    ] }),
    [`${api}/issues/6`]: () => Response.json({ message: 'Not Found' }, { status: 404 }),
    // Multi-byte and escaped text: the bound is on the JSON's bytes, not on characters.
    [`${api}/issues/8`]: () => Response.json({ html_url: 'https://github.com/owner/repo/issues/8', title: 'Long thread', state: 'open', user: { login: 'author' },
      created_at: createdAt, body: '€'.repeat(16000), labels: [] }),
    [`${api}/issues/8/comments?per_page=100&page=1`]: () => Response.json(comments(1, 100).map(item => ({ ...item, body: 'é'.repeat(1000) }))),
    [`${api}/issues/9`]: () => Response.json({ html_url: 'https://github.com/owner/repo/issues/9', title: '\u0001'.repeat(1000), state: 'open', user: { login: 'author' },
      created_at: createdAt, body: '\u0001'.repeat(16000), labels: [] }),
    [`${api}/issues/9/comments?per_page=100&page=1`]: () => Response.json([]),
  };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${githubToken}`);
    const route = routes[url];
    assert.ok(route, `unexpected GitHub call ${url}`);
    return route();
  });
  const audits = () => f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'github.read'").all().map(row => JSON.parse(String(row.detail_json)));
  const admissionId = admit(f, s.session.id, s.session.ownerId);
  const read = (issue: number) => self(f, s.connector, 'github/read', {
    sessionId: s.session.id, actorId: s.session.ownerId, admissionId, callId: 'call-1', repository: 'OWNER/Repo', issue,
  });

  const view = await json<GitHubIssueView>(await read(5));
  assert.deepEqual([view.repository, view.number, view.url, view.title, view.state, view.author, view.createdAt, view.labels],
    ['owner/repo', 5, 'https://github.com/owner/repo/pull/5', 'Fix it', 'open', 'author', createdAt, ['bug', 'plain']]);
  assert.equal(view.body, `${'b'.repeat(16000)}\n… 5 more characters`);
  assert.equal(view.comments.length, 100);
  assert.deepEqual([view.comments[0].id, view.comments.at(-1)!.id], [131, 230]);
  assert.deepEqual(view.comments[0], { id: 131, author: 'commenter', createdAt, body: 'comment 131', url: 'https://github.com/owner/repo/pull/5#issuecomment-131' });
  assert.deepEqual(view.omitted, { comments: 130, checks: 3 });
  assert.deepEqual(view.pullRequest, {
    draft: false, merged: false, mergeable: true, mergeableState: 'clean',
    head: { ref: 'feature', sha: headSha, repository: 'owner/repo' }, base: { ref: 'main', sha: 'a'.repeat(40) },
    reviews: [{ id: 11, author: 'reviewer', state: 'CHANGES_REQUESTED', submittedAt: createdAt, commit: headSha, body: 'Please fix',
      url: 'https://github.com/owner/repo/pull/5#pullrequestreview-11' }],
    reviewComments: [{ id: 21, inReplyTo: null, author: 'reviewer', createdAt, path: 'src/a.ts', line: 12, originalLine: 10, commit: headSha,
      body: 'Off by one', diffHunk: `… 10 earlier characters\n${hunk.slice(-1500)}`, url: 'https://github.com/owner/repo/pull/5#discussion_r21' }],
    checks: [
      { name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'ci/legacy', status: 'pending', conclusion: null },
      ...Array.from({ length: 98 }, (_, index) => ({ name: `run-${index + 1}`, status: 'completed', conclusion: 'success' })),
    ],
  });
  assert.equal(calls[0], api, 'the pin identity is checked before any read');
  const pullRoutes = Object.keys(routes).filter(url => !/\/issues\/[689]/.test(url));
  assert.deepEqual(calls.toSorted(), pullRoutes.toSorted());
  assert.ok(!JSON.stringify(view).includes(githubToken));
  assert.deepEqual(audits(), [{ repository: 'owner/repo', issue: 5, actingAs: s.session.ownerId }]);

  await denied(await read(6), 404, 'github_not_found');
  assert.equal(audits().length, 1);

  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  // A long thread gives way oldest first until the JSON fits, counting what it left out.
  const thread = await json<GitHubIssueView>(await read(8));
  assert.ok(bytes(thread) <= 96 * 1024, String(bytes(thread)));
  assert.equal(thread.body, '€'.repeat(16000));
  assert.equal(thread.omitted!.comments! + thread.comments.length, 100);
  assert.ok(thread.comments.length > 0 && thread.comments.at(-1)!.id === 100);
  // When even the description alone is too large, it is cut to fit, with a note.
  const escaped = await json<GitHubIssueView>(await read(9));
  assert.ok(bytes(escaped) <= 96 * 1024, String(bytes(escaped)));
  assert.equal(escaped.body, `${'\u0001'.repeat(8000)}\n… cut to fit the read limit`);
});

test('write admission quota follows an actor across sessions without blocking another owner or losing ambiguous receipts', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const cloneSession = f.sqlite.prepare(`INSERT INTO sessions
    (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id)
    SELECT ?,workspace_id,?,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id
    FROM sessions WHERE id = ?`);
  const sessionIds = [s.session.id];
  for (let index = 1; index < 10; index++) {
    const sessionId = `actor-budget-session-${index}`;
    cloneSession.run(sessionId, s.creator.user.id, s.session.id);
    sessionIds.push(sessionId);
  }
  cloneSession.run('unrelated-owner-session', s.admin.user.id, s.session.id);
  const content = 'Quota-bound write';
  const contentHash = await sha256(content);
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const seed = f.sqlite.prepare(`INSERT INTO run_admissions
    (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,'write',?,?,?,?)`);
  for (let index = 0; index < 999; index++) {
    seed.run(`actor-budget-${index}`.padEnd(43, '_'), sessionIds[index % sessionIds.length], s.creator.user.id,
      `seed-${index}`, contentHash, expiresAt, createdAt);
  }
  let failDispatch = true;
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'submit');
    if (failDispatch) return Response.json({ error: 'Ambiguous dispatch' }, { status: 503 });
    return Response.json({ submissionId: 'quota-submission', conversationId: 'quota-conversation', status: 'queued' }, { status: 202 });
  });
  const path = `/api/sessions/${s.session.id}/submit`;
  const input = { content, requestId: 'last-actor-slot' };
  await denied(await s.creator.request('POST', path, input), 503, 'runner_error');
  const stored = f.sqlite.prepare('SELECT * FROM run_admissions WHERE session_id = ? AND actor_id = ? AND request_id = ?')
    .get(s.session.id, s.creator.user.id, input.requestId)!;
  assert.ok(stored, 'An ambiguous dispatch must retain its admission');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(s.creator.user.id)!.n, 1000);
  await denied(await s.creator.request('POST', `/api/sessions/${sessionIds[1]}/submit`, {
    content, requestId: 'cannot-escape-through-another-session',
  }), 409, 'admission_unavailable');
  assert.equal(requests.length, 1, 'Quota denial must happen before relay dispatch');
  failDispatch = false;
  await json(await s.creator.request('POST', path, input), 202);
  assert.equal(JSON.parse(requests[1].request.body).admissionId, stored.id, 'A full quota must not replace an existing receipt');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM run_admissions WHERE id = ?').get(stored.id as string), stored);
  await denied(await s.creator.request('POST', path, { ...input, content: 'Changed retry' }), 409, 'admission_conflict');
  assert.equal(requests.length, 2);
  await json(await s.admin.request('POST', '/api/sessions/unrelated-owner-session/submit', {
    content, requestId: 'unrelated-owner-write',
  }), 202);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 1001);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(s.admin.user.id)!.n, 1);
});

test('owner admission budgets aggregate collaborators but do not impose a cross-tenant global gate', async t => {
  const f = await fixture(t); const s = await sharedSession(f);
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const content = 'Owner-budget write';
  const contentHash = await sha256(content);
  const cloneSession = f.sqlite.prepare(`INSERT INTO sessions
    (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id)
    SELECT ?,workspace_id,?,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id
    FROM sessions WHERE id = ?`);
  const seed = f.sqlite.prepare(`INSERT INTO run_admissions
    (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,'write',?,?,?,?)`);
  const grant = f.sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)');
  const tenants: { owner: Client; sessionIds: string[]; actors: Client[] }[] = [];
  for (const [tenant, owner] of [s.creator, s.admin].entries()) {
    const sessionIds: string[] = [];
    const actors: Client[] = [];
    for (let index = 0; index < 10; index++) {
      const sessionId = `owner-budget-${tenant}-${index}`;
      cloneSession.run(sessionId, owner.user.id, s.session.id);
      sessionIds.push(sessionId);
    }
    for (let index = 0; index < 5; index++) {
      const actor = await f.client(`quota-writer-${tenant}-${index}`);
      await addMember(s.admin, s.team.id, actor);
      actors.push(actor);
      for (const sessionId of sessionIds) grant.run(sessionId, actor.user.id, '["write"]', createdAt);
    }
    tenants.push({ owner, sessionIds, actors });
    const count = tenant === 0 ? 4999 : 5000;
    for (let index = 0; index < count; index++) {
      seed.run(`owner-budget-${tenant}-${index}`.padEnd(43, '_'), sessionIds[index % sessionIds.length],
        actors[index % actors.length].user.id, `seed-${index}`, contentHash, expiresAt, createdAt);
    }
  }
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'submit');
    return Response.json({ submissionId: 'owner-quota-submission', conversationId: 'owner-quota-conversation', status: 'queued' }, { status: 202 });
  });
  const target = tenants[0].sessionIds[0];
  const path = `/api/sessions/${target}/submit`;
  const input = { content, requestId: 'last-owner-slot' };
  await json(await s.creator.request('POST', path, input), 202);
  const admitted = f.sqlite.prepare('SELECT * FROM run_admissions WHERE session_id = ? AND actor_id = ? AND request_id = ?')
    .get(target, s.creator.user.id, input.requestId)!;
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 10000);
  await denied(await s.creator.request('POST', `/api/sessions/${tenants[0].sessionIds[1]}/submit`, {
    content, requestId: 'cannot-escape-owner-budget',
  }), 409, 'admission_unavailable');
  assert.equal(requests.length, 1);
  await json(await s.creator.request('POST', path, input), 202);
  assert.equal(JSON.parse(requests[1].request.body).admissionId, admitted.id);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM run_admissions WHERE id = ?').get(admitted.id as string), admitted);
  cloneSession.run('third-owner-session', s.host.user.id, s.session.id);
  await json(await s.host.request('POST', '/api/sessions/third-owner-session/submit', {
    content, requestId: 'third-owner-is-independent',
  }), 202);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 10001);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions WHERE actor_id = ?').get(s.host.user.id)!.n, 1);
});

test('workspace pairing imports a private connector catalog without granting teammates discovery or guessed model access', async t => {
  const f = await fixture(t); const s = await privateWorkspace(f);
  const associations = f.sqlite.prepare('SELECT workspace_id FROM connector_workspaces WHERE connector_id = ?').all(s.connector.connectorId);
  assert.deepEqual(associations.map(row => row.workspace_id), [s.team.id]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 1);
  const own = await json<{ connectors: ConnectorInfo[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/connectors`));
  assert.equal(own.connectors.length, 1);
  assert.equal(own.connectors[0].id, s.connector.connectorId);
  assert.deepEqual(own.connectors[0].workspaceIds, []);
  assert.deepEqual(own.connectors[0].connectedWorkspaceIds, [s.team.id]);
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.deepEqual(await json(await s.member.request('GET', '/api/connectors')), { connectors: [] });
  await denied(await s.member.request('POST', '/api/sessions', { ...s.input, trustedConnectorId: s.connector.connectorId }), 404, 'not_found');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_versions').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(s.hub.requests.length, 0);
  await denied(await s.outsider.request('GET', `/api/workspaces/${s.team.id}/connectors`), 404, 'not_found');
  await denied(await s.outsider.request('GET', `/api/workspaces/${s.team.id}/models`), 404, 'not_found');
  await json(await self(f, s.connector, 'manifest', { ...manifest, models: [{ ...manifest.models[0], name: 'Private renamed model' }] }));
  const updated = await json<{ models: ModelDefinition[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`));
  assert.deepEqual(updated.models, [{ ...s.model, name: 'Private renamed model' }]);
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
});

test('owner runs a session on an unshared host and the default session is listed and readable only as read by members', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  assert.equal(s.session.visibility, 'workspace');
  assert.equal(f.sqlite.prepare('SELECT visibility FROM sessions WHERE id = ?').get(s.session.id)!.visibility, 'workspace');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_grants').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.deepEqual(s.session.permissions, ['read', 'ask', 'write', 'approve', 'manage']);
  assert.equal(s.hub.requests.length, 1);
  const binding = JSON.parse(s.hub.requests[0].request.body) as RunnerBinding;
  assert.equal(binding.owner.id, s.owner.user.id);
  assert.equal(binding.agent.id, s.session.agentVersionId);
  assert.equal(binding.agent.authorId, s.owner.user.id);
  assert.equal(binding.agent.workspaceId, null);
  assert.equal(binding.model.id, s.model.id);
  assert.equal(binding.session.visibility, undefined);
  assert.equal(binding.session.permissions, undefined);
  assert.equal(s.hub.requests[0].request.ticket.actorId, s.owner.user.id);
  const { session } = await json<{ session: SessionRecord }>(await s.member.request('GET', `/api/sessions/${s.session.id}`));
  assert.deepEqual(session.permissions, ['read']);
  assert.equal(session.visibility, 'workspace');
  // The owner runs shell commands on their own host, so the session clones.
  assert.equal(session.cloneUnavailable, undefined);
  const listed = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  assert.deepEqual(listed.sessions, [session]);
  const requests = rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'view');
    assert.equal(envelope.request.ticket.actorId, s.member.user.id);
    assert.equal(envelope.request.ticket.ownerId, s.owner.user.id);
    return Response.json({ view: s.view });
  });
  assert.deepEqual((await json<{ view: SessionView }>(await s.member.request('GET', `/api/sessions/${s.session.id}/view`))).view, s.view);
  assert.equal(requests.length, 1);
  await denied(await s.outsider.request('GET', `/api/sessions/${s.session.id}`), 404, 'not_found');
  await denied(await s.outsider.request('GET', `/api/sessions/${s.session.id}/view`), 404, 'not_found');
  assert.deepEqual(await json(await s.outsider.request('GET', '/api/sessions')), { sessions: [] });
  assert.equal(requests.length, 1);
});

test('a session starts from a model and gets its own chat agent with every tool its host carries', async t => {
  const f = await fixture(t); const s = await privateWorkspace(f);
  const start = (client: Client, body: Record<string, unknown>) => client.request('POST', '/api/sessions', { workspaceId: s.team.id, ...body });
  // Retired tools stay valid in stored agents but are never offered.
  const offered = toolNames.filter(tool => !retiredToolNames.includes(tool));
  const startedAgent = () => (JSON.parse(s.hub.requests.at(-1)!.request.body) as RunnerBinding).agent;

  // A model, and no agent version; a teammate cannot start on the owner's unshared host.
  await denied(await start(s.owner, {}), 400, 'invalid_input');
  const saved = seedAgentVersion(f.sqlite, { authorId: s.owner.user.id, modelId: s.model.id, tools: ['identity'] });
  for (const body of [{ agentVersionId: saved.id }, { agentVersionId: saved.id, modelId: s.model.id }]) {
    await denied(await start(s.owner, body), 400, 'invalid_input');
  }
  await denied(await start(s.member, { modelId: s.model.id, trustedConnectorId: s.connector.connectorId }), 404, 'not_found');
  assert.equal(s.hub.requests.length, 0);

  // This host carries neither pushes nor GitHub reads and merges, so the chat agent leaves those tools out instead of refusing the start.
  const { session } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.equal(session.status, 'ready');
  const agent = startedAgent();
  assert.equal(agent.id, session.agentVersionId);
  assert.deepEqual(agent.tools, offered.filter(tool => !['git_push', 'github_read', 'github_merge', 'host_bash'].includes(tool)));
  assert.deepEqual([agent.name, agent.instructions, agent.workspaceId, agent.authorId, agent.modelId], [s.model.name, '', null, s.owner.user.id, s.model.id]);

  // There is no agent catalog: agents can't be listed, revised or published.
  await denied(await s.owner.request('GET', '/api/agents'), 404, 'not_found');
  await denied(await s.owner.request('POST', `/api/agents/${agent.agentId}/versions`, { tools: ['identity'], modelId: s.model.id }), 404, 'not_found');
  await denied(await s.owner.request('POST', `/api/agents/${agent.agentId}/publish`, { workspaceId: s.team.id }), 404, 'not_found');

  // Once the host carries pushes, the next session's own chat agent offers git_push, but GitHub tools still need the host's github capability.
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, gitPush: true } }));
  const { session: second } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.notEqual(second.agentVersionId, session.agentVersionId);
  assert.deepEqual(startedAgent().tools, offered.filter(tool => !['github_read', 'github_merge', 'host_bash'].includes(tool)));

  // A host that also carries GitHub reads and merges gets every tool.
  await json(await self(f, s.connector, 'manifest', { ...manifest, capabilities: { ...manifest.capabilities, gitPush: true, github: true, hostCommands: true } }));
  const { session: third } = await json<{ session: SessionRecord }>(await start(s.owner, { modelId: s.model.id }), 201);
  assert.notEqual(third.agentVersionId, second.agentVersionId);
  assert.deepEqual(startedAgent().tools, offered);
});

test('workspace read does not grant mutations, connector credentials, personal environment or backup access', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const personalValue = 'owner-personal-environment-not-for-teammates';
  await json(await s.owner.request('PATCH', '/api/me', { env: { APP_CONTEXT: personalValue } }));
  const ciphertext = await encryptToken(f.env, s.owner.user.id, githubToken);
  f.sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)')
    .run(s.owner.user.id, ciphertext, new Date().toISOString());
  f.sqlite.prepare('INSERT INTO backups (id,session_id,owner_id,object_key,sha256,size,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('private-backup', s.session.id, s.owner.user.id, 'private-object-key', 'private-digest', 1, new Date().toISOString());
  const requests = rpcHub(f, s.connector, () => Response.json({ view: s.view }));
  let storageCalls = 0;
  f.env.BUCKET = { provider: 'filesystem', async get() { storageCalls++; throw new Error('Unauthorized backup read'); },
    async put() { storageCalls++; throw new Error('Unauthorized backup write'); }, async delete() { storageCalls++; } };
  for (const [method, suffix, body] of [
    ['POST', '/ask', { content: 'Question', requestId: 'read-only-ask' }],
    ['POST', '/submit', { content: 'Write', requestId: 'read-only-write' }],
    ['POST', '/operations', { kind: 'github.comment', repository: 'owner/repo', issue: 1, body: 'No' }],
    ['POST', '/approvals/approval', { decision: 'approve', reviewHash: 'a'.repeat(64) }],
    ['POST', '/restart', {}],
    ['POST', '/stop', {}],
    ['POST', '/backup', {}],
    ['GET', '/backups', undefined],
    ['GET', '/backups/private-backup/download', undefined],
    ['GET', '/grants', undefined],
    ['POST', '/grants', { userId: s.member.user.id, permissions: ['manage'] }],
    ['DELETE', `/grants/${encodeURIComponent(s.owner.user.id)}`, undefined],
  ] as const) {
    await denied(await s.member.request(method, `${path}${suffix}`, body), 403, 'forbidden');
  }
  await denied(await s.member.request('PUT', `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`), 404, 'not_found');
  await denied(await s.member.request('DELETE', `/api/connectors/${s.connector.connectorId}`), 404, 'not_found');
  assert.equal(requests.length, 0);
  assert.equal(storageCalls, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_admissions').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM broker_capabilities').get()!.n, 0);
  const visible = [];
  for (const route of [path, `${path}/view`, `${path}/audit`, '/api/sessions', '/api/me',
    `/api/workspaces/${s.team.id}/members`, `/api/workspaces/${s.team.id}/connectors`, `/api/workspaces/${s.team.id}/models`]) {
    visible.push(await json(await s.member.request('GET', route)));
  }
  const serialized = JSON.stringify(visible);
  for (const secret of [personalValue, githubToken, ciphertext, s.connector.token, s.connector.connectionToken,
    s.connector.pairing.code, await sha256(s.connector.token), await sha256(s.connector.connectionToken), 'private-object-key', 'private-digest']) {
    assert.ok(!serialized.includes(secret), 'Read-only metadata must not contain credentials, environment or backup storage details');
  }
  assert.equal(storageCalls, 0);
  assert.equal(f.sqlite.prepare('SELECT ciphertext FROM github_tokens WHERE user_id = ?').get(s.owner.user.id)!.ciphertext, ciphertext);
});

test('root visibility PATCH is CSRF protected, owner-only, versioned and unions rather than replaces explicit grants', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const rowBefore = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id);
  assert.equal((await s.owner.request('PATCH', path, { visibility: 'private' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await s.owner.request('PATCH', path, { visibility: 'private' }, { Origin: 'https://hostile.example' })).status, 403);
  assert.equal((await s.member.request('PATCH', path, { visibility: 'private' })).status, 403);
  await json(await s.owner.request('POST', `/api/workspaces/${s.team.id}/members`, { userId: s.member.user.id, role: 'admin' }));
  assert.equal((await s.member.request('PATCH', path, { visibility: 'private' })).status, 403, 'Workspace administration is not session ownership');
  await denied(await s.outsider.request('PATCH', path, { visibility: 'private' }), 404, 'not_found');
  for (const visibility of ['public', '', null, 1]) {
    assert.equal((await s.owner.request('PATCH', path, { visibility })).status, 400);
  }
  for (const body of [{}, { visibility: 'private', ownerId: s.member.user.id }, { visibility: 'private', title: 'Forged rename' }]) {
    assert.equal((await s.owner.request('PATCH', path, body)).status, 400);
  }
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id), rowBefore);
  const privateResult = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { visibility: 'private' }));
  assert.equal(privateResult.session.visibility, 'private');
  assert.equal(privateResult.session.policyVersion, s.session.policyVersion + 1);
  assert.deepEqual(privateResult.session.permissions, ['read', 'ask', 'write', 'approve', 'manage']);
  await denied(await s.member.request('GET', path), 404, 'not_found');
  assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['ask', 'manage'] }));
  const granted = await json<{ session: SessionRecord }>(await s.member.request('GET', path));
  assert.deepEqual(granted.session.permissions, ['read', 'ask', 'manage']);
  assert.equal((await s.member.request('PATCH', path, { visibility: 'workspace' })).status, 403, 'Manage is not ownership');
  assert.equal(f.sqlite.prepare('SELECT policy_version FROM sessions WHERE id = ?').get(s.session.id)!.policy_version, granted.session.policyVersion);
  const grantBefore = f.sqlite.prepare('SELECT * FROM session_grants WHERE session_id = ?').all(s.session.id);
  const shared = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { visibility: 'workspace' }));
  assert.equal(shared.session.policyVersion, granted.session.policyVersion + 1);
  assert.equal(shared.session.visibility, 'workspace');
  assert.deepEqual((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.permissions, ['read', 'ask', 'manage']);
  const privateAgain = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { visibility: 'private' }));
  assert.equal(privateAgain.session.policyVersion, shared.session.policyVersion + 1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM session_grants WHERE session_id = ?').all(s.session.id), grantBefore);
  assert.deepEqual((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.permissions, ['read', 'ask', 'manage']);
  await json(await s.owner.request('PATCH', path, { visibility: 'workspace' }));
  await json(await s.owner.request('DELETE', `${path}/grants/${encodeURIComponent(s.member.user.id)}`));
  assert.deepEqual((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.permissions, ['read']);
  await json(await s.owner.request('PATCH', path, { visibility: 'private' }));
  await denied(await s.member.request('GET', path), 404, 'not_found');
  assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
  const stored = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
  for (const key of ['owner_id', 'workspace_id', 'agent_version_id', 'connector_id', 'connector_owner_id', 'repositories_json']) {
    assert.equal(stored[key], rowBefore![key], key);
  }
  assert.equal(s.hub.requests.length, 1, 'Visibility changes must not reprovision the pinned runtime');
});

test('owners rename and archive sessions; archived sessions are read-only and unarchive to their exact status', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  // Rename: owner-only, one line, never mixed with visibility, no policy bump.
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['manage'] }));
  const { policy_version: granted } = f.sqlite.prepare('SELECT policy_version FROM sessions WHERE id = ?').get(s.session.id) as { policy_version: number };
  await denied(await s.member.request('PATCH', path, { title: 'Hijacked' }), 403, 'owner_required');
  for (const title of ['', '   ', 'two\nlines', 'x'.repeat(201), 1, null]) {
    assert.equal((await s.owner.request('PATCH', path, { title })).status, 400, JSON.stringify(title));
  }
  assert.equal((await s.owner.request('PATCH', path, { title: 'Renamed', visibility: 'private' })).status, 400);
  const renamed = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { title: '  Renamed session  ' }));
  assert.equal(renamed.session.title, 'Renamed session');
  assert.equal(renamed.session.policyVersion, granted);

  // Archive: owner-only, bumps the policy version and blocks every mutation.
  await denied(await s.member.request('POST', `${path}/archive`), 403, 'owner_required');
  const archived = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/archive`));
  assert.equal(archived.session.status, 'archived');
  assert.equal(archived.session.policyVersion, granted + 1);
  assert.equal(f.sqlite.prepare('SELECT archived_status FROM sessions WHERE id = ?').get(s.session.id)!.archived_status, 'ready');
  await denied(await s.owner.request('POST', `${path}/archive`), 409, 'session_archived');
  await denied(await s.owner.request('PATCH', path, { title: 'While archived' }), 409, 'session_archived');
  await denied(await s.owner.request('PATCH', path, { visibility: 'private' }), 409, 'session_archived');
  await denied(await s.owner.request('POST', `${path}/submit`, { content: 'hi', requestId: 'archived-request' }), 409, 'session_archived');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.status, 'archived');

  // Unarchive: owner-only, restores the exact previous status.
  await denied(await s.member.request('POST', `${path}/unarchive`), 403, 'owner_required');
  const restored = await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/unarchive`));
  assert.equal(restored.session.status, 'ready');
  assert.equal(restored.session.policyVersion, granted + 2);
  assert.equal(f.sqlite.prepare('SELECT archived_status FROM sessions WHERE id = ?').get(s.session.id)!.archived_status, null);
  await denied(await s.owner.request('POST', `${path}/unarchive`), 409, 'session_not_archived');
  f.sqlite.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(s.session.id);
  await json(await s.owner.request('POST', `${path}/archive`));
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('POST', `${path}/unarchive`))).session.status, 'error');
  const actions = (f.sqlite.prepare('SELECT action FROM audit WHERE session_id = ? ORDER BY created_at, rowid').all(s.session.id) as { action: string }[]).map(row => row.action);
  for (const action of ['session.renamed', 'session.archived', 'session.unarchived']) assert.ok(actions.includes(action), action);
  assert.equal(s.hub.requests.length, 1, 'Renaming and archiving must not contact the host');
});

test('hosts report what the agent of each session they serve is doing; lists show it and the runner binding never carries it', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const report = (activity: unknown, sessionId: unknown = s.session.id, connector = s.connector) => self(f, connector, 'activity', { sessionId, activity });
  const listed = async (client = s.owner) => (await json<{ sessions: SessionRecord[] }>(await client.request('GET', '/api/sessions'))).sessions
    .find(session => session.id === s.session.id)!;
  const audits = () => f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE session_id = ?').get(s.session.id)!.n;
  const audited = audits();
  assert.equal((await listed()).activity, undefined, 'unknown until the host reports it');
  assert.deepEqual(await json(await report('working')), { ok: true });
  assert.equal((await listed()).activity, 'working');
  assert.equal((await listed(s.member)).activity, 'working', 'readers see what the owner sees');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.activity, 'working');
  for (const activity of ['busy', '', null, 3, ['done']]) await denied(await report(activity), 400, 'invalid_activity');
  await denied(await self(f, s.connector, 'activity', { sessionId: s.session.id, activity: 'done', status: 'ready' }), 400, 'invalid_activity');
  await denied(await report('done', 'missing-session'), 404, 'not_found');
  // Only the host serving the session reports for it.
  const other = await connect(f, s.owner, s.team.id);
  await denied(await report('done', s.session.id, other), 403, 'connector_binding_mismatch');
  assert.equal((await listed()).activity, 'working');

  // Display state only: no policy version, no audit entry, and never part of the binding the host is sent.
  await json(await report('failed'));
  assert.deepEqual({ ...f.sqlite.prepare('SELECT activity, policy_version FROM sessions WHERE id = ?').get(s.session.id) },
    { activity: 'failed', policy_version: s.session.policyVersion });
  assert.equal(audits(), audited);
  f.sqlite.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(s.session.id);
  await json(await s.owner.request('POST', `${path}/restart`));
  const binding = JSON.parse(s.hub.requests.at(-1)!.request.body) as RunnerBinding;
  assert.equal(binding.session.id, s.session.id);
  assert.equal('activity' in binding.session, false);
  assert.equal((await listed()).activity, 'failed', 'restarting leaves the activity to the host to report');
  assert.deepEqual(s.hub.unexpected, []);
});

test('writers stop a session\'s work through its host, audited; archived sessions refuse', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  let stopped: unknown = 2;
  const requests = rpcHub(f, s.connector, () => Response.json({ stopped }));
  assert.deepEqual(await json(await s.owner.request('POST', `${path}/stop`, {})), { stopped: 2 });
  assert.equal(requests.length, 1);
  const { request } = requests[0]!;
  assert.deepEqual([request.method, request.path, request.body, request.ticket.action, request.ticket.actorId],
    ['POST', `/v1/sessions/${s.session.id}/stop`, '{}', 'stop', s.owner.user.id]);
  const audit = f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE session_id = ? AND action = 'session.stopped'").all(s.session.id);
  assert.deepEqual(audit.map(row => ({ ...row })), [{ actor_id: s.owner.user.id, detail_json: JSON.stringify({ stopped: 2 }) }]);
  stopped = 'all';
  await denied(await s.owner.request('POST', `${path}/stop`, {}), 502, 'invalid_runner_response');
  await json(await s.owner.request('POST', `${path}/archive`));
  await denied(await s.owner.request('POST', `${path}/stop`, {}), 409, 'session_archived');
  assert.equal(requests.length, 2);
});

test('explicitly private creation stays unlisted until granted and membership removal defeats both visibility and grants', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const { session: privateSession } = await json<{ session: SessionRecord }>(await s.owner.request('POST', '/api/sessions', {
    ...s.input, visibility: 'private',
  }), 201);
  assert.equal(privateSession.visibility, 'private');
  await denied(await s.member.request('GET', `/api/sessions/${privateSession.id}`), 404, 'not_found');
  let listed = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  assert.deepEqual(listed.sessions.map(session => session.id), [s.session.id]);
  await json(await s.owner.request('POST', `/api/sessions/${privateSession.id}/grants`, { userId: s.member.user.id, permissions: ['read'] }));
  listed = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  assert.deepEqual(listed.sessions.map(session => session.id).sort(), [s.session.id, privateSession.id].sort());
  assert.equal((await s.owner.request('DELETE', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(s.member.user.id)}`)).status, 204);
  for (const session of [s.session, privateSession]) {
    await denied(await s.member.request('GET', `/api/sessions/${session.id}`), 404, 'not_found');
    await denied(await s.member.request('GET', `/api/sessions/${session.id}/view`), 404, 'not_found');
  }
  assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_grants WHERE user_id = ?').get(s.member.user.id)!.n, 0);
  await addMember(s.owner, s.team.id, s.member);
  assert.deepEqual((await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'))).sessions.map(session => session.id), [s.session.id]);
  await denied(await s.member.request('GET', `/api/sessions/${privateSession.id}`), 404, 'not_found');
});

for (const mutation of ['privacy', 'membership'] as const) {
  for (const transport of ['view', 'events'] as const) {
    test(`${mutation} revocation suppresses an in-flight workspace ${transport} response`, async t => {
      const f = await fixture(t); const s = await privateHostSession(f);
      const began = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      if (transport === 'events') t.mock.timers.enable({ apis: ['setTimeout'] });
      let polls = 0;
      const requests = rpcHub(f, s.connector, async envelope => {
        assert.equal(envelope.request.ticket.action, 'view');
        if (transport === 'events' && ++polls === 1) {
          return Response.json({ view: { ...s.view, entries: [{ id: 'first', kind: 'message', role: 'assistant', text: 'authorized-before-revocation' }] } });
        }
        began.resolve();
        await release.promise;
        return Response.json({ view: { ...s.view, entries: [{ id: 'late', kind: 'message', role: 'assistant', text: 'revoked-must-not-leak' }] } });
      });
      const pending = Promise.resolve(s.member.request('GET', `/api/sessions/${s.session.id}/${transport}`));
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let body = '';
      if (transport === 'events') {
        const response = await pending;
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
        reader = response.body!.getReader();
        t.after(() => reader!.cancel());
        const first = await reader.read();
        assert.equal(first.done, false);
        body = new TextDecoder().decode(first.value);
        assert.ok(body.includes('authorized-before-revocation'));
        await new Promise<void>(resolve => setImmediate(resolve));
        t.mock.timers.tick(1000);
      }
      await began.promise;
      if (mutation === 'privacy') {
        await json(await s.owner.request('PATCH', `/api/sessions/${s.session.id}`, { visibility: 'private' }));
      } else {
        assert.equal((await s.owner.request('DELETE', `/api/workspaces/${s.team.id}/members/${encodeURIComponent(s.member.user.id)}`)).status, 204);
      }
      release.resolve();
      const response = await pending;
      if (transport === 'view') {
        assert.ok(!(await response.clone().text()).includes('revoked-must-not-leak'));
        await denied(response, 403, 'permission_revoked');
      } else {
        while (true) {
          const chunk = await reader!.read();
          if (chunk.done) break;
          body += new TextDecoder().decode(chunk.value);
        }
        assert.equal((body.match(/event: view/g) ?? []).length, 1);
        assert.ok(!body.includes('revoked-must-not-leak'));
        assert.ok(!body.includes('error'));
      }
      assert.equal(requests.length, transport === 'events' ? 2 : 1);
      await denied(await s.member.request('GET', `/api/sessions/${s.session.id}`), 404, 'not_found');
      assert.deepEqual(await json(await s.member.request('GET', '/api/sessions')), { sessions: [] });
    });
  }
}

test('opt-in sharing admits a teammate runtime; unshare blocks foreign sessions but preserves workspace views of the owner session; revoke blocks all runtimes', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const input = { workspaceId: s.team.id, modelId: s.model.id, trustedConnectorId: s.connector.connectorId };
  // Until the owner shares the host, its model isn't one the member can start on.
  await denied(await s.member.request('POST', '/api/sessions', input), 404, 'not_found');
  assert.equal(s.hub.requests.length, 1);
  const sharePath = `/api/connectors/${s.connector.connectorId}/shares/${s.team.id}`;
  await json(await s.owner.request('PUT', sharePath));
  assert.deepEqual((await json<{ models: ModelDefinition[] }>(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`))).models, [s.model]);
  const { session: foreign } = await json<{ session: SessionRecord }>(await s.member.request('POST', '/api/sessions', input), 201);
  assert.equal(foreign.status, 'ready');
  assert.equal(foreign.ownerId, s.member.user.id);
  assert.equal(foreign.connectorOwnerId, s.owner.user.id);
  const foreignBinding = JSON.parse(s.hub.requests[1].request.body) as RunnerBinding;
  assert.equal(foreignBinding.owner.id, s.member.user.id);
  const requests = rpcHub(f, s.connector, envelope => {
    const own = envelope.request.ticket.sessionId === s.session.id;
    return Response.json({ view: own ? s.view : { ...s.view, sessionId: foreign.id, owner: { ...s.view.owner, id: s.member.user.id } } });
  });
  await json(await s.member.request('GET', `/api/sessions/${foreign.id}/view`));
  await json(await s.member.request('GET', `/api/sessions/${s.session.id}/view`));
  assert.equal((await s.owner.request('DELETE', sharePath)).status, 204);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM connector_workspaces WHERE connector_id = ? AND workspace_id = ?').get(s.connector.connectorId, s.team.id)!.n, 1);
  assert.equal(f.sqlite.prepare('SELECT available FROM models WHERE id = ?').get(s.model.id)!.available, 1);
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.deepEqual(await json(await s.member.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
  assert.deepEqual((await json<{ models: ModelDefinition[] }>(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`))).models, [s.model]);
  const beforeDenied = requests.length;
  await denied(await s.member.request('GET', `/api/sessions/${foreign.id}/view`), 403, 'connector_unavailable');
  await denied(await self(f, s.connector, 'authorize', authorization(foreign)), 403, 'connector_unavailable');
  await denied(await s.member.request('POST', '/api/sessions', input), 404, 'not_found');
  assert.equal(requests.length, beforeDenied);
  assert.deepEqual((await json<{ view: SessionView }>(await s.member.request('GET', `/api/sessions/${s.session.id}/view`))).view, s.view);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session)))).allowed, true);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', { ...authorization(s.session, s.member.user.id), permission: 'read' }))).allowed, true);
  assert.equal((await json<{ allowed: boolean }>(await self(f, s.connector, 'authorize', authorization(s.session, s.member.user.id)))).allowed, false);
  // Revocation must be enforced even without a hub available to drain the socket.
  delete f.env.CONNECTOR_HUB;
  assert.equal((await s.owner.request('DELETE', `/api/connectors/${s.connector.connectorId}`)).status, 204);
  rpcHub(f, s.connector, () => { assert.fail('Revoked connector must not receive a runtime request'); });
  for (const session of [s.session, foreign]) {
    for (const actor of [s.owner, s.member]) {
      await denied(await actor.request('GET', `/api/sessions/${session.id}/view`), 403, 'connector_unavailable');
    }
    await denied(await self(f, s.connector, 'authorize', authorization(session)), 401, 'connector_authentication_required');
  }
  await denied(await s.owner.request('POST', '/api/sessions', s.input), 404, 'not_found');
  assert.deepEqual(await json(await s.owner.request('GET', `/api/workspaces/${s.team.id}/models`)), { models: [] });
  assert.deepEqual(await json(await s.owner.request('GET', `/api/workspaces/${s.team.id}/connectors`)), { connectors: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
});

test('workspace session listing stays query-bounded with sixty implicit readers and still filters private and owner-membership policy', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const clone = f.sqlite.prepare(`INSERT INTO sessions
    (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json,visibility)
    SELECT ?,workspace_id,?,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json,?
    FROM sessions WHERE id = ?`);
  const workspaceIds = [s.session.id];
  for (let index = 1; index < 60; index++) {
    const id = `workspace-listed-${index}`;
    clone.run(id, s.owner.user.id, 'workspace', s.session.id);
    workspaceIds.push(id);
  }
  clone.run('ungranted-private', s.owner.user.id, 'private', s.session.id);
  clone.run('granted-private', s.owner.user.id, 'private', s.session.id);
  clone.run('removed-owner', s.outsider.user.id, 'workspace', s.session.id);
  await json(await s.owner.request('POST', '/api/sessions/granted-private/grants', {
    userId: s.member.user.id, permissions: ['ask'],
  }));
  const before = f.queryCount();
  const { sessions } = await json<{ sessions: SessionRecord[] }>(await s.member.request('GET', '/api/sessions'));
  const queries = f.queryCount() - before;
  assert.ok(queries > 0 && queries <= 3, `Listing sixty workspace sessions must not perform per-session authorization queries; used ${queries}`);
  assert.deepEqual(sessions.map(session => session.id).sort(), [...workspaceIds, 'granted-private'].sort());
  for (const session of sessions) {
    assert.deepEqual(session.permissions, session.id === 'granted-private' ? ['read', 'ask'] : ['read']);
    assert.equal(session.visibility, session.id === 'granted-private' ? 'private' : 'workspace');
  }
  assert.equal(s.hub.requests.length, 1, 'Listing must not dispatch runtime work');
});

for (const mutation of ['owner-membership', 'policy-version'] as const) {
  test(`visibility PATCH compare-and-swap rejects a concurrent ${mutation} change without an audit or runtime effect`, async t => {
    const f = await fixture(t); const s = await sharedSession(f);
    const path = `/api/sessions/${s.session.id}`;
    const before = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
    let changed = false;
    f.setBeforeQuery(sql => {
      if (changed || !sql.startsWith('UPDATE sessions SET visibility =')) return;
      changed = true;
      if (mutation === 'owner-membership') {
        f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(s.team.id, s.creator.user.id);
      } else {
        f.sqlite.prepare("UPDATE sessions SET visibility = 'private', policy_version = policy_version + 1 WHERE id = ?").run(s.session.id);
      }
    });
    await denied(await s.creator.request('PATCH', path, { visibility: 'private' }), 409, 'policy_changed');
    f.setBeforeQuery();
    assert.equal(changed, true, 'The revocation must land after admission and before the conditional update');
    const after = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(s.session.id)!;
    assert.deepEqual({ ...after }, mutation === 'owner-membership' ? { ...before }
      : { ...before, visibility: 'private', policy_version: Number(before.policy_version) + 1 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND action = 'session.visibility.updated'").get(s.session.id)!.n, 0);
    assert.equal(s.hub.requests.length, 1);
    if (mutation === 'owner-membership') await denied(await s.creator.request('GET', path), 404, 'not_found');
  });
}
