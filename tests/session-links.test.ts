import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { ConnectorRelayEnvelope } from '../apps/server/src/connector-transport.js';
import { sharedView } from '../apps/server/src/session-links.js';
import type { Env } from '../apps/server/src/types.js';
import { encryptToken } from '../apps/server/src/vault.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';
import type { ConnectorCredentials, ConnectorPairing } from '../packages/shared/src/connector.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { REDACTED } from '../packages/shared/src/redaction.js';
import type { SessionLink, SharedSession, SharedSessionView } from '../packages/shared/src/sharing.js';
import type { ApprovalRecord, EntryView, ModelDefinition, SessionRecord, SessionView } from '../packages/shared/src/types.js';

// Share links and secret redaction, end to end through the control plane. The fixture is the one connectors.test.ts
// uses for a session on its owner's own host.
const origin = 'http://localhost:8787';
const testSecret = 'session-links-test-secret-not-for-deployment';
const internalSecret = 'session-links-internal-secret-not-for-deployment';
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
  const { db, sqlite, setBeforeQuery } = await testDatabase();
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
  return { sqlite, env, request, client, setBeforeQuery };
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

/** A session on its owner's own host, started from its model: the agent has every tool the host carries, bash included. */
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

test('share links show anyone who has one the shared conversation, and nothing else, until the owner turns them off', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const shared = (token: string | null, route = '/api/shared') =>
    f.request('GET', route, undefined, token === null ? {} : { 'X-Share-Token': token });
  const sideAsk = 'A side ask that only people who can view the session may see';
  const view: SessionView = {
    ...s.view,
    owner: { ...s.view.owner, gitEmail: 'owner-private@example.test' },
    entries: [
      { id: '0:1', kind: 'message', role: 'user', text: 'Shared prompt', actorId: s.member.user.id, conversationId: '0' },
      { id: '0:2', kind: 'message', role: 'assistant', text: 'Shared answer', actorId: s.member.user.id, conversationId: '0', durationMs: 1200 },
      { id: '0:3', kind: 'workspace.run-failure', role: 'assistant', text: '', conversationId: '0', error: { provider: 'local-native', status: 429 } },
      { id: '1:1', kind: 'message', role: 'user', text: sideAsk, actorId: s.member.user.id, conversationId: '1' },
    ],
    conversations: [{ id: '0', mode: 'write' }, { id: '1', mode: 'ask', actorId: s.member.user.id }],
    approvals: [{ id: 'approval', sessionId: s.session.id, requestedBy: s.member.user.id, operation: { kind: 'bash', command: 'cat approval-only-command' },
      status: 'pending', createdAt: new Date().toISOString() }],
    queue: [{ submissionId: 'queue-only-receipt', actorId: s.member.user.id, mode: 'write', status: 'queued' }],
    busy: true,
  };
  const requests = rpcHub(f, s.connector, envelope => {
    // The control plane reads as the owner once it has checked the link: a link holder is never an actor on the host.
    assert.equal(envelope.request.ticket.action, 'view');
    assert.equal(envelope.request.ticket.actorId, s.owner.user.id);
    return Response.json({ view });
  });

  // Only the owner can see, create or turn off a link: manage is not ownership, and outsiders don't learn the session exists.
  await denied(await s.member.request('PUT', `${path}/link`), 403, 'forbidden');
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['manage'] }));
  for (const method of ['GET', 'PUT', 'DELETE']) {
    await denied(await s.member.request(method, `${path}/link`), 403, 'owner_required');
    await denied(await s.outsider.request(method, `${path}/link`), 404, 'not_found');
  }
  assert.deepEqual(await json(await s.owner.request('GET', `${path}/link`)), { link: null });
  assert.equal((await s.owner.request('PUT', `${path}/link`, undefined, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await s.owner.request('PUT', `${path}/link`, undefined, { Origin: 'https://hostile.example' })).status, 403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_links').get()!.n, 0);
  const { link } = await json<{ link: SessionLink }>(await s.owner.request('PUT', `${path}/link`), 201);
  const prefix = `${origin}/#/shared/`;
  assert.ok(link.url.startsWith(prefix), link.url);
  const token = link.url.slice(prefix.length);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  // Turning it on again, or reading it, gives the same link while it exists.
  assert.deepEqual(await json(await s.owner.request('PUT', `${path}/link`)), { link });
  assert.deepEqual(await json(await s.owner.request('GET', `${path}/link`)), { link });
  const stored = f.sqlite.prepare('SELECT * FROM session_links WHERE session_id = ?').get(s.session.id)!;
  assert.equal(stored.token_hash, await sha256(token));
  assert.ok(!String(stored.token_ciphertext).includes(token), 'The token is stored only hashed and vault-encrypted');
  for (const client of [s.owner, s.member]) {
    assert.equal((await json<{ session: SessionRecord }>(await client.request('GET', path))).session.linkShared, true, 'Everyone who can view learns that a link exists');
  }

  // Anyone with the link, signed in or not, reads the title and the shared conversation: no side asks, approvals, queue or attribution.
  const metadata = await json<{ session: SharedSession }>(await shared(token));
  assert.deepEqual(metadata, { session: { title: s.session.title, status: 'ready', createdAt: s.session.createdAt, ownerName: 'private-owner' } });
  assert.deepEqual(await json(await f.request('GET', '/api/shared', undefined, { 'X-Share-Token': token, Cookie: s.outsider.cookie })), metadata);
  const seen = await json<{ view: SharedSessionView }>(await shared(token, '/api/shared/view'));
  assert.deepEqual(seen, { view: { busy: true, entries: [
    { id: '0:1', kind: 'message', role: 'user', text: 'Shared prompt' },
    { id: '0:2', kind: 'message', role: 'assistant', text: 'Shared answer', durationMs: 1200 },
    { id: '0:3', kind: 'workspace.run-failure', role: 'assistant', text: '', error: { provider: 'local-native', status: 429 } },
  ] } });
  assert.equal(requests.length, 1);
  const serialized = JSON.stringify([metadata, seen]);
  for (const hidden of [sideAsk, 'approval-only-command', 'queue-only-receipt', 'owner-private@example.test', s.member.user.id, s.owner.user.id,
    s.session.id, s.team.id, s.connector.connectorId, s.session.agentVersionId, s.model.id]) {
    assert.ok(!serialized.includes(hidden), `A share link must not reveal ${hidden}`);
  }

  // A link is no credential anywhere else, can't change anything, and unknown or malformed links reach no host.
  for (const route of [path, `${path}/view`, `${path}/audit`, `${path}/link`, '/api/sessions', '/api/me']) {
    assert.equal((await f.request('GET', route, undefined, { 'X-Share-Token': token })).status, 401, route);
  }
  await denied(await s.outsider.request('GET', path, undefined, { 'X-Share-Token': token }), 404, 'not_found');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const route of ['/api/shared', '/api/shared/view']) {
      assert.equal((await f.request(method, route, {}, { 'X-Share-Token': token })).status, 401, `${method} ${route}`);
    }
  }
  for (const wrong of [null, '', 'short', `${token.slice(0, 42)}!`, changedToken(token), await sha256(token)]) {
    for (const route of ['/api/shared', '/api/shared/view']) await denied(await shared(wrong, route), 404, 'not_found');
  }
  assert.equal(requests.length, 1);

  // A link shows only what its owner can see: it stops while they're out of the workspace and works again on their return.
  const membership = f.sqlite.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(s.team.id, s.owner.user.id)!;
  f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(s.team.id, s.owner.user.id);
  for (const route of ['/api/shared', '/api/shared/view']) await denied(await shared(token, route), 404, 'not_found');
  f.sqlite.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(membership.workspace_id, membership.user_id, membership.role, membership.created_at);
  assert.deepEqual(await json(await shared(token)), metadata);
  assert.equal(requests.length, 1);

  // A view fetched while the link was being turned off is never answered.
  rpcHub(f, s.connector, () => {
    f.sqlite.prepare('DELETE FROM session_links WHERE session_id = ?').run(s.session.id);
    return Response.json({ view });
  });
  await denied(await shared(token, '/api/shared/view'), 404, 'not_found');
  assert.deepEqual(await json(await s.owner.request('GET', `${path}/link`)), { link: null });
  assert.equal((await json<{ session: SessionRecord }>(await s.member.request('GET', path))).session.linkShared, undefined);

  // Turning link sharing on again issues a new link; the old one stays dead.
  rpcHub(f, s.connector, () => Response.json({ view }));
  const { link: renewed } = await json<{ link: SessionLink }>(await s.owner.request('PUT', `${path}/link`), 201);
  assert.notEqual(renewed.url, link.url);
  await denied(await shared(token), 404, 'not_found');
  const renewedToken = renewed.url.slice(prefix.length);
  await json(await shared(renewedToken, '/api/shared/view'));

  // An archived session stays readable by link and can't get a new one, but its link can always be turned off.
  await json(await s.owner.request('POST', `${path}/archive`));
  assert.equal((await json<{ session: SharedSession }>(await shared(renewedToken))).session.status, 'archived');
  await json(await shared(renewedToken, '/api/shared/view'));
  await denied(await s.owner.request('PUT', `${path}/link`), 409, 'session_archived');
  await denied(await s.member.request('DELETE', `${path}/link`), 403, 'owner_required');
  assert.deepEqual(await json(await s.owner.request('DELETE', `${path}/link`)), { ok: true });
  assert.deepEqual(await json(await s.owner.request('DELETE', `${path}/link`)), { ok: true });
  for (const route of ['/api/shared', '/api/shared/view']) await denied(await shared(renewedToken, route), 404, 'not_found');
  const actions = (f.sqlite.prepare("SELECT action FROM audit WHERE session_id = ? AND action LIKE 'session.link.%' ORDER BY created_at, rowid")
    .all(s.session.id) as { action: string }[]).map(row => row.action);
  assert.deepEqual(actions, ['session.link.created', 'session.link.created', 'session.link.revoked']);
});

