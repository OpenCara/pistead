import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import pg from 'pg';
import type { Env, WorkerEnv } from '../apps/server/src/types.js';
import type { RunnerBinding, WorkspaceDatabase } from '../packages/shared/src/types.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { registerBackups } from '../apps/server/src/backups.js';
import { exportSession, exportWorkspace } from '../apps/server/src/data-export.js';
import { decryptToken } from '../apps/server/src/vault.js';
import type { ImportSummary } from '../apps/server/src/workspace-databases/import.js';
import { publicAddress, resolveDatabaseHost } from '../apps/server/src/workspace-databases/hosts.js';
import { classify, limitResponses, PostgresWorkspaceDatabases } from '../apps/server/src/workspace-databases/postgres.js';
import { registerWorkspaceDatabases } from '../apps/server/src/workspace-databases/routes.js';
import { databaseSettings } from '../apps/server/src/workspace-databases/settings.js';
import { databaseSecretContext } from '../apps/server/src/workspace-databases/store.js';
import {
  WorkspaceDatabaseError, type WorkspaceBackupRef, type WorkspaceBackupSave, type WorkspaceDatabaseFailure,
  type WorkspaceDatabaseProvider, type WorkspaceDatabaseTarget, type WorkspaceImport,
} from '../apps/server/src/workspace-databases/types.js';
import { memoryStorage, testDatabase } from './helpers/control-plane.js';

const runnerSecret = 'workspace-database-runner-secret-not-for-deployment';
const password = 'owner-database-password-not-for-deployment';
const settings = { host: 'db.example.com', port: 5432, database: 'pistead', user: 'pistead_app', password };
const databasePath = '/api/workspaces/workspace/database';
// A throwaway self-signed CA certificate (CN=pistead-test-ca); only its PEM shape matters here.
const testCa = `-----BEGIN CERTIFICATE-----
MIIBWTCB/6ADAgECAhQMFylGgW/Qp9XXNeHqDtK7Xy5x5zAKBggqhkjOPQQDAjAa
MRgwFgYDVQQDDA9waXN0ZWFkLXRlc3QtY2EwIBcNMjYxMDE1MTM1MzU2WhgPMjEy
NjA5MjExMzUzNTZaMBoxGDAWBgNVBAMMD3Bpc3RlYWQtdGVzdC1jYTBZMBMGByqG
SM49AgEGCCqGSM49AwEHA0IABA9jSvPNmq6Xjmf3s220PHhyEe5XZEOSzNqtnyty
amAXvaD+7d0nYtCdicCFdofMVkDgySaU2PxrSnZ8VpZzCzKjITAfMB0GA1UdDgQW
BBTeAhjV5oWRFU3G84FaIpnQXfYxsDAKBggqhkjOPQQDAgNJADBGAiEAlmySm4MI
SJz676JrCZH/xe6ij4ZMY8CyBBaEogkjciQCIQDdA24KFmHSPyc3Idi3rvu7qng+
heFdOqiLS7rR47K8Wg==
-----END CERTIFICATE-----`;

/** A provider double: records every target, keeps saves in memory and fails on demand. */
interface FakeDatabases extends WorkspaceDatabaseProvider {
  targets: WorkspaceDatabaseTarget[];
  saved: Map<string, WorkspaceBackupSave>;
  loads: WorkspaceBackupRef[];
  imports: WorkspaceImport[];
  failure: WorkspaceDatabaseError | null;
}

function fakeDatabases(): FakeDatabases {
  const databases: FakeDatabases = {
    privateHosts: false, targets: [], saved: new Map(), loads: [], imports: [], failure: null,
    async import(target, data) {
      databases.targets.push(target);
      if (databases.failure) throw databases.failure;
      databases.imports.push(structuredClone(data));
    },
    async verify(target) {
      databases.targets.push(target);
      if (databases.failure) throw databases.failure;
    },
    async save(target, save) {
      databases.targets.push(target);
      if (databases.failure) throw databases.failure;
      databases.saved.set(save.backup.id, structuredClone(save));
    },
    async load(target, backup) {
      databases.targets.push(target);
      databases.loads.push(backup);
      if (databases.failure) throw databases.failure;
      const saved = databases.saved.get(backup.id);
      return saved && saved.session.id === backup.sessionId && saved.snapshot.byteLength === backup.size ? new Uint8Array(saved.snapshot) : null;
    },
  };
  return databases;
}

function failed(failure: WorkspaceDatabaseFailure) {
  return (error: unknown) => error instanceof WorkspaceDatabaseError && error.failure === failure;
}

