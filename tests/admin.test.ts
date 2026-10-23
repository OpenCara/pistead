import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { app } from '../apps/server/src/index.js';
import { instanceAdmins } from '../apps/server/src/admin.js';
import { ConfigurationError, loadConfig } from '../apps/server/src/config.js';
import { authenticateConnectorSocket } from '../apps/server/src/connectors.js';
import type { Env } from '../apps/server/src/types.js';
import { fakeHub, testDatabase, type FakeHub } from './helpers/control-plane.js';
import type { AdminHost, AdminList, AdminOverview, AdminUser, AdminWorkspace } from '../packages/shared/src/admin.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import type { ModelDefinition, SessionRecord, UserProfile } from '../packages/shared/src/types.js';
import { sha256 } from '../packages/shared/src/crypto.js';

const origin = 'http://localhost:8787';
const testSecret = 'admin-test-secret-not-for-deployment';
const manifest = {
  models: [{ provider: 'local-native', modelId: 'local/model-v1', name: 'Local model' }],
  capabilities: { platform: 'linux', sandbox: true, productionShell: false, plainGit: true },
};
const token = () => Buffer.from(randomBytes(32)).toString('base64url');

type ApiRequest = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Response | Promise<Response>;
interface Client { user: { id: string }; cookie: string; request: ApiRequest }
interface Fixture { sqlite: DatabaseSync; env: Env; hub: FakeHub; request: ApiRequest; client(name: string): Promise<Client> }
type Connected = ConnectorCredentials & { connectionToken: string };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}

async function denied(response: Response, status: number, code: string) {
  assert.equal((await json<{ code: string }>(response, status)).code, code);
}

