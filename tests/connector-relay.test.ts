import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ConnectorHubRegistry } from '../apps/server/src/connector-hub.js';
import { connectorPath, connectorRequest, validateConnectorRpc, connectorUtf8Bytes, connectorJsonValid, type ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import { openDatabase } from '../apps/server/src/db/index.js';
import type { Database, Query, SqlValue } from '../apps/server/src/db/types.js';
import type { AppContext, Env, SessionRow } from '../apps/server/src/types.js';
import { connectorLimits, type ConnectorRpcRequest } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import type { RunnerAction } from '../packages/shared/src/types.js';

/** A connector-side client: records relayed requests and the server's close code. */
class RelaySocket {
  readonly requests: ConnectorRpcRequest[] = [];
  readonly messages: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly waiters: ((request: ConnectorRpcRequest) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    this.closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? '' : data.toString();
      this.messages.push(text);
      if (text === 'pong' || text === '') return;
      const message = JSON.parse(text) as ConnectorRpcRequest;
      if (message.type !== 'request') return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message); else this.requests.push(message);
    });
  }
  get readyState(): number { return this.ws.readyState; }
  send(raw: string | Buffer): void {
    try { this.ws.send(raw); } catch { /* A closed socket cannot answer; the assertions check the outcome. */ }
  }
  async nextRequest(): Promise<ConnectorRpcRequest> {
    const existing = this.requests.shift();
    if (existing) return existing;
    const { promise, resolve } = Promise.withResolvers<ConnectorRpcRequest>();
    this.waiters.push(resolve);
    return promise;
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close(1000, '');
    await this.closed;
  }
}

