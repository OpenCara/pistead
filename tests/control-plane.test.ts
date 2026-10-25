import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { decryptToken, encryptToken } from '../apps/server/src/vault.js';
import { userIdentifier } from '../apps/server/src/http.js';
import { sessionAccess } from '../apps/server/src/db.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import type { SessionView } from '../packages/shared/src/types.js';
import { applyViewPatch, diffView, type SessionViewPatch } from '../packages/shared/src/view-patch.js';
import { seedAgentVersion, testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'control-plane-test-secret-not-for-deployment';
const internalSecret = 'control-plane-internal-secret-not-for-deployment';
const migrationsDirectory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const migrationFiles = readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort();

function migrate(sqlite: DatabaseSync, files = migrationFiles) {
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of files) {
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(readFileSync(new URL(file, migrationsDirectory), 'utf8'));
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

async function fixture(t: TestContext) {
  const { db, sqlite, queryCount } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true',
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
  return { sqlite, env, client, queryCount };
}

function seedLegacySchema(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
      VALUES ('schema-owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01'),
             ('schema-host', 'Host', 'Host', 'host@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at)
      VALUES ('schema-workspace', 'Workspace', 'schema-owner', '2026-01-01'),
             ('schema-other-workspace', 'Other workspace', 'schema-owner', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
      VALUES ('schema-workspace', 'schema-owner', 'owner', '2026-01-01');
    INSERT INTO models (id, workspace_id, name, provider, model_id, created_at)
      VALUES ('schema-faux', 'schema-workspace', 'Faux', 'faux', 'faux-1', '2026-01-01'),
             ('schema-openai', 'schema-workspace', 'OpenAI', 'openai', 'gpt-4', '2026-01-01'),
             ('schema-anthropic', 'schema-workspace', 'Anthropic', 'anthropic', 'claude', '2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('schema-agent', 'schema-owner', '2026-01-01');
    INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
      SELECT 'version-' || id, 'schema-agent', 'schema-owner', workspace_id,
             CASE provider WHEN 'faux' THEN 1 WHEN 'openai' THEN 2 ELSE 3 END,
             name, '', '', '[]', id, created_at FROM models;
    INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, status, created_at)
      VALUES ('schema-session', 'schema-workspace', 'schema-owner', 'version-schema-faux', 'Original', 'ready', '2026-01-01');
    INSERT INTO session_grants (session_id, user_id, permissions_json, created_at)
      VALUES ('schema-session', 'schema-host', '["read"]', '2026-01-01');
    INSERT INTO backups (id, session_id, owner_id, object_key, sha256, size, created_at)
      VALUES ('schema-backup', 'schema-session', 'schema-owner', 'schema-object', 'schema-digest', 1, '2026-01-01');
    INSERT INTO broker_capabilities (token_hash, session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, created_at)
      VALUES ('schema-token', 'schema-session', 'schema-approval', 'schema-owner', 'schema-owner', 'schema-operation', 1, '2026-01-01');
    INSERT INTO audit (id, workspace_id, session_id, actor_id, action, created_at)
      VALUES ('schema-audit', 'schema-workspace', 'schema-session', 'schema-owner', 'created', '2026-01-01');
  `);
}

test('connector migration preserves populated legacy rows, foreign keys, and immutable bindings', t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  assert.equal(migrationFiles[0], '0001_control_plane.sql');
  migrate(sqlite, migrationFiles.slice(0, 1));
  seedLegacySchema(sqlite);
  const tables = ['users', 'workspaces', 'workspace_members', 'models', 'agents', 'agent_versions', 'sessions', 'session_grants', 'backups', 'broker_capabilities', 'audit'];
  const original = tables.map(table => ({ table, rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
  migrate(sqlite, migrationFiles.slice(1));
  for (const { table, rows } of original) {
    const columns = Object.keys(rows[0]!).join(', ');
    assert.deepEqual(sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all(), rows, table);
  }
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(sqlite.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  assert.ok(sqlite.prepare('PRAGMA foreign_key_list(agent_versions)').all().some(row => row.table === 'models' && row.from === 'model_id'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM models WHERE connector_id IS NULL AND connector_owner_id IS NULL AND available = 1').get()!.count, 3);
  assert.equal(sqlite.prepare("SELECT connector_id FROM sessions WHERE id = 'schema-session'").get()!.connector_id, null);
  assert.equal(sqlite.prepare("SELECT connector_owner_id FROM sessions WHERE id = 'schema-session'").get()!.connector_owner_id, null);
  assert.throws(() => sqlite.exec("DELETE FROM models WHERE id = 'schema-faux'"), /FOREIGN KEY/);
  assert.throws(() => sqlite.exec("INSERT INTO agent_versions SELECT 'bad-version', agent_id, author_id, workspace_id, 4, name, description, instructions, tools_json, 'missing-model', created_at FROM agent_versions LIMIT 1"), /FOREIGN KEY/);
  assert.throws(() => sqlite.exec("UPDATE agent_versions SET name = 'changed'"), /immutable/);
  assert.throws(() => sqlite.exec('DELETE FROM agent_versions'), /immutable/);
  for (const column of ['workspace_id', 'owner_id', 'agent_version_id']) {
    assert.throws(() => sqlite.exec(`UPDATE sessions SET ${column} = ${column}`), /immutable/);
  }
});

test('connector schema enforces credentials, shares, catalog identity, and paired immutable session routing', async t => {
  const f = await fixture(t);
  const sqlite = f.sqlite;
  seedLegacySchema(sqlite);
  const insertConnector = sqlite.prepare('INSERT INTO connectors (id, owner_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  insertConnector.run('schema-connector', 'schema-host', 'Local Pi', 'credential-one', '2026-01-01');
  insertConnector.run('schema-other-connector', 'schema-host', 'Other Pi', 'credential-two', '2026-01-01');
  assert.throws(() => insertConnector.run('duplicate', 'schema-host', 'Duplicate', 'credential-one', '2026-01-01'), /UNIQUE/);
  assert.throws(() => insertConnector.run('missing-owner', 'missing', 'Missing', 'credential-three', '2026-01-01'), /FOREIGN KEY/);
  const connector = sqlite.prepare("SELECT * FROM connectors WHERE id = 'schema-connector'").get()!;
  assert.equal(connector.models_json, '[]');
  assert.equal(connector.capabilities_json, '{}');
  for (const column of ['revoked_at', 'last_seen_at', 'connection_hash']) assert.equal(connector[column], null);
  sqlite.prepare('INSERT INTO connector_pairings (id, owner_id, name, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('schema-pairing', 'schema-host', 'Local Pi', 'pairing-hash', 1234567890, '2026-01-01');
  const pairing = sqlite.prepare("SELECT *, typeof(expires_at) AS expiry_type FROM connector_pairings WHERE id = 'schema-pairing'").get()!;
  assert.equal(pairing.expiry_type, 'integer');
  assert.equal(pairing.expires_at, 1234567890);
  assert.equal(pairing.claimed_at, null);
  const insertShare = sqlite.prepare("INSERT INTO connector_shares (connector_id, workspace_id, created_at) VALUES (?, ?, '2026-01-01')");
  insertShare.run('schema-connector', 'schema-workspace');
  assert.throws(() => insertShare.run('schema-connector', 'schema-workspace'), /UNIQUE/);
  assert.throws(() => insertShare.run('missing', 'schema-workspace'), /FOREIGN KEY/);
  assert.throws(() => insertShare.run('schema-connector', 'missing'), /FOREIGN KEY/);

  const insertModel = sqlite.prepare(`INSERT INTO models (id, workspace_id, name, provider, model_id, connector_id, connector_owner_id, created_at)
    VALUES (?, ?, 'Local model', ?, ?, ?, ?, '2026-01-01')`);
  insertModel.run('connected-model', 'schema-workspace', 'local-native-provider', 'local-model', 'schema-connector', 'schema-host');
  assert.throws(() => insertModel.run('duplicate-model', 'schema-workspace', 'local-native-provider', 'local-model', 'schema-connector', 'schema-host'), /UNIQUE/);
  insertModel.run('other-connector-model', 'schema-workspace', 'local-native-provider', 'local-model', 'schema-other-connector', 'schema-host');
  insertModel.run('other-workspace-model', 'schema-other-workspace', 'local-native-provider', 'local-model', 'schema-connector', 'schema-host');
  insertModel.run('other-provider-model', 'schema-workspace', 'another-provider', 'local-model', 'schema-connector', 'schema-host');
  insertModel.run('other-local-model', 'schema-workspace', 'local-native-provider', 'other-model', 'schema-connector', 'schema-host');
  insertModel.run('legacy-duplicate', 'schema-workspace', 'faux', 'faux-1', null, null);
  for (const [connectorId, ownerId] of [['schema-connector', null], [null, 'schema-host']] as const) {
    assert.throws(() => insertModel.run('unpaired', 'schema-workspace', 'provider', 'model', connectorId, ownerId), /CHECK/);
  }
  assert.throws(() => insertModel.run('missing-connector', 'schema-workspace', 'provider', 'model', 'missing', 'schema-host'), /FOREIGN KEY/);
  assert.throws(() => insertModel.run('missing-host', 'schema-workspace', 'provider', 'model', 'schema-connector', 'missing'), /FOREIGN KEY/);
  assert.equal(sqlite.prepare("SELECT available FROM models WHERE id = 'connected-model'").get()!.available, 1);
  for (const column of ['workspace_id', 'provider', 'model_id', 'connector_id', 'connector_owner_id']) {
    assert.throws(() => sqlite.exec(`UPDATE models SET ${column} = ${column} WHERE id = 'connected-model'`), /immutable/);
  }
  assert.throws(() => sqlite.exec("UPDATE models SET connector_id = 'schema-connector', connector_owner_id = 'schema-host' WHERE id = 'schema-faux'"), /immutable/);
  sqlite.exec("UPDATE models SET name = 'Renamed', available = 0 WHERE id = 'connected-model'");
  assert.equal(sqlite.prepare("SELECT available FROM models WHERE id = 'connected-model'").get()!.available, 0);
  assert.throws(() => sqlite.exec("UPDATE models SET available = 2 WHERE id = 'connected-model'"), /CHECK/);

  const insertSession = sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, status, connector_id, connector_owner_id, created_at)
    VALUES (?, 'schema-workspace', 'schema-owner', 'version-schema-faux', 'Connected', 'ready', ?, ?, '2026-01-01')`);
  insertSession.run('connected-session', 'schema-connector', 'schema-host');
  for (const [connectorId, ownerId] of [['schema-connector', null], [null, 'schema-host']] as const) {
    assert.throws(() => insertSession.run('unpaired-session', connectorId, ownerId), /must be paired/);
  }
  assert.throws(() => insertSession.run('missing-connector-session', 'missing', 'schema-host'), /FOREIGN KEY/);
  assert.throws(() => insertSession.run('missing-host-session', 'schema-connector', 'missing'), /FOREIGN KEY/);
  for (const column of ['connector_id', 'connector_owner_id']) {
    assert.throws(() => sqlite.exec(`UPDATE sessions SET ${column} = NULL WHERE id = 'connected-session'`), /immutable/);
  }
  assert.throws(() => sqlite.exec("UPDATE sessions SET connector_id = 'schema-connector', connector_owner_id = 'schema-host' WHERE id = 'schema-session'"), /immutable/);
  sqlite.exec("UPDATE sessions SET title = 'Renamed', status = 'archived' WHERE id = 'connected-session'");
  sqlite.exec("UPDATE connectors SET revoked_at = '2026-01-02', connection_hash = NULL WHERE id = 'schema-connector'");
  sqlite.exec("DELETE FROM connector_shares WHERE connector_id = 'schema-connector'");
  assert.equal(sqlite.prepare("SELECT connector_id FROM sessions WHERE id = 'connected-session'").get()!.connector_id, 'schema-connector');
  assert.equal(sqlite.prepare("SELECT connector_id FROM models WHERE id = 'connected-model'").get()!.connector_id, 'schema-connector');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('test auth is disabled by default, secret gated, isolated, and expires existing cookies', async t => {
  const f = await fixture(t);
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
  const f = await fixture(t);
  const alice = await f.client('alice');
  assert.equal((await alice.request('POST', '/api/workspaces', { name: 'blocked' }, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await alice.request('POST', '/api/workspaces', { name: 'blocked' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await alice.request('POST', '/api/workspaces', { name: 'blocked' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await alice.request('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await alice.request('GET', '/api/me')).status, 401);
});

test('agents are gone; saved versions are immutable and do not grant authors access to another owner session', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice'); const bob = await f.client('bob'); const eve = await f.client('eve');
  const workspace = (await (await alice.request('POST', '/api/workspaces', { name: 'team' })).json() as { workspace: { id: string } }).workspace;
  assert.equal((await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'member' })).status, 200);
  const model = (await (await alice.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'fixture', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  // A version alice published before agents were removed. Nothing lists, revises, publishes or starts one any more.
  const published = seedAgentVersion(f.sqlite, { authorId: alice.user.id, workspaceId: workspace.id, modelId: model.id, tools: ['identity'] });
  const routes: [string, string][] = [['GET', '/api/agents'], ['GET', `/api/workspaces/${workspace.id}/agents`], ['POST', '/api/agents'],
    ['POST', `/api/agents/${published.agentId}/versions`], ['POST', `/api/agents/${published.agentId}/publish`]];
  for (const [method, path] of routes) {
    const response = await alice.request(method, path, method === 'POST' ? { workspaceId: workspace.id, tools: ['identity'], modelId: model.id } : undefined);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const fromAgent = await bob.request('POST', '/api/sessions', { workspaceId: workspace.id, agentVersionId: published.id });
  assert.equal(fromAgent.status, 400);
  assert.equal((await fromAgent.json() as { code: string }).code, 'invalid_input');
  assert.throws(() => f.sqlite.prepare('UPDATE agent_versions SET name = ? WHERE id = ?').run('changed', published.id), /immutable/);
  f.sqlite.prepare("INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private')")
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

test('workspace names must not be blank', async t => {
  const f = await fixture(t);
  const alice = await f.client('alice');
  assert.equal((await alice.request('POST', '/api/workspaces', { name: '   ' })).status, 400);
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
  const f = await fixture(t);
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
  f.sqlite.prepare(`INSERT INTO approval_reviews (session_id,approval_id,requested_by,operation_json,source,admission_id,review_hash,created_at)
    VALUES (?,?,?,?, 'explicit', NULL,?,?)`).run('session', 'approval', ownerId, JSON.stringify(operation),
      await sha256(JSON.stringify({ sessionId: 'session', approvalId: 'approval', requestedBy: ownerId, operation })), createdAt);
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
  const f = await fixture(t);
  const alice = await f.client('alice');
  const workspace = (await (await alice.request('POST', '/api/workspaces', { name: 'real memberships' })).json() as { workspace: { id: string } }).workspace;
  f.sqlite.prepare('INSERT INTO users (id,github_id,github_login,display_name,git_name,git_email,auth_kind,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('github:12345', '12345', 'real-user', 'Real user', 'Real user', 'real@example.test', 'github', new Date().toISOString());
  const added = await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: 'github:12345', role: 'member' });
  assert.equal(added.status, 200);
  assert.ok((await added.json() as { members: { userId: string }[] }).members.some(member => member.userId === 'github:12345'));
  assert.equal((await alice.request('DELETE', `/api/workspaces/${workspace.id}/members/github%3A12345`)).status, 204);
});

async function pollingFixture(t: TestContext) {
  const f = await fixture(t);
  const owner = await f.client('poll-owner');
  const reader = await f.client('poll-reader');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'polling' })).json() as { workspace: { id: string } }).workspace;
  await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: reader.user.id, role: 'member' });
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'polling', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const agent = seedAgentVersion(f.sqlite, { authorId: owner.user.id, modelId: model.id, tools: ['identity'] });
  f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility) VALUES (?,?,?,?,?,?,?,'private')")
    .run('poll-session', workspace.id, owner.user.id, agent.id, 'polling', 'ready', new Date().toISOString());
  await owner.request('POST', '/api/sessions/poll-session/grants', { userId: reader.user.id, permissions: ['read'] });
  f.env.RUNNER_URL = 'https://runner.example.test';
  f.env.RUNNER_EVENT_TRANSPORT = 'poll';
  const view = { sessionId: 'poll-session', owner: { id: owner.user.id, displayName: 'Owner', gitName: 'Owner', gitEmail: 'owner@example.test', githubLogin: null },
    entries: [], approvals: [], conversations: [], busy: false };
  return { ...f, owner, reader, view };
}

test('poll SSE emits at most four authoritative views within the subrequest budget', async t => {
  const f = await pollingFixture(t);
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
  assert.ok(f.queryCount() - before + polls <= 27, 'Four snapshots including restore-state checks must fit the query budget');
});

test('poll SSE rechecks live grants after fetching and before emitting each snapshot', async t => {
  const f = await pollingFixture(t);
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
  const f = await pollingFixture(t);
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
  const f = await pollingFixture(t);
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
  const f = await pollingFixture(t);
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

function events(body: string): { event: string; data: Record<string, unknown> }[] {
  return body.split('\n\n').filter(block => block.includes('data: ')).map(block => ({
    event: /^event: (.*)$/m.exec(block)?.[1] ?? 'message',
    data: JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Record<string, unknown>,
  }));
}

async function readSnapshots(t: TestContext, response: Response, count: number): Promise<string> {
  const reader = response.body!.getReader();
  let body = '';
  for (let snapshot = 0; snapshot < count; snapshot++) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += new TextDecoder().decode(chunk.value);
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  while (!(await reader.read()).done) { /* The stream ends after its snapshots. */ }
  return body;
}

test('a runner that reports revisions is asked only for what changed, and one that refuses is asked for the whole view', async t => {
  const f = await pollingFixture(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const first = 'a'.repeat(32);
  const second = 'b'.repeat(32);
  const entry = { id: '0:1', kind: 'message', role: 'user', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' };
  const v1: SessionView = { ...f.view, entries: [entry] };
  const v2: SessionView = { ...v1, entries: [entry, { id: '0:2', kind: 'message', role: 'assistant', text: 'done' }], busy: true };
  const paths: string[] = [];
  let refuse = false;
  let misfit = false;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith('/view')) return Response.json({ view: v1, revision: first });
    if (refuse) return Response.json({ error: 'Unknown runner endpoint' }, { status: 404 });
    if (misfit) return Response.json({ patch: { base: 'c'.repeat(32), revision: 'd'.repeat(32), view: {}, lists: {} } });
    if (path.endsWith(`/view/${first}`)) return Response.json({ patch: diffView(v1, v2, first, second) });
    if (path.endsWith(`/view/${second}`)) return Response.json({ patch: { base: second, revision: second } });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const read = async () => (await f.reader.request('GET', '/api/sessions/poll-session/view')).json() as Promise<{ view: SessionView; revision: string }>;
  const one = await read();
  assert.equal(one.view.entries[0]!.text, 'token ghp_[redacted]');
  const two = await read();
  assert.equal(two.view.busy, true);
  assert.deepEqual(two.view.entries.map(item => item.id), ['0:1', '0:2']);
  assert.equal(two.view.entries[0]!.text, 'token ghp_[redacted]', 'Patched entries are redacted like whole views');
  assert.notEqual(two.revision, one.revision);
  const three = await read();
  assert.equal(three.revision, two.revision, 'An unchanged host view keeps its revision');
  assert.deepEqual(paths, ['/v1/sessions/poll-session/view', `/v1/sessions/poll-session/view/${first}`, `/v1/sessions/poll-session/view/${second}`]);
  // A runner that does not know the path (an older one) answers the whole view instead.
  refuse = true;
  paths.length = 0;
  const four = await read();
  assert.deepEqual(four.view.entries.map(item => item.id), ['0:1']);
  assert.deepEqual(paths, [`/v1/sessions/poll-session/view/${second}`, '/v1/sessions/poll-session/view']);
  // A patch that does not fit the view the server holds is replaced by the whole view, not asked for again.
  refuse = false;
  misfit = true;
  paths.length = 0;
  assert.deepEqual((await read()).view.entries.map(item => item.id), ['0:1']);
  assert.deepEqual(paths, [`/v1/sessions/poll-session/view/${first}`, '/v1/sessions/poll-session/view']);
});

test('viewers of one session share a host read, and a message makes the next read ask the host again', async t => {
  const f = await pollingFixture(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/submit')) return Response.json({ submissionId: 'sub-1', conversationId: '0', status: 'queued' });
    polls++;
    return Response.json({ view: { ...f.view, busy: polls > 1 } });
  };
  const [owner, reader] = await Promise.all([
    f.owner.request('GET', '/api/sessions/poll-session/events'),
    f.reader.request('GET', '/api/sessions/poll-session/events'),
  ]);
  const ownerReader = owner.body!.getReader();
  const readerReader = reader.body!.getReader();
  t.after(() => { void ownerReader.cancel(); void readerReader.cancel(); });
  const [a, b] = await Promise.all([ownerReader.read(), readerReader.read()]);
  assert.ok(new TextDecoder().decode(a.value).includes('event: view'));
  assert.ok(new TextDecoder().decode(b.value).includes('event: view'));
  assert.equal(polls, 1, 'Two viewers at once cost one host read');
  // A third read within the same second is served the same view.
  assert.equal((await (await f.reader.request('GET', '/api/sessions/poll-session/events')).body!.getReader().read()).done, false);
  assert.equal(polls, 1);
  const submitted = await f.owner.request('POST', '/api/sessions/poll-session/submit', { content: 'go', requestId: 'request-1' });
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const after = await (await f.reader.request('GET', '/api/sessions/poll-session/events')).body!.getReader().read();
  assert.equal(polls, 2, 'The view after a message comes from the host, not from before it');
  assert.ok(new TextDecoder().decode(after.value).includes('"busy":true'));
});

test('a client holding a revision gets patches: nothing while nothing changed, then only the change', async t => {
  const f = await pollingFixture(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const entries = Array.from({ length: 50 }, (_, index) => ({ id: `0:${index}`, kind: 'message', role: 'assistant', text: 'x'.repeat(400) }));
  let current: SessionView = { ...f.view, entries };
  globalThis.fetch = async () => Response.json({ view: current });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loaded = await (await f.reader.request('GET', '/api/sessions/poll-session/view')).json() as { view: SessionView; revision: string };
  const response = await f.reader.request('GET', `/api/sessions/poll-session/events?since=${loaded.revision}`);
  const reader = response.body!.getReader();
  const first = await reader.read();
  const [unchanged] = events(new TextDecoder().decode(first.value));
  assert.deepEqual(unchanged, { event: 'patch', data: { patch: { base: loaded.revision, revision: loaded.revision } } });
  current = { ...current, entries: [...entries, { id: '0:50', kind: 'message', role: 'assistant', text: 'new' }] };
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.ok(second.length < 1000, `The change alone travels, not the ${JSON.stringify(current).length}-byte view`);
  const [changed] = events(second);
  assert.equal(changed!.event, 'patch');
  const patch = changed!.data.patch as SessionViewPatch;
  assert.equal(patch.base, loaded.revision);
  assert.deepEqual(applyViewPatch(loaded.view, patch).entries, current.entries);
  await reader.cancel();

  // A revision the server does not hold, or none at all, starts again from a whole view with its revision.
  for (const since of ['f'.repeat(32), '']) {
    const body = await readSnapshots(t, await f.reader.request('GET', `/api/sessions/poll-session/events?since=${since}`), 4);
    const [whole, next] = events(body);
    assert.equal(whole!.event, 'view');
    assert.deepEqual((whole!.data.view as SessionView).entries, current.entries);
    assert.equal(whole!.data.revision, patch.revision);
    assert.deepEqual(next, { event: 'patch', data: { patch: { base: patch.revision, revision: patch.revision } } });
  }
});

test('workspace roles: viewers read and create nothing, members read, collaborators and admins message shared sessions', async t => {
  const f = await fixture(t);
  const owner = await f.client('roles-owner');
  const [viewer, member, collaborator, admin, other] = await Promise.all(['roles-viewer', 'roles-member', 'roles-collaborator', 'roles-admin', 'roles-other'].map(name => f.client(name)));
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'roles' })).json() as { workspace: { id: string } }).workspace;
  const members = `/api/workspaces/${workspace.id}/members`;
  for (const [client, role] of [[viewer, 'viewer'], [member, 'member'], [collaborator, 'collaborator'], [admin, 'admin']] as const) {
    assert.equal((await owner.request('POST', members, { userId: client.user.id, role })).status, 200);
  }
  assert.equal((await owner.request('POST', members, { userId: other.user.id, role: 'owner' })).status, 400);
  assert.equal((await owner.request('POST', members, { userId: other.user.id, role: 'editor' })).status, 400);
  const listed = (await (await viewer.request('GET', '/api/workspaces')).json() as { workspaces: { id: string; role: string }[] }).workspaces;
  assert.equal(listed.find(item => item.id === workspace.id)?.role, 'viewer');

  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'roles', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const agent = seedAgentVersion(f.sqlite, { authorId: owner.user.id, modelId: model.id, tools: ['identity'] });
  const insert = f.sqlite.prepare('INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility) VALUES (?,?,?,?,?,?,?,?)');
  insert.run('roles-shared', workspace.id, owner.user.id, agent.id, 'shared', 'ready', new Date().toISOString(), 'workspace');
  insert.run('roles-private', workspace.id, owner.user.id, agent.id, 'private', 'ready', new Date().toISOString(), 'private');
  const held = async (client: { user: { id: string } }, sessionId: string) => (await sessionAccess(f.env, sessionId, client.user.id))?.permissions ?? null;

  // A shared session: viewers and members follow it read-only; collaborators and admins can also send messages.
  assert.deepEqual(await held(viewer, 'roles-shared'), ['read']);
  assert.deepEqual(await held(member, 'roles-shared'), ['read']);
  assert.deepEqual(await held(collaborator, 'roles-shared'), ['read', 'ask', 'write']);
  assert.deepEqual(await held(admin, 'roles-shared'), ['read', 'ask', 'write']);
  // A private session stays private, whatever the role.
  for (const client of [viewer, member, collaborator, admin]) assert.equal(await held(client, 'roles-private'), null);

  // Members are read-only by default, so they can be granted more; a viewer is read-only whatever it is granted.
  assert.equal((await owner.request('POST', '/api/sessions/roles-shared/grants', { userId: member.user.id, permissions: ['read', 'write'] })).status, 200);
  assert.deepEqual(await held(member, 'roles-shared'), ['read', 'write']);
  const refused = await owner.request('POST', '/api/sessions/roles-shared/grants', { userId: viewer.user.id, permissions: ['read', 'write'] });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { code: string }).code, 'viewer_role');
  f.sqlite.prepare('INSERT INTO session_grants (session_id,user_id,permissions_json,created_at) VALUES (?,?,?,?)')
    .run('roles-private', viewer.user.id, JSON.stringify(['read', 'ask', 'write', 'approve', 'manage']), new Date().toISOString());
  assert.deepEqual(await held(viewer, 'roles-private'), ['read']);

  // Viewers can't start sessions; the role check comes before anything about the model or host.
  const created = await viewer.request('POST', '/api/sessions', { workspaceId: workspace.id, modelId: model.id, title: 'mine' });
  assert.equal(created.status, 403);
  assert.equal((await created.json() as { code: string }).code, 'viewer_role');

  // Admins manage collaborators, members and viewers; only the owner manages admins.
  assert.equal((await admin.request('POST', members, { userId: other.user.id, role: 'collaborator' })).status, 200);
  assert.equal((await admin.request('POST', members, { userId: other.user.id, role: 'viewer' })).status, 200);
  assert.equal((await admin.request('POST', members, { userId: other.user.id, role: 'admin' })).status, 403);
  assert.equal((await admin.request('POST', members, { userId: admin.user.id, role: 'member' })).status, 403);
  assert.equal((await collaborator.request('POST', members, { userId: other.user.id, role: 'member' })).status, 403);
  // A role change takes effect at once and invalidates what was issued under the previous one; re-saving a member's
  // current role, or adding someone new, takes nothing away and leaves the workspace's sessions alone.
  const version = () => (f.sqlite.prepare("SELECT policy_version FROM sessions WHERE id = 'roles-shared'").get() as { policy_version: number }).policy_version;
  const before = version();
  const resaved = await admin.request('POST', members, { userId: collaborator.user.id, role: 'collaborator' });
  assert.equal(resaved.status, 200);
  assert.ok((await resaved.json() as { members: { userId: string; role: string }[] }).members.some(item => item.userId === collaborator.user.id && item.role === 'collaborator'));
  const newcomer = await f.client('roles-newcomer');
  assert.equal((await admin.request('POST', members, { userId: newcomer.user.id, role: 'member' })).status, 200);
  assert.equal(version(), before);
  assert.equal((await admin.request('POST', members, { userId: collaborator.user.id, role: 'member' })).status, 200);
  assert.deepEqual(await held(collaborator, 'roles-shared'), ['read']);
  assert.equal((f.sqlite.prepare("SELECT policy_version FROM sessions WHERE id = 'roles-shared'").get() as { policy_version: number }).policy_version, before + 1);
  assert.equal((await admin.request('DELETE', `${members}/${other.user.id}`)).status, 204);
  assert.equal((await owner.request('POST', members, { userId: admin.user.id, role: 'collaborator' })).status, 200);
});
