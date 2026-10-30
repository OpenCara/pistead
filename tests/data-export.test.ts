import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import type { Env, WorkerEnv } from '../apps/server/src/types.js';
import { exportSession, exportWorkspace, registerDataExports, type SessionExport, type WorkspaceExport } from '../apps/server/src/data-export.js';
import { testDatabase } from './helpers/control-plane.js';

// Values that must never leave the database in any export: credentials, credential digests, ciphertexts, personal
// environment (also inside restore bindings), storage keys, and the data of other members' sessions.
const secrets = ['REVOCATION-CIPHERTEXT', 'BROKER-TOKEN-HASH', 'DATABASE-PASSWORD-CIPHERTEXT', 'IDENTITY-SECRET-CIPHERTEXT',
  'PERSONAL-ENVIRONMENT-VALUE', 'OBJECT-KEY-SERVER', 'OBJECT-KEY-DATABASE', 'D'.repeat(43), 'GITHUB-TOKEN-CIPHERTEXT'];
const memberPrivate = 'MEMBER PRIVATE TITLE';
const memberPrivateActivity = 'MEMBER PRIVATE ACTIVITY';

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: 'http://localhost:8787', TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: 'data-export-auth-secret-not-for-deployment', TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString() };
  sqlite.exec(`
    INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES
      ('test:owner','Owner','Owner','owner@example.test','{"TOKEN":"PERSONAL-ENVIRONMENT-VALUE"}','test','2026-01-01'),
      ('test:admin','Admin','Admin','admin@example.test','{}','test','2026-01-01'),
      ('test:member','Member','Member','member@example.test','{}','test','2026-01-01'),
      ('test:outsider','Outsider','Outsider','outsider@example.test','{}','test','2026-01-01');
    INSERT INTO github_tokens VALUES ('test:owner','GITHUB-TOKEN-CIPHERTEXT','2026-01-01');
    INSERT INTO workspaces VALUES ('workspace','Workspace','test:owner','2026-01-01'), ('other','Other','test:outsider','2026-01-01');
    INSERT INTO workspace_members VALUES ('workspace','test:owner','owner','2026-01-01'),
      ('workspace','test:admin','admin','2026-01-02'),('workspace','test:member','member','2026-01-03'),
      ('other','test:outsider','owner','2026-01-01');
    INSERT INTO models (id,workspace_id,name,provider,model_id,created_at) VALUES ('model','workspace','Model','faux','faux-v1','2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent','test:owner','2026-01-01');
    INSERT INTO agent_versions VALUES ('version','agent','test:owner','workspace',1,'Agent','Description','Instructions','["read_file"]','model','2026-01-01');
    INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,policy_version,status,created_at,visibility) VALUES
      ('owner-private','workspace','test:owner','version','Owner private',1,'ready','2026-01-01','private'),
      ('owner-shared','workspace','test:owner','version','Owner shared',1,'ready','2026-01-02','workspace'),
      ('owner-restored','workspace','test:owner','version','Owner restored',1,'provisioning','2026-01-03','private'),
      ('member-private','workspace','test:member','version','${memberPrivate}',1,'ready','2026-01-04','private'),
      ('member-shared','workspace','test:member','version','Member shared',1,'ready','2026-01-05','workspace'),
      ('member-granted','workspace','test:member','version','Member granted',1,'ready','2026-01-06','private');
    INSERT INTO session_grants VALUES ('owner-private','test:admin','["read"]','2026-01-01'),
      ('member-granted','test:owner','["read","ask"]','2026-01-06');
    INSERT INTO session_tool_grants VALUES ('owner-private','bash','','approval-1','test:owner','2026-01-01');
    INSERT INTO backups (id,session_id,owner_id,object_key,sha256,size,created_at) VALUES ('backup-server','owner-private','test:owner','OBJECT-KEY-SERVER','${'s'.repeat(43)}',10,'2026-01-02'),
      ('backup-database','owner-private','test:owner','OBJECT-KEY-DATABASE','${'t'.repeat(43)}',20,'2026-01-03');
    INSERT INTO workspace_database_backups VALUES ('backup-database','workspace','2026-01-03');
    INSERT INTO restore_jobs (id,request_id,owner_id,workspace_id,source_session_id,backup_id,target_session_id,request_title,sha256,size,
      binding_json,download_token_hash,download_expires_at,created_at)
      VALUES ('restore','request','test:owner','workspace','owner-private','backup-server','owner-restored','Restored','${'s'.repeat(43)}',10,
        '{"owner":{"env":{"TOKEN":"PERSONAL-ENVIRONMENT-VALUE"}}}','${'D'.repeat(43)}',1,'2026-01-03');
    INSERT INTO approval_reviews (session_id,approval_id,requested_by,source,admission_id,operation_json,review_hash,created_at)
      VALUES ('owner-private','approval-1','test:owner','explicit',NULL,'{"kind":"bash","command":"ls"}','${'r'.repeat(43)}','2026-01-01');
    INSERT INTO broker_capabilities VALUES ('BROKER-TOKEN-HASH','owner-private','approval-1','test:owner','test:owner','operation',1,NULL,'2026-01-01');
    INSERT INTO push_credentials (id,session_id,approval_id,requested_by,identity_id,kind,binding_id,operation_json,automatic,admission_id,
      revocation_ciphertext,expires_at,created_at,completed_at,outcome,tip,pull_request_url)
      VALUES ('push','owner-private','approval-2','test:owner',NULL,'github-app','binding','{"kind":"git.push","branch":"feature"}',0,NULL,
        'REVOCATION-CIPHERTEXT',1,'2026-01-02','2026-01-02','pushed','${'a'.repeat(40)}','https://github.com/owner/project/pull/1');
    INSERT INTO workspace_repositories (id,workspace_id,repository_id,full_name,ref,private,created_at)
      VALUES ('binding','workspace','123','Owner/Project','main',1,'2026-01-01');
    INSERT INTO push_identities (id,workspace_id,provider,host,scope,kind,config_json,secret_ciphertext,status,created_by,created_at,updated_at)
      VALUES ('identity','workspace','github','github.com','','github-app','{"appId":"1","slug":"app"}','IDENTITY-SECRET-CIPHERTEXT','ready',
        'test:owner','2026-01-01','2026-01-01');
    INSERT INTO workspace_databases (id,workspace_id,host,port,database_name,username,tls,ca_certificate,password_ciphertext,created_by,created_at,updated_at)
      VALUES ('database','workspace','db.example.com',5432,'pistead','pistead_app','verify-full',NULL,'DATABASE-PASSWORD-CIPHERTEXT','test:owner',
        '2026-01-01','2026-01-01');
    INSERT INTO audit (id,workspace_id,session_id,actor_id,action,detail_json,created_at) VALUES
      ('audit-session','workspace','owner-private','test:owner','session.created','{"agentVersionId":"version"}','2026-01-01'),
      ('audit-workspace','workspace',NULL,'test:owner','workspace.create','{}','2026-01-01'),
      ('audit-private','workspace','member-private','test:member','session.created','{"note":"${memberPrivateActivity}"}','2026-01-04'),
      ('audit-other','other',NULL,'test:outsider','workspace.create','{}','2026-01-01');
  `);
  const app = new Hono<WorkerEnv>();
  // Cookie/CSRF are covered by control-plane tests; this seam supplies an authenticated actor.
  app.use('/api/*', async (c, next) => {
    c.set('auth', { userId: c.req.header('x-test-user') ?? 'test:owner', tokenHash: 'test', csrfToken: 'test', client: 'browser' });
    await next();
  });
  registerDataExports(app);
  const get = (path: string, user: string) => app.request(path, { headers: { 'x-test-user': user } }, env);
  return { sqlite, env, get };
}

