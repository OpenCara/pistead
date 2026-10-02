import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { app } from '../apps/worker/src/index.js';
import type { Env } from '../apps/worker/src/types.js';
import { decryptToken, encryptToken } from '../apps/worker/src/vault.js';
import { userIdentifier } from '../apps/worker/src/http.js';
import { sessionAccess } from '../apps/worker/src/db.js';
import { sha256 } from '../packages/shared/src/crypto.js';

const origin = 'http://localhost:8787';
const testSecret = 'control-plane-test-secret-not-for-deployment';
const internalSecret = 'control-plane-internal-secret-not-for-deployment';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../apps/worker/migrations/0001_control_plane.sql', import.meta.url), 'utf8'));
  let queryCount = 0;
  class Prepared {
    values: (string | number | null | Uint8Array)[] = [];
    constructor(readonly sql: string) {}
    bind(...values: (string | number | null | Uint8Array)[]) { this.values = values; return this; }
    execute() {
      queryCount++;
      const results = sqlite.prepare(this.sql).all(...this.values);
      const changes = /^\s*(SELECT|PRAGMA)\b/i.test(this.sql) ? 0 : Number(sqlite.prepare('SELECT changes() AS count').get()!.count);
      return { success: true, results, meta: { changes, duration: 0, last_row_id: 0, changed_db: changes > 0, size_after: 0, rows_read: results.length, rows_written: changes } };
    }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
    async first(column?: string) {
      const row = this.execute().results[0];
      return row ? column ? row[column] : row : null;
    }
  }
  const database = {
    prepare(sql: string) { return new Prepared(sql); },
    async batch(statements: Prepared[]) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env: Env = { DB: database as unknown as D1Database, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    RUNNER_SHARED_SECRET: internalSecret, VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` }) }, env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const user = (await login.json() as { user: { id: string } }).user;
    const csrfResponse = await app.request('/api/auth/csrf', { headers: { Cookie: cookie } }, env);
    const csrf = (await csrfResponse.json() as { csrfToken: string }).csrfToken;
    return { user, cookie, csrf, async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      return app.request(path, { method, headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    } };
  }
  return { sqlite, env, client, queryCount: () => queryCount };
}

test('test auth is disabled by default, secret gated, isolated, and expires existing cookies', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  f.env.TEST_AUTH_ENABLED = 'false';
  let response = await app.request('/api/auth/test', { method: 'POST', headers: { Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' }, body: '{}' }, f.env);
  assert.equal(response.status, 404);
  f.env.TEST_AUTH_ENABLED = 'true';
  response = await app.request('/api/auth/test', { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' }, f.env);
  assert.equal(response.status, 401);
  const alice = await f.client('alice');
  assert.equal(alice.user.id, 'test:alice');
  response = await alice.request('PATCH', '/api/me', { githubId: '1', ownerId: 'victim' });
  assert.equal(response.status, 400);
  response = await alice.request('PATCH', '/api/me', { env: { APP_API_KEY: 'forbidden' } });
  assert.equal(response.status, 400);
  // Keep a secure configured origin after disabling test-mode HTTP allowances.
  f.env.APP_ORIGIN = 'https://app.example.test';
  f.env.TEST_AUTH_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  response = await app.request('/api/me', { headers: { Cookie: alice.cookie.replace('test-auth=', '__Host-auth=') } }, f.env);
  assert.equal(response.status, 401);
});

test('cookie mutations require CSRF and reject hostile origins; logout revokes the DB session', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const alice = await f.client('alice');
  assert.equal((await alice.request('POST', '/api/workspaces', { name: 'blocked' }, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await alice.request('POST', '/api/workspaces', { name: 'blocked' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await alice.request('POST', '/api/workspaces', { name: 'blocked' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await alice.request('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await alice.request('GET', '/api/me')).status, 401);
});

test('published definitions are immutable and do not grant authors access to another owner session', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const alice = await f.client('alice'); const bob = await f.client('bob'); const eve = await f.client('eve');
  const workspace = (await (await alice.request('POST', '/api/workspaces', { name: 'team' })).json() as { workspace: { id: string } }).workspace;
  assert.equal((await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'member' })).status, 200);
  const model = (await (await alice.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'fixture', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const privateVersion = (await (await alice.request('POST', '/api/agents', { name: 'agent', description: '', instructions: '', tools: ['identity'], modelId: model.id })).json() as { agent: { id: string; agentId: string } }).agent;
  assert.equal((await bob.request('POST', '/api/sessions', { workspaceId: workspace.id, agentVersionId: privateVersion.id })).status, 404);
  const published = (await (await alice.request('POST', `/api/agents/${privateVersion.agentId}/publish`, { workspaceId: workspace.id })).json() as { agent: { id: string } }).agent;
  assert.throws(() => f.sqlite.prepare('UPDATE agent_versions SET name = ? WHERE id = ?').run('changed', published.id), /immutable/);
  f.sqlite.prepare('INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('bob-session', workspace.id, bob.user.id, published.id, 'private session', 1, 'ready', new Date().toISOString());
  assert.equal((await alice.request('GET', '/api/sessions/bob-session')).status, 404);
  assert.equal((await eve.request('GET', '/api/sessions/bob-session')).status, 404);
  const ownerSession = await bob.request('GET', '/api/sessions/bob-session');
  assert.equal(ownerSession.status, 200);
  assert.deepEqual((await ownerSession.json() as { session: { permissions: string[] } }).session.permissions, ['read', 'ask', 'write', 'approve', 'manage']);
  assert.equal((await bob.request('POST', '/api/sessions/bob-session/grants', { userId: alice.user.id, permissions: ['manage'] })).status, 200);
  assert.equal((await alice.request('POST', '/api/sessions/bob-session/grants', { userId: alice.user.id, permissions: ['write', 'manage'] })).status, 403);
  assert.equal((await alice.request('POST', '/api/sessions/bob-session/grants', { userId: eve.user.id, permissions: ['read'] })).status, 404);
  assert.equal((await bob.request('POST', '/api/sessions/bob-session/grants', { userId: bob.user.id, permissions: ['read'] })).status, 400);
  assert.equal((await bob.request('DELETE', `/api/sessions/bob-session/grants/${encodeURIComponent(alice.user.id)}`)).status, 200);
  assert.equal((await alice.request('GET', '/api/sessions/bob-session')).status, 404);
  assert.equal((await bob.request('POST', '/api/sessions/bob-session/backup', {})).status, 503);
  assert.equal((await bob.request('GET', '/api/sessions/bob-session/view')).status, 503);
});

test('AES-GCM vault binds ciphertext to the account and rejects tampering', async () => {
  const env = { VAULT_KEY: Buffer.alloc(32, 4).toString('base64url') } as Env;
  const ciphertext = await encryptToken(env, 'github:7', 'never-expose-this-access-token');
  assert.ok(!ciphertext.includes('never-expose'));
  assert.equal(await decryptToken(env, 'github:7', ciphertext), 'never-expose-this-access-token');
  await assert.rejects(decryptToken(env, 'github:8', ciphertext));
  const parts = ciphertext.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(decryptToken(env, 'github:7', parts.join('.')));
  await assert.rejects(encryptToken({ VAULT_KEY: 'invalid' } as Env, 'github:7', 'token'));
});

test('internal broker rejects wrong operations and consumes exact approval capability before GitHub', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const ownerId = 'github:7'; const createdAt = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(ownerId, '7', 'owner', 'Owner', 'Owner', 'owner@example.test', 'github', createdAt);
  f.sqlite.prepare('INSERT INTO workspaces (id,name,owner_id,created_at) VALUES (?,?,?,?)').run('workspace', 'Workspace', ownerId, createdAt);
  f.sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run('workspace', ownerId, 'owner', createdAt);
  f.sqlite.prepare('INSERT INTO models (id,workspace_id,name,provider,model_id,created_at) VALUES (?,?,?,?,?,?)').run('model', 'workspace', 'model', 'faux', 'faux-1', createdAt);
  f.sqlite.prepare('INSERT INTO agents (id,author_id,created_at) VALUES (?,?,?)').run('agent', ownerId, createdAt);
  f.sqlite.prepare('INSERT INTO agent_versions (id,agent_id,author_id,version,name,description,instructions,tools_json,model_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('version', 'agent', ownerId, 1, 'agent', '', '', '["github_comment"]', 'model', createdAt);
  f.sqlite.prepare('INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('session', 'workspace', ownerId, 'version', 'session', 'ready', createdAt);
  assert.ok(await sessionAccess(f.env, 'session', ownerId));
  f.env.TEST_AUTH_ENABLED = 'false';
  assert.equal(await sessionAccess(f.env, 'session', ownerId), null, 'Real users cannot retain faux sessions when test mode is disabled');
  const disabled = await app.request('/api/internal/authorize', {
    method: 'POST', headers: { Authorization: `Bearer ${internalSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session', actorId: ownerId, ownerId, permission: 'write' }),
  }, f.env);
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { allowed: boolean }).allowed, false);
  f.env.TEST_AUTH_ENABLED = 'true';
  const expiry = f.env.TEST_AUTH_EXPIRES_AT;
  f.env.TEST_AUTH_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  assert.equal(await sessionAccess(f.env, 'session', ownerId), null, 'Faux sessions stop at the test-mode expiry');
  f.env.TEST_AUTH_EXPIRES_AT = expiry;
  f.sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)').run(ownerId, await encryptToken(f.env, ownerId, 'vault-only-token'), createdAt);
  const operation = { kind: 'github.comment', repository: 'owner/repo', issue: 3, body: 'Approved text' };
  const capability = 'one-time-capability';
  f.sqlite.prepare('INSERT INTO broker_capabilities (token_hash,session_id,approval_id,actor_id,requested_by,operation_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(await sha256(capability), 'session', 'approval', ownerId, ownerId, await sha256(JSON.stringify(operation)), Math.floor(Date.now() / 1000) + 60, createdAt);
  const request = (body: unknown, authorization = `Bearer ${internalSecret}`) => app.request('/api/internal/github/comment', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, f.env);
  const payload = { sessionId: 'session', actorId: ownerId, approvalId: 'approval', capability, repository: operation.repository, issue: operation.issue, body: operation.body };
  assert.equal((await request(payload, 'Bearer wrong')).status, 401);
  assert.equal((await request({ ...payload, body: 'Different text' })).status, 403);
  assert.equal((await request({ ...payload, repository: 'https://attacker.invalid' })).status, 400);
  const previousFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    writes++;
    assert.equal(String(input), 'https://api.github.com/repos/owner/repo/issues/3/comments');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer vault-only-token');
    return Response.json({ id: 99, html_url: 'https://github.com/owner/repo/issues/3#issuecomment-99', sensitive: 'must-not-return' });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const first = await request(payload);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { id: 99, url: 'https://github.com/owner/repo/issues/3#issuecomment-99' });
  assert.equal((await request(payload)).status, 409);
  assert.equal(writes, 1);
});

