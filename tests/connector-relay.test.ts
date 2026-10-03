import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ConnectorHub } from '../apps/worker/src/connector-hub.js';
import { connectorPath, connectorRequest, validateConnectorRpc, connectorUtf8Bytes, connectorJsonValid, type ConnectorRelayEnvelope } from '../apps/worker/src/connector-transport.js';
import type { AppContext, Env, SessionRow } from '../apps/worker/src/types.js';
import { connectorLimits, type ConnectorRpcRequest } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import type { RunnerAction } from '../packages/shared/src/types.js';

const NativeResponse = Response;
class RelaySocket {
  readyState = 1;
  attachment: unknown = null;
  sent: string[] = [];
  closes: { code: number; reason: string }[] = [];
  requests: ConnectorRpcRequest[] = [];
  waiters: ((request: ConnectorRpcRequest) => void)[] = [];
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error('closed');
    this.sent.push(raw);
    const message = JSON.parse(raw) as ConnectorRpcRequest;
    if (message.type === 'request') {
      const waiter = this.waiters.shift();
      if (waiter) waiter(message); else this.requests.push(message);
    }
  }
  close(code: number, reason: string) { this.closes.push({ code, reason }); this.readyState = 3; }
  async nextRequest(): Promise<ConnectorRpcRequest> {
    const existing = this.requests.shift();
    if (existing) return existing;
    const { promise, resolve } = Promise.withResolvers<ConnectorRpcRequest>();
    this.waiters.push(resolve);
    return promise;
  }
}

