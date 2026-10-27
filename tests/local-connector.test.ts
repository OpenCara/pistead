import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { ConnectorCapabilities, ConnectorCredentials, ConnectorRpcRequest, LocalModelSummary } from '../packages/shared/src/connector.js';
import type { AuthorizationRequest, ModelDefinition, RunnerAction, RunnerBinding } from '../packages/shared/src/types.js';
import type { ConnectorRuntime, ConnectorSocket, LocalConnector } from '../apps/runner/src/connector.js';
import type { LocalModels } from '../apps/runner/src/local-pi.js';
import type { RunnerConfig } from '../apps/runner/src/session.js';
import { connectorLimits } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { claimConnectorPairing, connectorManifest, controlPlaneOrigin, createConnector, readConnectorState, validateRelayRequest, writeConnectorState } from '../apps/runner/src/connector.js';
import { verifyRunnerTicket } from '../apps/runner/src/protocol.js';

// Linux connectors also accept sessions moved from another host.
const hostMigration = process.platform === 'linux' ? { hostMigration: true } : {};

const origin = 'https://control.fixture.invalid';
const credentials: ConnectorCredentials = {
  connectorId: 'fixture-connector', token: 'fixture_only_connector_token_0123456789abcdef', controlPlaneUrl: origin,
};
const replacement: ConnectorCredentials = {
  connectorId: 'replacement-connector', token: 'replacement_connector_token_0123456789abcdef', controlPlaneUrl: origin,
};
const connectionToken = 'fixture_only_connection_token_0123456789abcdef';
const providerSecret = 'fixture-provider-secret-never-on-wire';
const verifierSecret = 'fixture-local-verifier-not-a-worker-secret';
const summary: LocalModelSummary = { provider: 'native.fixture', modelId: 'region/model', name: 'Local fixture model' };
const model: ModelDefinition = { ...summary, id: 'model', workspaceId: 'workspace', connectorId: credentials.connectorId };
// As the CLI and the desktop host advertise it: isolation is verified per session, not claimed up front.
const publicCapabilities: ConnectorCapabilities = { platform: 'linux', sandbox: false, productionShell: false };
const authorizationRequest: AuthorizationRequest = { sessionId: 'session', actorId: 'owner', ownerId: 'owner', permission: 'write' };
function localModels(entries: LocalModelSummary[] = [summary]): LocalModels {
  return {
    manifest: () => Promise.resolve(entries),
    resolve: () => Promise.reject(new Error('This transport fixture must not execute a model')),
  };
}

function binding(): RunnerBinding {
  return {
    session: {
      id: 'session', workspaceId: 'workspace', ownerId: 'owner', agentVersionId: 'agent-version',
      title: 'Fixture', policyVersion: 1, status: 'ready', createdAt: '2026-01-01T00:00:00Z',
      connectorId: credentials.connectorId,
    },
    owner: {
      id: 'owner', githubId: null, githubLogin: null, displayName: 'Fixture owner',
      gitName: 'Fixture', gitEmail: 'fixture@example.invalid', env: {}, githubConnected: false,
    },
    agent: {
      id: 'agent-version', agentId: 'agent', authorId: 'owner', workspaceId: 'workspace', version: 1,
      name: 'Fixture', description: '', instructions: '', tools: [], modelId: model.id, createdAt: '2026-01-01T00:00:00Z',
    },
    model: { ...model },
  };
}

async function rpc(action: RunnerAction = 'view', body = '', id = 'request'): Promise<ConnectorRpcRequest> {
  const now = Math.floor(Date.now() / 1000);
  return {
    type: 'request', id, method: action === 'view' || action === 'events' ? 'GET' : 'POST',
    path: action === 'create' ? '/v1/sessions' : `/v1/sessions/session/${action === 'approve' ? 'approvals/approval' : action}`,
    body,
    ticket: {
      aud: 'runner', sessionId: 'session', actorId: 'owner', ownerId: 'owner', action,
      policyVersion: 1, iat: now, exp: now + 45, jti: `ticket-${id}`, bodyHash: await sha256(body), connectorId: credentials.connectorId,
    },
  };
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'local-connector-fixture-'));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('connector token state is mode0600 in a private directory and cannot be overwritten', async t => {
  const root = await directory(t);
  const stateDir = join(root, 'state');
  assert.equal(await readConnectorState(stateDir, origin), undefined);
  await writeConnectorState(stateDir, credentials);
  assert.equal((await lstat(stateDir)).mode & 0o777, 0o700);
  const file = join(stateDir, 'connector.json');
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(file)).nlink, 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, credentials });
  assert.deepEqual(await readConnectorState(stateDir, origin), credentials);
  await assert.rejects(writeConnectorState(stateDir, { ...credentials, token: 'replacement_fixture_token_0123456789abcdef' }), { code: 'EEXIST' });
  assert.deepEqual(await readConnectorState(stateDir, origin), credentials);
});

test('connector state refuses permissive files/directories, symlinks, hard links and origin mismatch; replacing never follows a link', async t => {
  const root = await directory(t);
  const stateDir = join(root, 'state');
  await writeConnectorState(stateDir, credentials);
  const file = join(stateDir, 'connector.json');
  await chmod(file, 0o644);
  await assert.rejects(readConnectorState(stateDir, origin), /mode0600/);
  await chmod(file, 0o600);
  await chmod(stateDir, 0o755);
  await assert.rejects(readConnectorState(stateDir, origin), /mode0700/);
  await chmod(stateDir, 0o700);
  await assert.rejects(readConnectorState(stateDir, 'https://other.fixture.invalid'), /different control-plane origin/);

  const alias = join(root, 'alias');
  await symlink(stateDir, alias, 'dir');
  await assert.rejects(readConnectorState(alias, origin), /non-symlink mode0700/);
  await assert.rejects(writeConnectorState(alias, credentials), /non-symlink mode0700/);
  const target = join(root, 'token-target');
  await link(file, target);
  await assert.rejects(readConnectorState(stateDir, origin), /mode0600 regular file/);
  await unlink(file);
  await symlink(target, file);
  await assert.rejects(readConnectorState(stateDir, origin), /Cannot safely open connector state/);
  await assert.rejects(writeConnectorState(stateDir, credentials), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 1, credentials });
  // A forced re-pairing swaps the link itself for a private file and never writes through it.
  await writeConnectorState(stateDir, replacement, false, true);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 1, credentials });
  assert.deepEqual(await readConnectorState(stateDir, origin), replacement);
});

test('control-plane origins are fixed HTTPS origins with only explicit loopback HTTP opt-in', () => {
  assert.equal(controlPlaneOrigin(`${origin}/`), origin);
  assert.equal(controlPlaneOrigin('http://127.0.0.1:8787', true), 'http://127.0.0.1:8787');
  for (const value of [
    'http://127.0.0.1:8787', 'http://localhost:8787', `${origin}/api`, `${origin}?token=secret`,
    `${origin}#fragment`, 'https://user:pass@control.fixture.invalid', `${origin}/../`,
    `${origin}\\evil`, ` ${origin}`, 'wss://control.fixture.invalid',
  ]) assert.throws(() => controlPlaneOrigin(value), /origin|HTTPS/);
  assert.throws(() => controlPlaneOrigin('http://remote.fixture.invalid', true), /HTTPS/);
});

