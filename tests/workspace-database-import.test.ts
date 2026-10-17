import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Env } from '../apps/server/src/types.js';
import { exportSession, exportWorkspace } from '../apps/server/src/data-export.js';
import { encryptToken } from '../apps/server/src/vault.js';
import { DumpImportError, dumpWorkspaceId, importDumpFromCommandLine, importFromDump } from '../apps/server/src/workspace-databases/import.js';
import { databaseSecretContext } from '../apps/server/src/workspace-databases/store.js';
import type { WorkspaceDatabaseProvider, WorkspaceDatabaseTarget, WorkspaceImport } from '../apps/server/src/workspace-databases/types.js';
import { testDatabase } from './helpers/control-plane.js';

const workspace = { id: 'workspace', name: 'Workspace', ownerId: 'test:owner' };
const vaultKey = Buffer.alloc(32, 5).toString('base64url');
const password = 'import-database-password-not-for-deployment';

function sessionRecord(id: string, extra: Record<string, unknown> = {}) {
  return { id, workspaceId: 'workspace', ownerId: 'test:owner', agentVersionId: 'version', title: `Title ${id}`, visibility: 'workspace',
    policyVersion: 1, status: 'ready', createdAt: '2026-01-01', repositories: [], ...extra };
}

function sessionDump(extra: Record<string, unknown> = {}) {
  return { format: 'pistead-session-export-v1', exportedAt: '2026-02-01T10:00:00.000Z', exportedBy: 'test:owner',
    session: { ...sessionRecord('one'), archivedStatus: null }, grants: [{ userId: 'test:member', permissions: ['read'], createdAt: '2026-01-01' }],
    toolGrants: [], backups: [{ id: 'backup', size: 10, sha256: 's'.repeat(43), createdAt: '2026-01-02', location: 'server' }], restores: [],
    approvals: [{ approvalId: 'approval', requestedBy: 'test:owner', source: 'explicit', operation: { kind: 'bash', command: 'ls' }, createdAt: '2026-01-01' }],
    pushes: [], audit: [{ id: 'audit-1', actorId: 'test:owner', action: 'session.created', detail: { agentVersionId: 'version' }, createdAt: '2026-01-01' }],
    ...extra };
}

function workspaceDump(extra: Record<string, unknown> = {}) {
  const full = sessionDump();
  return { format: 'pistead-workspace-export-v1', exportedAt: '2026-02-01T10:00:00.000Z', exportedBy: null,
    workspace: { id: 'workspace', name: 'Workspace', ownerId: 'test:owner', createdAt: '2026-01-01' },
    members: [{ userId: 'test:owner', displayName: 'Owner', githubLogin: null, role: 'owner', createdAt: '2026-01-01' }], models: [], agents: [],
    repositories: [], pushIdentities: [], database: { id: 'database', host: 'db.example.com' },
    audit: [{ id: 'audit-workspace', actorId: null, action: 'workspace.create', detail: {}, createdAt: '2026-01-01' }],
    sessions: [{ session: full.session, grants: full.grants, toolGrants: [], backups: full.backups, restores: [], approvals: full.approvals,
      pushes: [], audit: full.audit }],
    otherSessions: [{ ...sessionRecord('two', { ownerId: 'test:member' }), permissions: ['read'] }],
    ...extra };
}

function refused(pattern: RegExp) {
  return (error: unknown) => error instanceof DumpImportError && pattern.test(error.message);
}

test('a session dump becomes one session with its details and activity', () => {
  const data = importFromDump(sessionDump(), workspace);
  assert.equal(data.exportedAt, '2026-02-01T10:00:00.000Z');
  assert.equal(data.workspaceData, null);
  assert.deepEqual(data.workspace, workspace);
  assert.equal(data.sessions.length, 1);
  const [session] = data.sessions;
  assert.ok(session);
  assert.deepEqual({ ...session, record: undefined, data: undefined }, { id: 'one', ownerId: 'test:owner', title: 'Title one', status: 'ready',
    visibility: 'workspace', createdAt: '2026-01-01T00:00:00.000Z', record: undefined, data: undefined });
  assert.equal(session.record.archivedStatus, null);
  assert.deepEqual(Object.keys(session.data ?? {}).sort(), ['approvals', 'backups', 'grants', 'pushes', 'restores', 'toolGrants']);
  assert.deepEqual(data.audit, [{ id: 'audit-1', sessionId: 'one', actorId: 'test:owner', action: 'session.created',
    detail: { agentVersionId: 'version' }, createdAt: '2026-01-01T00:00:00.000Z' }]);
});

