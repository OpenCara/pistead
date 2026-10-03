import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env, WorkerEnv } from '../apps/worker/src/types.js';
import type { RunnerBinding, RunnerTicket } from '../packages/shared/src/types.js';
import type { RestoreInput } from '../packages/shared/src/connector.js';
import type { SessionRepository } from '../packages/shared/src/repositories.js';
import { sha256, verifyToken } from '../packages/shared/src/crypto.js';
import { registerRestoreRoutes, downloadRestoreSnapshot } from '../apps/worker/src/restore-routes.js';
import { registerBackups } from '../apps/worker/src/backups.js';
import { boundedSnapshotText, MAX_BACKUP_BYTES, validateSnapshot } from '../apps/worker/src/restore-snapshot.js';
import { sessionAccess } from '../apps/worker/src/db.js';

const secret = 'restore-internal-test-secret-not-for-deployment';
const bearer = 'b'.repeat(43);
const connection = 'c'.repeat(43);
const downloadToken = 'd'.repeat(43);
const restorePath = '/api/sessions/source/backups/backup/restore';
const repositoryPins: SessionRepository[] = [{ bindingId: 'original-binding', repositoryId: 123,
  fullName: 'Owner/Project', ref: 'main', commit: 'a'.repeat(40), path: 'Owner/Project' }];

interface SnapshotFixture {
  sqlite: DatabaseSync;
  key: string;
  snapshot: { binding: RunnerBinding };
  objects: Map<string, Uint8Array>;
  replaceSnapshot(change: (snapshot: { binding: RunnerBinding }) => void): Promise<void>;
}

