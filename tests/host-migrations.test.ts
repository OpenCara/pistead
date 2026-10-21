import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env, WorkerEnv } from '../apps/server/src/types.js';
import type { RestoreInput } from '../packages/shared/src/connector.js';
import type { RunnerBinding } from '../packages/shared/src/types.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { registerHostMigrations } from '../apps/server/src/host-migrations.js';
import { downloadRestoreSnapshot } from '../apps/server/src/restore-routes.js';
import { requireNoMigration } from '../apps/server/src/db.js';
import { fakeHub, testDatabase } from './helpers/control-plane.js';

const sourceBearer = 's'.repeat(43);
const targetBearer = 't'.repeat(43);
const sourceConnection = 'c'.repeat(43);
const targetConnection = 'k'.repeat(43);
const migratePath = '/api/sessions/source/migrate';

async function fixture(t: TestContext, options: { targetCapabilities?: Record<string, unknown> } = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  let rpc: (connectorId: string, input: { action: string; body: string }) => Promise<Response> = async () => Response.json({}, { status: 503 });
  const hub = fakeHub({ rpc: (connectorId, envelope) => rpc(connectorId, { action: envelope.request.ticket.action, body: envelope.request.body }) });
  const env: Env = { DB: db, APP_ORIGIN: 'http://localhost:8787', TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: 'migration-auth-test-secret-not-for-deployment', TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    CONNECTOR_HUB: hub };
  const models = '[{"provider":"faux","modelId":"faux-v1","name":"Model"}]';
  sqlite.exec(`
    INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES
      ('test:owner','Owner','Owner','owner@example.test','{}','test','2026-01-01'),
      ('test:host','Host','Host','host@example.test','{}','test','2026-01-01');
    INSERT INTO workspaces VALUES ('workspace','Workspace','test:owner','2026-01-01');
    INSERT INTO workspace_members VALUES ('workspace','test:owner','owner','2026-01-01'),('workspace','test:host','member','2026-01-01');
  `);
  sqlite.prepare(`INSERT INTO connectors (id,owner_id,name,credential_hash,connection_hash,models_json,capabilities_json,created_at)
    VALUES ('old-host','test:host','Old host',?,?,?,'{"platform":"linux","sandbox":true,"productionShell":false}','2026-01-01')`)
    .run(await sha256(sourceBearer), await sha256(sourceConnection), models);
  sqlite.prepare(`INSERT INTO connectors (id,owner_id,name,credential_hash,connection_hash,models_json,capabilities_json,created_at)
    VALUES ('new-host','test:owner','New host',?,?,?,?,'2026-01-01')`)
    .run(await sha256(targetBearer), await sha256(targetConnection), models,
      JSON.stringify(options.targetCapabilities ?? { platform: 'linux', sandbox: true, productionShell: false, hostMigration: true }));
  sqlite.exec(`
    INSERT INTO connector_workspaces VALUES ('old-host','workspace','2026-01-01'),('new-host','workspace','2026-01-01');
    INSERT INTO connector_shares VALUES ('old-host','workspace','2026-01-01');
    INSERT INTO models (id,workspace_id,name,provider,model_id,connector_id,connector_owner_id,created_at) VALUES
      ('old-model','workspace','Old model','faux','faux-v1','old-host','test:host','2026-01-01'),
      ('new-model','workspace','New model','faux','faux-v1','new-host','test:owner','2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent','test:owner','2026-01-01');
    INSERT INTO agent_versions VALUES ('version','agent','test:owner','workspace',1,'Agent','Description','Instructions','["read_file","git_push"]','old-model','2026-01-01');
    INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id,repositories_json,visibility)
      VALUES ('source','workspace','test:owner','version','Original',3,'ready','2026-01-01','old-host','test:host','[]','workspace');
  `);
  const route = { connectorId: 'old-host', connectorOwnerId: 'test:host' };
  const binding: RunnerBinding = {
    session: { id: 'source', workspaceId: 'workspace', ownerId: 'test:owner', agentVersionId: 'version', title: 'Original',
      policyVersion: 3, status: 'ready', createdAt: '2026-01-01', ...route },
    owner: { id: 'test:owner', githubId: null, githubLogin: null, displayName: 'Owner', gitName: 'Owner',
      gitEmail: 'owner@example.test', env: {}, githubConnected: false },
    agent: { id: 'version', agentId: 'agent', authorId: 'test:owner', workspaceId: 'workspace', version: 1, name: 'Agent',
      description: 'Description', instructions: 'Instructions', tools: ['read_file', 'git_push'], modelId: 'old-model', createdAt: '2026-01-01' },
    model: { id: 'old-model', workspaceId: 'workspace', name: 'Old model', provider: 'faux', modelId: 'faux-v1', ...route },
  };
  const snapshot = JSON.stringify({ format: 'pi-runner-backup-v1', binding, manifest: { version: 1 }, sqlite: 'c25hcHNob3Q=', files: [], createdAt: '2026-01-01' });
  const app = new Hono<WorkerEnv>();
  app.use('/api/sessions/*', async (c, next) => {
    c.set('auth', { userId: c.req.header('x-test-user') ?? 'test:owner', tokenHash: 'test', csrfToken: 'test', client: 'browser' });
    await next();
  });
  registerHostMigrations(app);
  app.post('/api/connectors/self/restores/:restoreId/download', async c => downloadRestoreSnapshot(c,
    c.req.header('authorization') === `Bearer ${targetBearer}` ? 'new-host' : 'old-host'));
  async function request(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);
  }
  const downloads: string[] = [];
  /** The source host answers with its snapshot; the target host downloads it as a restore and confirms. */
  function hosts(target?: (input: RestoreInput) => Promise<Response>) {
    rpc = async (connectorId, { action, body }) => {
      if (connectorId === 'old-host' && action === 'backup') return new Response(snapshot, { headers: { 'content-type': 'application/json' } });
      if (connectorId === 'new-host' && action === 'restore') {
        const input = JSON.parse(body) as RestoreInput;
        if (target) return target(input);
        const download = await request(`/api/connectors/self/restores/${input.restore.id}/download`, {
          targetSessionId: input.binding.session.id, sourceSessionId: input.restore.sourceSessionId,
          backupId: input.restore.backupId, downloadToken: input.restore.downloadToken,
        }, { Authorization: `Bearer ${targetBearer}`, 'X-Connection-Token': targetConnection });
        assert.equal(download.status, 200);
        downloads.push(await download.text());
        return Response.json({ restore: { id: input.restore.id, sha256: input.restore.sha256, targetSessionId: input.binding.session.id } });
      }
      return Response.json({ error: 'unexpected' }, { status: 400 });
    };
  }
  return { sqlite, env, app, request, hosts, snapshot, downloads };
}