test('a workspace dump brings its settings, full sessions, viewed records and workspace activity', () => {
  const data = importFromDump(workspaceDump(), workspace);
  assert.deepEqual(Object.keys(data.workspaceData ?? {}).sort(), ['agents', 'database', 'members', 'models', 'pushIdentities', 'repositories']);
  assert.deepEqual(data.sessions.map(session => [session.id, session.data === null]), [['one', false], ['two', true]]);
  // The exporter's permissions describe the exporter, not the session.
  assert.equal('permissions' in data.sessions[1]!.record, false);
  assert.equal(data.sessions[1]!.ownerId, 'test:member');
  assert.deepEqual(data.audit.map(entry => [entry.id, entry.sessionId, entry.actorId]), [['audit-1', 'one', 'test:owner'], ['audit-workspace', null, null]]);
});

test('dumps are checked before anything is written', () => {
  assert.throws(() => importFromDump({ format: 'pi-runner-backup-v1' }, workspace), refused(/not a Pistead dump/));
  assert.throws(() => importFromDump([], workspace), refused(/not an object/));
  assert.throws(() => importFromDump(workspaceDump({ workspace: { id: 'other' } }), workspace), refused(/another workspace/));
  assert.throws(() => importFromDump(sessionDump({ session: sessionRecord('one', { workspaceId: 'other' }) }), workspace), refused(/another workspace/));
  const foreign = workspaceDump({ otherSessions: [sessionRecord('two', { workspaceId: 'other' })] });
  assert.throws(() => importFromDump(foreign, workspace), refused(/session of another workspace/));
  assert.throws(() => importFromDump(workspaceDump({ otherSessions: [sessionRecord('one')] }), workspace), refused(/session one twice/));
  for (const session of [sessionRecord('one', { id: '../one' }), sessionRecord('one', { title: '' }), sessionRecord('one', { createdAt: 'soon' }),
    sessionRecord('one', { ownerId: 7 }), sessionRecord('one', { createdAt: '1969-12-31T23:59:59Z' })]) {
    assert.throws(() => importFromDump(sessionDump({ session }), workspace), refused(/invalid session/));
  }
  assert.throws(() => importFromDump(sessionDump({ exportedAt: 'later' }), workspace), refused(/invalid export time/));
  assert.throws(() => importFromDump(sessionDump({ grants: {} }), workspace), refused(/not a list/));
  // Workspace settings are kept as they are, but only as lists of objects.
  assert.throws(() => importFromDump(workspaceDump({ members: ['test:owner'] }), workspace), refused(/members are not all objects/));
  assert.throws(() => importFromDump(workspaceDump({ pushIdentities: [[]] }), workspace), refused(/push identities are not all objects/));
  assert.throws(() => importFromDump(workspaceDump({ database: 'db.example.com' }), workspace), refused(/database connection is not an object/));
  assert.equal(importFromDump(workspaceDump({ database: null }), workspace).workspaceData?.database, null);
  assert.throws(() => importFromDump(sessionDump({ audit: [{ id: 'a', action: 'x', createdAt: 'never' }] }), workspace), refused(/invalid activity time/));
  let deep: unknown = 'bottom';
  for (let level = 0; level < 100; level++) deep = [deep];
  assert.throws(() => importFromDump(sessionDump({ approvals: [deep] }), workspace), refused(/nested too deeply/));
});