async function code(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const storage = memoryStorage();
  const databases = fakeDatabases();
  const env: Env = { DB: db, APP_ORIGIN: 'http://localhost:8787', TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: 'workspace-database-auth-secret-not-for-deployment',
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_URL: 'http://localhost:9001',
    RUNNER_SHARED_SECRET: runnerSecret, VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'), BUCKET: storage, WORKSPACE_DATABASES: databases };
  // The session belongs to a member: their backups go to the database the workspace owner connects.
  sqlite.exec(`
    INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES
      ('test:owner','Owner','Owner','owner@example.test','{}','test','2026-01-01'),
      ('test:admin','Admin','Admin','admin@example.test','{}','test','2026-01-01'),
      ('test:member','Member','Member','member@example.test','{}','test','2026-01-01'),
      ('test:outsider','Outsider','Outsider','outsider@example.test','{}','test','2026-01-01');
    INSERT INTO workspaces VALUES ('workspace','Workspace','test:owner','2026-01-01');
    INSERT INTO workspace_members VALUES ('workspace','test:owner','owner','2026-01-01'),
      ('workspace','test:admin','admin','2026-01-01'),('workspace','test:member','member','2026-01-01');
    INSERT INTO models (id,workspace_id,name,provider,model_id,created_at) VALUES ('model','workspace','Model','faux','faux-v1','2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent','test:member','2026-01-01');
    INSERT INTO agent_versions VALUES ('version','agent','test:member','workspace',1,'Agent','Description','Instructions','["read_file"]','model','2026-01-01');
    INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at)
      VALUES ('session','workspace','test:member','version','Member session',1,'ready','2026-01-01'),
        ('owner-session','workspace','test:owner','version','Owner session',1,'ready','2026-01-02');
  `);
  function snapshotOf(sessionId: string, ownerId: string, name: string, title: string): string {
    const binding: RunnerBinding = {
      session: { id: sessionId, workspaceId: 'workspace', ownerId, agentVersionId: 'version', title, policyVersion: 1, status: 'ready',
        createdAt: '2026-01-01' },
      owner: { id: ownerId, githubId: null, githubLogin: null, displayName: name, gitName: name, gitEmail: `${name.toLowerCase()}@example.test`,
        env: {}, githubConnected: false },
      agent: { id: 'version', agentId: 'agent', authorId: 'test:member', workspaceId: 'workspace', version: 1, name: 'Agent',
        description: 'Description', instructions: 'Instructions', tools: ['read_file'], modelId: 'model', createdAt: '2026-01-01' },
      model: { id: 'model', workspaceId: 'workspace', name: 'Model', provider: 'faux', modelId: 'faux-v1' },
    };
    return JSON.stringify({ format: 'pi-runner-backup-v1', binding, manifest: { version: 1 }, sqlite: 'c25hcHNob3Q=', files: [], createdAt: '2026-01-01' });
  }
  const snapshots: Record<string, string> = {
    session: snapshotOf('session', 'test:member', 'Member', 'Member session'),
    'owner-session': snapshotOf('owner-session', 'test:owner', 'Owner', 'Owner session'),
  };
  const snapshot = snapshots.session!;
  const app = new Hono<WorkerEnv>();
  // Cookie/CSRF are covered by control-plane tests; this seam supplies an authenticated actor.
  app.use('/api/*', async (c, next) => {
    c.set('auth', { userId: c.req.header('x-test-user') ?? 'test:owner', tokenHash: 'test', csrfToken: 'test' });
    await next();
  });
  registerBackups(app);
  registerWorkspaceDatabases(app);
  async function request(method: string, path: string, user: string, body?: unknown): Promise<Response> {
    return app.request(path, { method, headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }
  /** The legacy runner answers each backup request with that session's snapshot; returns how many it served. */
  function runner(whilePreparing?: () => void): { calls: number } {
    const counter = { calls: 0 };
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      counter.calls++;
      whilePreparing?.();
      const sessionId = /\/v1\/sessions\/([^/]+)\/backup$/.exec(String(url))?.[1] ?? '';
      return new Response(snapshots[sessionId], { headers: { 'Content-Type': 'application/json' } });
    });
    return counter;
  }
  return { sqlite, env, storage, databases, snapshot, request, runner };
}

test('only the workspace owner connects, replaces and disconnects the session database; its password stays encrypted', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('PUT', databasePath, 'test:outsider', settings)).status, 404);
  for (const user of ['test:admin', 'test:member']) {
    const response = await f.request('PUT', databasePath, user, settings);
    assert.equal(response.status, 403);
    assert.equal(await code(response), 'owner_required');
  }
  assert.equal(f.databases.targets.length, 0);
  const created = await f.request('PUT', databasePath, 'test:owner', settings);
  assert.equal(created.status, 201);
  const { database } = await created.json() as { database: WorkspaceDatabase };
  assert.equal(database.workspaceId, 'workspace');
  assert.equal(database.host, 'db.example.com');
  assert.equal(database.port, 5432);
  assert.equal(database.database, 'pistead');
  assert.equal(database.user, 'pistead_app');
  assert.equal(database.tls, 'verify-full');
  assert.equal(database.customCa, false);
  assert.equal(database.connectedBy, 'test:owner');
  assert.deepEqual(f.databases.targets, [{ ...settings, tls: 'verify-full', caCertificate: null }]);
  const row = f.sqlite.prepare('SELECT * FROM workspace_databases').get()!;
  const ciphertext = String(row.password_ciphertext);
  assert.ok(!JSON.stringify(row).includes(password));
  assert.equal(await decryptToken(f.env, databaseSecretContext(database.id), ciphertext), password);
  // The ciphertext is bound to this connection and can't be read as another secret.
  await assert.rejects(decryptToken(f.env, 'test:owner', ciphertext));
  for (const user of ['test:admin', 'test:member']) {
    const view = await f.request('GET', databasePath, user);
    assert.equal(view.status, 200);
    const text = await view.text();
    assert.ok(!text.includes(password) && !text.includes(ciphertext));
    assert.deepEqual(JSON.parse(text), { available: true, privateHosts: false, database });
  }
  assert.equal((await f.request('GET', databasePath, 'test:outsider')).status, 404);
  // New credentials or TLS for the same database keep its id, which members' confirmations name; another database gets a new one.
  const rotated = await f.request('PUT', databasePath, 'test:owner', { ...settings, password: 'rotated-password', tls: 'require' });
  assert.equal(rotated.status, 201);
  const rotation = (await rotated.json() as { database: WorkspaceDatabase }).database;
  assert.equal(rotation.id, database.id);
  assert.equal(rotation.tls, 'require');
  assert.equal(rotation.createdAt, database.createdAt);
  const moved = await f.request('PUT', databasePath, 'test:owner', { ...settings, host: 'db2.example.com' });
  assert.equal(moved.status, 201);
  const replacement = (await moved.json() as { database: WorkspaceDatabase }).database;
  assert.notEqual(replacement.id, database.id);
  assert.equal(replacement.host, 'db2.example.com');
  const stored = f.sqlite.prepare('SELECT id, password_ciphertext FROM workspace_databases').all();
  assert.equal(stored.length, 1);
  assert.equal(await decryptToken(f.env, databaseSecretContext(replacement.id), String(stored[0]!.password_ciphertext)), password);
  await assert.rejects(decryptToken(f.env, databaseSecretContext(database.id), String(stored[0]!.password_ciphertext)));
  assert.equal((await f.request('DELETE', databasePath, 'test:admin')).status, 403);
  assert.equal((await f.request('DELETE', databasePath, 'test:owner')).status, 204);
  assert.equal((await f.request('DELETE', databasePath, 'test:owner')).status, 404);
  assert.equal((await (await f.request('GET', databasePath, 'test:member')).json() as { database: unknown }).database, null);
  const actions = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'workspace.database.%'").all().map(event => String(event.action)).sort();
  assert.deepEqual(actions, ['workspace.database.connected', 'workspace.database.connected', 'workspace.database.connected',
    'workspace.database.disconnected']);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM audit').all()).includes(password));
});