test('a share link shows only entries of a conversation the view lists as shared, and nothing when it lists none', () => {
  const entry = (id: string, conversationId?: string): EntryView =>
    ({ id, kind: 'message', role: 'user', text: id, ...(conversationId === undefined ? {} : { conversationId }) });
  const base = { sessionId: 'session', owner: { id: 'owner', displayName: 'Owner', gitName: 'Owner', gitEmail: 'owner@example.test', githubLogin: null },
    approvals: [], busy: false };
  const entries = [entry('shared', '0'), entry('side-ask', '1'), entry('unlisted', '2'), entry('unlabelled', '3'), entry('no-conversation')];
  const conversations = [{ id: '0', mode: 'write' }, { id: '1', mode: 'ask' }, { id: '3' }];
  assert.deepEqual(sharedView({ ...base, entries, conversations } as unknown as SessionView).entries.map(item => item.id), ['shared']);
  // A view that drops or garbles its conversations shows nothing rather than everything.
  for (const broken of [undefined, null, 'write', [null, 5, { mode: 'write' }]]) {
    assert.deepEqual(sharedView({ ...base, entries, conversations: broken } as unknown as SessionView).entries, [], JSON.stringify(broken));
  }
});

test('turning link sharing on answers a concurrent request with the same link and refuses an owner who just lost access', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}/link`;
  // Another request turns link sharing on between this one's check and its insert.
  const winner = token();
  const ciphertext = await encryptToken(f.env, `session-link:${s.session.id}`, winner);
  const winnerHash = await sha256(winner);
  let raced = false;
  f.setBeforeQuery(sql => {
    if (raced || !sql.startsWith('INSERT INTO session_links')) return;
    raced = true;
    f.sqlite.prepare('INSERT INTO session_links (session_id, token_hash, token_ciphertext, created_at) VALUES (?, ?, ?, ?)')
      .run(s.session.id, winnerHash, ciphertext, new Date().toISOString());
  });
  const { link } = await json<{ link: SessionLink }>(await s.owner.request('PUT', path));
  f.setBeforeQuery();
  assert.equal(raced, true);
  assert.equal(link.url, `${origin}/#/shared/${winner}`, 'The request that lost the race answers with the winning link');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_links').get()!.n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.link.created'").get()!.n, 0);

  // The owner leaves the workspace between the check and the insert: no link is created.
  f.sqlite.prepare('DELETE FROM session_links').run();
  let removed = false;
  f.setBeforeQuery(sql => {
    if (removed || !sql.startsWith('INSERT INTO session_links')) return;
    removed = true;
    f.sqlite.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(s.team.id, s.owner.user.id);
  });
  await denied(await s.owner.request('PUT', path), 409, 'policy_changed');
  f.setBeforeQuery();
  assert.equal(removed, true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_links').get()!.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.link.created'").get()!.n, 0);
});