test('a session moves to another connected host and the source is archived', async t => {
  const f = await fixture(t);
  const restores: RestoreInput[] = [];
  f.hosts();
  const inner = f.env.CONNECTOR_HUB!.rpc.bind(f.env.CONNECTOR_HUB);
  f.env.CONNECTOR_HUB!.rpc = async (connectorId, envelope) => {
    if (envelope.request.ticket.action === 'restore') restores.push(JSON.parse(envelope.request.body) as RestoreInput);
    return inner(connectorId, envelope);
  };
  const response = await f.request(migratePath, { requestId: 'move', modelId: 'new-model' });
  assert.equal(response.status, 201);
  const body = await response.json() as { session: { id: string; status: string; connectorId: string; visibility: string }; migration: { status: string; targetSessionId: string } };
  assert.equal(body.migration.status, 'completed');
  assert.equal(body.session.status, 'ready');
  assert.equal(body.session.connectorId, 'new-host');
  assert.equal(body.session.visibility, 'workspace');
  assert.deepEqual(f.downloads, [f.snapshot]);
  const [restore] = restores;
  assert.equal(restore!.restore.migration, true);
  assert.equal(restore!.binding.model.connectorId, 'new-host');
  assert.equal(restore!.binding.agent.instructions, 'Instructions');
  // The new host doesn't carry git_push, so the successor's agent doesn't offer it.
  assert.deepEqual(restore!.binding.agent.tools, ['read_file']);
  const source = f.sqlite.prepare("SELECT status, archived_status, policy_version FROM sessions WHERE id = 'source'").get()!;
  assert.deepEqual({ ...source }, { status: 'archived', archived_status: 'ready', policy_version: 4 });
  const job = f.sqlite.prepare('SELECT status, snapshot, download_token_hash FROM host_migrations').get()!;
  assert.deepEqual({ ...job }, { status: 'completed', snapshot: null, download_token_hash: null });
  // Replays are inert and need neither host.
  f.env.CONNECTOR_HUB!.rpc = async () => { throw new Error('no host should be contacted'); };
  const replay = await f.request(migratePath, { requestId: 'move', modelId: 'new-model' });
  assert.equal(replay.status, 200);
  assert.equal((await f.request(migratePath, { requestId: 'move', modelId: 'old-model' })).status, 409);
  assert.throws(() => f.sqlite.exec("UPDATE host_migrations SET status = 'pending'"), /immutable/);
  assert.throws(() => f.sqlite.exec('DELETE FROM host_migrations'), /retained/);
});

test('a move needs another host that accepts moved sessions', async t => {
  const f = await fixture(t, { targetCapabilities: { platform: 'linux', sandbox: true, productionShell: false } });
  f.hosts();
  assert.equal((await f.request(migratePath, { requestId: 'old', modelId: 'new-model' })).status, 409);
  const g = await fixture(t);
  g.hosts();
  assert.equal((await g.request(migratePath, { requestId: 'same', modelId: 'old-model' })).status, 400);
  assert.equal((await g.request(migratePath, { requestId: 'other', modelId: 'new-model' }, { 'x-test-user': 'test:host' })).status, 403);
  for (const s of [f, g]) assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
});