test('saving validates the settings and the live connection, and never shows driver messages', async t => {
  const f = await fixture(t);
  for (const body of [{ ...settings, connectionString: 'postgres://u:p@db.example.com/pistead' }, { ...settings, host: 'https://db.example.com' },
    { ...settings, host: 'db.example.com:5432' }, { ...settings, port: 0 }, { ...settings, port: '5432' }, { ...settings, password: '' },
    { ...settings, password: 'a\u0000b' }, { ...settings, tls: 'prefer' }, { ...settings, tls: 'require', caCertificate: testCa },
    { ...settings, caCertificate: 'not a certificate' }]) {
    const response = await f.request('PUT', databasePath, 'test:owner', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await code(response), 'invalid_workspace_database');
  }
  assert.equal(f.databases.targets.length, 0);
  const driver = new Error('password authentication failed for user "pistead_app" connecting to 10.0.0.7');
  for (const [failure, status] of [['authentication_failed', 400], ['host_not_allowed', 400], ['tls_failed', 400],
    ['pistead_database', 400], ['unreachable', 502]] as const) {
    f.databases.failure = new WorkspaceDatabaseError(failure, { cause: driver });
    const response = await f.request('PUT', databasePath, 'test:owner', settings);
    assert.equal(response.status, status, failure);
    const text = await response.text();
    assert.equal((JSON.parse(text) as { code: string }).code, `workspace_database_${failure}`);
    assert.ok(!text.includes('10.0.0.7') && !text.includes('pistead_app'), 'Driver details must stay on the server');
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_databases').get()!.n, 0);
  f.databases.failure = null;
  const withCa = await f.request('PUT', databasePath, 'test:owner', { ...settings, caCertificate: `Region A\n${testCa}\n` });
  assert.equal(withCa.status, 201);
  assert.equal((await withCa.json() as { database: WorkspaceDatabase }).database.customCa, true);
  assert.equal(f.databases.targets.at(-1)?.caCertificate, `${testCa}\n`);
});

test('with workspace databases turned off, connecting is refused, disconnecting works and backups never fall back to server storage', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('PUT', databasePath, 'test:owner', settings)).status, 201);
  delete f.env.WORKSPACE_DATABASES;
  const put = await f.request('PUT', databasePath, 'test:owner', settings);
  assert.equal(put.status, 503);
  assert.equal(await code(put), 'workspace_databases_disabled');
  const view = await (await f.request('GET', databasePath, 'test:member')).json() as { available: boolean; database: WorkspaceDatabase | null };
  assert.equal(view.available, false);
  assert.equal(view.database?.host, 'db.example.com');
  const runner = f.runner();
  const listing = await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json() as { destination: string; enabled: boolean };
  assert.deepEqual([listing.destination, listing.enabled], ['workspace-database', false]);
  const refused = await f.request('POST', '/api/sessions/session/backup', 'test:member', {});
  assert.equal(refused.status, 503);
  assert.equal(await code(refused), 'workspace_databases_disabled');
  assert.equal(runner.calls, 0);
  assert.equal(f.storage.objects.size, 0);
  assert.equal((await f.request('DELETE', databasePath, 'test:owner')).status, 204);
  const saved = await f.request('POST', '/api/sessions/session/backup', 'test:member', {});
  assert.equal(saved.status, 201);
  assert.equal((await saved.json() as { backup: { location: string } }).backup.location, 'server');
  assert.equal(runner.calls, 1);
  assert.equal(f.storage.objects.size, 1);
});