function assertNoSecrets(text: string): void {
  for (const secret of secrets) assert.ok(!text.includes(secret), `An export must not contain ${secret}`);
  assert.ok(!text.includes(memberPrivateActivity), "An export must not contain the data of another member's session, only its record");
}

test('a session export is its owner\'s, archived sessions included, with every record and no secrets', async t => {
  const f = await fixture(t);
  const response = await f.get('/api/sessions/owner-private/export', 'test:owner');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="pistead-session-owner-private.json"');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const text = await response.text();
  for (const secret of secrets) assert.ok(!text.includes(secret), `A session export must not contain ${secret}`);
  const exported = JSON.parse(text) as SessionExport;
  assert.equal(exported.format, 'pistead-session-export-v1');
  assert.equal(exported.exportedBy, 'test:owner');
  assert.equal(exported.session.id, 'owner-private');
  assert.equal(exported.session.title, 'Owner private');
  assert.equal(exported.session.archivedStatus, null);
  assert.deepEqual(exported.grants, [{ userId: 'test:admin', permissions: ['read'], createdAt: '2026-01-01' }]);
  assert.deepEqual(exported.toolGrants, [{ tool: 'bash', callId: '', approvalId: 'approval-1', grantedBy: 'test:owner', createdAt: '2026-01-01' }]);
  assert.deepEqual(exported.backups.map(backup => [backup.id, backup.location, backup.size]),
    [['backup-server', 'server', 10], ['backup-database', 'workspace-database', 20]]);
  assert.deepEqual(exported.restores, [{ id: 'restore', sourceSessionId: 'owner-private', backupId: 'backup-server',
    targetSessionId: 'owner-restored', title: 'Restored', status: 'pending', createdAt: '2026-01-03', completedAt: null }]);
  assert.deepEqual(exported.approvals, [{ approvalId: 'approval-1', requestedBy: 'test:owner', source: 'explicit',
    operation: { kind: 'bash', command: 'ls' }, createdAt: '2026-01-01' }]);
  assert.equal(exported.pushes.length, 1);
  assert.equal(exported.pushes[0]!.automatic, false);
  assert.equal(exported.pushes[0]!.outcome, 'pushed');
  assert.deepEqual(exported.pushes[0]!.operation, { kind: 'git.push', branch: 'feature' });
  assert.deepEqual(exported.audit.map(event => event.id), ['audit-session']);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.exported' AND session_id = 'owner-private'").get()!.n, 1);
  // The restore target lists the same receipt.
  const restored = await (await f.get('/api/sessions/owner-restored/export', 'test:owner')).json() as SessionExport;
  assert.deepEqual(restored.restores.map(restore => restore.id), ['restore']);

  // Read access is not ownership; without access the session doesn't exist.
  const granted = await f.get('/api/sessions/owner-private/export', 'test:admin');
  assert.equal(granted.status, 403);
  assert.equal((await granted.json() as { code: string }).code, 'owner_required');
  assert.equal((await f.get('/api/sessions/owner-private/export', 'test:member')).status, 404);
  assert.equal((await f.get('/api/sessions/owner-private/export', 'test:outsider')).status, 404);
  assert.equal((await f.get('/api/sessions/member-granted/export', 'test:owner')).status, 403);

  f.sqlite.exec("UPDATE sessions SET archived_status = status, status = 'archived' WHERE id = 'owner-shared'");
  const archived = await f.get('/api/sessions/owner-shared/export', 'test:owner');
  assert.equal(archived.status, 200);
  const archivedExport = await archived.json() as SessionExport;
  assert.equal(archivedExport.session.status, 'archived');
  assert.equal(archivedExport.session.archivedStatus, 'ready');
});

