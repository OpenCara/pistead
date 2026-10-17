import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { encryptToken } from '../apps/server/src/vault.js';
import { reviewCommitment } from '../apps/server/src/approval-reviews.js';
import { parseOperation } from '../apps/server/src/operations.js';
import { validateOperation } from '../apps/runner/src/protocol.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import type { GitRepinOperation, RepinResult } from '../packages/shared/src/types.js';
import { testDatabase } from './helpers/control-plane.js';

const owner = 'github:7';
const secret = 'repin-internal-test-secret-not-for-deployment';
const oldCommit = 'a'.repeat(40), newCommit = 'b'.repeat(40);
const operation: GitRepinOperation = { kind: 'git.repin', repository: 'owner/one', ref: 'feature/next' };
const pins = [1, 2].map(n => ({ bindingId: `binding-${n}`, repositoryId: n, fullName: `owner/${n === 1 ? 'one' : 'two'}`,
  path: `owner/${n === 1 ? 'one' : 'two'}`, ref: 'main', commit: oldCommit }));

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: 'http://localhost:8787', RUNNER_SHARED_SECRET: secret,
    TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: 'repin-test-auth-secret-not-for-deployment', TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    VAULT_KEY: Buffer.alloc(32, 9).toString('base64url') };
  const created = new Date().toISOString();
  for (const [id, githubId] of [[owner, '7'], ['github:8', '8']]) sqlite.prepare(
    'INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, githubId, `user${githubId}`, 'User', 'User', 'user@example.test', 'github', created);
  sqlite.prepare('INSERT INTO workspaces (id,name,owner_id,created_at) VALUES (?,?,?,?)').run('workspace', 'Workspace', owner, created);
  for (const id of [owner, 'github:8']) sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .run('workspace', id, id === owner ? 'owner' : 'member', created);
  sqlite.prepare('INSERT INTO models (id,workspace_id,name,provider,model_id,created_at) VALUES (?,?,?,?,?,?)').run('model', 'workspace', 'Model', 'faux', 'faux-1', created);
  sqlite.prepare('INSERT INTO agents (id,author_id,created_at) VALUES (?,?,?)').run('agent', owner, created);
  sqlite.prepare('INSERT INTO agent_versions (id,agent_id,author_id,version,name,description,instructions,tools_json,model_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('version', 'agent', owner, 1, 'Agent', '', '', '["git_repin","host_bash"]', 'model', created);
  sqlite.prepare('INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,repositories_json) VALUES (?,?,?,?,?,?,?,?)')
    .run('source', 'workspace', owner, 'version', 'Original', 'ready', created, JSON.stringify(pins));
  sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)')
    .run('source', 'github:8', '["read","write","approve"]', created);
  for (const pin of pins) sqlite.prepare('INSERT INTO workspace_repositories (id,workspace_id,provider,host,repository_id,full_name,ref,private,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(pin.bindingId, 'workspace', 'github', 'github.com', String(pin.repositoryId), pin.fullName, 'main', 1, created);
  sqlite.prepare('INSERT INTO github_tokens (user_id,ciphertext,updated_at) VALUES (?,?,?)').run(owner, await encryptToken(env, owner, 'owner-token'), created);
  const admissionId = await sha256('auto-repin-message');
  sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,request_id,content_hash,expires_at,created_at,access) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(admissionId, 'source', owner, 'write', 'message', await sha256('message'), Math.floor(Date.now() / 1000) + 3600, created, 'auto');
  const requests: string[] = [];
  let duringResolve = () => {};
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer owner-token');
    requests.push(url.pathname);
    const pin = pins.find(item => url.pathname.startsWith(`/repos/${item.fullName}`));
    assert.ok(pin, url.href);
    if (url.pathname.includes('/commits/')) {
      assert.equal(pin.path, operation.repository, 'unchanged repositories must not resolve their branch again');
      assert.equal(decodeURIComponent(url.pathname.split('/commits/')[1]!), operation.ref);
      duringResolve();
      return Response.json({ sha: newCommit });
    }
    return Response.json({ id: pin.repositoryId, full_name: pin.fullName, default_branch: 'main', private: true });
  });
  const post = (overrides: Record<string, unknown> = {}) => app.request('http://localhost:8787/api/internal/git/repin', {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'source', approvalId: 'tool-repin', actorId: owner, operation, admissionId, ...overrides }),
  }, env);
  return { env, sqlite, admissionId, created, post, requests, duringResolve: (fn: () => void) => { duringResolve = fn; } };
}

test('operation validators agree on exact host-command and repin payloads', () => {
  for (const op of [operation, { kind: 'host.bash' as const, command: 'dotnet --info', timeoutSeconds: 300 }]) {
    assert.deepEqual(parseOperation(op), validateOperation(op));
    assert.throws(() => parseOperation({ ...op, extra: true }));
    assert.throws(() => validateOperation({ ...op, extra: true }));
  }
});