test('a member confirms the workspace database before each backup goes there; the workspace owner who connected it does not', async t => {
  const f = await fixture(t);
  const runner = f.runner();
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  const listing = await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json() as { workspaceDatabase: unknown };
  assert.deepEqual(listing.workspaceDatabase, { id: database.id, host: 'db.example.com', port: 5432, database: 'pistead', confirm: true });
  for (const body of [undefined, {}, { trustedDatabaseId: 'another-database' }]) {
    const response = await f.request('POST', '/api/sessions/session/backup', 'test:member', body);
    assert.equal(response.status, 409);
    assert.equal(await code(response), 'workspace_database_trust_required');
  }
  assert.equal((await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id, title: 'x' })).status, 400);
  assert.equal(runner.calls, 0, 'No snapshot is taken before the member confirms');
  assert.equal((await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id })).status, 201);
  const ownerListing = await (await f.request('GET', '/api/sessions/owner-session/backups', 'test:owner')).json() as { workspaceDatabase: { confirm: boolean } };
  assert.equal(ownerListing.workspaceDatabase.confirm, false);
  assert.equal((await f.request('POST', '/api/sessions/owner-session/backup', 'test:owner')).status, 201);
  // Rotating the password keeps the member's confirmation; pointing the connection at another database asks again.
  assert.equal((await f.request('PUT', databasePath, 'test:owner', { ...settings, password: 'rotated-password' })).status, 201);
  assert.equal((await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id })).status, 201);
  const moved = (await (await f.request('PUT', databasePath, 'test:owner', { ...settings, host: 'db2.example.com' })).json() as { database: WorkspaceDatabase }).database;
  const stale = await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id });
  assert.equal(stale.status, 409);
  assert.equal(await code(stale), 'workspace_database_trust_required');
  assert.equal((await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: moved.id })).status, 201);
  assert.equal(f.databases.saved.size, 4);
  assert.equal(runner.calls, 4);
});

test('a backup is not saved when the workspace database changes while the host prepares it', async t => {
  const f = await fixture(t);
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  f.runner(() => { f.sqlite.exec("UPDATE workspace_databases SET id = 'elsewhere', host = 'db3.example.com'"); });
  const response = await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id });
  assert.equal(response.status, 409);
  assert.equal(await code(response), 'workspace_database_changed');
  assert.equal(f.databases.saved.size, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM backups').get()!.n, 0);
});

test('a backup meant for server storage is not saved there once a workspace database was connected meanwhile', async t => {
  const f = await fixture(t);
  f.runner(() => {
    f.sqlite.exec(`INSERT INTO workspace_databases (id,workspace_id,host,port,database_name,username,tls,ca_certificate,password_ciphertext,
      created_by,created_at,updated_at) VALUES ('connected-meanwhile','workspace','db.example.com',5432,'pistead','pistead_app','verify-full',NULL,
      'ciphertext','test:owner','2026-01-01','2026-01-01')`);
  });
  const response = await f.request('POST', '/api/sessions/owner-session/backup', 'test:owner', {});
  assert.equal(response.status, 409);
  assert.equal(await code(response), 'workspace_database_changed');
  assert.equal(f.storage.objects.size, 0);
  assert.equal(f.databases.saved.size, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM backups').get()!.n, 0);
});

test('without backup storage the server saves no backup, and its listings say so', async t => {
  const f = await fixture(t);
  delete f.env.BUCKET;
  const runner = f.runner();
  assert.deepEqual(await (await f.request('GET', '/api/sessions/owner-session/backups', 'test:owner')).json(),
    { backups: [], destination: 'server', enabled: false });
  const refused = await f.request('POST', '/api/sessions/owner-session/backup', 'test:owner', {});
  assert.equal(refused.status, 503);
  assert.equal(await code(refused), 'backup_unavailable');
  assert.equal(runner.calls, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM backups').get()!.n, 0);
});

test('without backup storage a workspace database still takes the backups of its sessions', async t => {
  const f = await fixture(t);
  delete f.env.BUCKET;
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  f.runner();
  const listing = await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json() as { destination: string; enabled: boolean };
  assert.deepEqual([listing.destination, listing.enabled], ['workspace-database', true]);
  const created = await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id });
  assert.equal(created.status, 201);
  assert.equal(f.databases.saved.size, 1);
});

test('the listing marks backups saved where this server can no longer read them', async t => {
  const f = await fixture(t);
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  f.runner();
  const first = await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id });
  assert.equal(first.status, 201);
  const inDatabase = (await first.json() as { backup: { id: string } }).backup.id;
  const marks = async () => ((await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json()) as
    { backups: { location: string; unavailable?: boolean }[] }).backups.map(backup => `${backup.location}:${backup.unavailable ?? false}`).sort();
  assert.deepEqual(await marks(), ['workspace-database:false']);
  delete f.env.WORKSPACE_DATABASES;
  assert.deepEqual(await marks(), ['workspace-database:true']);
  f.env.WORKSPACE_DATABASES = f.databases;
  assert.equal((await f.request('DELETE', databasePath, 'test:owner')).status, 204);
  assert.deepEqual(await marks(), ['workspace-database:true']);
  // Disconnected, new backups go to the server's storage, readable only while it is configured.
  const second = await f.request('POST', '/api/sessions/session/backup', 'test:member', {});
  assert.equal(second.status, 201);
  const inStorage = (await second.json() as { backup: { id: string } }).backup.id;
  assert.deepEqual(await marks(), ['server:false', 'workspace-database:true']);
  delete f.env.BUCKET;
  assert.deepEqual(await marks(), ['server:true', 'workspace-database:true']);
  for (const [id, expected] of [[inStorage, 'backup_unavailable'], [inDatabase, 'workspace_database_disconnected']] as const) {
    const download = await f.request('GET', `/api/sessions/session/backups/${id}/download`, 'test:member');
    assert.equal(download.status, 503);
    assert.equal(await code(download), expected);
  }
});