test('a move that fails on the target locks the source until it is retried or cancelled', async t => {
  const f = await fixture(t);
  f.hosts(async () => Response.json({ error: 'busy' }, { status: 503 }));
  assert.equal((await f.request(migratePath, { requestId: 'move', modelId: 'new-model' })).status, 503);
  const job = f.sqlite.prepare('SELECT * FROM host_migrations').get()!;
  assert.equal(job.status, 'pending');
  assert.equal(job.snapshot, f.snapshot);
  const moving = (error: unknown) => error instanceof HTTPException && error.status === 409;
  await assert.rejects(requireNoMigration(f.env, 'source'), moving);
  await assert.rejects(requireNoMigration(f.env, String(job.target_session_id)), moving);
  // A second move of the same session is refused while one is in flight.
  assert.equal((await f.request(migratePath, { requestId: 'again', modelId: 'new-model' })).status, 409);
  // The schema enforces that too, so concurrent READ COMMITTED transactions can't both commit a move.
  f.sqlite.exec(`INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,connector_id,connector_owner_id)
    VALUES ('racer','workspace','test:owner','version','Racer',1,'provisioning','2026-01-01','new-host','test:owner')`);
  assert.throws(() => f.sqlite.prepare(`INSERT INTO host_migrations (id,request_id,owner_id,workspace_id,source_session_id,source_connector_id,
    target_session_id,target_connector_id,target_model_id,sha256,size,snapshot,binding_json,created_at)
    VALUES ('racer','racer','test:owner','workspace','source','old-host','racer','new-host','new-model',?,1,'{}','{}','2026-01-01')`)
    .run('a'.repeat(43)), /UNIQUE/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 3);
  // The retry reuses the held snapshot: the source host isn't asked again.
  let backups = 0;
  f.hosts();
  const inner = f.env.CONNECTOR_HUB!.rpc.bind(f.env.CONNECTOR_HUB);
  f.env.CONNECTOR_HUB!.rpc = async (connectorId, envelope) => {
    if (envelope.request.ticket.action === 'backup') backups++;
    return inner(connectorId, envelope);
  };
  const cancelPath = `/api/sessions/source/migrations/${job.id}/cancel`;
  const g = await fixture(t);
  g.hosts(async () => Response.json({ error: 'busy' }, { status: 503 }));
  assert.equal((await g.request(migratePath, { requestId: 'move', modelId: 'new-model' })).status, 503);
  const pending = g.sqlite.prepare('SELECT * FROM host_migrations').get()!;
  const cancelled = await g.request(`/api/sessions/source/migrations/${pending.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  await requireNoMigration(g.env, 'source');
  assert.equal(g.sqlite.prepare("SELECT status FROM sessions WHERE id = 'source'").get()!.status, 'ready');
  assert.equal(g.sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(String(pending.target_session_id))!.status, 'archived');
  assert.equal(g.sqlite.prepare('SELECT snapshot FROM host_migrations').get()!.snapshot, null);
  assert.equal((await g.request(migratePath, { requestId: 'move', modelId: 'new-model' })).status, 409);
  // Back to the first move: its retry completes from the held snapshot.
  const retried = await f.request(migratePath, { requestId: 'move', modelId: 'new-model' });
  assert.equal(retried.status, 200);
  assert.equal(backups, 0);
  assert.equal((await f.request(cancelPath, {})).status, 409);
});

test('only the target host can download a move snapshot, with the current grant', async t => {
  const f = await fixture(t);
  let grant: RestoreInput | undefined;
  f.hosts(async input => { grant = input; return Response.json({ error: 'busy' }, { status: 503 }); });
  assert.equal((await f.request(migratePath, { requestId: 'move', modelId: 'new-model' })).status, 503);
  // The failed attempt released its lease, but its token is still the latest one issued.
  const descriptor = { targetSessionId: grant!.binding.session.id, sourceSessionId: 'source', backupId: grant!.restore.backupId,
    downloadToken: grant!.restore.downloadToken };
  const path = `/api/connectors/self/restores/${grant!.restore.id}/download`;
  assert.equal((await f.request(path, descriptor, { Authorization: `Bearer ${sourceBearer}`, 'X-Connection-Token': sourceConnection })).status, 403);
  assert.equal((await f.request(path, { ...descriptor, downloadToken: 'x'.repeat(43) },
    { Authorization: `Bearer ${targetBearer}`, 'X-Connection-Token': targetConnection })).status, 403);
  const ok = await f.request(path, descriptor, { Authorization: `Bearer ${targetBearer}`, 'X-Connection-Token': targetConnection });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), f.snapshot);
});