test('namespace-aware user IDs accept real GitHub members and reject malformed identities', async t => {
  assert.equal(userIdentifier('github:12345'), 'github:12345');
  assert.equal(userIdentifier(`test:${'a'.repeat(128)}`), `test:${'a'.repeat(128)}`);
  for (const value of ['github:0', 'github:01', 'github:-1', 'github:abc', 'test:', 'other:123', `test:${'a'.repeat(129)}`]) {
    assert.throws(() => userIdentifier(value));
  }
  const f = fixture(); t.after(() => f.sqlite.close());
  const alice = await f.client('alice');
  const workspace = (await (await alice.request('POST', '/api/workspaces', { name: 'real memberships' })).json() as { workspace: { id: string } }).workspace;
  f.sqlite.prepare('INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('github:12345', '12345', 'real-user', 'Real user', 'Real user', 'real@example.test', 'github', new Date().toISOString());
  const added = await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: 'github:12345', role: 'member' });
  assert.equal(added.status, 200);
  assert.ok((await added.json() as { members: { userId: string }[] }).members.some(member => member.userId === 'github:12345'));
  assert.equal((await alice.request('DELETE', `/api/workspaces/${workspace.id}/members/github%3A12345`)).status, 204);
});

async function pollingFixture() {
  const f = fixture();
  const owner = await f.client('poll-owner');
  const reader = await f.client('poll-reader');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'polling' })).json() as { workspace: { id: string } }).workspace;
  await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: reader.user.id, role: 'member' });
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'polling', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const agent = (await (await owner.request('POST', '/api/agents', { name: 'polling', description: '', instructions: '', tools: ['identity'], modelId: model.id })).json() as { agent: { id: string } }).agent;
  f.sqlite.prepare('INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('poll-session', workspace.id, owner.user.id, agent.id, 'polling', 'ready', new Date().toISOString());
  await owner.request('POST', '/api/sessions/poll-session/grants', { userId: reader.user.id, permissions: ['read'] });
  f.env.RUNNER_URL = 'https://runner.example.test';
  f.env.RUNNER_EVENT_TRANSPORT = 'poll';
  const view = { sessionId: 'poll-session', owner: { id: owner.user.id, displayName: 'Owner', gitName: 'Owner', gitEmail: 'owner@example.test', githubLogin: null },
    entries: [], approvals: [], conversations: [], busy: false };
  return { ...f, owner, reader, view };
}