async function fixture(t: TestContext) {
  const db = await openDatabase('sqlite::memory:');
  await db.migrate();
  const run = (sql: string, ...values: SqlValue[]) => db.query(sql).bind(...values).run();
  const exec = async (sql: string) => {
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await run(statement);
  };
  const created = new Date().toISOString();
  for (const [user, github] of [['owner', '1'], ['host', '2'], ['guest', '3']]) {
    await run('INSERT INTO users (id, github_id, display_name, git_name, git_email, auth_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user, github, user, user, `${user}@example.test`, 'github', created);
  }
  await run('INSERT INTO workspaces VALUES (?, ?, ?, ?)', 'workspace', 'Workspace', 'owner', created);
  for (const user of ['owner', 'host', 'guest']) await run('INSERT INTO workspace_members VALUES (?, ?, ?, ?)', 'workspace', user, user === 'owner' ? 'owner' : 'member', created);
  const credentialHash = await sha256('fixture-connector-bearer-not-a-global-secret');
  await run('INSERT INTO connectors (id, owner_id, name, credential_hash, created_at, models_json, capabilities_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'connector', 'host', 'Local host', credentialHash, created, JSON.stringify([{ provider: 'openai', modelId: 'local-model', name: 'Local model' }]), JSON.stringify({ platform: 'linux', sandbox: true, productionShell: false }));
  await run('INSERT INTO connector_shares VALUES (?, ?, ?)', 'connector', 'workspace', created);
  await run('INSERT INTO connector_workspaces VALUES (?, ?, ?)', 'connector', 'workspace', created);
  await run('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'model', 'workspace', 'Model', 'openai', 'local-model', created, 'connector', 'host');
  await run('INSERT INTO agents VALUES (?, ?, ?)', 'agent', 'owner', created);
  await run('INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'version', 'agent', 'owner', 'workspace', 1, 'Agent', '', '', '[]', 'model', created);
  await run("INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private')",
    'session', 'workspace', 'owner', 'version', 'Session', 1, 'ready', created, 'connector', 'host');
  await run('INSERT INTO session_grants VALUES (?, ?, ?, ?)', 'session', 'guest', '["read","manage"]', created);
  let beforeQuery: ((sql: string) => Promise<void>) | undefined;
  // The hub sees a provider whose statements can be held mid-flight to reproduce admission races.
  const hooked: Database = {
    provider: db.provider,
    batch: statements => db.batch(statements),
    transaction: work => db.transaction(work),
    migrate: () => db.migrate(),
    close: () => db.close(),
    query<T>(sql: string): Query<T> {
      let inner = db.query<T>(sql);
      const outer: Query<T> = {
        bind: (...values) => { inner = inner.bind(...values); return outer; },
        first: (async (column?: keyof T) => { await beforeQuery?.(sql); return column === undefined ? inner.first() : inner.first(column); }) as Query<T>['first'],
        all: async () => { await beforeQuery?.(sql); return inner.all(); },
        run: async () => { await beforeQuery?.(sql); return inner.run(); },
      };
      return outer;
    },
  };
  const env = { DB: hooked, APP_ORIGIN: 'https://app.example.test' } as Env;
  const hub = new ConnectorHubRegistry(env);
  env.CONNECTOR_HUB = hub;
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  const upgrades: Promise<void>[] = [];
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const connectorId = request.headers['x-connector-id'];
    const credential = request.headers['x-connector-credential-hash'];
    upgrades.push(hub.connect(request, socket, head, String(connectorId ?? ''), String(credential ?? '')));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listen address');
  const origin = `ws://127.0.0.1:${address.port}`;
  const sockets: RelaySocket[] = [];
  async function connect(headers: Record<string, string> = { 'X-Connector-Id': 'connector', 'X-Connector-Credential-Hash': credentialHash }) {
    const ws = new WebSocket(`${origin}/api/connectors/socket`, ['opencara-pi-v1', 'bearer.unused'], { headers });
    const socket = new RelaySocket(ws);
    sockets.push(socket);
    const welcome = await new Promise<{ type: string; connectorId: string; connectionToken: string }>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => reject(Object.assign(new Error(`rejected ${response.statusCode}: ${body}`), { status: response.statusCode, body })));
      });
      ws.once('error', reject);
      ws.once('message', data => resolve(JSON.parse(data.toString())));
    });
    assert.equal(ws.protocol, 'opencara-pi-v1');
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.connectorId, 'connector');
    return { socket, welcome };
  }
  t.after(async () => {
    beforeQuery = undefined;
    for (const socket of sockets) await socket.close();
    await Promise.allSettled(upgrades);
    await hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  });
  const initial = await connect();
  async function envelope(action: RunnerAction = 'view', body = '', actorId = 'owner'): Promise<ConnectorRelayEnvelope> {
    const connectionHash = await db.query<{ connection_hash: string }>('SELECT connection_hash FROM connectors WHERE id = ?').bind('connector').first('connection_hash');
    const issuedAt = Math.floor(Date.now() / 1000);
    const requestId = crypto.randomUUID();
    return { connectorId: 'connector', credentialHash, connectionHash: connectionHash!,
      request: { type: 'request', id: requestId, method: action === 'view' || action === 'events' ? 'GET' : 'POST',
        path: connectorPath(action, 'session', action === 'approve' ? 'approval' : ''), body,
        ticket: { aud: 'runner', connectorId: 'connector', sessionId: 'session', actorId, ownerId: 'owner', action,
          policyVersion: 1, iat: issuedAt, exp: issuedAt + 60, jti: requestId, bodyHash: await sha256(body) } } };
  }
  const rpc = (value: ConnectorRelayEnvelope) => hub.rpc('connector', value);
  const reply = (socket: RelaySocket, request: ConnectorRpcRequest, body = '{"ok":true}', status = 200) => {
    socket.send(JSON.stringify({ type: 'response', id: request.id, status, body }));
  };
  const connectionHash = () => db.query<{ connection_hash: string | null }>('SELECT connection_hash FROM connectors WHERE id = ?').bind('connector').first('connection_hash');
  return { db, env, hub, initial, connect, envelope, rpc, reply, exec, connectionHash,
    setBeforeQuery(hook?: (sql: string) => Promise<void>) { beforeQuery = hook; } };
}

/** Lets in-flight frames land; used only to prove that nothing was sent. */
const settled = () => delay(30);

test('connector handshake stores only the connection hash, negotiates the protocol and answers heartbeats', async t => {
  const f = await fixture(t);
  const { socket, welcome } = f.initial;
  assert.equal(await f.connectionHash(), await sha256(welcome.connectionToken));
  socket.send('ping');
  await delay(30);
  assert.ok(socket.messages.includes('pong'), 'ping is answered with pong');
  assert.equal(await f.hub.status('connector', 1000), true);
  assert.equal(await f.hub.status('other', 1000), false);
  const pending = f.rpc(await f.envelope());
  const wire = await socket.nextRequest();
  f.reply(socket, wire);
  assert.deepEqual(await (await pending).json(), { ok: true });
});