test('pairing posts only to the fixed origin and strips extra model/capability secrets', async () => {
  const calls: Request[] = [];
  const extraModel = { ...summary, apiKey: providerSecret, headers: { authorization: providerSecret }, auth: { refreshToken: providerSecret } };
  const extraCapabilities = { ...publicCapabilities, token: providerSecret, env: { API_KEY: providerSecret } };
  const fetchFixture: typeof fetch = (input, init) => {
    calls.push(new Request(input, init));
    return Promise.resolve(Response.json({ credentials }));
  };
  const result = await claimConnectorPairing({
    server: `${origin}/`, pairing: { id: 'pairing', code: 'fixture_pairing_code' },
    localModels: localModels([extraModel]), capabilities: extraCapabilities, fetch: fetchFixture,
  });
  assert.deepEqual(result, credentials);
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.url, `${origin}/api/connectors/pairings/pairing/claim`);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.headers.get('authorization'), null);
  assert.deepEqual(await request.json(), { code: 'fixture_pairing_code', models: [summary], capabilities: { ...publicCapabilities, chatOptions: true, chatImages: true, gitProviders: true, gitPush: true, github: true, githubIssues: true, schedules: true, plainGit: true, cloneBackups: true, sessionBranches: true, conversationBackups: true, hostCommands: true, hostGrants: true, hostOwnerDecides: true, automaticGitHub: true, fileBrowser: true, ...hostMigration, hostConfig: true, compactionConfig: true } });
  for (const secret of [providerSecret, credentials.token, 'fixture_pairing_code']) assert.equal(request.url.includes(secret), false);
});

test('pairing refuses URL injection before fetching, redirected claims and credentials for another origin', async () => {
  let calls = 0;
  let response = () => Response.json({ credentials });
  const options = {
    server: origin, pairing: { id: 'pairing', code: 'fixture_pairing_code' }, localModels: localModels(),
    fetch: ((input, init) => {
      calls++;
      assert.equal(new Request(input, init).redirect, 'error');
      return Promise.resolve(response());
    }) satisfies typeof fetch,
  };
  for (const server of [`${origin}/claim`, `${origin}?redirect=https://evil.invalid`, 'https://user:pass@control.fixture.invalid']) {
    await assert.rejects(claimConnectorPairing({ ...options, server }), /HTTPS origin/);
  }
  await assert.rejects(claimConnectorPairing({ ...options, pairing: { id: '../pairing', code: 'fixture_pairing_code' } }), /Invalid identifier/);
  await assert.rejects(claimConnectorPairing({ ...options, pairing: { id: 'pairing', code: 'bad?code' } }), /Invalid pairing code/);
  assert.equal(calls, 0);
  response = () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/claim' } });
  await assert.rejects(claimConnectorPairing(options), /Pairing rejected or unavailable/);
  assert.equal(calls, 1);
  response = () => Response.json({ credentials: { ...credentials, controlPlaneUrl: 'https://evil.invalid' } });
  await assert.rejects(claimConnectorPairing(options), /different control-plane origin/);
  assert.equal(calls, 2);
});

test('connector manifests reject duplicates, excessive catalogs and implicit faux providers', async () => {
  await assert.rejects(connectorManifest(localModels([summary, { ...summary }])), /Invalid or disabled local model/);
  await assert.rejects(connectorManifest(localModels([{ ...summary, provider: 'faux' }])), /Invalid or disabled local model/);
  assert.deepEqual(await connectorManifest(localModels([{ ...summary, provider: 'faux' }]), true), [{ ...summary, provider: 'faux' }]);
  await assert.rejects(connectorManifest(localModels(Array.from({ length: connectorLimits.models + 1 }, (_, index) => ({ ...summary, modelId: `model-${index}` })))), /Too many local models/);
});

test('relay accepts exactly the supported action/method/path combinations and locally signs bound tickets', async t => {
  const bodies: Record<Exclude<RunnerAction, 'events'>, string> = {
    create: JSON.stringify(binding()), view: '', submit: '{}', ask: '{}', operations: '{}',
    approve: '{}', backup: '{}', restart: '{}', restore: JSON.stringify({ binding: binding() }), stop: '{}',
    files: JSON.stringify({ path: 'src' }),
  };
  for (const action of Object.keys(bodies) as (keyof typeof bodies)[]) {
    await t.test(action, async () => {
      const request = await rpc(action, bodies[action]);
      const result = await validateRelayRequest(request, credentials.connectorId, verifierSecret);
      assert.notStrictEqual(result.rpc, request);
      assert.deepEqual(result.rpc, request);
      assert.notEqual(result.authorization, verifierSecret);
      assert.deepEqual(await verifyRunnerTicket(result.authorization, verifierSecret, action, 'session', request.body), request.ticket);
      await assert.rejects(verifyRunnerTicket(result.authorization, 'wrong-fixture-verifier', action, 'session', request.body));
    });
  }
});

test('relay accepts a view request for what changed since a revision', async () => {
  const view = await rpc();
  const request = { ...view, path: `${view.path}/${'a'.repeat(32)}` };
  const result = await validateRelayRequest(request, credentials.connectorId, verifierSecret);
  assert.deepEqual(result.rpc, request);
  assert.deepEqual(await verifyRunnerTicket(result.authorization, verifierSecret, 'view', 'session', ''), request.ticket);
});

test('relay rejects events, wrong methods, path tricks, unknown envelope fields and body changes', async t => {
  const view = await rpc();
  const submit = await rpc('submit', '{}');
  const cases: [string, unknown][] = [
    ['events', await rpc('events')], ['GET submit', { ...submit, method: 'GET' }],
    ['POST view', { ...view, method: 'POST' }], ['DELETE view', { ...view, method: 'DELETE' }],
    ['GET create', { ...await rpc('create', JSON.stringify(binding())), method: 'GET' }],
    ['query', { ...view, path: `${view.path}?token=hidden` }], ['fragment', { ...view, path: `${view.path}#fragment` }],
    ['absolute URL', { ...view, path: `https://evil.invalid${view.path}` }],
    ['encoded session', { ...view, path: '/v1/sessions/%73ession/view' }],
    ['traversal', { ...view, path: '/v1/sessions/session/../view' }],
    ['trailing slash', { ...view, path: `${view.path}/` }], ['unknown route', { ...view, path: '/v1/admin' }],
    ['short revision', { ...view, path: `${view.path}/abc` }], ['uppercase revision', { ...view, path: `${view.path}/${'A'.repeat(32)}` }],
    ['revision on submit', { ...submit, path: `${submit.path}/${'a'.repeat(32)}` }], ['POST revision', { ...view, method: 'POST', path: `${view.path}/${'a'.repeat(32)}` }],
    ['extra envelope secret', { ...view, authorization: providerSecret }], ['invalid request ID', { ...view, id: '../request' }],
    ['wrong type', { ...view, type: 'response' }], ['non-string body', { ...submit, body: {} }],
    ['non-empty GET', await rpc('view', '{}')], ['changed body', { ...submit, body: '{"changed":true}' }],
    ['oversized body', { ...submit, body: 'x'.repeat(connectorLimits.requestBytes + 1) }],
    ['UTF-8 byte limit', { ...submit, body: '\u00e9'.repeat(connectorLimits.requestBytes / 2 + 1) }],
    ['null request', null],
  ];
  for (const [label, value] of cases) {
    await t.test(label, () => assert.rejects(validateRelayRequest(value, credentials.connectorId, verifierSecret)));
  }
});