async function fixture(t: TestContext, connected = false, repositories: SessionRepository[] = []) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../apps/worker/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec('BEGIN');
    try { sqlite.exec(readFileSync(new URL(file, directory), 'utf8')); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  class Prepared {
    values: (string | number | null)[] = [];
    constructor(readonly sql: string) {}
    bind(...values: (string | number | null)[]) { this.values = values; return this; }
    execute() {
      const results = sqlite.prepare(this.sql).all(...this.values);
      const changes = /^\s*(SELECT|PRAGMA)\b/i.test(this.sql) ? 0 : Number(sqlite.prepare('SELECT changes() AS n').get()!.n);
      return { results, success: true, meta: { changes } };
    }
    async first() { return this.execute().results[0] ?? null; }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
  }
  const database = { prepare(sql: string) { return new Prepared(sql); }, async batch(statements: Prepared[]) {
    sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const env: Env = { DB: database as unknown as D1Database, APP_ORIGIN: 'http://localhost:8787',
    TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: 'restore-auth-test-secret-not-for-deployment',
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_URL: 'http://localhost:9001',
    RUNNER_SHARED_SECRET: secret, BUCKET: { async get(key: string) {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { size: bytes.byteLength, body: new Response(new Uint8Array(bytes)).body };
    } } as unknown as R2Bucket };
  sqlite.exec(`
    INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES
      ('test:owner','Owner','Current Owner','current@example.test','{"APP_PROJECT":"current"}','test','2026-01-01'),
      ('test:manager','Manager','Manager','manager@example.test','{}','test','2026-01-01'),
      ('test:host','Host','Host','host@example.test','{}','test','2026-01-01');
    INSERT INTO workspaces VALUES ('workspace','Workspace','test:owner','2026-01-01');
    INSERT INTO workspace_members VALUES ('workspace','test:owner','owner','2026-01-01'),
      ('workspace','test:manager','member','2026-01-01'),('workspace','test:host','member','2026-01-01');
  `);
  if (connected) {
    sqlite.prepare(`INSERT INTO connectors (id,owner_id,name,credential_hash,connection_hash,models_json,created_at)
      VALUES ('connector','test:host','Local Pi',?,?,'[{"provider":"faux","modelId":"faux-v1","name":"Model"}]','2026-01-01')`).run(await sha256(bearer), await sha256(connection));
    sqlite.exec("INSERT INTO connector_shares VALUES ('connector','workspace','2026-01-01')");
    sqlite.exec("INSERT INTO connector_workspaces VALUES ('connector','workspace','2026-01-01')");
  }
  sqlite.prepare(`INSERT INTO models (id,workspace_id,name,provider,model_id,connector_id,connector_owner_id,created_at)
    VALUES ('model','workspace','Model','faux','faux-v1',?,?,'2026-01-01')`).run(connected ? 'connector' : null, connected ? 'test:host' : null);
  sqlite.exec(`INSERT INTO agents VALUES ('agent','test:host','2026-01-01');
    INSERT INTO agent_versions VALUES ('version','agent','test:host','workspace',1,'Agent','Description','Instructions','["read_file"]','model','2026-01-01')`);
  sqlite.prepare(`INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json)
    VALUES ('source','workspace','test:owner','version','Original',7,'ready','2026-01-01',?,?,?)`)
    .run(connected ? 'connector' : null, connected ? 'test:host' : null, JSON.stringify(repositories));
  sqlite.exec(`INSERT INTO session_grants VALUES ('source','test:manager','["read","manage"]','2026-01-01')`);
  const route = connected ? { connectorId: 'connector', connectorOwnerId: 'test:host' } : {};
  const binding: RunnerBinding = {
    session: { id: 'source', workspaceId: 'workspace', ownerId: 'test:owner', agentVersionId: 'version', title: 'Original',
      policyVersion: 7, status: 'ready', createdAt: '2026-01-01', ...route,
      ...(repositories.length ? { repositories: structuredClone(repositories) } : {}) },
    owner: { id: 'test:owner', githubId: null, githubLogin: null, displayName: 'Old Owner', gitName: 'Old Name',
      gitEmail: 'old@example.test', env: { APP_PROJECT: 'old' }, githubConnected: false },
    agent: { id: 'version', agentId: 'agent', authorId: 'test:host', workspaceId: 'workspace', version: 1,
      name: 'Agent', description: 'Description', instructions: 'Instructions', tools: ['read_file'], modelId: 'model', createdAt: '2026-01-01' },
    model: { id: 'model', workspaceId: 'workspace', name: 'Model', provider: 'faux', modelId: 'faux-v1', ...route },
  };
  const snapshot = { format: 'pi-runner-backup-v1', binding, manifest: { version: 1 }, sqlite: 'c25hcHNob3Q=', files: [], createdAt: '2026-01-01' };
  const key = 'sessions/test:owner/source/backup.json';
  let raw = JSON.stringify(snapshot);
  objects.set(key, new TextEncoder().encode(raw));
  sqlite.prepare('INSERT INTO backups VALUES (?,?,?,?,?,?,?)').run('backup', 'source', 'test:owner', key, await sha256(raw), Buffer.byteLength(raw), '2026-01-01');
  const app = new Hono<WorkerEnv>();
  // Cookie/CSRF are covered by control-plane tests; this seam supplies an authenticated actor.
  app.use('/api/sessions/*', async (c, next) => {
    c.set('auth', { userId: c.req.header('x-test-user') ?? 'test:owner', tokenHash: 'test', csrfToken: 'test' });
    await next();
  });
  registerRestoreRoutes(app);
  registerBackups(app);
  app.post('/api/internal/restores/:restoreId/download', c => downloadRestoreSnapshot(c, null));
  app.post('/api/connectors/self/restores/:restoreId/download', c => downloadRestoreSnapshot(c, 'connector'));
  async function request(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);
  }
  async function replaceSnapshot(change: (value: typeof snapshot) => void) {
    change(snapshot); raw = JSON.stringify(snapshot); objects.set(key, new TextEncoder().encode(raw));
    sqlite.prepare('UPDATE backups SET sha256 = ?, size = ?').run(await sha256(raw), Buffer.byteLength(raw));
  }
  async function pending(storedRepositories = repositories) {
    const targetBinding = structuredClone(binding);
    targetBinding.session = { ...binding.session, id: 'target', title: 'Restored', policyVersion: 1, status: 'provisioning' };
    sqlite.prepare(`INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json)
      VALUES ('target','workspace','test:owner','version','Restored',1,'provisioning','2026-01-01',?,?,?)`)
      .run(connected ? 'connector' : null, connected ? 'test:host' : null, JSON.stringify(storedRepositories));
    sqlite.prepare(`INSERT INTO restore_jobs (id,request_id,owner_id,workspace_id,source_session_id,backup_id,target_session_id,
      sha256,size,binding_json,download_token_hash,download_expires_at,created_at)
      VALUES ('restore','request','test:owner','workspace','source','backup','target',?,?,?,?,?,'2026-01-01')`)
      .run(await sha256(raw), Buffer.byteLength(raw), JSON.stringify(targetBinding), await sha256(downloadToken), Date.now() + 120000);
    return { targetSessionId: 'target', sourceSessionId: 'source', backupId: 'backup', downloadToken };
  }
  return { sqlite, env, app, objects, reads, key, binding, snapshot, request, replaceSnapshot, pending };
}

function runnerReceipt(body: RestoreInput): Response {
  return Response.json({ restore: { id: body.restore.id, sha256: body.restore.sha256, targetSessionId: body.binding.session.id }, session: body.binding.session });
}

test('only the original owner may restore, not a manager or template/connector author', async t => {
  const f = await fixture(t);
  for (const actor of ['test:manager', 'test:host']) {
    const response = await f.request(restorePath, { requestId: 'request' }, { 'x-test-user': actor });
    assert.ok([403, 404].includes(response.status));
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
  assert.equal(f.reads.length, 0);
});

test('workspace viewers and explicit managers cannot create, list, download or restore owner backups', async t => {
  const f = await fixture(t);
  f.sqlite.exec("UPDATE sessions SET visibility = 'workspace' WHERE id = 'source'");
  for (const actor of ['test:host', 'test:manager']) {
    const headers = { 'x-test-user': actor };
    assert.equal((await f.request('/api/sessions/source/backup', {}, headers)).status, 403);
    assert.equal((await f.app.request('/api/sessions/source/backups', { headers }, f.env)).status, 403);
    assert.equal((await f.app.request('/api/sessions/source/backups/backup/download', { headers }, f.env)).status, 403);
    assert.equal((await f.request(restorePath, { requestId: 'forbidden' }, headers)).status, 403);
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM restore_jobs').get()!.n, 0);
  assert.equal((await f.app.request('/api/sessions/source/backups', {}, f.env)).status, 200);
});

test('restore pins one new target, uses current owner profile and copies no grants; completed replay is inert', async t => {
  const f = await fixture(t);
  f.sqlite.exec("UPDATE sessions SET visibility = 'workspace' WHERE id = 'source'");
  assert.deepEqual((await sessionAccess(f.env, 'source', 'test:host'))?.permissions, ['read']);
  const sourceBefore = f.sqlite.prepare("SELECT * FROM sessions WHERE id='source'").get();
  let calls = 0;
  let targetId = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body)) as RestoreInput;
    targetId = body.binding.session.id;
    assert.notEqual(targetId, 'source');
    assert.equal(body.binding.owner.gitName, 'Current Owner');
    assert.equal(body.binding.owner.env.APP_PROJECT, 'current');
    assert.equal(body.binding.agent.authorId, 'test:host');
    assert.equal(body.binding.session.ownerId, 'test:owner');
    assert.equal(body.binding.session.policyVersion, 1);
    assert.equal(body.binding.session.permissions, undefined);
    assert.equal(body.binding.session.visibility, undefined);
    const stored = f.sqlite.prepare('SELECT * FROM restore_jobs').get()!;
    assert.equal(stored.download_token_hash, await sha256(body.restore.downloadToken));
    assert.ok(!JSON.stringify(stored).includes(body.restore.downloadToken));
    for (let repeat = 0; repeat < 2; repeat++) {
      const download = await f.request(`/api/internal/restores/${body.restore.id}/download`, {
        targetSessionId: targetId, sourceSessionId: 'source', backupId: 'backup', downloadToken: body.restore.downloadToken,
      }, { Authorization: `Bearer ${secret}` });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('x-backup-sha256'), body.restore.sha256);
      assert.equal(download.headers.get('content-length'), String(body.restore.size));
      assert.equal(await sha256(await download.text()), body.restore.sha256);
    }
    return runnerReceipt(body);
  });
  const first = await f.request(restorePath, { requestId: 'request', title: 'Restored title' });
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { session: { id: string; status: string; visibility: string } };
  assert.equal(firstBody.session.id, targetId);
  assert.equal(firstBody.session.status, 'ready');
  assert.equal(firstBody.session.visibility, 'private');
  assert.equal(f.sqlite.prepare('SELECT visibility FROM sessions WHERE id = ?').get(targetId)!.visibility, 'private');
  assert.equal(await sessionAccess(f.env, targetId, 'test:host'), null);
  assert.equal(await sessionAccess(f.env, targetId, 'test:manager'), null);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM sessions WHERE id='source'").get(), sourceBefore);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_grants WHERE session_id=?').get(targetId)!.n, 0);
  f.objects.clear(); // Completed receipts must not depend on another R2 read or runner RPC.
  const replay = await f.request(restorePath, { requestId: 'request', title: 'Restored title' });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), await f.request(restorePath, { requestId: 'request', title: 'Restored title' }).then(r => r.json()));
  assert.equal(calls, 1);
  assert.equal((await f.request(restorePath, { requestId: 'request', title: 'Different' })).status, 409);
  assert.equal((await f.request('/api/sessions/source/backups/other/restore', { requestId: 'request', title: 'Restored title' })).status, 409);
  const job = f.sqlite.prepare('SELECT * FROM restore_jobs').get()!;
  assert.equal(job.status, 'completed');
  assert.equal(job.download_token_hash, null);
  assert.throws(() => f.sqlite.exec("UPDATE restore_jobs SET target_session_id='source'"), /immutable/);
  assert.throws(() => f.sqlite.exec('DELETE FROM restore_jobs'), /retained/);
});