test('handshake rejects wrong credentials and stale generations with HTTP errors before upgrading', async t => {
  const f = await fixture(t);
  await assert.rejects(f.connect({ 'X-Connector-Id': 'connector', 'X-Connector-Credential-Hash': 'x'.repeat(43) }), { status: 403 });
  await assert.rejects(f.connect({ 'X-Connector-Id': 'other', 'X-Connector-Credential-Hash': 'x'.repeat(43) }), { status: 403 });
  assert.equal(f.initial.socket.readyState, WebSocket.OPEN, 'rejected handshakes do not disturb the live connection');
  assert.equal(await f.hub.status('connector', 1000), true);
});

test('transport preserves session ownership and restore ticket claims without any global secret', async t => {
  const f = await fixture(t);
  const c = { env: f.env, get: () => ({ userId: 'owner' }) } as unknown as AppContext;
  const row = await f.db.query<SessionRow>('SELECT * FROM sessions').first();
  const pending = connectorRequest(c, row!, 'restore', '', { restore: { id: 'restore' } });
  const wire = await f.initial.socket.nextRequest();
  assert.equal(wire.path, '/v1/sessions/session/restore');
  assert.equal(wire.ticket.ownerId, 'owner');
  assert.equal(wire.ticket.connectorId, 'connector');
  assert.equal(wire.ticket.exp - wire.ticket.iat, 60);
  assert.equal(wire.ticket.bodyHash, await sha256(wire.body));
  assert.ok(!JSON.stringify(wire).includes('credentialHash'));
  f.reply(f.initial.socket, wire, '{"restored":true}');
  assert.deepEqual(await (await pending).json(), { restored: true });
});

test('RPC validation rejects path confusion, body tampering, ticket mismatch, SSE and oversized bodies', async t => {
  const f = await fixture(t);
  for (const mutate of [
    (e: ConnectorRelayEnvelope) => { e.request.path = '/v1/sessions/other/view'; },
    (e: ConnectorRelayEnvelope) => { e.request.path += '?token=secret'; },
    (e: ConnectorRelayEnvelope) => { e.request.ticket.connectorId = 'other'; },
    (e: ConnectorRelayEnvelope) => { e.request.id = 'wrong'; },
    (e: ConnectorRelayEnvelope) => { e.request.body = 'tampered'; },
    (e: ConnectorRelayEnvelope) => { e.request.ticket.exp += 60; },
    (e: ConnectorRelayEnvelope) => { e.request.ticket.action = 'events'; e.request.path = '/v1/sessions/session/events'; },
  ]) {
    const value = await f.envelope(); mutate(value);
    assert.equal((await f.rpc(value)).status, 400);
  }
  await assert.rejects(validateConnectorRpc(await f.envelope('submit', 'x'.repeat(connectorLimits.requestBytes + 1))));
  assert.equal((await f.hub.rpc('other', await f.envelope())).status, 503, 'an unknown connector id is offline');
  await settled();
  assert.equal(f.initial.socket.requests.length, 0);
});

test('the caller envelope keeps its own request id while the wire carries a hub-minted nonce', async t => {
  const f = await fixture(t);
  const value = await f.envelope();
  const pending = f.rpc(value);
  const wire = await f.initial.socket.nextRequest();
  assert.notEqual(wire.id, value.request.id);
  assert.equal(wire.ticket.jti, wire.id);
  assert.equal(value.request.id, value.request.ticket.jti, 'the caller still holds its original ticket');
  f.reply(f.initial.socket, wire);
  assert.equal((await pending).status, 200);
});