test('a workspace export covers its settings, the exporter\'s own sessions in full and only the records of the other sessions, which they manage', async t => {
  const f = await fixture(t);
  const denied = await f.get('/api/workspaces/workspace/export', 'test:member');
  assert.equal(denied.status, 403);
  assert.equal((await f.get('/api/workspaces/workspace/export', 'test:outsider')).status, 404);
  const response = await f.get('/api/workspaces/workspace/export', 'test:owner');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="pistead-workspace-workspace.json"');
  const text = await response.text();
  assertNoSecrets(text);
  const exported = JSON.parse(text) as WorkspaceExport;
  assert.equal(exported.format, 'pistead-workspace-export-v1');
  assert.equal(exported.exportedBy, 'test:owner');
  assert.deepEqual(exported.workspace, { id: 'workspace', name: 'Workspace', ownerId: 'test:owner', createdAt: '2026-01-01' });
  assert.deepEqual(exported.members, [
    { userId: 'test:owner', displayName: 'Owner', githubLogin: null, role: 'owner', createdAt: '2026-01-01' },
    { userId: 'test:admin', displayName: 'Admin', githubLogin: null, role: 'admin', createdAt: '2026-01-02' },
    { userId: 'test:member', displayName: 'Member', githubLogin: null, role: 'member', createdAt: '2026-01-03' },
  ]);
  assert.deepEqual(exported.models.map(model => [model.id, model.available]), [['model', true]]);
  assert.deepEqual(exported.agents.map(agent => agent.id), ['version']);
  assert.deepEqual(exported.repositories.map(repository => repository.fullName), ['Owner/Project']);
  assert.deepEqual(exported.pushIdentities.map(identity => [identity.id, identity.config]), [['identity', { appId: '1', slug: 'app' }]]);
  assert.equal(exported.database?.host, 'db.example.com');
  assert.equal(exported.database?.user, 'pistead_app');
  // Only workspace events: session events are in each session, and other workspaces' are never included.
  assert.deepEqual(exported.audit.map(event => event.id), ['audit-workspace']);
  assert.deepEqual(exported.sessions.map(session => session.session.id), ['owner-private', 'owner-shared', 'owner-restored']);
  assert.deepEqual(exported.sessions[0]!.backups.map(backup => backup.location), ['server', 'workspace-database']);
  // The workspace's owner manages every session there, private ones included, so every other member's session comes
  // as its record, with what they hold on it; its activity, grants and approvals stay in its owner's own export.
  const managed = ['read', 'ask', 'write', 'manage'];
  assert.deepEqual(exported.otherSessions.map(session => [session.id, session.permissions]),
    [['member-private', managed], ['member-shared', managed], ['member-granted', managed]]);
  assert.equal(exported.otherSessions[0]!.title, memberPrivate);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.exported'").get()!.n, 1);

  // An admin gets the same settings; every session is someone else's, so they come as records only, with what the
  // admin holds on each: what managing it gives, and what a grant adds.
  const admin = await f.get('/api/workspaces/workspace/export', 'test:admin');
  assert.equal(admin.status, 200);
  const adminText = await admin.text();
  assertNoSecrets(adminText);
  const adminExport = JSON.parse(adminText) as WorkspaceExport;
  assert.deepEqual(adminExport.sessions, []);
  assert.deepEqual(adminExport.otherSessions.map(session => [session.id, session.permissions]),
    [['owner-private', managed], ['owner-shared', managed], ['owner-restored', managed], ['member-private', managed], ['member-shared', managed],
      ['member-granted', managed]]);
});

test('the operator dump holds every session of the workspace in full, still without secrets', async t => {
  const f = await fixture(t);
  const dump = await exportWorkspace(f.env.DB, 'workspace', null);
  assert.ok(dump);
  assert.equal(dump.exportedBy, null);
  assert.deepEqual(dump.sessions.map(session => session.session.id),
    ['owner-private', 'owner-shared', 'owner-restored', 'member-private', 'member-shared', 'member-granted']);
  assert.deepEqual(dump.otherSessions, []);
  const text = JSON.stringify(dump);
  for (const secret of secrets) assert.ok(!text.includes(secret), `A dump must not contain ${secret}`);
  const session = await exportSession(f.env.DB, 'member-private', null);
  assert.ok(session);
  assert.equal(session.session.title, memberPrivate);
  assert.deepEqual(session.audit.map(event => event.id), ['audit-private']);
  assert.equal(await exportSession(f.env.DB, 'missing', null), null);
  assert.equal(await exportWorkspace(f.env.DB, 'missing', null), null);
  // Dumps read only: nothing is recorded in the audit log.
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE '%.exported'").get()!.n, 0);
});