test('restore copies source repository pins after live workspace bindings are removed or replaced', async t => {
  const f = await fixture(t, false, repositoryPins);
  f.sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at)
    VALUES ('original-binding', 'workspace', 123, 'Owner/Project', 'main', 1, '2026-01-01')`).run();
  f.sqlite.exec(`DELETE FROM workspace_repositories;
    INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at)
    VALUES ('replacement-binding', 'workspace', 456, 'Other/Project', 'new-branch', 0, '2026-01-02')`);
  let targetId = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as RestoreInput;
    targetId = body.binding.session.id;
    assert.deepEqual(body.binding.session.repositories, repositoryPins);
    const download = await f.request(`/api/internal/restores/${body.restore.id}/download`, {
      targetSessionId: targetId, sourceSessionId: 'source', backupId: 'backup', downloadToken: body.restore.downloadToken,
    }, { Authorization: `Bearer ${secret}` });
    assert.equal(download.status, 200);
    const snapshot = await download.json() as { binding: RunnerBinding };
    assert.equal(snapshot.binding.session.id, 'source');
    assert.deepEqual(snapshot.binding.session.repositories, repositoryPins);
    return runnerReceipt(body);
  });
  const response = await f.request(restorePath, { requestId: 'pinned' });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json() as { session: RunnerBinding['session'] }).session.repositories, repositoryPins);
  const target = f.sqlite.prepare('SELECT repositories_json FROM sessions WHERE id = ?').get(targetId)!;
  assert.equal(target.repositories_json, JSON.stringify(repositoryPins));
  assert.throws(() => f.sqlite.prepare('UPDATE sessions SET repositories_json = ? WHERE id = ?')
    .run('[]', targetId), /immutable/);
});

test('snapshot repositories must match every source pin before target creation or owner download', async t => {
  const changes: ((session: RunnerBinding['session']) => void)[] = [
    session => { delete session.repositories; },
    session => { session.repositories = []; },
    ...Object.entries({ bindingId: 'other-binding', repositoryId: 456, fullName: 'Other/Project',
      ref: 'other-branch', commit: 'b'.repeat(40), path: '../escape' })
      .map(([key, value]) => (session: RunnerBinding['session']) => {
        Object.assign(session.repositories![0], { [key]: value });
      }),
    session => { Object.assign(session, { repositories: null }); },
    session => { Object.assign(session, { repositories: {} }); },
    session => { Object.assign(session, { repositories: [null] }); },
  ];
  for (const change of changes) {
    const f = await fixture(t, false, repositoryPins);
    await f.replaceSnapshot(snapshot => change(snapshot.binding.session));
    assert.equal((await f.request(restorePath, { requestId: 'wrong-pins' })).status, 502);
    assert.equal((await f.app.request('/api/sessions/source/backups/backup/download', {}, f.env)).status, 502);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
  }
});

test('snapshot pin comparison allows property order and legacy absent pins, but not repository order changes', async t => {
  const f = await fixture(t);
  const source = structuredClone(f.binding);
  source.session.repositories = [];
  assert.doesNotThrow(() => validateSnapshot(JSON.stringify(f.snapshot), source));
  const pins = [...repositoryPins, { bindingId: 'second-binding', repositoryId: 456, fullName: 'Other/Project',
    ref: 'stable', commit: 'b'.repeat(40), path: 'Other/Project' }];
  source.session.repositories = pins;
  f.snapshot.binding.session.repositories = pins.map(pin => ({ path: pin.path, commit: pin.commit, ref: pin.ref,
    fullName: pin.fullName, repositoryId: pin.repositoryId, bindingId: pin.bindingId }));
  assert.doesNotThrow(() => validateSnapshot(JSON.stringify(f.snapshot), source));
  f.snapshot.binding.session.repositories.reverse();
  let response: Response | undefined;
  assert.throws(() => validateSnapshot(JSON.stringify(f.snapshot), source), (error: unknown) => {
    assert.ok(error instanceof HTTPException);
    response = error.getResponse();
    return true;
  });
  assert.ok(response);
  assert.equal(response.status, 502);
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, 'invalid_backup');
  assert.match(body.error, /immutable session binding/);
});

test('restore download rejects target rows whose pins differ from the immutable receipt', async t => {
  const f = await fixture(t, false, repositoryPins);
  const descriptor = await f.pending([{ ...repositoryPins[0]!, commit: 'b'.repeat(40) }]);
  const response = await f.request('/api/internal/restores/restore/download', descriptor,
    { Authorization: `Bearer ${secret}` });
  assert.equal(response.status, 409);
  assert.equal(f.reads.length, 0);
});

test('ambiguous runner failure and invalid receipt retry the same target and immutable binding', async t => {
  const f = await fixture(t);
  const attempts: RestoreInput[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as RestoreInput;
    attempts.push(body);
    if (attempts.length === 1) throw new Error('Lost response after publication');
    const authorization = new Headers(init.headers).get('authorization')!;
    const ticket = await verifyToken<RunnerTicket>(authorization.slice(7), secret);
    assert.equal(ticket?.policyVersion, 2);
    assert.equal(body.binding.session.policyVersion, 1);
    if (attempts.length === 2) return Response.json({ restore: { id: 'wrong' } });
    return runnerReceipt(body);
  });
  assert.equal((await f.request(restorePath, { requestId: 'stable' })).status, 503);
  // Membership/share revocation can increment target policy even while direct grants are blocked.
  f.sqlite.exec("UPDATE sessions SET policy_version=2 WHERE id <> 'source'");
  assert.equal((await f.request(restorePath, { requestId: 'stable' })).status, 502);
  assert.equal((await f.request(restorePath, { requestId: 'stable' })).status, 200);
  assert.equal(attempts.length, 3);
  for (const attempt of attempts) {
    assert.equal(attempt.restore.id, attempts[0].restore.id);
    assert.deepEqual(attempt.binding, attempts[0].binding);
  }
  assert.notEqual(attempts[0].restore.downloadToken, attempts[1].restore.downloadToken);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
});

test('concurrent retries acquire only one target and runner attempt', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; started(); await blocked;
    return runnerReceipt(JSON.parse(String(init.body)) as RestoreInput);
  });
  const first = f.request(restorePath, { requestId: 'concurrent' });
  await running;
  const second = await f.request(restorePath, { requestId: 'concurrent' });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 201);
  assert.equal(calls, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 2);
});

test('snapshot identity, digest, size and fixed object key are verified before target creation', async t => {
  const mutations: ((f: SnapshotFixture) => Promise<void> | void)[] = [
    f => f.replaceSnapshot(s => { s.binding.session.id = 'other'; }),
    f => f.replaceSnapshot(s => { s.binding.owner.id = 'test:manager'; }),
    f => f.replaceSnapshot(s => { s.binding.session.ownerId = 'test:manager'; }),
    f => f.replaceSnapshot(s => { s.binding.session.workspaceId = 'other'; }),
    f => f.replaceSnapshot(s => { s.binding.agent.version = 2; }),
    f => f.replaceSnapshot(s => { s.binding.model.modelId = 'other'; }),
    f => f.replaceSnapshot(s => { s.binding.session.connectorId = 'other'; }),
    f => { f.objects.set(f.key, new TextEncoder().encode(JSON.stringify(f.snapshot).replace('Old Name', 'Bad Name'))); },
    f => { f.sqlite.prepare('UPDATE backups SET size = ?').run(MAX_BACKUP_BYTES + 1); },
    f => { f.sqlite.exec("UPDATE backups SET object_key='unrelated/private.json'"); },
    f => { f.objects.set(f.key, new Uint8Array([0xff])); f.sqlite.exec('UPDATE backups SET size=1'); },
    async f => {
      const raw = ` ${JSON.stringify(f.snapshot)}`;
      f.objects.set(f.key, new TextEncoder().encode(raw));
      f.sqlite.prepare('UPDATE backups SET sha256=?, size=?').run(await sha256(raw), Buffer.byteLength(raw));
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    await mutate(f);
    const response = await f.request(restorePath, { requestId: 'invalid' });
    assert.ok([409, 502].includes(response.status), `Unexpected ${response.status}`);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
  }
});

test('legacy pulls require authentication and exact unexpired descriptor; no arbitrary R2 key', async t => {
  const f = await fixture(t);
  const descriptor = await f.pending();
  const path = '/api/internal/restores/restore/download';
  const auth = { Authorization: `Bearer ${secret}` };
  assert.equal((await f.request(path, descriptor)).status, 401);
  for (const field of ['targetSessionId', 'sourceSessionId', 'backupId', 'downloadToken']) {
    assert.equal((await f.request(path, { ...descriptor, [field]: 'x'.repeat(43) }, auth)).status, 403);
  }
  assert.equal((await f.request(path, { ...descriptor, objectKey: f.key }, auth)).status, 400);
  assert.equal(f.reads.length, 0);
  assert.equal((await f.request(path, descriptor, auth)).status, 200);
  f.sqlite.exec('UPDATE restore_jobs SET download_expires_at=1');
  assert.equal((await f.request(path, descriptor, auth)).status, 403);
});

test('connector pulls require current generation, correct routed connector and live owner/host/share', async t => {
  const f = await fixture(t, true);
  const descriptor = await f.pending();
  const path = '/api/connectors/self/restores/restore/download';
  const auth = { Authorization: `Bearer ${bearer}`, 'X-Connection-Token': connection };
  assert.equal((await f.request(path, descriptor)).status, 401);
  assert.equal((await f.request(path, descriptor, { Authorization: `Bearer ${bearer}` })).status, 401);
  assert.equal((await f.request(path, descriptor, { ...auth, 'X-Connection-Token': 'x'.repeat(43) })).status, 401);
  assert.equal((await f.request('/api/internal/restores/restore/download', descriptor, { Authorization: `Bearer ${secret}` })).status, 403);
  assert.equal((await f.request(path, descriptor, auth)).status, 200);
  f.sqlite.exec("DELETE FROM connector_shares WHERE connector_id='connector'");
  assert.equal((await f.request(path, descriptor, auth)).status, 403);
  f.sqlite.exec("INSERT INTO connector_shares VALUES ('connector','workspace','2026-01-01'); DELETE FROM workspace_members WHERE user_id='test:host'");
  assert.equal((await f.request(path, descriptor, auth)).status, 403);
  f.sqlite.exec("INSERT INTO workspace_members VALUES ('workspace','test:host','member','2026-01-01'); DELETE FROM workspace_members WHERE user_id='test:owner'");
  assert.equal((await f.request(path, descriptor, auth)).status, 404);
});

test('revoked memberships/share prevent new restore targets and completed receipt access', async t => {
  for (const sql of ["DELETE FROM workspace_members WHERE user_id='test:owner'", "DELETE FROM workspace_members WHERE user_id='test:host'", 'DELETE FROM connector_shares']) {
    const f = await fixture(t, true);
    f.sqlite.exec(sql);
    assert.ok([403, 404].includes((await f.request(restorePath, { requestId: 'revoked' })).status));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
  }
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => runnerReceipt(JSON.parse(String(init.body)) as RestoreInput));
  assert.equal((await f.request(restorePath, { requestId: 'completed' })).status, 201);
  f.sqlite.exec("DELETE FROM workspace_members WHERE user_id='test:owner'");
  assert.equal((await f.request(restorePath, { requestId: 'completed' })).status, 404);
});

test('regular owner backup downloads retain bounded integrity checks', async t => {
  const f = await fixture(t);
  const path = '/api/sessions/source/backups/backup/download';
  assert.equal((await f.app.request(path, {}, f.env)).status, 200);
  assert.equal((await f.app.request(path, { headers: { 'x-test-user': 'test:manager' } }, f.env)).status, 403);
  f.sqlite.prepare('UPDATE backups SET size=?').run(MAX_BACKUP_BYTES + 1);
  const reads = f.reads.length;
  assert.equal((await f.app.request(path, {}, f.env)).status, 409);
  assert.equal(f.reads.length, reads);
});

test('current connection is rechecked after R2 reading, before snapshot bytes are returned', async t => {
  const f = await fixture(t, true);
  const descriptor = await f.pending();
  const bytes = f.objects.get(f.key)!;
  f.env.BUCKET = { async get() {
    f.sqlite.prepare('UPDATE connectors SET connection_hash=?').run(await sha256('n'.repeat(43)));
    return { size: bytes.byteLength, body: new Response(new Uint8Array(bytes)).body };
  } } as unknown as R2Bucket;
  const response = await f.request('/api/connectors/self/restores/restore/download', descriptor,
    { Authorization: `Bearer ${bearer}`, 'X-Connection-Token': connection });
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('pi-runner-backup-v1'));
});

test('download grants cannot be used by another connector or after receipt completion', async t => {
  const f = await fixture(t, true);
  const descriptor = await f.pending();
  const otherToken = 'o'.repeat(43);
  f.sqlite.prepare(`INSERT INTO connectors (id,owner_id,name,credential_hash,connection_hash,created_at)
    VALUES ('other','test:host','Other',?,?,'2026-01-01')`).run(await sha256(otherToken), await sha256(connection));
  const path = '/api/connectors/self/restores/restore/download';
  assert.equal((await f.request(path, descriptor,
    { Authorization: `Bearer ${otherToken}`, 'X-Connection-Token': connection })).status, 403);
  f.sqlite.exec("UPDATE restore_jobs SET status='completed', download_token_hash=NULL, download_expires_at=0");
  assert.equal((await f.request(path, descriptor,
    { Authorization: `Bearer ${bearer}`, 'X-Connection-Token': connection })).status, 403);
  assert.equal(f.reads.length, 0);
});

test('bounded decoder cancels overlong streams and rejects malformed UTF-8 and nonexact lengths', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedSnapshotText(new Response(stream), 1));
  assert.equal(cancelled, true);
  await assert.rejects(boundedSnapshotText(new Response(new Uint8Array([0xff])), 1));
  await assert.rejects(boundedSnapshotText(new Response('abc'), 4));
});