test('no viewer ever receives a secret, while approvals still review, decide and run the exact operation', async t => {
  // The owner requests and approves; the member reads through workspace visibility.
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const secret = `ghp_${'a1B2'.repeat(9)}`;
  const operation = { kind: 'bash' as const, command: `curl -H "Authorization: Bearer ${secret}" https://api.github.com/user` };
  const shownCommand = 'curl -H "Authorization: Bearer [redacted]" https://api.github.com/user';
  const pending: ApprovalRecord = { id: 'secret-approval', sessionId: s.session.id, requestedBy: s.owner.user.id, operation,
    status: 'pending', createdAt: new Date().toISOString() };
  const view: SessionView = {
    sessionId: s.session.id,
    owner: s.view.owner,
    entries: [{ id: '0:1', kind: 'message', role: 'user', text: `Use ${secret} with DB_PASSWORD=hunter2hunter2`, actorId: s.owner.user.id, conversationId: '0' }],
    approvals: [pending], conversations: [{ id: '0', mode: 'write' }], busy: false,
  };
  const leaks = (body: string) => body.includes(secret) || body.includes('hunter2hunter2');
  let approveBody: { operation?: unknown } = {};
  rpcHub(f, s.connector, envelope => {
    const action = envelope.request.ticket.action;
    if (action === 'operations') return Response.json({ approval: pending }, { status: 201 });
    if (action === 'view') return Response.json({ view });
    assert.equal(action, 'approve');
    approveBody = JSON.parse(envelope.request.body);
    return Response.json({ approval: { ...pending, status: 'executed', decidedBy: s.owner.user.id, result: `{"login":"creator","token":"${secret}"}` } });
  });

  // Requesting the operation answers with it redacted, and a review hash that commits to the real operation.
  const reviewHash = await sha256(JSON.stringify({ sessionId: s.session.id, approvalId: pending.id, requestedBy: s.owner.user.id, operation }));
  const created = await s.owner.request('POST', `${path}/operations`, operation);
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  assert.ok(!leaks(createdBody));
  const { approval: requested } = JSON.parse(createdBody) as { approval: ApprovalRecord };
  assert.deepEqual(requested.operation, { kind: 'bash', command: shownCommand });
  assert.equal(requested.reviewHash, reviewHash);
  assert.deepEqual(JSON.parse(String(f.sqlite.prepare('SELECT operation_json FROM approval_reviews WHERE approval_id = ?').get(pending.id)!.operation_json)), operation,
    'The review keeps the real operation');

  // Every viewer, the owner included, gets the same redacted view.
  for (const client of [s.owner, s.member]) {
    const response = await client.request('GET', `${path}/view`);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(!leaks(body), 'No viewer receives a secret');
    const { view: seen } = JSON.parse(body) as { view: SessionView };
    assert.equal(seen.entries[0]!.text, 'Use ghp_[redacted] with DB_PASSWORD=[redacted]');
    assert.deepEqual(seen.approvals[0]!.operation, { kind: 'bash', command: shownCommand });
    assert.equal(seen.approvals[0]!.reviewHash, reviewHash);
  }
  // So are live updates.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = await s.member.request('GET', `${path}/events`);
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const snapshot = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  t.mock.timers.reset();
  assert.match(snapshot, /event: view/);
  assert.ok(snapshot.includes(REDACTED) && !leaks(snapshot));

  // Approving with the hash of what was shown runs the real command on the host; its output comes back redacted.
  const approved = await s.owner.request('POST', `${path}/approvals/${pending.id}`, { decision: 'approve', reviewHash });
  const approvedBody = await approved.text();
  assert.equal(approved.status, 200, approvedBody);
  assert.deepEqual(approveBody.operation, operation, 'The host receives the real operation');
  assert.ok(!leaks(approvedBody));
  const { approval: decided } = JSON.parse(approvedBody) as { approval: ApprovalRecord };
  assert.equal(decided.result, '{"login":"creator","token":"[redacted]"}');
  assert.deepEqual(decided.operation, { kind: 'bash', command: shownCommand });

  // A share link shows the same redacted transcript.
  const { link } = await json<{ link: SessionLink }>(await s.owner.request('PUT', `${path}/link`), 201);
  const shared = await f.request('GET', '/api/shared/view', undefined, { 'X-Share-Token': link.url.split('/').at(-1)! });
  const sharedBody = await shared.text();
  assert.equal(shared.status, 200, sharedBody);
  assert.ok(!leaks(sharedBody));
  assert.equal((JSON.parse(sharedBody) as { view: SharedSessionView }).view.entries[0]!.text, 'Use ghp_[redacted] with DB_PASSWORD=[redacted]');
});