async function fixture(t: TestContext) {
  const globals = ['WebSocketPair', 'WebSocketRequestResponsePair', 'Response'];
  const descriptors = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'WebSocketPair', { configurable: true, value: class {
    0 = new RelaySocket();
    1 = new RelaySocket();
  } });
  Object.defineProperty(globalThis, 'WebSocketRequestResponsePair', { configurable: true, value: class {
    constructor(readonly request: string, readonly response: string) {}
  } });
  Object.defineProperty(globalThis, 'Response', { configurable: true, value: class extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) {
        Object.defineProperty(this, 'status', { value: 101 });
        Object.defineProperty(this, 'webSocket', { value: init.webSocket });
      }
    }
  } });
  const db = new DatabaseSync(':memory:');
  const local = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../apps/worker/migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(`BEGIN; ${readFileSync(new URL(file, migrations), 'utf8')} COMMIT;`);
  }
  const created = new Date().toISOString();
  for (const [user, github] of [['owner', '1'], ['host', '2'], ['guest', '3']]) {
    db.prepare('INSERT INTO users (id, github_id, display_name, git_name, git_email, auth_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user, github, user, user, `${user}@example.test`, 'github', created);
  }
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run('workspace', 'Workspace', 'owner', created);
  for (const user of ['owner', 'host', 'guest']) db.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, ?)').run('workspace', user, user === 'owner' ? 'owner' : 'member', created);
  const credentialHash = await sha256('fixture-connector-bearer-not-a-global-secret');
  db.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, created_at, models_json, capabilities_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('connector', 'host', 'Local host', credentialHash, created, JSON.stringify([{ provider: 'openai', modelId: 'local-model', name: 'Local model' }]), JSON.stringify({ platform: 'linux', sandbox: true, productionShell: false }));
  db.prepare('INSERT INTO connector_shares VALUES (?, ?, ?)').run('connector', 'workspace', created);
  db.prepare('INSERT INTO connector_workspaces VALUES (?, ?, ?)').run('connector', 'workspace', created);
  db.prepare('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('model', 'workspace', 'Model', 'openai', 'local-model', created, 'connector', 'host');
  db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run('agent', 'owner', created);
  db.prepare('INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('version', 'agent', 'owner', 'workspace', 1, 'Agent', '', '', '[]', 'model', created);
  db.prepare("INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private')")
    .run('session', 'workspace', 'owner', 'version', 'Session', 1, 'ready', created, 'connector', 'host');
  db.prepare('INSERT INTO session_grants VALUES (?, ?, ?, ?)').run('session', 'guest', '["read","manage"]', created);
  let beforeQuery: ((sql: string) => Promise<void>) | undefined;
  class Prepared {
    values: (string | number | null)[] = [];
    constructor(readonly sql: string) {}
    bind(...values: (string | number | null)[]) { this.values = values; return this; }
    async first(column?: string) {
      await beforeQuery?.(this.sql);
      const row = db.prepare(this.sql).get(...this.values);
      return row ? column ? row[column] : row : null;
    }
    async run() {
      await beforeQuery?.(this.sql);
      const result = db.prepare(this.sql).run(...this.values);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    }
  }
  const env = { DB: { prepare(sql: string) { return new Prepared(sql); } }, APP_ORIGIN: 'https://app.example.test' } as unknown as Env;
  const sockets: RelaySocket[] = [];
  let ready: Promise<unknown> = Promise.resolve();
  let autoResponse: unknown;
  const state = {
    storage: { sql: { exec(sql: string, ...bindings: (string | number | null)[]) {
      const rows = local.prepare(sql).all(...bindings);
      return { toArray: () => rows };
    } } },
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = ready.then(callback);
      ready = result;
      return result;
    },
    getWebSockets: () => sockets.filter(socket => socket.readyState === 1),
    acceptWebSocket(socket: RelaySocket) { sockets.push(socket); },
    setWebSocketAutoResponse(pair: unknown) { autoResponse = pair; },
  };
  let hub = new ConnectorHub(state as unknown as DurableObjectState, env);
  await ready;
  async function connect() {
    const response = await hub.fetch(new Request('https://connector.internal/socket', { headers: {
      Upgrade: 'websocket', 'X-Connector-Id': 'connector', 'X-Connector-Credential-Hash': credentialHash,
      'Sec-WebSocket-Protocol': 'opencara-pi-v1',
    } }));
    assert.equal(response.status, 101);
    assert.equal(response.headers.get('sec-websocket-protocol'), 'opencara-pi-v1');
    const socket = sockets.at(-1)!;
    const welcome = JSON.parse(socket.sent[0]) as { type: string; connectorId: string; connectionToken: string };
    assert.equal(welcome.type, 'welcome');
    return { socket, welcome };
  }
  const initial = await connect();
  async function envelope(action: RunnerAction = 'view', body = '', actorId = 'owner'): Promise<ConnectorRelayEnvelope> {
    const current = db.prepare('SELECT connection_hash FROM connectors WHERE id = ?').get('connector')!;
    const issuedAt = Math.floor(Date.now() / 1000);
    const requestId = crypto.randomUUID();
    return { connectorId: 'connector', credentialHash, connectionHash: current.connection_hash as string,
      request: { type: 'request', id: requestId, method: action === 'view' || action === 'events' ? 'GET' : 'POST',
        path: connectorPath(action, 'session', action === 'approve' ? 'approval' : ''), body,
        ticket: { aud: 'runner', connectorId: 'connector', sessionId: 'session', actorId, ownerId: 'owner', action,
          policyVersion: 1, iat: issuedAt, exp: issuedAt + 60, jti: requestId, bodyHash: await sha256(body) } } };
  }
  function rpc(value: ConnectorRelayEnvelope) {
    return hub.fetch(new Request('https://connector.internal/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }));
  }
  async function reply(socket: RelaySocket, request: ConnectorRpcRequest, body = '{"ok":true}', status = 200) {
    await hub.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: 'response', id: request.id, status, body }));
  }
  t.after(async () => {
    beforeQuery = undefined;
    for (const socket of sockets) await hub.webSocketClose(socket as unknown as WebSocket, 1000, '', true);
    db.close(); local.close();
    globals.forEach((name, index) => {
      if (descriptors[index]) Object.defineProperty(globalThis, name, descriptors[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  });
  return { db, local, env, initial, connect, envelope, rpc, reply,
    get hub() { return hub; }, get autoResponse() { return autoResponse; },
    setBeforeQuery(hook?: (sql: string) => Promise<void>) { beforeQuery = hook; },
    async hibernate() { hub = new ConnectorHub(state as unknown as DurableObjectState, env); await ready; },
  };
}

test('outbound connector handshake persists only hashes, restores hibernation identity and auto-heartbeats', async t => {
  const f = await fixture(t);
  const { socket, welcome } = f.initial;
  const stored = f.db.prepare('SELECT connection_hash FROM connectors').get()!;
  assert.equal(stored.connection_hash, await sha256(welcome.connectionToken));
  assert.ok(!JSON.stringify(f.local.prepare('SELECT * FROM connector_identity').all()).includes(welcome.connectionToken));
  assert.ok(!JSON.stringify(socket.attachment).includes(welcome.connectionToken));
  assert.deepEqual({ ...f.autoResponse as object }, { request: 'ping', response: 'pong' });
  await f.hibernate();
  assert.deepEqual(await (await f.hub.fetch(new Request('https://connector.internal/status'))).json(), { online: true });
  const pending = f.rpc(await f.envelope());
  const wire = await socket.nextRequest();
  await f.reply(socket, wire);
  assert.deepEqual(await (await pending).json(), { ok: true });
});

test('transport preserves session ownership and restore ticket claims without any global secret', async t => {
  const f = await fixture(t);
  const namespace = { idFromName(name: string) { assert.equal(name, 'connector'); return name; }, get() { return { fetch(url: string, init: RequestInit) { return f.hub.fetch(new Request(url, init)); } }; } };
  f.env.CONNECTOR_HUB = namespace as unknown as DurableObjectNamespace;
  const c = { env: f.env, get: () => ({ userId: 'owner' }) } as unknown as AppContext;
  const row = f.db.prepare('SELECT * FROM sessions').get() as unknown as SessionRow;
  const pending = connectorRequest(c, row, 'restore', '', { restore: { id: 'restore' } });
  const wire = await f.initial.socket.nextRequest();
  assert.equal(wire.path, '/v1/sessions/session/restore');
  assert.equal(wire.ticket.ownerId, 'owner');
  assert.equal(wire.ticket.connectorId, 'connector');
  assert.equal(wire.ticket.exp - wire.ticket.iat, 60);
  assert.equal(wire.ticket.bodyHash, await sha256(wire.body));
  assert.ok(!JSON.stringify(wire).includes('credentialHash'));
  await f.reply(f.initial.socket, wire, '{"restored":true}');
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
  assert.equal(f.initial.socket.requests.length, 0);
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
    test(`${name} is checked against live D1 before ${stage}`, async t => {
      const f = await fixture(t);
      const value = await f.envelope('view', '', 'guest');
      if (stage === 'dispatch') {
        f.db.exec(mutation);
        assert.ok([403, 503].includes((await f.rpc(value)).status));
        assert.equal(f.initial.socket.requests.length, 0);
      } else {
        const pending = f.rpc(value);
        const wire = await f.initial.socket.nextRequest();
        f.db.exec(mutation);
        await f.reply(f.initial.socket, wire, '{"private":"must-not-leak"}');
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
  const nextHash = await sha256(next.welcome.connectionToken);
  const nextPending = f.rpc(await f.envelope());
  const nextWire = await next.socket.nextRequest();
  await f.reply(old, nextWire, '{"wrong":true}');
  await f.reply(old, oldWire, '{"late":true}');
  await f.hub.webSocketClose(old as unknown as WebSocket, 1000, '', true);
  assert.equal(f.db.prepare('SELECT connection_hash FROM connectors').get()!.connection_hash, nextHash);
  await f.reply(next.socket, nextWire, '{"generation":"new"}');
  assert.deepEqual(await (await nextPending).json(), { generation: 'new' });
});

test('socket replacement during a pending D1 admission fences dispatch', async t => {
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
  assert.equal(f.initial.socket.requests.length, 0);
  assert.equal(replacement.socket.requests.length, 0);
});

test('unsolicited and duplicate replies fail closed without satisfying another RPC', async t => {
  const f = await fixture(t);
  const value = await f.envelope();
  const first = f.rpc(value);
  const firstWire = await f.initial.socket.nextRequest();
  await f.reply(f.initial.socket, firstWire);
  await (await first).text();
  const second = f.rpc(value);
  const secondWire = await f.initial.socket.nextRequest();
  assert.notEqual(secondWire.id, firstWire.id);
  await f.reply(f.initial.socket, firstWire, '{"duplicate":true}');
  assert.equal((await second).status, 502);
  assert.equal(f.initial.socket.readyState, 3);
});

test('concurrent duplicate response cannot race through asynchronous policy checks', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  await Promise.all([f.reply(f.initial.socket, wire), f.reply(f.initial.socket, wire)]);
  assert.equal((await pending).status, 502);
});

test('malformed, binary and oversized responses close the generation and fail requests', async t => {
  const f = await fixture(t);
  for (const kind of ['malformed', 'binary', 'oversized', 'status']) {
    const { socket } = kind === 'malformed' ? f.initial : await f.connect();
    const pending = f.rpc(await f.envelope());
    const wire = await socket.nextRequest();
    if (kind === 'malformed') await f.hub.webSocketMessage(socket as unknown as WebSocket, '{');
    if (kind === 'binary') await f.hub.webSocketMessage(socket as unknown as WebSocket, new ArrayBuffer(1));
    if (kind === 'oversized') await f.reply(socket, wire, 'x'.repeat(connectorLimits.responseBytes + 1));
    if (kind === 'status') await f.reply(socket, wire, 'body', 204);
    assert.ok([403, 502].includes((await pending).status));
    assert.equal(socket.readyState, 3);
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
  for (const wire of wires) await f.reply(f.initial.socket, wire);
  const responses = await Promise.all(pending);
  assert.equal((await f.rpc(await f.envelope())).status, 429, 'undrained replies retain concurrency slots');
  await Promise.all(responses.map(response => response.body!.cancel()));
  const accepted = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  await f.reply(f.initial.socket, wire);
  assert.equal((await accepted).status, 200);
  await (await accepted).body!.cancel();
});

test('aggregate response buffering rejects overflow even below individual response limits', async t => {
  const f = await fixture(t);
  const responses: Response[] = [];
  for (let i = 0; i < 3; i++) {
    const pending = f.rpc(await f.envelope());
    const wire = await f.initial.socket.nextRequest();
    await f.reply(f.initial.socket, wire, JSON.stringify('x'.repeat(9 * 1024 * 1024)));
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
  await f.reply(f.initial.socket, wire, '{"late":true}');
  assert.equal(f.initial.socket.sent.filter(raw => JSON.parse(raw).type === 'request').length, 1);
  t.mock.timers.reset();
});

test('revoke is namespace scoped, requires D1 revocation and drains active requests', async t => {
  const f = await fixture(t);
  const revoke = (connectorId: string) => f.hub.fetch(new Request('https://connector.internal/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectorId }),
  }));
  assert.equal((await revoke('other')).status, 404);
  assert.equal((await revoke('connector')).status, 409);
  const pending = f.rpc(await f.envelope());
  await f.initial.socket.nextRequest();
  f.db.exec("UPDATE connectors SET revoked_at = 'revoked'");
  assert.equal((await revoke('connector')).status, 204);
  assert.equal((await pending).status, 403);
  assert.deepEqual(await (await f.hub.fetch(new Request('https://connector.internal/status'))).json(), { online: false });
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
  await f.reply(f.initial.socket, wire, '{"snapshot":true}');
  assert.deepEqual(await (await pending).json(), { snapshot: true });
  t.mock.timers.reset();
});

test('an unsolicited id closes the socket without forwarding connector-controlled bytes', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  await f.reply(f.initial.socket, { ...wire, id: 'unsolicited' }, '{"private":"not-a-correlated-reply"}');
  const response = await pending;
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('not-a-correlated-reply'));
});

test('non-JSON upstream responses are rejected instead of relabeled application/json', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  await f.reply(f.initial.socket, wire, '<html>not a runner response</html>');
  assert.equal((await pending).status, 502);
});

test('chunked replies preserve surrogate pairs across chunk boundaries', async t => {
  const f = await fixture(t);
  const pending = f.rpc(await f.envelope());
  const wire = await f.initial.socket.nextRequest();
  const body = JSON.stringify('a'.repeat(16382) + '\ud83d\ude00' + 'z'.repeat(20000));
  await f.reply(f.initial.socket, wire, body);
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
  const oldReply = f.reply(f.initial.socket, wire, '{"private":"old-response"}');
  await entered;
  const replacement = await f.connect();
  release();
  await oldReply;
  const response = await pending;
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('old-response'));
  assert.equal(f.db.prepare('SELECT connection_hash FROM connectors').get()!.connection_hash, await sha256(replacement.welcome.connectionToken));
});

test('workspace visibility authorizes relay reads without granting any mutation or backup action', async t => {
  const f = await fixture(t);
  f.db.exec("DELETE FROM session_grants; UPDATE sessions SET visibility = 'workspace'");
  const value = await f.envelope('view', '', 'guest');
  const pending = f.rpc(value);
  const wire = await f.initial.socket.nextRequest();
  assert.equal(wire.ticket.actorId, 'guest');
  assert.equal(wire.ticket.ownerId, 'owner');
  await f.reply(f.initial.socket, wire, '{"view":"workspace-readable"}');
  assert.deepEqual(await (await pending).json(), { view: 'workspace-readable' });
  for (const action of ['ask', 'submit', 'operations', 'approve', 'backup', 'restore', 'restart', 'create'] as const) {
    assert.equal((await f.rpc(await f.envelope(action, '{}', 'guest'))).status, 403, action);
  }
  assert.equal(f.initial.socket.requests.length, 0);
});

for (const mutation of ['privacy', 'membership'] as const) {
  for (const stage of ['dispatch', 'response'] as const) {
    test(`workspace ${mutation} is rechecked by the relay before ${stage} without an explicit grant`, async t => {
      const f = await fixture(t);
      f.db.exec("DELETE FROM session_grants; UPDATE sessions SET visibility = 'workspace'");
      const value = await f.envelope('view', '', 'guest');
      const sql = mutation === 'privacy' ? "UPDATE sessions SET visibility = 'private'"
        : "DELETE FROM workspace_members WHERE user_id = 'guest'";
      // Do not bump policy_version: live access must be sufficient even with an unchanged ticket.
      if (stage === 'dispatch') {
        f.db.exec(sql);
        assert.equal((await f.rpc(value)).status, 403);
        assert.equal(f.initial.socket.requests.length, 0);
      } else {
        const pending = f.rpc(value);
        const wire = await f.initial.socket.nextRequest();
        f.db.exec(sql);
        await f.reply(f.initial.socket, wire, '{"private":"workspace-revoked-must-not-leak"}');
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
    f.db.exec(`DELETE FROM session_grants;
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
    const generation = f.db.prepare("SELECT connection_hash FROM connectors WHERE id = 'connector'").get()!.connection_hash;
    const isolated = name in isolatedRevocations;
    f.db.exec(isolatedRevocations[name] ?? revocations[name]!);
    await f.reply(f.initial.socket, viewerWire, '{"private":"revoked-content-must-not-leak"}');
    const denied = await viewer;
    assert.equal(denied.status, 403);
    assert.ok(!(await denied.text()).includes('revoked-content-must-not-leak'));
    if (!isolated) {
      assert.equal((await owner).status, 403);
      assert.equal(f.initial.socket.readyState, 3, 'host revocation still closes the entire generation');
      return;
    }
    assert.equal(f.initial.socket.readyState, 1, 'session revocation must not disconnect the host');
    assert.equal(f.db.prepare("SELECT connection_hash FROM connectors WHERE id = 'connector'").get()!.connection_hash, generation);
    await f.reply(f.initial.socket, ownerWire, '{"owner":"uninterrupted"}');
    assert.deepEqual(await (await owner).json(), { owner: 'uninterrupted' });
    const continued = f.rpc(ownerEnvelope);
    const continuedWire = await f.initial.socket.nextRequest();
    await f.reply(f.initial.socket, continuedWire, '{"owner":"still-connected"}');
    assert.deepEqual(await (await continued).json(), { owner: 'still-connected' });
  });
}