const revocations: Record<string, string> = {
  association: 'DELETE FROM connector_workspaces',
  share: 'DELETE FROM connector_shares',
  hostMembership: "DELETE FROM workspace_members WHERE user_id = 'host'",
  ownerMembership: "DELETE FROM workspace_members WHERE user_id = 'owner'",
  grant: 'DELETE FROM session_grants',
  policyVersion: 'UPDATE sessions SET policy_version = policy_version + 1',
  modelAvailability: 'UPDATE models SET available = 0',
  manifest: "UPDATE connectors SET models_json = '[]'",
  revocation: "UPDATE connectors SET revoked_at = 'revoked'",
  credential: "UPDATE connectors SET credential_hash = 'changed'",
  generation: "UPDATE connectors SET connection_hash = 'changed'",
};
for (const [name, mutation] of Object.entries(revocations)) {
  for (const stage of ['dispatch', 'response']) {
    test(`${name} is checked against the live database before ${stage}`, async t => {
      const f = await fixture(t);
      const value = await f.envelope('view', '', 'guest');
      if (stage === 'dispatch') {
        await f.exec(mutation);
        assert.ok([403, 503].includes((await f.rpc(value)).status));
        await settled();
        assert.equal(f.initial.socket.requests.length, 0);
      } else {
        const pending = f.rpc(value);
        const wire = await f.initial.socket.nextRequest();
        await f.exec(mutation);
        f.reply(f.initial.socket, wire, '{"private":"must-not-leak"}');
        const response = await pending;
        assert.ok([403, 503].includes(response.status));
        assert.ok(!(await response.text()).includes('must-not-leak'));
      }
    });
  }
}

test('manage grant cannot back up, restore or restart another creator session', async t => {
  const f = await fixture(t);
  for (const action of ['backup', 'restore', 'restart', 'create'] as const) {
    const value = await f.envelope(action, '{}', 'guest');
    assert.equal((await f.rpc(value)).status, 403);
  }
});

test('reconnect fails ambiguous in-flight work and old sockets cannot answer or clear the new generation', async t => {
  const f = await fixture(t);
  const old = f.initial.socket;
  const pending = f.rpc(await f.envelope());
  const oldWire = await old.nextRequest();
  const next = await f.connect();
  assert.equal((await pending).status, 503);
  assert.deepEqual(await old.closed, { code: 1012, reason: 'Connection replaced' });
  const nextHash = await sha256(next.welcome.connectionToken);
  const nextPending = f.rpc(await f.envelope());
  const nextWire = await next.socket.nextRequest();
  f.reply(old, nextWire, '{"wrong":true}');
  f.reply(old, oldWire, '{"late":true}');
  await old.close();
  await settled();
  assert.equal(await f.connectionHash(), nextHash);
  f.reply(next.socket, nextWire, '{"generation":"new"}');
  assert.deepEqual(await (await nextPending).json(), { generation: 'new' });
});

test('socket replacement during a pending database admission fences dispatch', async t => {
  const f = await fixture(t);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: entered, resolve: signal } = Promise.withResolvers<void>();
  let held = false;
  f.setBeforeQuery(async sql => {
    if (!held && sql.includes('FROM sessions s')) { held = true; signal(); await gate; }
  });
  const pending = f.rpc(await f.envelope());
  await entered;
  const replacement = await f.connect();
  release();
  assert.ok([403, 503].includes((await pending).status));
  await settled();
  assert.equal(f.initial.socket.requests.length, 0);
  assert.equal(replacement.socket.requests.length, 0);
});

test('unsolicited and duplicate replies fail closed without satisfying another RPC', async t => {
  const f = await fixture(t);
  const value = await f.envelope();
  const first = f.rpc(value);
  const firstWire = await f.initial.socket.nextRequest();
  f.reply(f.initial.socket, firstWire);
  await (await first).text();
  const second = f.rpc(value);
  const secondWire = await f.initial.socket.nextRequest();
  assert.notEqual(secondWire.id, firstWire.id);
  f.reply(f.initial.socket, firstWire, '{"duplicate":true}');
  assert.equal((await second).status, 502);
  assert.equal((await f.initial.socket.closed).code, 1008);
});

test('concurrent duplicate response cannot race through asynchronous policy checks', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  f.reply(f.initial.socket, wire);
  f.reply(f.initial.socket, wire);
  assert.equal((await pending).status, 502);
});