test('repin creates one private successor, keeps other pins and source unchanged, and retries return its receipt', async t => {
  const f = await fixture(t);
  const before = f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get('source');
  const response = await f.post();
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json() as RepinResult;
  assert.notEqual(result.sessionId, 'source');
  assert.equal(result.path, `/#/s/${result.sessionId}`);
  assert.deepEqual(result.repositories, [{ ...pins[0]!, ref: operation.ref, commit: newCommit }, pins[1]]);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get('source'), before);
  const target = f.sqlite.prepare('SELECT visibility,status,owner_id,agent_version_id FROM sessions WHERE id = ?').get(result.sessionId);
  assert.deepEqual({ ...target }, { visibility: 'private', status: 'provisioning', owner_id: owner, agent_version_id: 'version' });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_grants WHERE session_id = ?').get(result.sessionId)!.n, 0);
  const count = f.requests.length;
  assert.deepEqual(await (await f.post()).json(), result);
  assert.equal(f.requests.length, count, 'retry must not resolve a moving branch again');
  assert.equal((await f.post({ operation: { ...operation, ref: 'other' } })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.repinned'").get()!.n, 1);
});

test('repin requires owner authority and a current auto admission; one message has a bounded number of successors', async t => {
  const f = await fixture(t);
  for (const overrides of [{ actorId: 'github:8' }, { admissionId: 'x'.repeat(43) }, { admissionId: undefined }, { operation: { ...operation, repository: 'owner/missing' } }]) {
    const response = await f.post(overrides);
    assert.ok(response.status >= 400 && response.status < 500, await response.text());
  }
  assert.equal(f.requests.length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await f.post({ approvalId: `tool-${i}` })).status, 200);
  assert.equal((await f.post({ approvalId: 'tool-sixth' })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 6);
});

test('repin callbacks require the runner secret or a current connector connection', async t => {
  const f = await fixture(t);
  const call = (path: string, authorization?: string) => app.request(`http://localhost:8787${path}`, {
    method: 'POST', headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'source', approvalId: 'tool-repin', actorId: owner, operation, admissionId: f.admissionId }),
  }, f.env);
  for (const authorization of [undefined, 'Bearer wrong-runner-secret-not-for-deployment-at-all']) {
    assert.equal((await call('/api/internal/git/repin', authorization)).status, 401);
  }
  // The runner secret is not a connector credential.
  for (const authorization of [undefined, `Bearer ${secret}`]) {
    assert.equal((await call('/api/connectors/self/git/repin', authorization)).status, 401);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
});

test('a human-approved repin consumes its exact owner-bound capability once, and a retry returns its successor', async t => {
  const f = await fixture(t);
  const capability = 'repin-test-human-capability';
  const approvalId = 'human-repin';
  f.sqlite.prepare('INSERT INTO approval_reviews (session_id,approval_id,requested_by,source,admission_id,operation_json,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('source', approvalId, owner, 'explicit', null, JSON.stringify(operation), await reviewCommitment('source', approvalId, owner, operation), f.created);
  f.sqlite.prepare('INSERT INTO broker_capabilities (token_hash,session_id,approval_id,actor_id,requested_by,operation_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(await sha256(capability), 'source', approvalId, owner, owner, await sha256(JSON.stringify(operation)), Math.floor(Date.now() / 1000) + 90, f.created);
  const input = { approvalId, admissionId: undefined, capability };
  assert.equal((await f.post({ ...input, operation: { ...operation, ref: 'other' } })).status, 403);
  const first = await f.post(input);
  assert.equal(first.status, 200, await first.clone().text());
  const created = await first.json() as RepinResult;
  const count = f.requests.length;
  // A retry, as after a lost response, gets the same successor without resolving or consuming anything again.
  assert.deepEqual(await (await f.post(input)).json(), created);
  assert.equal(f.requests.length, count);
  // The consumed capability still proves only its own call and operation.
  assert.equal((await f.post({ ...input, operation: { ...operation, ref: 'other' } })).status, 403);
  assert.equal((await f.post({ ...input, approvalId: 'human-repin-other' })).status, 403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
});

test('removing a binding or revoking credentials during resolution never creates a successor', async t => {
  for (const kind of ['binding', 'credential', 'policy'] as const) await t.test(kind, async t => {
    const f = await fixture(t);
    f.duringResolve(() => {
      if (kind === 'binding') f.sqlite.prepare('DELETE FROM workspace_repositories WHERE id = ?').run(pins[0]!.bindingId);
      else if (kind === 'credential') f.sqlite.prepare('DELETE FROM github_tokens WHERE user_id = ?').run(owner);
      else f.sqlite.prepare('UPDATE sessions SET policy_version = policy_version + 1 WHERE id = ?').run('source');
    });
    const response = await f.post();
    assert.ok(response.status >= 400 && response.status < 500, await response.text());
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
  });
});