test('backups of a workspace with its own database are saved and read back there, with the recorded digest', async t => {
  const f = await fixture(t);
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  f.runner();
  assert.deepEqual(await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json(), { backups: [], destination: 'workspace-database',
    enabled: true, workspaceDatabase: { id: database.id, host: 'db.example.com', port: 5432, database: 'pistead', confirm: true } });
  const created = await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id });
  assert.equal(created.status, 201);
  const { backup } = await created.json() as { backup: { id: string; sha256: string; size: number; location: string } };
  assert.equal(backup.location, 'workspace-database');
  assert.equal(backup.sha256, await sha256(f.snapshot));
  assert.equal(f.storage.objects.size, 0, 'Nothing goes to the server storage');
  assert.equal(f.databases.targets.at(-1)?.password, password);
  const saved = f.databases.saved.get(backup.id);
  assert.ok(saved);
  assert.deepEqual(saved.workspace, { id: 'workspace', name: 'Workspace', ownerId: 'test:owner' });
  assert.equal(saved.session.id, 'session');
  assert.equal(saved.session.ownerId, 'test:member');
  assert.equal(saved.session.title, 'Member session');
  assert.equal(saved.session.visibility, 'private');
  assert.equal((saved.session.record as { id: string; title: string }).title, 'Member session');
  assert.deepEqual(saved.backup, { id: backup.id, format: 'pi-runner-backup-v1', sha256: backup.sha256, size: backup.size,
    createdAt: saved.backup.createdAt });
  assert.equal(new TextDecoder().decode(saved.snapshot), f.snapshot);
  assert.deepEqual({ ...f.sqlite.prepare('SELECT backup_id, workspace_id FROM workspace_database_backups').get() },
    { backup_id: backup.id, workspace_id: 'workspace' });
  const audit = f.sqlite.prepare("SELECT detail_json FROM audit WHERE action = 'backup.created'").get()!;
  assert.equal((JSON.parse(String(audit.detail_json)) as { location: string }).location, 'workspace-database');
  const listing = await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json() as { backups: { id: string; location: string }[] };
  assert.deepEqual(listing.backups.map(item => [item.id, item.location]), [[backup.id, 'workspace-database']]);
  const downloadPath = `/api/sessions/session/backups/${backup.id}/download`;
  const download = await f.request('GET', downloadPath, 'test:member');
  assert.equal(download.status, 200);
  assert.equal(await download.text(), f.snapshot);
  assert.deepEqual(f.databases.loads, [{ id: backup.id, sessionId: 'session', size: backup.size }]);
  // Connecting the database gives the workspace owner no access to the member's backups through Pistead.
  assert.equal((await f.request('GET', downloadPath, 'test:owner')).status, 404);
  // A snapshot changed in the workspace database no longer matches the digest the control plane recorded.
  saved.snapshot = new TextEncoder().encode(f.snapshot.replace('Instructions', 'Instructionz'));
  assert.equal((await f.request('GET', downloadPath, 'test:member')).status, 502);
  f.databases.saved.delete(backup.id);
  assert.equal((await f.request('GET', downloadPath, 'test:member')).status, 404);
  f.databases.failure = new WorkspaceDatabaseError('unreachable', { cause: new Error('connect ECONNREFUSED 10.0.0.7:5432') });
  const unreachable = await f.request('GET', downloadPath, 'test:member');
  assert.equal(unreachable.status, 503);
  const text = await unreachable.text();
  assert.equal((JSON.parse(text) as { code: string }).code, 'workspace_database_unavailable');
  assert.ok(!text.includes('10.0.0.7'));
  f.databases.failure = null;
  assert.equal((await f.request('DELETE', databasePath, 'test:owner')).status, 204);
  const disconnected = await f.request('GET', downloadPath, 'test:member');
  assert.equal(disconnected.status, 503);
  assert.equal(await code(disconnected), 'workspace_database_disconnected');
  assert.equal(f.storage.reads.length, 0);
});

test('a failed save records no backup, and backups saved earlier stay in the server storage', async t => {
  const f = await fixture(t);
  f.runner();
  const earlier = await f.request('POST', '/api/sessions/session/backup', 'test:member', {});
  assert.equal(earlier.status, 201);
  const { backup } = await earlier.json() as { backup: { id: string; location: string } };
  assert.equal(backup.location, 'server');
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  f.databases.failure = new WorkspaceDatabaseError('authentication_failed');
  const failure = await f.request('POST', '/api/sessions/session/backup', 'test:member', { trustedDatabaseId: database.id });
  assert.equal(failure.status, 503);
  assert.equal(await code(failure), 'workspace_database_unavailable');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM backups').get()!.n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_database_backups').get()!.n, 0);
  assert.equal(f.storage.objects.size, 1);
  f.databases.failure = null;
  const download = await f.request('GET', `/api/sessions/session/backups/${backup.id}/download`, 'test:member');
  assert.equal(download.status, 200);
  assert.equal(await download.text(), f.snapshot);
  assert.equal(f.databases.loads.length, 0);
  const listing = await (await f.request('GET', '/api/sessions/session/backups', 'test:member')).json() as { backups: { location: string }[]; destination: string };
  assert.deepEqual(listing.backups.map(item => item.location), ['server']);
  assert.equal(listing.destination, 'workspace-database');
});