test('relay rejects mismatched or malformed ticket claims instead of trusting Worker-delivered JSON', async t => {
  const request = await rpc('submit', '{}');
  const now = Math.floor(Date.now() / 1000);
  const changes: Record<string, unknown> = {
    aud: 'another-service', action: 'ask', sessionId: 'another-session', connectorId: 'another-connector',
    bodyHash: await sha256('different'), policyVersion: 0, actorId: 'bad\nactor', ownerId: '',
    jti: '../ticket', exp: now - 1, iat: now + 30,
  };
  for (const [key, value] of Object.entries(changes)) {
    await t.test(key, () => assert.rejects(validateRelayRequest({ ...request, ticket: { ...request.ticket, [key]: value } }, credentials.connectorId, verifierSecret)));
  }
  const invalid: unknown[] = [
    undefined, null, { ...request.ticket, connectorId: undefined }, { ...request.ticket, jti: undefined },
    { ...request.ticket, extraSecret: providerSecret }, { ...request.ticket, policyVersion: 1.5 },
    { ...request.ticket, iat: now, exp: now + 61 }, { ...request.ticket, iat: now, exp: now },
    { ...request.ticket, exp: now + 10.5 }, { ...request.ticket, actorId: 'a'.repeat(201) },
  ];
  for (const ticket of invalid) await assert.rejects(validateRelayRequest({ ...request, ticket }, credentials.connectorId, verifierSecret));
  for (const action of ['create', 'restore', 'restart'] as const) {
    const body = action === 'create' ? JSON.stringify(binding()) : action === 'restore' ? JSON.stringify({ binding: binding() }) : '{}';
    const ownerOnly = await rpc(action, body);
    await assert.rejects(validateRelayRequest({ ...ownerOnly, ticket: { ...ownerOnly.ticket, actorId: 'guest' } }, credentials.connectorId, verifierSecret));
  }
});

test('create and restore independently bind session, model and owner even with a matching body hash', async t => {
  const changes: [string, (value: RunnerBinding) => void][] = [
    ['session connector', value => { value.session.connectorId = 'foreign'; }],
    ['model connector', value => { value.model.connectorId = 'foreign'; }],
    ['missing session connector', value => { delete value.session.connectorId; }],
    ['missing model connector', value => { delete value.model.connectorId; }],
    ['owner profile', value => { value.owner.id = 'foreign'; }],
    ['session owner', value => { value.session.ownerId = 'foreign'; }],
    ['session ID', value => { value.session.id = 'foreign'; }],
  ];
  for (const action of ['create', 'restore'] as const) {
    for (const [label, change] of changes) {
      await t.test(`${action}: ${label}`, async () => {
        const value = binding();
        change(value);
        const request = await rpc(action, JSON.stringify(action === 'create' ? value : { binding: value }));
        await assert.rejects(validateRelayRequest(request, credentials.connectorId, verifierSecret));
      });
    }
  }
});

class FakeSocket extends EventTarget implements ConnectorSocket {
  readyState = 0;
  private buffered = 0;
  private bufferRead?: () => void;
  protocol = 'opencara-pi-v1';
  readonly sent: string[] = [];
  readonly messages = mailbox<string>();
  readonly closed = Promise.withResolvers<void>();
  constructor(readonly url: string, readonly protocols: string[]) { super(); }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  get bufferedAmount(): number {
    this.bufferRead?.();
    this.bufferRead = undefined;
    return this.buffered;
  }
  set bufferedAmount(value: number) { this.buffered = value; }
  observeBufferRead(): Promise<void> {
    const observed = Promise.withResolvers<void>();
    this.bufferRead = observed.resolve;
    return observed.promise;
  }
  send(data: string): void {
    assert.equal(this.readyState, 1, 'must not send on a retired socket');
    this.sent.push(data);
    this.messages.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
    this.closed.resolve();
  }
  welcome(token = connectionToken): void {
    this.receive({ type: 'welcome', connectorId: credentials.connectorId, connectionToken: token });
  }
}

type Mailbox<T> = { push(value: T): void; next(): Promise<T> };

function mailbox<T>(): Mailbox<T> {
  const values: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) waiter(value); else values.push(value);
    },
    async next(): Promise<T> {
      if (values.length) return values.shift()!;
      const pending = Promise.withResolvers<T>();
      waiters.push(pending.resolve);
      return pending.promise;
    },
  };
}

type WorkerCall = { request: Request; body: string };
type RuntimeRecord = { config: RunnerConfig; requests: Request[]; closed: boolean };
type FixtureOptions = {
  manifest?: (generation: number) => Response | Promise<Response>;
  authorize?: () => Response | Promise<Response>;
  pushCredential?: (request: Request) => Response | Promise<Response>;
  github?: (request: Request) => Response | Promise<Response>;
  execute?: (request: Request, generation: number) => Response | Promise<Response>;
  unblock?: () => void;
  /** The control plane's answer to the host's configuration request; the defaults without it. */
  hostConfig?: () => Response | Promise<Response>;
  /** The GPU device the host could lend; none unless given, whatever this machine has. */
  gpu?: 'dxg' | 'render';
  /** What the host's Pi settings add to its models. */
  piSettings?: Pick<LocalModels, 'compaction' | 'identity'>;
};