test('poll SSE emits at most four authoritative views within the subrequest budget', async t => {
  const f = await pollingFixture(); t.after(() => f.sqlite.close());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  globalThis.fetch = async (input, init) => {
    polls++;
    assert.equal(String(input), 'https://runner.example.test/v1/sessions/poll-session/view');
    assert.equal(init?.method, 'GET');
    return Response.json({ view: f.view });
  };
  const before = f.queryCount();
  const response = await f.reader.request('GET', '/api/sessions/poll-session/events');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  let body = '';
  for (let snapshot = 0; snapshot < 4; snapshot++) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += new TextDecoder().decode(chunk.value);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (snapshot < 3) t.mock.timers.tick(1000);
  }
  assert.equal((await reader.read()).done, true);
  assert.equal(polls, 4);
  assert.equal((body.match(/event: view/g) ?? []).length, 4);
  assert.ok(f.queryCount() - before + polls <= 23, 'Four snapshots must fit the Free-plan subrequest budget');
});

test('poll SSE rechecks live grants after fetching and before emitting each snapshot', async t => {
  const f = await pollingFixture(); t.after(() => f.sqlite.close());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  globalThis.fetch = async () => {
    polls++;
    if (polls === 2) {
      f.sqlite.prepare('DELETE FROM session_grants WHERE session_id = ? AND user_id = ?').run('poll-session', f.reader.user.id);
      f.sqlite.prepare('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ?').run('poll-session');
    }
    return Response.json({ view: { ...f.view, entries: [{ id: String(polls), kind: 'message', role: 'assistant', text: polls === 1 ? 'authorized' : 'must-not-leak' }] } });
  };
  const response = await f.reader.request('GET', '/api/sessions/poll-session/events');
  const reader = response.body!.getReader();
  let body = new TextDecoder().decode((await reader.read()).value);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += new TextDecoder().decode(chunk.value);
  }
  assert.equal(polls, 2);
  assert.equal((body.match(/event: view/g) ?? []).length, 1);
  assert.ok(body.includes('authorized'));
  assert.ok(!body.includes('must-not-leak'));
  assert.ok(!body.includes('error'));
});