test('the workspace owner imports dumps of this workspace into its database; nobody else does', async t => {
  const f = await fixture(t);
  const importPath = '/api/workspaces/workspace/database/import';
  const early = await f.request('POST', importPath, 'test:owner', await exportWorkspace(f.env.DB, 'workspace', null));
  assert.equal(early.status, 409);
  assert.equal(await code(early), 'workspace_database_required');
  const { database } = await (await f.request('PUT', databasePath, 'test:owner', settings)).json() as { database: WorkspaceDatabase };
  const dump = await exportWorkspace(f.env.DB, 'workspace', null);
  assert.ok(dump);
  assert.equal((await f.request('POST', importPath, 'test:outsider', dump)).status, 404);
  for (const user of ['test:admin', 'test:member']) {
    const refused = await f.request('POST', importPath, user, dump);
    assert.equal(refused.status, 403);
    assert.equal(await code(refused), 'owner_required');
  }
  assert.equal(f.databases.imports.length, 0);
  const response = await f.request('POST', importPath, 'test:owner', dump);
  assert.equal(response.status, 200);
  const auditEntries = dump.audit.length + dump.sessions.reduce((total, session) => total + session.audit.length, 0);
  assert.ok(auditEntries > 0, 'Connecting the database is workspace activity');
  const expected: ImportSummary = { format: 'workspace', exportedAt: dump.exportedAt, sessions: 2, sessionDetails: 2, auditEntries, workspaceSettings: true };
  assert.deepEqual((await response.json() as { imported: ImportSummary }).imported, expected);
  assert.equal(f.databases.targets.at(-1)?.password, password);
  const [data] = f.databases.imports;
  assert.ok(data);
  assert.deepEqual(data.workspace, { id: 'workspace', name: 'Workspace', ownerId: 'test:owner' });
  assert.deepEqual(data.sessions.map(session => [session.id, session.ownerId, session.data === null]), [['session', 'test:member', false], ['owner-session', 'test:owner', false]]);
  assert.deepEqual(Object.keys(data.workspaceData ?? {}).sort(), ['agents', 'database', 'members', 'models', 'pushIdentities', 'repositories']);
  assert.equal((data.workspaceData?.database as { id: string }).id, database.id);
  const audit = f.sqlite.prepare("SELECT actor_id, workspace_id, detail_json FROM audit WHERE action = 'workspace.database.imported'").get()!;
  assert.equal(audit.actor_id, 'test:owner');
  assert.deepEqual(JSON.parse(String(audit.detail_json)), { databaseId: database.id, ...expected });

  // A session export of this workspace imports too.
  const session = await f.request('POST', importPath, 'test:owner', await exportSession(f.env.DB, 'session', 'test:member'));
  assert.equal(session.status, 200);
  assert.deepEqual(((await session.json()) as { imported: ImportSummary }).imported.format, 'session');
  assert.deepEqual(f.databases.imports[1]?.sessions.map(entry => entry.id), ['session']);

  // Other files, other workspaces' dumps and dumps holding another workspace's session are refused before connecting.
  const other = structuredClone(dump);
  other.workspace.id = 'other-workspace';
  const foreign = structuredClone(dump);
  foreign.sessions[0]!.session.workspaceId = 'other-workspace';
  for (const body of [{ format: 'pistead-backup' }, other, foreign, { ...dump, exportedAt: 'yesterday' }]) {
    const refused = await f.request('POST', importPath, 'test:owner', body);
    assert.equal(refused.status, 400);
    assert.equal(await code(refused), 'invalid_dump');
  }
  assert.equal(f.databases.imports.length, 2);

  f.databases.failure = new WorkspaceDatabaseError('schema_mismatch', { cause: new Error('column "data" of relation "pistead_sessions" does not exist at 10.0.0.7') });
  const failed = await f.request('POST', importPath, 'test:owner', dump);
  assert.equal(failed.status, 503);
  const failure = await failed.json() as { code: string; error: string };
  assert.equal(failure.code, 'workspace_database_unavailable');
  assert.match(failure.error, /README/);
  assert.ok(!failure.error.includes('10.0.0.7'));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.database.imported'").get()!.n, 2);
  delete f.env.WORKSPACE_DATABASES;
  const disabled = await f.request('POST', importPath, 'test:owner', dump);
  assert.equal(disabled.status, 503);
  assert.equal(await code(disabled), 'workspace_databases_disabled');
});