// The same fixture serves transcript display (packages/shared/src/transcript-display.ts): what views carry once a session
// shows brief tool output, or its workspace loads transcripts latest first. Hosts keep sending whole views.
test('brief tool output and paged transcripts change what views carry, not what hosts send', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const path = `/api/sessions/${s.session.id}`;
  const call = `write(${JSON.stringify({ path: 'a.txt', content: 'x'.repeat(5000) })})`;
  const entries: EntryView[] = Array.from({ length: 60 }, (_, index) => {
    const n = index + 1;
    return index % 2 ? { id: `0:${n}`, kind: 'message', role: 'toolResult', text: `first of ${n}\nsecond\nthird`, conversationId: '0' }
      : { id: `0:${n}`, kind: 'message', role: 'assistant', text: n === 59 ? `Writing it.\n${call}` : `answer ${n}`, conversationId: '0' };
  });
  const asks: EntryView[] = [1, 2, 3].map(n => ({ id: `1:${n}`, kind: 'message', role: 'user', text: `ask ${n}`, conversationId: '1', actorId: s.owner.user.id }));
  const hostView: SessionView = { ...s.view, entries: [...entries, ...asks],
    conversations: [{ id: '0', mode: 'write' }, { id: '1', mode: 'ask', actorId: s.owner.user.id }] };
  rpcHub(f, s.connector, envelope => {
    assert.equal(envelope.request.ticket.action, 'view');
    return Response.json({ view: hostView });
  });
  const read = async () => (await json<{ view: SessionView }>(await s.owner.request('GET', `${path}/view`))).view;
  const shown = (view: SessionView, id: string) => view.entries.find(item => item.id === id)!;

  // Full tool output by default.
  const whole = await read();
  assert.equal(whole.entries.length, 63);
  assert.equal(shown(whole, '0:2').text, 'first of 2\nsecond\nthird');
  assert.equal(shown(whole, '0:2').trimmed, undefined);

  // Only the owner changes it, to full or brief, and it leaves the session's policy alone.
  await json(await s.owner.request('POST', `${path}/grants`, { userId: s.member.user.id, permissions: ['manage'] }));
  await denied(await s.member.request('PATCH', path, { toolOutput: 'brief' }), 403, 'owner_required');
  await denied(await s.owner.request('PATCH', path, { toolOutput: 'short' }), 400, 'invalid_tool_output');
  await denied(await s.owner.request('PATCH', path, { toolOutput: 'brief', title: 'Both' }), 400, 'invalid_input');
  const before = (await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session;
  const { session: brief } = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', path, { toolOutput: 'brief' }));
  assert.equal(brief.toolOutput, 'brief');
  assert.equal(brief.policyVersion, before.policyVersion);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE session_id = ? AND action = 'session.tool_output.updated'").get(s.session.id)!.n, 1);
  const briefView = await read();
  assert.deepEqual(shown(briefView, '0:2'), { ...entries[1], text: 'first of 2', trimmed: { lines: 3, chars: entries[1]!.text.length } });
  const cut = shown(briefView, '0:59').text;
  assert.ok(cut.startsWith('Writing it.\nwrite({"path":"a.txt","content":"xxx') && cut.endsWith('…})') && cut.length < 260, cut);
  assert.equal(shown(briefView, '0:1').text, 'answer 1', 'Prose is never shortened');

  // Paging is the workspace's: members see it, owners and admins change it.
  const settingsPath = `/api/workspaces/${s.team.id}/transcripts`;
  assert.deepEqual(await json(await s.member.request('GET', settingsPath)), { settings: { paging: false, toolOutput: 'full' } });
  await denied(await s.member.request('PUT', settingsPath, { paging: true }), 403, 'forbidden');
  await denied(await s.outsider.request('GET', settingsPath), 404, 'not_found');
  await denied(await s.owner.request('PUT', settingsPath, { paging: 'yes' }), 400, 'invalid_input');
  await denied(await s.owner.request('PUT', settingsPath, { toolOutput: 'short' }), 400, 'invalid_input');
  await denied(await s.owner.request('PUT', settingsPath, {}), 400, 'invalid_input');
  assert.deepEqual(await json(await s.owner.request('PUT', settingsPath, { paging: true })), { settings: { paging: true, toolOutput: 'full' } });

  // A paged view holds each conversation's latest 50 entries, and says what comes before.
  const paged = await read();
  assert.deepEqual(paged.entries.filter(item => item.conversationId === '0').map(item => item.id), entries.slice(10).map(item => item.id));
  assert.deepEqual(paged.conversations, [{ id: '0', mode: 'write', olderEntries: 10, previousEntryId: '0:10' }, { id: '1', mode: 'ask', actorId: s.owner.user.id }]);
  assert.equal(paged.entries.filter(item => item.conversationId === '1').length, 3);

  // Earlier entries come a page at a time, presented as views are.
  const page = await json<{ entries: EntryView[]; older: number }>(await s.owner.request('GET', `${path}/entries?conversation=0&before=${encodeURIComponent('0:11')}&limit=5`));
  assert.deepEqual(page.entries.map(item => item.id), ['0:6', '0:7', '0:8', '0:9', '0:10']);
  assert.equal(page.older, 5);
  assert.equal(page.entries.find(item => item.id === '0:8')!.text, 'first of 8');
  await denied(await s.owner.request('GET', `${path}/entries?conversation=0&before=0%3A999`), 409, 'entries_changed');
  for (const query of ['conversation=0&before=0%3A11&limit=0', 'conversation=0&before=0%3A11&limit=201', 'before=0%3A11', 'conversation=0']) {
    await denied(await s.owner.request('GET', `${path}/entries?${query}`), 400, 'invalid_input');
  }
  await denied(await s.outsider.request('GET', `${path}/entries?conversation=0&before=0%3A11`), 404, 'not_found');

  // Back to full tool output, and to whole transcripts.
  await json(await s.owner.request('PATCH', path, { toolOutput: 'full' }));
  await json(await s.owner.request('PUT', settingsPath, { paging: false }));
  const restored = await read();
  assert.equal(restored.entries.length, 63);
  assert.equal(shown(restored, '0:2').text, 'first of 2\nsecond\nthird');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', path))).session.toolOutput, undefined);
});