test('what Postgres cannot store is replaced, keys stay data, and repeated activity is written once', () => {
  const tricky = JSON.parse('{"__proto__": {"polluted": true}, "note": "a\\u0000b"}') as unknown;
  const data = importFromDump(sessionDump({
    session: { ...sessionRecord('one', { title: 'Nul\u0000title' }), archivedStatus: null },
    approvals: [tricky],
    audit: [
      { id: 'audit-1', actorId: null, action: 'session.created', detail: null, createdAt: '2026-01-01' },
      { id: 'audit-1', actorId: null, action: 'session.created', detail: null, createdAt: '2026-01-01' },
    ],
  }), workspace);
  const [session] = data.sessions;
  assert.equal(session?.title, 'Nul\uFFFDtitle');
  const approval = (session?.data?.approvals as Record<string, unknown>[])[0]!;
  assert.equal(approval.note, 'a\uFFFDb');
  assert.ok(Object.hasOwn(approval, '__proto__'), 'A "__proto__" key is kept as data');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.ok(!JSON.stringify(data).includes('\\u0000'));
  assert.deepEqual(data.audit.map(entry => [entry.id, entry.detail]), [['audit-1', {}]]);
});

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  sqlite.exec(`
    INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES
      ('test:owner','Owner','Owner','owner@example.test','{}','test','2026-01-01'),
      ('test:member','Member','Member','member@example.test','{}','test','2026-01-01');
    INSERT INTO workspaces VALUES ('workspace','Workspace','test:owner','2026-01-01'), ('empty','Empty','test:owner','2026-01-01');
    INSERT INTO workspace_members VALUES ('workspace','test:owner','owner','2026-01-01'),('workspace','test:member','member','2026-01-02'),
      ('empty','test:owner','owner','2026-01-01');
    INSERT INTO models (id,workspace_id,name,provider,model_id,created_at) VALUES ('model','workspace','Model','faux','faux-v1','2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent','test:owner','2026-01-01');
    INSERT INTO agent_versions VALUES ('version','agent','test:owner','workspace',1,'Agent','','','["read_file"]','model','2026-01-01');
    INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,visibility) VALUES
      ('owner-session','workspace','test:owner','version','Owner session',1,'ready','2026-01-01','workspace'),
      ('member-session','workspace','test:member','version','Member session',1,'ready','2026-01-02','private');
    INSERT INTO audit (id,workspace_id,session_id,actor_id,action,detail_json,created_at) VALUES
      ('created','workspace','owner-session','test:owner','session.created','{}','2026-01-01'),
      ('workspace','workspace',NULL,'test:owner','workspace.create','{}','2026-01-01');
  `);
  const env = { DB: db, APP_ORIGIN: 'http://localhost:8787', VAULT_KEY: vaultKey } as Env;
  sqlite.prepare(`INSERT INTO workspace_databases (id,workspace_id,host,port,database_name,username,tls,ca_certificate,password_ciphertext,created_by,created_at,updated_at)
    VALUES ('database','workspace','db.example.com',5432,'pistead','pistead_app','verify-full',NULL,?,'test:owner','2026-01-01','2026-01-01')`)
    .run(await encryptToken(env, databaseSecretContext('database'), password));
  const imports: { target: WorkspaceDatabaseTarget; data: WorkspaceImport }[] = [];
  const provider: WorkspaceDatabaseProvider = {
    privateHosts: false,
    async verify() {},
    async save() {},
    async load() { return null; },
    async import(target, data) { imports.push({ target, data }); },
  };
  return { db, sqlite, provider, imports };
}

test('our own exports import as they are', async t => {
  const f = await fixture(t);
  const dump = await exportWorkspace(f.db, 'workspace', null);
  const data = importFromDump(dump, workspace);
  assert.deepEqual(data.sessions.map(session => [session.id, session.data === null]), [['owner-session', false], ['member-session', false]]);
  assert.deepEqual(data.audit.map(entry => entry.id).sort(), ['created', 'workspace']);
  const session = importFromDump(await exportSession(f.db, 'owner-session', 'test:owner'), workspace);
  assert.deepEqual(session.sessions.map(entry => entry.id), ['owner-session']);
  assert.equal(dumpWorkspaceId(dump), 'workspace');
});

test('the operator imports a dump into the database of the workspace it names', async t => {
  const f = await fixture(t);
  const dump = await exportWorkspace(f.db, 'workspace', null);
  const { summary, database } = await importDumpFromCommandLine(f.db, { VAULT_KEY: vaultKey }, dump, f.provider);
  assert.equal(database.id, 'database');
  assert.deepEqual(summary, { format: 'workspace', exportedAt: dump!.exportedAt, sessions: 2, sessionDetails: 2, auditEntries: 2, workspaceSettings: true });
  assert.equal(f.imports.length, 1);
  assert.deepEqual({ ...f.imports[0]!.target }, { host: 'db.example.com', port: 5432, database: 'pistead', user: 'pistead_app', password,
    tls: 'verify-full', caCertificate: null });
  const audit = f.sqlite.prepare("SELECT actor_id, workspace_id FROM audit WHERE action = 'workspace.database.imported'").get()!;
  assert.deepEqual({ ...audit }, { actor_id: null, workspace_id: 'workspace' });

  const elsewhere = { ...dump!, workspace: { ...dump!.workspace, id: 'empty' } };
  await assert.rejects(importDumpFromCommandLine(f.db, { VAULT_KEY: vaultKey }, elsewhere, f.provider), refused(/no database connected/));
  const missing = { ...dump!, workspace: { ...dump!.workspace, id: 'missing' } };
  await assert.rejects(importDumpFromCommandLine(f.db, { VAULT_KEY: vaultKey }, missing, f.provider), refused(/not on this server/));
  await assert.rejects(importDumpFromCommandLine(f.db, { VAULT_KEY: vaultKey }, dump), refused(/turned off/));
  await assert.rejects(importDumpFromCommandLine(f.db, { VAULT_KEY: Buffer.alloc(32, 6).toString('base64url') }, dump, f.provider), refused(/VAULT_KEY/));
  await assert.rejects(importDumpFromCommandLine(f.db, { VAULT_KEY: vaultKey }, { format: 'unknown' }, f.provider), refused(/not a Pistead dump/));
  assert.equal(f.imports.length, 1);
});