test('database settings are explicit fields, and hosts are checked once resolved', async () => {
  assert.deepEqual(databaseSettings({ host: ' DB.Example.COM ', database: 'pistead', user: 'app', password: 'p w' }), {
    host: 'db.example.com', port: 5432, database: 'pistead', user: 'app', password: 'p w', tls: 'verify-full', caCertificate: null,
  });
  assert.equal(databaseSettings({ host: '[2001:DB8::1]', database: 'd', user: 'u', password: 'p' }).host, '2001:db8::1');
  for (const input of [{ connectionString: 'postgres://u:p@db.example.com/d' }, { ...settings, host: 'db.example.com/pistead' },
    { ...settings, host: 'fe80::1%eth0' }, { ...settings, database: 'd'.repeat(64) }, { ...settings, user: 'a\nb' }, { ...settings, port: 70000 }]) {
    assert.throws(() => databaseSettings(input), HTTPException);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '64:ff9b::a00:1', 'not-an-address']) {
    assert.equal(publicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(publicAddress(address), true, address);
  const records: Record<string, string[]> = { 'public.example.com': ['8.8.8.8'], 'mixed.example.com': ['8.8.4.4', '10.0.0.5'] };
  const lookup = async (host: string) => {
    const addresses = records[host];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses;
  };
  assert.deepEqual(await resolveDatabaseHost('public.example.com', { privateHosts: false, lookup }), { address: '8.8.8.8', public: true });
  // One private record is enough to refuse a name: it could otherwise reach the server's own network.
  await assert.rejects(resolveDatabaseHost('mixed.example.com', { privateHosts: false, lookup }), failed('host_not_allowed'));
  await assert.rejects(resolveDatabaseHost('10.0.0.5', { privateHosts: false, lookup }), failed('host_not_allowed'));
  assert.deepEqual(await resolveDatabaseHost('mixed.example.com', { privateHosts: true, lookup }), { address: '8.8.4.4', public: true });
  assert.deepEqual(await resolveDatabaseHost('10.0.0.5', { privateHosts: true, lookup }), { address: '10.0.0.5', public: false });
  await assert.rejects(resolveDatabaseHost('missing.example.com', { privateHosts: true, lookup }), failed('host_not_found'));
});

test('the Postgres provider refuses private hosts and unencrypted public connections before connecting', async () => {
  const target: WorkspaceDatabaseTarget = { host: 'db.example.com', port: 5432, database: 'pistead', user: 'app', password: 'secret',
    tls: 'disable', caCertificate: null };
  let lookups = 0;
  const lookup = (addresses: string[]) => async () => { lookups++; return addresses; };
  await assert.rejects(new PostgresWorkspaceDatabases({ privateHosts: false, lookup: lookup(['10.1.2.3']) }).verify({ ...target, tls: 'verify-full' }),
    failed('host_not_allowed'));
  await assert.rejects(new PostgresWorkspaceDatabases({ privateHosts: true, lookup: lookup(['8.8.8.8']) }).verify(target), failed('tls_not_allowed'));
  await assert.rejects(new PostgresWorkspaceDatabases({ privateHosts: false }).save({ ...target, host: '127.0.0.1', tls: 'require' }, {
    workspace: { id: 'w', name: 'W', ownerId: 'o' },
    session: { id: 's', workspaceId: 'w', ownerId: 'o', title: 'T', status: 'ready', visibility: 'private', createdAt: '2026-01-01', record: {} },
    backup: { id: 'b', format: 'pi-runner-backup-v1', sha256: 'x', size: 1, createdAt: '2026-01-01' }, snapshot: new Uint8Array([1]),
  }), failed('host_not_allowed'));
  assert.equal(lookups, 2);
});

test('a server sending more than the response limit is cut off, and that is the failure whatever pg reports next', async () => {
  // pg's Connection reads its `stream`: the socket, then the TLS socket once the upgrade emits 'sslconnect'.
  const plain = new PassThrough();
  const connection = Object.assign(new EventEmitter(), { stream: plain });
  const client = { connection } as unknown as pg.Client;
  limitResponses(client, 10);
  plain.write(Buffer.alloc(6));
  await new Promise(resolve => setImmediate(resolve));
  const secure = new PassThrough();
  connection.stream = secure;
  connection.emit('sslconnect');
  // pg no longer reads the raw socket after the upgrade, so its bytes don't count twice.
  plain.write(Buffer.alloc(100));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plain.destroyed, false);
  const cutOff = once(secure, 'error');
  secure.write(Buffer.alloc(5));
  const [error] = await cutOff as [unknown];
  assert.ok(error instanceof WorkspaceDatabaseError);
  assert.equal(error.failure, 'response_too_large');
  // pg reports the dropped connection with an error of its own, without a cause.
  assert.equal(classify(new Error('Connection terminated unexpectedly'), client).failure, 'response_too_large');
  assert.equal(classify(new Error('Connection terminated unexpectedly')).failure, 'unreachable');
  // A failure of ours wrapped in another error keeps its meaning.
  assert.equal(classify(new Error('wrapped', { cause: new WorkspaceDatabaseError('pistead_database') })).failure, 'pistead_database');
});

const postgresUrl = process.env.TEST_DATABASE_URL;