// A workspace's owners and admins choose the tool output its new sessions start with; existing sessions keep theirs.
test('new sessions start with the tool output their workspace sets', async t => {
  const f = await fixture(t); const s = await privateHostSession(f);
  const settingsPath = `/api/workspaces/${s.team.id}/transcripts`;
  assert.equal(s.session.toolOutput, undefined, 'Full tool output until the workspace says otherwise');
  await denied(await s.member.request('PUT', settingsPath, { toolOutput: 'brief' }), 403, 'forbidden');
  await json(await s.owner.request('PUT', settingsPath, { paging: true }));
  // Either setting alone leaves the other as it was.
  assert.deepEqual(await json(await s.owner.request('PUT', settingsPath, { toolOutput: 'brief' })), { settings: { paging: true, toolOutput: 'brief' } });
  assert.deepEqual(await json(await s.member.request('GET', settingsPath)), { settings: { paging: true, toolOutput: 'brief' } });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE workspace_id = ? AND action = 'workspace.transcripts.updated'").get(s.team.id)!.n, 2);

  const { session: next } = await json<{ session: SessionRecord }>(await s.owner.request('POST', '/api/sessions', s.input), 201);
  assert.equal(next.toolOutput, 'brief');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', `/api/sessions/${next.id}`))).session.toolOutput, 'brief');
  assert.equal((await json<{ session: SessionRecord }>(await s.owner.request('GET', `/api/sessions/${s.session.id}`))).session.toolOutput, undefined);
  // Its owner still changes their own session's.
  const { session: shown } = await json<{ session: SessionRecord }>(await s.owner.request('PATCH', `/api/sessions/${next.id}`, { toolOutput: 'full' }));
  assert.equal(shown.toolOutput, undefined);

  assert.deepEqual(await json(await s.owner.request('PUT', settingsPath, { toolOutput: 'full', paging: false })), { settings: { paging: false, toolOutput: 'full' } });
  const { session: last } = await json<{ session: SessionRecord }>(await s.owner.request('POST', '/api/sessions', s.input), 201);
  assert.equal(last.toolOutput, undefined);
});