test('malformed, binary, oversized and over-limit frames close the generation and fail requests', async t => {
  const f = await fixture(t);
  for (const kind of ['malformed', 'binary', 'oversized', 'status', 'frame']) {
    const { socket } = kind === 'malformed' ? f.initial : await f.connect();
    const pending = f.rpc(await f.envelope());
    const wire = await socket.nextRequest();
    if (kind === 'malformed') socket.send('{');
    if (kind === 'binary') socket.send(Buffer.alloc(1));
    if (kind === 'oversized') f.reply(socket, wire, 'x'.repeat(connectorLimits.responseBytes + 1));
    if (kind === 'status') f.reply(socket, wire, 'body', 204);
    if (kind === 'frame') socket.send(Buffer.alloc(connectorLimits.frameBytes + 1, 0x20));
    const response = await pending;
    assert.equal(response.status, 502, `${kind}: ${response.status}`);
    // ws itself refuses frames above maxPayload with 1009 before the relay sees them.
    assert.equal((await socket.closed).code, kind === 'frame' ? 1009 : 1008, kind);
    assert.equal(await f.connectionHash(), null, `${kind} clears the generation`);
  }
});

test('pending RPC and undrained completed response counts remain aggregate bounded', async t => {
  const f = await fixture(t);
  const pending: Promise<Response>[] = [];
  const wires: ConnectorRpcRequest[] = [];
  for (let i = 0; i < connectorLimits.pendingRequests; i++) {
    pending.push(f.rpc(await f.envelope()));
    wires.push(await f.initial.socket.nextRequest());
  }
  assert.equal((await f.rpc(await f.envelope())).status, 429);
  for (const wire of wires) f.reply(f.initial.socket, wire);
  const responses = await Promise.all(pending);
  assert.equal((await f.rpc(await f.envelope())).status, 429, 'undrained replies retain concurrency slots');
  await Promise.all(responses.map(response => response.body!.cancel()));
  const accepted = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  f.reply(f.initial.socket, wire);
  assert.equal((await accepted).status, 200);
  await (await accepted).body!.cancel();
});

test('aggregate response buffering rejects overflow even below individual response limits', async t => {
  const f = await fixture(t);
  const responses: Response[] = [];
  for (let i = 0; i < 3; i++) {
    const pending = f.rpc(await f.envelope());
    const wire = await f.initial.socket.nextRequest();
    f.reply(f.initial.socket, wire, JSON.stringify('x'.repeat(9 * 1024 * 1024)));
    const response = await pending;
    if (i < 2) { assert.equal(response.status, 200); responses.push(response); }
    else assert.equal(response.status, 502, 'wire frame plus decoded body exceeds aggregate capacity');
  }
  await Promise.all(responses.map(response => response.body!.cancel()));
});

test('deadline closes ambiguous generation and late replies never replay effects', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.rpc(await f.envelope('submit', '{}'));
  const wire = await f.initial.socket.nextRequest();
  t.mock.timers.tick(30001);
  assert.equal((await pending).status, 504);
  t.mock.timers.reset();
  assert.deepEqual(await f.initial.socket.closed, { code: 1008, reason: 'Connector timed out' });
  f.reply(f.initial.socket, wire, '{"late":true}');
  assert.equal(f.initial.socket.requests.length, 0);
  assert.equal(f.initial.socket.messages.filter(raw => raw.startsWith('{') && JSON.parse(raw).type === 'request').length, 1);
});

test('revoke is namespace scoped, requires database revocation and drains active requests', async t => {
  const f = await fixture(t);
  await assert.rejects(f.hub.revoke('other'), { status: 404 });
  await assert.rejects(f.hub.revoke('connector'), { status: 409 });
  const pending = f.rpc(await f.envelope());
  await f.initial.socket.nextRequest();
  await f.exec("UPDATE connectors SET revoked_at = 'revoked'");
  await f.hub.revoke('connector');
  assert.equal((await pending).status, 403);
  assert.deepEqual(await f.initial.socket.closed, { code: 1008, reason: 'Connector revoked' });
  assert.equal(await f.hub.status('connector', 1000), false);
});

test('status reports false once the database generation no longer matches or the lookup times out', async t => {
  const f = await fixture(t);
  assert.equal(await f.hub.status('connector', 1000), true);
  f.setBeforeQuery(async () => { await delay(200); });
  assert.equal(await f.hub.status('connector', 20), false, 'a slow database check reports offline');
  f.setBeforeQuery(undefined);
  await f.exec("UPDATE connectors SET connection_hash = 'changed'");
  assert.equal(await f.hub.status('connector', 1000), false);
  assert.equal(f.initial.socket.readyState, WebSocket.OPEN, 'status is read-only');
});