test('the Postgres provider provisions, saves and reads back snapshots in a real database', {
  skip: postgresUrl ? false : 'TEST_DATABASE_URL is not set; skipping the workspace database run against Postgres',
}, async t => {
  const server = new URL(postgresUrl!);
  // A database of its own: other suites reset the public schema of the shared test database.
  const name = `pistead_workspace_test_${randomUUID().replaceAll('-', '')}`;
  const role = `pistead_limited_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const inside = new URL(server.href);
  inside.pathname = `/${name}`;
  const inspect = new pg.Client({ connectionString: inside.href });
  t.after(async () => {
    await inspect.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  });
  await inspect.connect();
  const target: WorkspaceDatabaseTarget = { host: server.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(server.port || 5432), database: name,
    user: decodeURIComponent(server.username), password: decodeURIComponent(server.password), tls: 'disable', caCertificate: null };
  const provider = new PostgresWorkspaceDatabases({ privateHosts: true });
  await provider.verify(target);
  await provider.verify(target);
  const tables = await inspect.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'pistead_%'`);
  assert.deepEqual(tables.rows.map(row => row.table_name).sort(), ['pistead_audit', 'pistead_session_backups', 'pistead_sessions', 'pistead_workspaces']);

  const snapshot = new TextEncoder().encode(JSON.stringify({ format: 'pi-runner-backup-v1', note: 'héllo ✓' }));
  const save: WorkspaceBackupSave = {
    workspace: { id: 'workspace', name: 'Workspace', ownerId: 'owner' },
    session: { id: 'session', workspaceId: 'workspace', ownerId: 'member', title: 'Session', status: 'ready', visibility: 'private',
      createdAt: '2026-01-01T00:00:00.000Z', record: { id: 'session', title: 'Session' } },
    backup: { id: 'backup', format: 'pi-runner-backup-v1', sha256: 'digest', size: snapshot.byteLength, createdAt: '2026-01-02T00:00:00.000Z' },
    snapshot,
  };
  await provider.save(target, save);
  await provider.save(target, { ...save, session: { ...save.session, title: 'Renamed', record: { id: 'session', title: 'Renamed' } },
    backup: { ...save.backup, id: 'second', createdAt: '2026-01-03T00:00:00.000Z' } });
  const loaded = await provider.load(target, { id: 'backup', sessionId: 'session', size: snapshot.byteLength });
  assert.ok(loaded);
  assert.deepEqual(Buffer.from(loaded), Buffer.from(snapshot));
  assert.equal(await provider.load(target, { id: 'backup', sessionId: 'session', size: snapshot.byteLength + 1 }), null);
  assert.equal(await provider.load(target, { id: 'backup', sessionId: 'other', size: snapshot.byteLength }), null);
  assert.equal(await provider.load(target, { id: 'missing', sessionId: 'session', size: snapshot.byteLength }), null);
  const sessions = await inspect.query('SELECT id, title, record FROM pistead_sessions');
  assert.deepEqual(sessions.rows, [{ id: 'session', title: 'Renamed', record: { id: 'session', title: 'Renamed' } }]);
  const backups = await inspect.query("SELECT id, (convert_from(snapshot, 'UTF8')::jsonb ->> 'note') AS note FROM pistead_session_backups ORDER BY id");
  assert.deepEqual(backups.rows, [{ id: 'backup', note: 'héllo ✓' }, { id: 'second', note: 'héllo ✓' }]);

  // Imports: a record or detail replaces only an older one; activity entries are added once.
  const imported: WorkspaceImport = {
    workspace: { id: 'workspace', name: 'Workspace', ownerId: 'owner' },
    exportedAt: '2026-01-05T00:00:00.000Z',
    workspaceData: { members: [{ userId: 'owner', role: 'owner' }] },
    sessions: [
      { id: 'session', ownerId: 'member', title: 'Imported title', status: 'ready', visibility: 'private', createdAt: '2026-01-01T00:00:00.000Z',
        record: { id: 'session', title: 'Imported title' }, data: { grants: [{ userId: 'owner', permissions: ['read'] }] } },
      { id: 'viewed', ownerId: 'member', title: 'Viewed', status: 'archived', visibility: 'workspace', createdAt: '2026-01-04T00:00:00.000Z',
        record: { id: 'viewed' }, data: null },
    ],
    audit: [
      { id: 'audit-session', sessionId: 'session', actorId: 'owner', action: 'session.created', detail: { note: 'héllo ✓' }, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'audit-workspace', sessionId: null, actorId: null, action: 'workspace.create', detail: {}, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  await provider.import(target, imported);
  await provider.import(target, imported);
  const stale = structuredClone(imported);
  stale.exportedAt = '2026-01-02T00:00:00.000Z';
  stale.sessions[0]!.title = 'Stale title';
  stale.sessions[0]!.data = { grants: [] };
  stale.workspaceData = { members: [] };
  await provider.import(target, stale);
  const sessionsAfterImport = await inspect.query<{ id: string; title: string; data: unknown; data_exported_at: Date | null }>(
    'SELECT id, title, data, data_exported_at FROM pistead_sessions ORDER BY id');
  assert.deepEqual(sessionsAfterImport.rows.map(row => [row.id, row.title, row.data, row.data_exported_at?.toISOString() ?? null]), [
    ['session', 'Imported title', { grants: [{ userId: 'owner', permissions: ['read'] }] }, '2026-01-05T00:00:00.000Z'],
    ['viewed', 'Viewed', null, null],
  ]);
  const activity = await inspect.query('SELECT id, workspace_id, session_id, actor_id, detail FROM pistead_audit ORDER BY id');
  assert.deepEqual(activity.rows, [
    { id: 'audit-session', workspace_id: 'workspace', session_id: 'session', actor_id: 'owner', detail: { note: 'héllo ✓' } },
    { id: 'audit-workspace', workspace_id: 'workspace', session_id: null, actor_id: null, detail: {} },
  ]);
  const workspaceRows = await inspect.query('SELECT name, owner_id, data FROM pistead_workspaces');
  assert.deepEqual(workspaceRows.rows, [{ name: 'Workspace', owner_id: 'owner', data: { members: [{ userId: 'owner', role: 'owner' }] } }]);
  // A later save updates the record and keeps the imported details.
  await provider.save(target, { ...save, session: { ...save.session, title: 'Saved later', record: { id: 'session', title: 'Saved later' } },
    backup: { ...save.backup, id: 'third', createdAt: '2026-01-06T00:00:00.000Z' } });
  const saved = await inspect.query<{ title: string; data: unknown }>("SELECT title, data FROM pistead_sessions WHERE id = 'session'");
  assert.deepEqual(saved.rows, [{ title: 'Saved later', data: { grants: [{ userId: 'owner', permissions: ['read'] }] } }]);

  // A user that may connect but was granted nothing on the tables is refused until the owner grants what saving needs.
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'limited-password'`);
  const limited = { ...target, user: role, password: 'limited-password' };
  await assert.rejects(provider.verify(limited), failed('permission_denied'));
  await inspect.query(`GRANT SELECT, INSERT, UPDATE ON pistead_workspaces, pistead_sessions, pistead_session_backups, pistead_audit TO ${role}`);
  await provider.verify(limited);
  await provider.import(limited, imported);

  await assert.rejects(provider.verify({ ...target, database: `${name}_missing` }), failed('database_not_found'));
  await assert.rejects(new PostgresWorkspaceDatabases({ privateHosts: false }).verify(target), failed('host_not_allowed'));
  // Tables created beforehand must have every column Pistead writes.
  await inspect.query('ALTER TABLE pistead_audit DROP COLUMN detail');
  await assert.rejects(provider.verify(target), failed('schema_mismatch'));
  await assert.rejects(provider.import(target, imported), failed('schema_mismatch'));
  // A Pistead control plane's own database is never used as a workspace database.
  await inspect.query('CREATE TABLE workspace_databases (id TEXT); CREATE TABLE schema_migrations (name TEXT); CREATE TABLE auth_sessions (token_hash TEXT)');
  await assert.rejects(provider.verify(target), failed('pistead_database'));
});