test('poll SSE stops polling after the consumer disconnects', async t => {
  const f = await pollingFixture(); t.after(() => f.sqlite.close());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  globalThis.fetch = async () => { polls++; return Response.json({ view: f.view }); };
  const response = await f.reader.request('GET', '/api/sessions/poll-session/events');
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  t.mock.timers.tick(8000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(polls, 1);
});

test('poll SSE deadline remains effective while a consumer applies backpressure', async t => {
  const f = await pollingFixture(); t.after(() => f.sqlite.close());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  let fetchedSecond!: () => void;
  const second = new Promise<void>(resolve => { fetchedSecond = resolve; });
  let fetchedThird!: () => void;
  const third = new Promise<void>(resolve => { fetchedThird = resolve; });
  globalThis.fetch = async () => {
    polls++;
    if (polls === 2) fetchedSecond();
    if (polls === 3) fetchedThird();
    return Response.json({ view: f.view });
  };
  const response = await f.reader.request('GET', '/api/sessions/poll-session/events');
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await second;
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await third;
  await new Promise<void>(resolve => setImmediate(resolve));
  // Leave the second snapshot queued and the third write blocked behind it.
  t.mock.timers.tick(6000);
  while (!(await reader.read()).done) { /* Drain already-authorized buffered bytes after abort. */ }
  assert.equal(polls, 3);
});

test('poll SSE deadline also closes a stalled upstream without exposing errors', async t => {
  const f = await pollingFixture(); t.after(() => f.sqlite.close());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let began!: () => void;
  const requested = new Promise<void>(resolve => { began = resolve; });
  globalThis.fetch = async () => { began(); return new Promise<Response>(() => {}); };
  const response = await f.reader.request('GET', '/api/sessions/poll-session/events');
  await requested;
  t.mock.timers.tick(8000);
  assert.equal(await response.text(), '');
});