async function fixture(t: TestContext): Promise<Fixture> {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  // Session creation asks the host to start the session; nothing else is relayed in these tests.
  const hub = fakeHub({ rpc: (_connectorId, envelope) => envelope.request.ticket.action === 'create'
    ? Response.json({ ok: true }, { status: 201 }) : Response.json({ error: 'Unsupported test relay request' }, { status: 503 }) });
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    CONNECTOR_HUB: hub, ADMIN_USER_IDS: 'github:1, test:operator' };
  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  async function client(name: string): Promise<Client> {
    const response = await request('POST', '/api/auth/test', { id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` },
      { Authorization: `Bearer ${testSecret}` });
    const { user } = await json<{ user: { id: string } }>(response);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await json<{ csrfToken: string }>(await request('GET', '/api/auth/csrf', undefined, { Cookie: cookie }));
    return { user, cookie, request: (method, path, body, headers = {}) => request(method, path, body, { Cookie: cookie, 'X-CSRF-Token': csrfToken, ...headers }) };
  }
  return { sqlite, env, hub, request, client };
}

async function workspace(owner: Client) {
  return (await json<{ workspace: { id: string } }>(await owner.request('POST', '/api/workspaces', { name: 'Team' }), 201)).workspace;
}

async function connect(f: Fixture, owner: Client, workspaceId: string): Promise<Connected> {
  const { pairing } = await json<{ pairing: ConnectorPairing }>(await owner.request('POST', '/api/connectors/pairings', { name: 'Local Pi', workspaceId }), 201);
  const { credentials } = await json<{ credentials: ConnectorCredentials }>(
    await f.request('POST', `/api/connectors/pairings/${pairing.id}/claim`, { code: pairing.code, ...manifest }), 201);
  const connectionToken = token();
  // The socket hub normally installs this generation; these tests exercise HTTP routes.
  f.sqlite.prepare('UPDATE connectors SET connection_hash = ? WHERE id = ?').run(await sha256(connectionToken), credentials.connectorId);
  return { ...credentials, connectionToken };
}

function self(f: Fixture, connector: Connected, path: string, body: unknown) {
  return f.request('POST', `/api/connectors/self/${path}`, body, { Authorization: `Bearer ${connector.token}`, 'X-Connection-Token': connector.connectionToken });
}

/** Alice runs a host in her workspace and shares it; she and Bob each have a session on it. */
async function team(f: Fixture) {
  const operator = await f.client('operator'); const alice = await f.client('alice'); const bob = await f.client('bob');
  const { id: workspaceId } = await workspace(alice);
  await json(await alice.request('POST', `/api/workspaces/${workspaceId}/members`, { userId: bob.user.id, role: 'member' }));
  const connector = await connect(f, alice, workspaceId);
  await json(await alice.request('PUT', `/api/connectors/${connector.connectorId}/shares/${workspaceId}`));
  const models = async (member: Client) => (await json<{ models: ModelDefinition[] }>(await member.request('GET', `/api/workspaces/${workspaceId}/models`))).models;
  const [model] = await models(alice);
  async function session(owner: Client) {
    return (await json<{ session: SessionRecord }>(await owner.request('POST', '/api/sessions',
      { workspaceId, modelId: model.id, title: 'Private work', trustedConnectorId: connector.connectorId }), 201)).session;
  }
  return { operator, alice, bob, workspaceId, connector, models, aliceSession: await session(alice), bobSession: await session(bob) };
}

test('only the administrators ADMIN_USER_IDS lists reach the admin API, and their profile says so', async t => {
  const f = await fixture(t);
  const operator = await f.client('operator'); const alice = await f.client('alice');
  assert.equal((await json<{ user: UserProfile }>(await operator.request('GET', '/api/me'))).user.instanceAdmin, true);
  assert.equal((await json<{ user: UserProfile }>(await operator.request('PATCH', '/api/me', { displayName: 'Operator' }))).user.instanceAdmin, true);
  assert.equal('instanceAdmin' in (await json<{ user: UserProfile }>(await alice.request('GET', '/api/me'))).user, false);
  for (const [method, path] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/users'], ['GET', '/api/admin/workspaces'], ['GET', '/api/admin/hosts'],
    ['POST', `/api/admin/users/${operator.user.id}/suspend`], ['POST', `/api/admin/users/${operator.user.id}/unsuspend`]] as const) {
    await denied(await alice.request(method, path), 403, 'forbidden');
    await denied(await f.request(method, path), 401, 'unauthorized');
  }
  // Changes need the CSRF token like every other browser request.
  await denied(await f.request('POST', `/api/admin/users/${alice.user.id}/suspend`, undefined, { Cookie: operator.cookie }), 403, 'invalid_csrf');
  // A test identity counts only while test mode lasts.
  assert.deepEqual([...instanceAdmins(f.env)], ['github:1', 'test:operator']);
  assert.deepEqual([...instanceAdmins({ ...f.env, TEST_AUTH_ENABLED: 'false' })], ['github:1']);
});

test('the server refuses to start with an ADMIN_USER_IDS entry that is not a GitHub user ID, or a test identity in test mode', async () => {
  const base = { APP_ORIGIN: 'https://pistead.example.com', SESSION_SECRET: 's'.repeat(32), VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    DATABASE_URL: 'sqlite::memory:' };
  for (const value of ['octocat', 'github:1,', 'github:01', 'test:operator']) {
    await assert.rejects(loadConfig({ ...base, ADMIN_USER_IDS: value }), ConfigurationError, value);
  }
  const testMode = { TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString() };
  for (const [settings, value] of [[{}, 'github:1, github:42'], [testMode, 'github:1, test:operator']] as const) {
    const config = await loadConfig({ ...base, ...settings, ADMIN_USER_IDS: value });
    try { assert.equal(config.env.ADMIN_USER_IDS, value); }
    finally { await config.env.CONNECTOR_HUB?.close(); await config.env.DB.close(); }
  }
});

test('the admin lists every account, workspace and host, without what anyone works on', async t => {
  const f = await fixture(t);
  const { operator, alice, bob, workspaceId, connector } = await team(f);
  const { overview } = await json<{ overview: AdminOverview }>(await operator.request('GET', '/api/admin/overview'));
  assert.deepEqual(overview, { users: 3, suspendedUsers: 0, workspaces: 1, hosts: 1, onlineHosts: 1, sessions: 2, activeSessions: 2 });

  const usersResponse = await operator.request('GET', '/api/admin/users');
  const users = await json<AdminList<AdminUser>>(usersResponse.clone());
  assert.equal(users.truncated, false);
  const byId = Object.fromEntries(users.items.map(user => [user.id, user]));
  assert.deepEqual(Object.keys(byId).sort(), [alice.user.id, bob.user.id, operator.user.id].sort());
  assert.deepEqual({ ...byId[alice.user.id], createdAt: '' }, { id: alice.user.id, githubLogin: null, displayName: 'alice', createdAt: '',
    instanceAdmin: false, suspendedAt: null, workspaces: 1, hosts: 1, sessions: 1 });
  assert.equal(byId[operator.user.id].instanceAdmin, true);
  assert.equal(byId[bob.user.id].hosts, 0);

  const workspaces = await json<AdminList<AdminWorkspace>>(await operator.request('GET', '/api/admin/workspaces'));
  assert.deepEqual(workspaces.items.map(item => ({ ...item, createdAt: '' })), [{ id: workspaceId, name: 'Team', ownerId: alice.user.id, ownerName: 'alice',
    ownerGithubLogin: null, createdAt: '', members: 2, repositories: 0, hosts: 1, sessions: 2 }]);

  const hostsResponse = await operator.request('GET', '/api/admin/hosts');
  const hosts = await json<AdminList<AdminHost>>(hostsResponse.clone());
  assert.deepEqual(hosts.items.map(item => ({ ...item, createdAt: '' })), [{ id: connector.connectorId, name: 'Local Pi', ownerId: alice.user.id,
    ownerName: 'alice', ownerGithubLogin: null, createdAt: '', lastSeenAt: null, revokedAt: null, online: true, workspaces: 1, sessions: 2 }]);

  // Nothing about the work itself: no session titles, models, emails or credentials.
  const listed = await usersResponse.text() + await hostsResponse.text();
  for (const secret of ['Private work', 'local/model-v1', 'alice@example.test', connector.token]) assert.equal(listed.includes(secret), false, secret);
});

test('suspending an account signs it out, refuses its hosts and its sessions, and unsuspending restores it', async t => {
  const f = await fixture(t);
  const { operator, alice, bob, connector, models, aliceSession, bobSession } = await team(f);
  const activity = (sessionId: string) => self(f, connector, 'activity', { sessionId, activity: 'working' });
  assert.equal((await bob.request('GET', `/api/sessions/${aliceSession.id}`)).status, 200);
  await json(await activity(bobSession.id));

  const { user } = await json<{ user: AdminUser }>(await operator.request('POST', `/api/admin/users/${alice.user.id}/suspend`));
  assert.ok(user.suspendedAt);
  assert.deepEqual(f.hub.revoked, [connector.connectorId]);
  assert.deepEqual(f.sqlite.prepare('SELECT action, actor_id, workspace_id, detail_json FROM audit WHERE action LIKE ?').all('user.%').map(row => ({ ...row })),
    [{ action: 'user.suspended', actor_id: operator.user.id, workspace_id: null, detail_json: JSON.stringify({ userId: alice.user.id }) }]);
  // Signed out everywhere, and no new sign-in.
  await denied(await alice.request('GET', '/api/me'), 401, 'unauthorized');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(alice.user.id)!.n, 0);
  await denied(await f.request('POST', '/api/auth/test', { id: 'alice' }, { Authorization: `Bearer ${testSecret}` }), 403, 'account_suspended');
  // Her host is refused, also for Bob's session on it, and her models are no longer offered.
  await denied(await activity(bobSession.id), 401, 'connector_authentication_required');
  await assert.rejects(authenticateConnectorSocket(f.env, new Headers({ 'sec-websocket-protocol': `opencara-pi-v1, bearer.${connector.token}` }),
    new URL(`${origin}/api/connectors/socket`)), (error: unknown) => error instanceof HTTPException && error.status === 401);
  assert.deepEqual(await models(bob), []);
  // Nobody opens the sessions she owns; Bob still reads his own.
  await denied(await bob.request('GET', `/api/sessions/${aliceSession.id}`), 404, 'not_found');
  assert.equal((await bob.request('GET', `/api/sessions/${bobSession.id}`)).status, 200);
  const { overview } = await json<{ overview: AdminOverview }>(await operator.request('GET', '/api/admin/overview'));
  assert.equal(overview.suspendedUsers, 1);

  // Suspending again changes nothing.
  await json(await operator.request('POST', `/api/admin/users/${alice.user.id}/suspend`));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'user.suspended'").get()!.n, 1);

  const restored = await json<{ user: AdminUser }>(await operator.request('POST', `/api/admin/users/${alice.user.id}/unsuspend`));
  assert.equal(restored.user.suspendedAt, null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'user.unsuspended'").get()!.n, 1);
  assert.equal((await bob.request('GET', `/api/sessions/${aliceSession.id}`)).status, 200);
  assert.equal((await models(bob)).length, 1);
  await json(await activity(bobSession.id));
  const again = await f.client('alice');
  assert.equal((await again.request('GET', `/api/sessions/${aliceSession.id}`)).status, 200);
});

test('a suspended session owner\'s sessions are refused on hosts that are still trusted', async t => {
  const f = await fixture(t);
  const { operator, alice, bob, connector, aliceSession, bobSession } = await team(f);
  await json(await operator.request('POST', `/api/admin/users/${bob.user.id}/suspend`));
  assert.deepEqual(f.hub.revoked, [], 'Bob has no host');
  await denied(await self(f, connector, 'activity', { sessionId: bobSession.id, activity: 'working' }), 403, 'connector_unavailable');
  await denied(await self(f, connector, 'network', { sessionId: bobSession.id }), 403, 'connector_unavailable');
  await json(await self(f, connector, 'activity', { sessionId: aliceSession.id, activity: 'working' }));
  await denied(await alice.request('GET', `/api/sessions/${bobSession.id}`), 404, 'not_found');
});

test('only the request that changes an account\'s suspension records it, also when requests race', async t => {
  const f = await fixture(t);
  const operator = await f.client('operator'); const alice = await f.client('alice');
  const audited = (action: string) => f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?').get(action)!.n;
  // Both requests check the account before either writes: each batch waits until the other request reaches its own.
  const db = f.env.DB;
  let waiting: (() => void) | null = null;
  f.env.DB = { ...db, async batch(statements) {
    if (waiting) { waiting(); waiting = null; } else await new Promise<void>(resolve => { waiting = resolve; });
    return db.batch(statements);
  } };
  for (const action of ['suspend', 'unsuspend'] as const) {
    const responses = await Promise.all([1, 2].map(() => operator.request('POST', `/api/admin/users/${alice.user.id}/${action}`)));
    for (const response of responses) await json(response);
    assert.equal(audited(`user.${action}ed`), 1, action);
  }
  f.env.DB = db;
  await json(await operator.request('POST', `/api/admin/users/${alice.user.id}/unsuspend`));
  assert.equal(audited('user.unsuspended'), 1, 'unsuspending an active account records nothing');
});

test('administrators can\'t be suspended, and unknown or malformed accounts are refused', async t => {
  const f = await fixture(t);
  const operator = await f.client('operator');
  await denied(await operator.request('POST', `/api/admin/users/${operator.user.id}/suspend`), 409, 'instance_admin');
  await denied(await operator.request('POST', '/api/admin/users/github:1/suspend'), 409, 'instance_admin');
  await denied(await operator.request('POST', '/api/admin/users/github:2/suspend'), 404, 'not_found');
  await denied(await operator.request('POST', '/api/admin/users/github:2/unsuspend'), 404, 'not_found');
  await denied(await operator.request('POST', '/api/admin/users/octocat/suspend'), 400, 'invalid_input');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL').get()!.n, 0);
});