test('hub close disconnects every connector and clears its generation', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  await f.initial.socket.nextRequest();
  await f.hub.close();
  assert.equal((await pending).status, 503);
  assert.deepEqual(await f.initial.socket.closed, { code: 1012, reason: 'Server shutting down' });
  assert.equal(await f.connectionHash(), null);
});

test('allocation-free byte counts and JSON validation handle UTF-8, escapes and bounded nesting', () => {
  for (const value of ['', 'ascii', '\\u0000', '\u00e9', '\ud83d\ude00', '\ud800', '\udc00']) {
    assert.equal(connectorUtf8Bytes(value), new TextEncoder().encode(value).byteLength);
    assert.equal(connectorJsonValid(JSON.stringify({ value })), true);
  }
  for (const raw of ['null', 'false', '12.5e-2', ' [1, {"escaped":"\\u0041"}] ', '"\\\\"']) assert.equal(connectorJsonValid(raw), true);
  for (const raw of ['', '<html>', 'NaN', '01', '1.', '[1,]', '{"a":1,}', '"\\q"', '{} trailing']) assert.equal(connectorJsonValid(raw), false);
  assert.equal(connectorJsonValid('['.repeat(130) + '0' + ']'.repeat(130)), false);
  assert.equal(connectorJsonValid('{\"body\":{\"unexpected\":\"object\"}}', 1, 8), false);
});

test('backup may finish after ticket admission expiry but never beyond its relay deadline', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const pending = f.rpc(await f.envelope('backup', '{}'));
  const wire = await f.initial.socket.nextRequest();
  t.mock.timers.tick(61000);
  f.reply(f.initial.socket, wire, '{"snapshot":true}');
  assert.deepEqual(await (await pending).json(), { snapshot: true });
  t.mock.timers.reset();
});

test('an unsolicited id closes the socket without forwarding connector-controlled bytes', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  f.reply(f.initial.socket, { ...wire, id: 'unsolicited' }, '{"private":"not-a-correlated-reply"}');
  const response = await pending;
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('not-a-correlated-reply'));
  assert.deepEqual(await f.initial.socket.closed, { code: 1008, reason: 'Unsolicited connector response' });
});

test('non-JSON upstream responses are rejected instead of relabeled application/json', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  f.reply(f.initial.socket, wire, '<html>not a runner response</html>');
  assert.equal((await pending).status, 502);
});

test('chunked replies preserve surrogate pairs across chunk boundaries', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  const body = JSON.stringify('a'.repeat(16382) + '\ud83d\ude00' + 'z'.repeat(20000));
  f.reply(f.initial.socket, wire, body);
  assert.equal(await (await pending).text(), body);
});

test('replacement during response policy lookup discards the old response', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: entered, resolve: signal } = Promise.withResolvers<void>();
  let held = false;
  f.setBeforeQuery(async sql => {
    if (!held && sql.includes('FROM sessions s')) { held = true; signal(); await gate; }
  });
  f.reply(f.initial.socket, wire, '{"private":"old-response"}');
  await entered;
  const replacement = await f.connect();
  release();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('old-response'));
  assert.equal(await f.connectionHash(), await sha256(replacement.welcome.connectionToken));
});

test('workspace visibility authorizes relay reads without granting any mutation or backup action', async t => {
  const f = await fixture(t);
  await f.exec("DELETE FROM session_grants; UPDATE sessions SET visibility = 'workspace'");
  const value = await f.envelope('view', '', 'guest');
  const pending = f.rpc(value);
  const wire = await f.initial.socket.nextRequest();
  assert.equal(wire.ticket.actorId, 'guest');
  assert.equal(wire.ticket.ownerId, 'owner');
  f.reply(f.initial.socket, wire, '{"view":"workspace-readable"}');
  assert.deepEqual(await (await pending).json(), { view: 'workspace-readable' });
  for (const action of ['ask', 'submit', 'operations', 'approve', 'backup', 'restore', 'restart', 'create'] as const) {
    assert.equal((await f.rpc(await f.envelope(action, '{}', 'guest'))).status, 403, action);
  }
  await settled();
  assert.equal(f.initial.socket.requests.length, 0);
});