async function connectorFixture(t: TestContext, options: FixtureOptions = {}) {
  const dataDir = await mkdtemp(join(await realpath(tmpdir()), 'local-connector-lifecycle-'));
  await chmod(dataDir, 0o700);
  const sockets = mailbox<FakeSocket>();
  const workerCalls = mailbox<WorkerCall>();
  const connected = mailbox<void>();
  const runtimes: RuntimeRecord[] = [];
  const allSockets: FakeSocket[] = [];
  const allCalls: WorkerCall[] = [];
  const statuses: string[] = [];
  const reasons: (string | undefined)[] = [];
  const leases = { acquired: 0, released: 0 };
  let manifests = 0;
  const connector = createConnector({
    dataDir, server: origin, localModels: { ...localModels([{ ...summary, ...{ apiKey: providerSecret } }]), ...options.piSettings },
    capabilities: publicCapabilities, reconnectDelayMs: 1, gpu: options.gpu ?? null,
    acquireLease: path => {
      assert.equal(path, dataDir);
      leases.acquired++;
      return Promise.resolve(() => { leases.released++; return Promise.resolve(); });
    },
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      allSockets.push(socket);
      sockets.push(socket);
      return socket;
    },
    runtimeFactory: config => {
      const generation = runtimes.length;
      const record: RuntimeRecord = { config, requests: [], closed: false };
      runtimes.push(record);
      const runtime: ConnectorRuntime = {
        fetch: request => {
          record.requests.push(request);
          return options.execute?.(request, generation) ?? Response.json({ ok: true });
        },
        close: () => { record.closed = true; return Promise.resolve(); },
      };
      return Promise.resolve(runtime);
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const call = { request, body: await request.text() };
      allCalls.push(call);
      // Asked for at every connection, before the runtime starts: kept out of the ordered calls the tests step through.
      if (request.url === `${origin}/api/connectors/self/config`) {
        return options.hostConfig?.() ?? Response.json({ config: { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off' } });
      }
      workerCalls.push(call);
      if (request.url === `${origin}/api/connectors/self/manifest`) {
        return options.manifest?.(manifests++) ?? Response.json({ ok: true });
      }
      if (request.url === `${origin}/api/connectors/self/authorize`) {
        return options.authorize?.() ?? Response.json({ allowed: true, policyVersion: 1, ownerId: 'owner' });
      }
      if (request.url === `${origin}/api/connectors/self/git/push/credential` && options.pushCredential) return options.pushCredential(request);
      if (request.url.startsWith(`${origin}/api/connectors/self/github/`) && options.github) return options.github(request);
      assert.fail(`Unexpected fixture Worker request: ${request.url}`);
    },
    onStatus: (status, reason) => {
      statuses.push(status);
      if (status === 'disconnected') reasons.push(reason);
      if (status === 'connected') connected.push();
    },
  });
  t.after(async () => {
    options.unblock?.();
    try { await connector.stop(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  await writeConnectorState(dataDir, credentials);
  return { connector, dataDir, sockets, workerCalls, connected, runtimes, allSockets, allCalls, statuses, reasons, leases };
}

type FixtureStartup = {
  connector: LocalConnector;
  sockets: Mailbox<FakeSocket>;
  connected: Mailbox<void>;
  workerCalls: Mailbox<WorkerCall>;
};

async function startFixture(fixture: FixtureStartup): Promise<FakeSocket> {
  const starting = fixture.connector.start();
  void starting.catch(() => {});
  const socket = await fixture.sockets.next();
  socket.open();
  socket.welcome();
  await starting;
  await fixture.connected.next();
  await fixture.workerCalls.next();
  return socket;
}

function deferredRuntime() {
  const started = mailbox<{ request: Request; response: PromiseWithResolvers<Response> }>();
  const responses: PromiseWithResolvers<Response>[] = [];
  let active = 0;
  let maximumActive = 0;
  return {
    started,
    get maximumActive() { return maximumActive; },
    execute(request: Request): Promise<Response> {
      const response = Promise.withResolvers<Response>();
      responses.push(response);
      maximumActive = Math.max(maximumActive, ++active);
      started.push({ request, response });
      return response.promise.finally(() => { active--; });
    },
    unblock(): void { for (const response of responses) response.resolve(new Response('fixture cleanup')); },
  };
}

function assertWorkerBoundary(calls: WorkerCall[], sockets: FakeSocket[], secrets: string[]): void {
  for (const { request, body } of calls) {
    assert.equal(new URL(request.url).origin, origin);
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.get('authorization'), `Bearer ${credentials.token}`);
    assert.ok(request.headers.get('x-connection-token'));
    assert.equal(request.url.includes(credentials.token), false);
    assert.equal(body.includes(credentials.token), false);
    assert.equal(body.includes(providerSecret), false);
    const wire = `${request.url}\n${JSON.stringify([...request.headers])}\n${body}`;
    for (const secret of secrets) assert.equal(wire.includes(secret), false, 'local verifier must never reach Worker');
  }
  for (const socket of sockets) {
    assert.equal(socket.url, 'wss://control.fixture.invalid/api/connectors/socket');
    assert.deepEqual(socket.protocols, ['opencara-pi-v1', `bearer.${credentials.token}`]);
    const wire = `${socket.url}\n${JSON.stringify(socket.protocols)}\n${socket.sent.join('\n')}`;
    for (const secret of [...secrets, providerSecret]) assert.equal(wire.includes(secret), false);
    for (const frame of socket.sent) assert.equal(frame.includes(credentials.token), false);
  }
}

test('fake WebSocket readiness requires welcome and acknowledged manifest; stop retires runtime and lease', { timeout: 10000 }, async t => {
  const manifest = Promise.withResolvers<Response>();
  const fixture = await connectorFixture(t, { manifest: () => manifest.promise, unblock: () => manifest.resolve(Response.json({ ok: true })) });
  let ready = false;
  const starting = fixture.connector.start();
  void starting.catch(() => {});
  void fixture.connector.ready.then(() => { ready = true; }, () => {});
  const socket = await fixture.sockets.next();
  socket.open();
  await nextTurn();
  assert.equal(ready, false);
  assert.equal(fixture.runtimes.length, 0);
  assert.equal(fixture.allCalls.length, 0);
  socket.welcome();
  const call = await fixture.workerCalls.next();
  assert.equal(call.request.url, `${origin}/api/connectors/self/manifest`);
  assert.deepEqual(JSON.parse(call.body), { models: [summary], capabilities: { ...publicCapabilities, chatOptions: true, chatImages: true, gitProviders: true, gitPush: true, github: true, githubIssues: true, schedules: true, plainGit: true, cloneBackups: true, sessionBranches: true, conversationBackups: true, hostCommands: true, hostGrants: true, hostOwnerDecides: true, automaticGitHub: true, fileBrowser: true, ...hostMigration, hostConfig: true, compactionConfig: true } });
  assert.equal(call.request.headers.get('x-connection-token'), connectionToken);
  assert.equal(fixture.runtimes.length, 1);
  assert.equal(ready, false);
  assert.equal(fixture.statuses.includes('connected'), false);
  manifest.resolve(Response.json({ ok: true }));
  await starting;
  assert.equal(ready, true);
  const config = fixture.runtimes[0]!.config;
  assert.equal(config.dataDir, join(fixture.dataDir, 'runner'));
  assert.equal(config.connectorId, credentials.connectorId);
  // The host's Git credentials stay unused until its owner turns them on in Pistead.
  await assert.rejects(config.hostGitCredential!('https://github.com/acme/alpha.git'), /hasn't turned on its Git credentials/);
  assert.deepEqual(await config.hostConfig!(), { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: {} });
  assert.equal(config.allowFaux, false);
  assert.equal(config.allowTestShell, false);
  assert.equal(config.compaction, undefined, 'without Pi settings, sessions compact by pi-durable\'s defaults');
  assert.equal(config.identity, undefined);
  assert.ok(config.sharedSecret.length >= 32);
  assert.notEqual(config.sharedSecret, credentials.token);
  assertWorkerBoundary(fixture.allCalls, fixture.allSockets, [config.sharedSecret]);
  await fixture.connector.stop();
  await fixture.connector.stop();
  assert.equal(socket.readyState, 3);
  assert.equal(fixture.runtimes[0]!.closed, true);
  assert.deepEqual(fixture.leases, { acquired: 1, released: 1 });
  assert.deepEqual(fixture.statuses, ['connecting', 'connected', 'stopped']);
});

const advertisedBase = { ...publicCapabilities, chatOptions: true, chatImages: true, gitProviders: true, gitPush: true, github: true, githubIssues: true, schedules: true, plainGit: true, cloneBackups: true, sessionBranches: true, conversationBackups: true, hostCommands: true, hostGrants: true, hostOwnerDecides: true, automaticGitHub: true, fileBrowser: true, ...hostMigration, hostConfig: true, compactionConfig: true };

test('a host configured in Pistead uses its Git credentials for pushes only while its owner has them on there', { timeout: 10000 }, async t => {
  let issued: unknown;
  const configured = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: { reserveTokens: 40_000 } };
  const fixture = await connectorFixture(t, { gpu: 'dxg', hostConfig: () => Response.json({ config: configured }), pushCredential: () => Response.json(issued) });
  await startFixture(fixture);
  const manifest = fixture.allCalls.find(call => call.request.url === `${origin}/api/connectors/self/manifest`)!;
  // It takes its configuration from Pistead and says which GPU device it could lend; Git credentials are no capability.
  assert.deepEqual(JSON.parse(manifest.body).capabilities, { ...advertisedBase, gpu: 'dxg' });
  const config = fixture.runtimes[0]!.config;
  assert.deepEqual(await config.hostConfig!(), configured);
  // The connection asked for it before its runtime started, as every callback is asked: over the current connection.
  const asked = fixture.allCalls.filter(call => call.request.url === `${origin}/api/connectors/self/config`);
  assert.equal(asked.length, 1);
  assert.ok(fixture.allCalls.indexOf(asked[0]!) < fixture.allCalls.indexOf(manifest));
  await assert.rejects(config.hostGitCredential!('https://github.com/acme/alpha.git'), /hasn't turned on its Git credentials/);
  const request = { sessionId: 'session', approvalId: 'tool-push', actorId: 'owner', admissionId: 'admission',
    operation: { kind: 'git.push', repository: 'acme/alpha', branch: 'feature', commit: 'a'.repeat(40) } } as const;
  const host = { credentialId: 'credential-1', remote: 'https://github.com/acme/alpha.git', hostCredentials: true, expiresAt: new Date().toISOString() };
  issued = host;
  assert.deepEqual(await config.pushCredential!(request), host);
  // A credential is either a token or the host's own: never both.
  issued = { ...host, authorization: 'Basic eDp5' };
  await assert.rejects(config.pushCredential!(request));
});

test('a host keeps the repository cache its configuration names for the whole connection, and says so', { timeout: 10000 }, async t => {
  const fixture = await connectorFixture(t, { hostConfig: () => Response.json({ config: { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'owner' } }) });
  await startFixture(fixture);
  const manifest = fixture.allCalls.find(call => call.request.url === `${origin}/api/connectors/self/manifest`)!;
  assert.deepEqual(JSON.parse(manifest.body).capabilities, { ...advertisedBase, repositoryCache: true });
  assert.equal(fixture.runtimes[0]!.config.repositoryCache?.scope, 'owner');
});

test('a host reads the largest configuration the control plane saves: compaction counts for every model, with the longest names', { timeout: 10000 }, async t => {
  const modelOverrides = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`${String(index).padStart(80, 'p')}/${'m'.repeat(200)}`,
    { reserveTokens: 10_000_000, keepRecentTokens: 10_000_000 }]));
  const configured = { commandTimeoutSeconds: 600, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: { reserveTokens: 10_000_000, modelOverrides } };
  const body = JSON.stringify({ config: configured });
  assert.ok(body.length > 64 * 1024, 'more than other callbacks take');
  const fixture = await connectorFixture(t, { hostConfig: () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  await startFixture(fixture);
  assert.deepEqual(await fixture.runtimes[0]!.config.hostConfig!(), configured);
});

test('without a configuration from the control plane, a host runs with the defaults and keeps no cache', { timeout: 10000 }, async t => {
  for (const answer of [() => new Response('Not found', { status: 404 }), () => Response.json({ config: { commandTimeoutSeconds: 5, gpu: false, gitCredentials: false, repositoryCache: 'off' } })]) {
    await t.test(answer().status === 404 ? 'a control plane that predates it' : 'an invalid one', async t => {
      const fixture = await connectorFixture(t, { hostConfig: answer });
      await startFixture(fixture);
      const config = fixture.runtimes[0]!.config;
      assert.equal(config.repositoryCache, undefined);
      assert.deepEqual(await config.hostConfig!(), { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: 'off', hostSessions: false, compaction: {} });
      const manifest = fixture.allCalls.find(call => call.request.url === `${origin}/api/connectors/self/manifest`)!;
      assert.deepEqual(JSON.parse(manifest.body).capabilities, advertisedBase);
    });
  }
});

test('sessions follow the compaction and attribution settings of the host\'s Pi', { timeout: 10000 }, async t => {
  const compaction = { reserveTokens: 8192, modelOverrides: { 'native.fixture/region/model': { keepRecentTokens: 4000 } } };
  const fixture = await connectorFixture(t, { piSettings: { compaction, identity: { attribution: null } } });
  await startFixture(fixture);
  const config = fixture.runtimes[0]!.config;
  assert.deepEqual(config.compaction, compaction);
  assert.deepEqual(config.identity, { attribution: null });
});

test('github reads and merges reach the control plane over the connection, pass its refusals on, and allow read results above the callback limit', { timeout: 10000 }, async t => {
  let answer = (_request: Request): Response => Response.json({});
  const fixture = await connectorFixture(t, { github: request => answer(request) });
  await startFixture(fixture);
  const config = fixture.runtimes[0]!.config;
  const read = { sessionId: 'session', actorId: 'owner', admissionId: 'admission', callId: 'call-1', repository: 'acme/alpha', issue: 7 };
  // A long pull request thread stays readable: the view is bounded by the control plane at 96 KiB, above other callbacks' 64 KiB.
  const view = { repository: 'acme/alpha', number: 7, url: 'https://github.com/acme/alpha/pull/7', title: 'Fix', state: 'open', author: 'a',
    createdAt: '2026-10-01T00:00:00Z', body: 'x'.repeat(90 * 1024), labels: [], comments: [] };
  answer = request => {
    assert.equal(request.url, `${origin}/api/connectors/self/github/read`);
    assert.equal(request.headers.get('x-connection-token'), connectionToken);
    return Response.json(view);
  };
  assert.deepEqual(await config.githubRead!(read), view);
  assert.deepEqual(JSON.parse(fixture.allCalls.at(-1)!.body), read);
  answer = () => Response.json({ error: 'acme/beta is not a github.com repository pinned in this session.', code: 'repository_not_pinned' }, { status: 403 });
  await assert.rejects(config.githubRead!({ ...read, repository: 'acme/beta' }), (error: Error & { status?: number }) =>
    error.status === 403 && error.message === 'acme/beta is not a github.com repository pinned in this session.');

  const merge = { sessionId: 'session', actorId: 'owner', approvalId: 'tool-merge', capability: 'capability', repository: 'acme/alpha', pull: 7, sha: 'a'.repeat(40), method: 'squash' } as const;
  answer = request => {
    assert.equal(request.url, `${origin}/api/connectors/self/github/merge`);
    return Response.json({ sha: 'b'.repeat(40), url: 'https://github.com/acme/alpha/pull/7' });
  };
  assert.deepEqual(await config.githubMerge!(merge), { sha: 'b'.repeat(40), url: 'https://github.com/acme/alpha/pull/7' });
  assert.deepEqual(JSON.parse(fixture.allCalls.at(-1)!.body), merge);
  // GitHub's reason not to merge reaches the session as a definite 422.
  answer = () => Response.json({ error: 'GitHub did not merge acme/alpha#7: Head branch was modified.', code: 'github_merge_refused' }, { status: 422 });
  await assert.rejects(config.githubMerge!(merge), (error: Error & { status?: number }) =>
    error.status === 422 && error.message === 'GitHub did not merge acme/alpha#7: Head branch was modified.');
  // A merge result that doesn't name a commit on github.com is refused.
  answer = () => Response.json({ sha: 'b'.repeat(40), url: 'https://evil.example/acme/alpha/pull/7' });
  await assert.rejects(config.githubMerge!(merge));
});

test('malformed welcome never creates a runtime or advertises readiness', { timeout: 10000 }, async t => {
  const fixture = await connectorFixture(t);
  const starting = fixture.connector.start();
  const rejected = assert.rejects(starting, /stopped before becoming ready/);
  const socket = await fixture.sockets.next();
  socket.open();
  socket.receive({ type: 'welcome', connectorId: 'foreign-connector', connectionToken });
  await socket.closed.promise;
  await fixture.connector.stop();
  await rejected;
  assert.equal(fixture.runtimes.length, 0);
  assert.equal(fixture.allCalls.length, 0);
  assert.equal(fixture.statuses.includes('connected'), false);
});

test('a forced pairing claims the new code first, then replaces the saved token the connector uses', { timeout: 10000 }, async t => {
  const dataDir = await directory(t);
  await writeConnectorState(dataDir, credentials);
  let claim = (): Response => new Response(null, { status: 403 });
  let claims = 0;
  const sockets = mailbox<FakeSocket>();
  const pairedConnector = (replacePairing: boolean) => {
    const connector = createConnector({
      dataDir, server: origin, pairing: { id: 'pairing', code: 'fixture_pairing_code' }, replacePairing,
      localModels: localModels(), capabilities: publicCapabilities,
      acquireLease: () => Promise.resolve(() => Promise.resolve()),
      createSocket: (url, protocols) => { const socket = new FakeSocket(url, protocols); sockets.push(socket); return socket; },
      runtimeFactory: () => Promise.resolve({ fetch: () => Response.json({ ok: true }), close: () => Promise.resolve() }),
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (request.url === `${origin}/api/connectors/pairings/pairing/claim`) { claims++; return Promise.resolve(claim()); }
        if (request.url === `${origin}/api/connectors/self/manifest`) return Promise.resolve(Response.json({ ok: true }));
        assert.fail(`Unexpected fixture Worker request: ${request.url}`);
      },
    });
    t.after(() => connector.stop());
    return connector;
  };

  // Without --force a paired machine refuses before the code reaches the server.
  await assert.rejects(pairedConnector(false).start(), /already paired/);
  assert.equal(claims, 0);

  // A rejected code leaves the saved pairing in place.
  await assert.rejects(pairedConnector(true).start(), /Pairing rejected/);
  assert.equal(claims, 1);
  assert.deepEqual(await readConnectorState(dataDir, origin), credentials);

  // The saved pairing may even belong to another server: replacing never reads it.
  await writeConnectorState(dataDir, { ...credentials, controlPlaneUrl: 'https://old.fixture.invalid' }, false, true);
  claim = () => Response.json({ credentials: replacement }, { status: 201 });
  const starting = pairedConnector(true).start();
  const socket = await sockets.next();
  assert.deepEqual(socket.protocols, ['opencara-pi-v1', `bearer.${replacement.token}`]);
  socket.open();
  socket.receive({ type: 'welcome', connectorId: replacement.connectorId, connectionToken });
  await starting;
  assert.equal(claims, 2);
  assert.deepEqual(await readConnectorState(dataDir, origin), replacement);
});

test('small concurrent requests fill the pending limit and complete FIFO on the same socket', { timeout: 15000 }, async t => {
  const runtime = deferredRuntime();
  const fixture = await connectorFixture(t, runtime);
  const socket = await startFixture(fixture);
  const requests = await Promise.all(Array.from({ length: connectorLimits.pendingRequests }, (_, index) =>
    rpc('submit', JSON.stringify({ index }), `fifo-${index}`)));

  for (const request of requests) socket.receive(request);
  for (const [index, request] of requests.entries()) {
    const execution = await runtime.started.next();
    assert.equal(await execution.request.text(), request.body);
    assert.equal(fixture.runtimes[0]!.requests.length, index + 1);
    assert.equal(socket.sent.length, index);
    execution.response.resolve(new Response(`result-${index}`, { status: 201 }));
    assert.deepEqual(JSON.parse(await socket.messages.next()), {
      type: 'response', id: request.id, status: 201, body: `result-${index}`,
    });
  }
  assert.equal(runtime.maximumActive, 1, 'only the FIFO head may execute');
  assert.equal(socket.readyState, 1);
  assert.equal(fixture.allSockets.length, 1);

  // A drained queue releases its count and byte reservations.
  const fresh = await rpc('view', '', 'after-fifo-drain');
  socket.receive(fresh);
  const execution = await runtime.started.next();
  execution.response.resolve(new Response('fresh'));
  assert.equal(JSON.parse(await socket.messages.next()).id, fresh.id);
  await fixture.connector.stop();
});

test('one request beyond the active plus queued count limit disconnects without executing queued work', { timeout: 10000 }, async t => {
  const runtime = deferredRuntime();
  const fixture = await connectorFixture(t, runtime);
  const socket = await startFixture(fixture);
  const requests = await Promise.all(Array.from({ length: connectorLimits.pendingRequests + 1 }, (_, index) =>
    rpc('view', '', `count-${index}`)));
  socket.receive(requests[0]!);
  const execution = await runtime.started.next();
  for (const request of requests.slice(1, connectorLimits.pendingRequests)) socket.receive(request);
  assert.equal(socket.readyState, 1, 'the active request counts as one of exactly pendingRequests slots');
  assert.equal(fixture.runtimes[0]!.requests.length, 1);

  socket.receive(requests[connectorLimits.pendingRequests]!);
  await socket.closed.promise;
  assert.equal(execution.request.signal.aborted, true);
  execution.response.resolve(new Response('late'));
  await fixture.connector.stop();
  assert.equal(fixture.runtimes[0]!.requests.length, 1);
  assert.deepEqual(socket.sent, []);
});

// #100: a large reply still draining to the relay and more requests behind it used to end the connection.
test('requests arriving while socket output is backed up queue behind it instead of ending the connection', { timeout: 10000 }, async t => {
  const runtime = deferredRuntime();
  const fixture = await connectorFixture(t, runtime);
  const socket = await startFixture(fixture);
  const requests = await Promise.all(['backed-first', 'backed-second', 'backed-third'].map(id => rpc('view', '', id)));
  socket.bufferedAmount = connectorLimits.bufferedBytes - 16;
  socket.receive(requests[0]!);
  const first = await runtime.started.next();
  socket.receive(requests[1]!);
  socket.receive(requests[2]!);
  assert.equal(socket.readyState, 1, 'queued requests are not the relay overrunning its budget');

  first.response.resolve(new Response('first response'));
  // The reply waits for output to drain to its own size.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(socket.sent, []);
  assert.equal(fixture.runtimes[0]!.requests.length, 1, 'later requests stay behind the waiting reply');
  socket.bufferedAmount = 0;
  assert.equal(JSON.parse(await socket.messages.next()).id, requests[0]!.id);
  for (const request of requests.slice(1)) {
    const next = await runtime.started.next();
    next.response.resolve(new Response(`${request.id} response`));
    assert.deepEqual(JSON.parse(await socket.messages.next()), { type: 'response', id: request.id, status: 200, body: `${request.id} response` });
  }
  assert.equal(socket.readyState, 1);
  assert.equal(fixture.statuses.includes('disconnected'), false);
  assert.equal(fixture.allSockets.length, 1);
});

test('a small reply is sent as soon as it fits, not once a worst-case reply would', { timeout: 10000 }, async t => {
  const runtime = deferredRuntime();
  const fixture = await connectorFixture(t, runtime);
  const socket = await startFixture(fixture);
  // Room for this reply, not for a full responseBytes one: the old reservation waited here for a drain.
  socket.bufferedAmount = connectorLimits.bufferedBytes - connectorLimits.responseBytes + 1;
  const request = await rpc('view', '', 'small-reply');
  socket.receive(request);
  const execution = await runtime.started.next();
  execution.response.resolve(new Response('small'));
  assert.deepEqual(JSON.parse(await socket.messages.next()), { type: 'response', id: request.id, status: 200, body: 'small' });
  assert.equal(socket.readyState, 1);
});

test('a reply that cannot be relayed is answered as an error for that request and the connection stays', { timeout: 30000 }, async t => {
  let calls = 0;
  const fixture = await connectorFixture(t, {
    execute: () => {
      switch (calls++) {
        case 0: return new Response('x'.repeat(connectorLimits.responseBytes + 1));
        // Within responseBytes, but over frameBytes once escaped into the reply frame.
        case 1: return new Response('"'.repeat(16 * 1024 * 1024));
        case 2: return new Response(new Uint8Array([0xff, 0xfe]));
        case 3: return Promise.reject(new Error('runtime detail that must not reach the relay'));
        default: return new Response('fine');
      }
    },
  });
  const socket = await startFixture(fixture);
  const requests = await Promise.all(['too-large', 'escaped', 'not-utf8', 'runtime-error', 'after'].map(id => rpc('view', '', id)));
  for (const request of requests) socket.receive(request);
  for (const request of requests.slice(0, 4)) {
    const reply = JSON.parse(await socket.messages.next());
    assert.equal(reply.id, request.id);
    assert.equal(reply.status, 502);
    assert.equal(JSON.parse(reply.body).code, 'connector_reply_error');
    assert.doesNotMatch(reply.body, /runtime detail/);
  }
  assert.deepEqual(JSON.parse(await socket.messages.next()), { type: 'response', id: requests[4]!.id, status: 200, body: 'fine' });
  assert.equal(socket.readyState, 1);
  assert.equal(fixture.statuses.includes('disconnected'), false);
});

test('a disconnect reports why the connection ended', { timeout: 10000 }, async t => {
  const fixture = await connectorFixture(t);
  const socket = await startFixture(fixture);
  socket.dispatchEvent(new MessageEvent('message', { data: 'not json' }));
  await socket.closed.promise;
  (await fixture.sockets.next()).open();
  assert.deepEqual(fixture.reasons, ['Invalid relay frame']);
});

test('stop drains the active request but never executes or publishes queued work', { timeout: 10000 }, async t => {
  const runtime = deferredRuntime();
  const fixture = await connectorFixture(t, runtime);
  const socket = await startFixture(fixture);
  const requests = await Promise.all(['stop-active', 'stop-queued', 'stop-late'].map(id => rpc('view', '', id)));
  socket.receive(requests[0]!);
  const execution = await runtime.started.next();
  socket.receive(requests[1]!);
  assert.equal(socket.readyState, 1);
  const stopping = fixture.connector.stop();
  void stopping.catch(() => {});
  await socket.closed.promise;
  assert.equal(execution.request.signal.aborted, true);
  assert.equal(fixture.runtimes[0]!.closed, false, 'active work must drain before the runtime closes');
  execution.response.resolve(new Response('late'));
  await stopping;
  socket.receive(requests[2]!);
  assert.equal(fixture.runtimes[0]!.requests.length, 1);
  assert.equal(fixture.runtimes[0]!.closed, true);
  assert.equal(fixture.allSockets.length, 1);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(fixture.leases, { acquired: 1, released: 1 });
});

test('a ticket that expires in the queue is rejected before runtime dispatch', { timeout: 10000 }, async t => {
  const runtime = deferredRuntime();
  const fixture = await connectorFixture(t, runtime);
  const socket = await startFixture(fixture);
  let now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  try {
    const active = await rpc('view', '', 'expiry-active');
    const queued = await rpc('view', '', 'expiry-queued');
    queued.ticket.exp = queued.ticket.iat + 1;
    socket.receive(active);
    const execution = await runtime.started.next();
    assert.ok(queued.ticket.exp * 1000 > now, 'the queued ticket is valid when admitted');
    // Observe the post-validation waiter so expiry cannot race initial async ticket validation.
    const { generation } = fixture.connector as unknown as { generation: { waiting: Set<unknown> } };
    const validated = Promise.withResolvers<void>();
    const add = generation.waiting.add.bind(generation.waiting);
    const observing = t.mock.method(generation.waiting, 'add', (value: unknown) => {
      const result = add(value);
      validated.resolve();
      return result;
    });
    socket.receive(queued);
    await validated.promise;
    observing.mock.restore();
    assert.equal(socket.readyState, 1);
    assert.equal(generation.waiting.size, 1);
    now = queued.ticket.exp * 1000;
    execution.response.resolve(new Response('active completed'));
    assert.equal(JSON.parse(await socket.messages.next()).id, active.id);
    await socket.closed.promise;
    await fixture.connector.stop();
    assert.equal(fixture.runtimes[0]!.requests.length, 1);
    assert.equal(socket.sent.length, 1);
  } finally {
    clock.mock.restore();
  }
});

for (const duplicate of ['request ID', 'ticket ID'] as const) {
  test(`a duplicate queued ${duplicate} disconnects before either queued request executes`, { timeout: 10000 }, async t => {
    const runtime = deferredRuntime();
    const fixture = await connectorFixture(t, runtime);
    const socket = await startFixture(fixture);
    const active = await rpc('view', '', 'duplicate-active');
    const queued = await rpc('view', '', 'duplicate-queued');
    const repeated = await rpc('view', '', 'duplicate-new');
    if (duplicate === 'request ID') repeated.id = queued.id;
    else repeated.ticket.jti = queued.ticket.jti;
    socket.receive(active);
    const execution = await runtime.started.next();
    socket.receive(queued);
    assert.equal(socket.readyState, 1);
    socket.receive(repeated);
    await socket.closed.promise;
    assert.equal(execution.request.signal.aborted, true);
    execution.response.resolve(new Response('late'));
    await fixture.connector.stop();
    assert.equal(fixture.runtimes[0]!.requests.length, 1);
    assert.deepEqual(socket.sent, []);
  });
}

test('reconnect drains an ambiguous in-flight effect without retry and rejects old callbacks and replay', { timeout: 15000 }, async t => {
  const effectStarted = Promise.withResolvers<Request>();
  const effectFinished = Promise.withResolvers<Response>();
  const authorizeFinished = Promise.withResolvers<void>();
  const fixture = await connectorFixture(t, {
    execute: request => { effectStarted.resolve(request); return effectFinished.promise; },
    authorize: async () => { await authorizeFinished.promise; return Response.json({ allowed: true, policyVersion: 1, ownerId: 'owner' }); },
    unblock: () => {
      effectFinished.resolve(Response.json({ effect: 'already-applied' }));
      authorizeFinished.resolve();
    },
  });
  const starting = fixture.connector.start();
  void starting.catch(() => {});
  const first = await fixture.sockets.next();
  first.open();
  first.welcome();
  await starting;
  await fixture.connected.next();
  await fixture.workerCalls.next();
  const oldRuntime = fixture.runtimes[0]!;
  assert.ok(oldRuntime.config.authorize);
  const oldAuthorization = assert.rejects(oldRuntime.config.authorize(authorizationRequest), /generation is no longer authorized|aborted/i);
  const callback = await fixture.workerCalls.next();
  assert.equal(callback.request.url, `${origin}/api/connectors/self/authorize`);
  assert.deepEqual(JSON.parse(callback.body), authorizationRequest);

  const request = await rpc('submit', '{"requestId":"fixture-effect","text":"fixture only"}', 'ambiguous-effect');
  first.receive(request);
  const localRequest = await effectStarted.promise;
  assert.equal(localRequest.url, 'http://local.invalid/v1/sessions/session/submit');
  assert.equal(await localRequest.clone().text(), request.body);
  const localAuthorization = localRequest.headers.get('authorization');
  assert.ok(localAuthorization?.startsWith('Bearer '));
  assert.ok(localAuthorization);
  const localTicket = localAuthorization.slice('Bearer '.length);
  assert.deepEqual(await verifyRunnerTicket(localTicket, oldRuntime.config.sharedSecret, 'submit', 'session', request.body), request.ticket);
  assert.equal(localRequest.headers.get('x-connection-token'), null);

  const queued = await rpc('submit', '{"requestId":"queued-effect","text":"never execute"}', 'queued-effect');
  first.receive(queued);
  assert.equal(first.readyState, 1, 'a second small request must queue rather than overload');

  first.close();
  assert.equal(localRequest.signal.aborted, true);
  assert.equal(callback.request.signal.aborted, true);
  await nextTurn();
  assert.equal(oldRuntime.closed, false, 'ambiguous local work must drain before runtime retirement');
  assert.equal(fixture.allSockets.length, 1, 'a replacement must not race the old runtime');
  assert.equal(oldRuntime.requests.length, 1);
  authorizeFinished.resolve();
  await oldAuthorization;
  effectFinished.resolve(Response.json({ effect: 'already-applied' }));

  const second = await fixture.sockets.next();
  assert.equal(oldRuntime.closed, true);
  second.open();
  const secondToken = 'fixture_second_connection_token_0123456789abcdef';
  second.welcome(secondToken);
  await fixture.connected.next();
  const secondManifest = await fixture.workerCalls.next();
  assert.equal(secondManifest.request.headers.get('x-connection-token'), secondToken);
  assert.equal(fixture.runtimes.length, 2);
  assert.equal(fixture.runtimes[1]!.requests.length, 0, 'reconnect must not retry an ambiguous effect');
  assert.deepEqual(first.sent, [], 'the lost generation must not publish a late effect response');
  const currentAuthorize = fixture.runtimes[1]!.config.authorize;
  assert.ok(currentAuthorize);
  assert.deepEqual(await currentAuthorize(authorizationRequest), { allowed: true, policyVersion: 1, ownerId: 'owner' });
  const currentCallback = await fixture.workerCalls.next();
  assert.equal(currentCallback.request.headers.get('x-connection-token'), secondToken);

  const count = fixture.allCalls.length;
  const oldConfig = oldRuntime.config;
  assert.ok(oldConfig.resolveModels);
  assert.ok(oldConfig.githubComment);
  assert.ok(oldConfig.readBackup);
  await assert.rejects(async () => oldConfig.authorize!(authorizationRequest), /generation is no longer authorized/);
  await assert.rejects(async () => oldConfig.resolveModels!(model), /generation is no longer authorized/);
  await assert.rejects(oldConfig.githubComment({
    sessionId: 'session', actorId: 'owner', approvalId: 'approval', capability: 'fixture-capability',
    repository: 'fixture/repository', issue: 1, body: 'fixture only',
  }), /generation is no longer authorized/);
  await assert.rejects(oldConfig.readBackup({
    id: 'restore', sourceSessionId: 'source', backupId: 'backup', size: 1,
    sha256: await sha256('x'), downloadToken: 'fixture_download_token_0123456789abcdef',
  }, 'session'), /generation is no longer authorized/);
  assert.equal(fixture.allCalls.length, count, 'retired callbacks must fail before Worker fetch');

  first.receive(await rpc('submit', '{}', 'late-old-message'));
  await nextTurn();
  assert.equal(oldRuntime.requests.length, 1);
  assert.equal(fixture.runtimes[1]!.requests.length, 0);

  // A new request ID cannot reuse an already-dispatched ticket after reconnect.
  second.receive({ ...request, id: 'new-envelope-same-ticket' });
  await second.closed.promise;
  assert.equal(fixture.runtimes[1]!.requests.length, 0);

  const third = await fixture.sockets.next();
  assert.equal(fixture.runtimes[1]!.closed, true);
  third.open();
  third.welcome('fixture_third_connection_token_0123456789abcdef');
  await fixture.connected.next();
  await fixture.workerCalls.next();
  // A fresh ticket cannot reuse the original request ID either.
  const freshTicket = await rpc('submit', request.body, 'fresh-ticket');
  third.receive({ ...freshTicket, id: request.id });
  await third.closed.promise;
  assert.equal(fixture.runtimes[2]!.requests.length, 0);

  // Admission burns queued IDs too, even though disconnect prevented their runtime execution.
  const freshQueuedTicket = await rpc('submit', queued.body, 'fresh-queued-ticket');
  for (const replay of [{ ...queued, id: 'new-envelope-queued-ticket' }, { ...freshQueuedTicket, id: queued.id }]) {
    const socket = await fixture.sockets.next();
    socket.open();
    socket.welcome();
    await fixture.connected.next();
    await fixture.workerCalls.next();
    socket.receive(replay);
    await socket.closed.promise;
    assert.equal(fixture.runtimes.at(-1)!.requests.length, 0, 'queued replay must fail before runtime execution');
  }
  assertWorkerBoundary(fixture.allCalls, fixture.allSockets, [oldConfig.sharedSecret, localTicket]);
  await fixture.connector.stop();
  assert.equal(fixture.runtimes.reduce((count, runtime) => count + runtime.requests.length, 0), 1);
  assert.deepEqual(fixture.leases, { acquired: 1, released: 1 });
});