for (const mutation of ['privacy', 'membership'] as const) {
  for (const stage of ['dispatch', 'response'] as const) {
    test(`workspace ${mutation} is rechecked by the relay before ${stage} without an explicit grant`, async t => {
      const f = await fixture(t);
      await f.exec("DELETE FROM session_grants; UPDATE sessions SET visibility = 'workspace'");
      const value = await f.envelope('view', '', 'guest');
      const sql = mutation === 'privacy' ? "UPDATE sessions SET visibility = 'private'"
        : "DELETE FROM workspace_members WHERE user_id = 'guest'";
      // Do not bump policy_version: live access must be sufficient even with an unchanged ticket.
      if (stage === 'dispatch') {
        await f.exec(sql);
        assert.equal((await f.rpc(value)).status, 403);
        await settled();
        assert.equal(f.initial.socket.requests.length, 0);
      } else {
        const pending = f.rpc(value);
        const wire = await f.initial.socket.nextRequest();
        await f.exec(sql);
        f.reply(f.initial.socket, wire, '{"private":"workspace-revoked-must-not-leak"}');
        const response = await pending;
        assert.equal(response.status, 403);
        assert.ok(!(await response.text()).includes('workspace-revoked-must-not-leak'));
      }
    });
  }
}

const isolatedRevocations: Record<string, string> = {
  share: "DELETE FROM connector_shares; UPDATE sessions SET policy_version = policy_version + 1 WHERE owner_id <> 'host'",
  privacy: "UPDATE sessions SET visibility = 'private', policy_version = policy_version + 1 WHERE id = 'session'",
  membership: "DELETE FROM workspace_members WHERE user_id = 'guest'",
};
for (const name of ['share', 'privacy', 'membership', 'revocation', 'credential', 'generation']) {
  test(`${name} response denial isolates session policy but preserves host-generation fencing`, async t => {
    const f = await fixture(t);
    await f.exec(`DELETE FROM session_grants;
      UPDATE sessions SET visibility = 'workspace';
      INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status,
        created_at, connector_id, connector_owner_id, visibility)
      SELECT 'host-session', workspace_id, 'host', agent_version_id, 'Host session', 1, 'ready',
        created_at, connector_id, connector_owner_id, 'workspace' FROM sessions WHERE id = 'session'`);
    const viewer = f.rpc(await f.envelope('view', '', 'guest'));
    const viewerWire = await f.initial.socket.nextRequest();
    const ownerEnvelope = await f.envelope('view', '', 'host');
    ownerEnvelope.request.path = connectorPath('view', 'host-session', '');
    ownerEnvelope.request.ticket.sessionId = 'host-session';
    ownerEnvelope.request.ticket.ownerId = 'host';
    const owner = f.rpc(ownerEnvelope);
    const ownerWire = await f.initial.socket.nextRequest();
    const generation = await f.connectionHash();
    const isolated = name in isolatedRevocations;
    await f.exec(isolatedRevocations[name] ?? revocations[name]!);
    f.reply(f.initial.socket, viewerWire, '{"private":"revoked-content-must-not-leak"}');
    const denied = await viewer;
    assert.equal(denied.status, 403);
    assert.ok(!(await denied.text()).includes('revoked-content-must-not-leak'));
    if (!isolated) {
      assert.equal((await owner).status, 403);
      assert.equal((await f.initial.socket.closed).code, 1008, 'host revocation still closes the entire generation');
      return;
    }
    await settled();
    assert.equal(f.initial.socket.readyState, WebSocket.OPEN, 'session revocation must not disconnect the host');
    assert.equal(await f.connectionHash(), generation);
    f.reply(f.initial.socket, ownerWire, '{"owner":"uninterrupted"}');
    assert.deepEqual(await (await owner).json(), { owner: 'uninterrupted' });
    const continued = f.rpc(ownerEnvelope);
    const continuedWire = await f.initial.socket.nextRequest();
    f.reply(f.initial.socket, continuedWire, '{"owner":"still-connected"}');
    assert.deepEqual(await (await continued).json(), { owner: 'still-connected' });
  });
}
