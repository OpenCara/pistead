import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { sessionAccess } from '../apps/server/src/db.js';
import { openDatabase } from '../apps/server/src/db/index.js';
import type { Env } from '../apps/server/src/types.js';

const directory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const sharingMigration = '0006_sharing_defaults.sql';
const migrationFiles = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();

function migrate(sqlite: DatabaseSync, files: string[]) {
  for (const file of files) {
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
}

function fixture(t: TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), 'pistead-sharing-')), 'control-plane.sqlite');
  const sqlite = new DatabaseSync(path);
  t.after(() => { sqlite.close(); rmSync(dirname(path), { recursive: true, force: true }); });
  sqlite.exec('PRAGMA foreign_keys = ON');
  assert.ok(migrationFiles.includes(sharingMigration));
  migrate(sqlite, migrationFiles.filter(file => file < sharingMigration));
  sqlite.exec(`
    INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
      VALUES ('owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01'),
             ('host', 'Host', 'Host', 'host@example.test', 'test', '2026-01-01'),
             ('reader', 'Reader', 'Reader', 'reader@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at)
      VALUES ('team', 'Team', 'owner', '2026-01-01'), ('other-team', 'Other', 'owner', '2026-01-02');
    INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
      VALUES ('team', 'owner', 'owner', '2026-01-01'), ('team', 'host', 'member', '2026-01-01'),
             ('team', 'reader', 'member', '2026-01-01'), ('other-team', 'owner', 'owner', '2026-01-02'),
             ('other-team', 'host', 'member', '2026-01-02');
    INSERT INTO connectors (id, owner_id, name, credential_hash, models_json, created_at)
      VALUES ('shared-host', 'host', 'Shared', 'shared-credential',
        '[{"provider":"openai","modelId":"local-model","name":"Local"}]', '2026-01-01'),
        ('unshared-host', 'host', 'Unshared', 'unshared-credential', '[]', '2026-01-02'),
        ('revoked-host', 'host', 'Revoked', 'revoked-credential', '[]', '2026-01-03');
    UPDATE connectors SET revoked_at = '2026-01-04' WHERE id = 'revoked-host';
    INSERT INTO connector_shares (connector_id, workspace_id, created_at)
      VALUES ('shared-host', 'team', '2026-01-02'), ('shared-host', 'other-team', '2026-01-03'),
             ('revoked-host', 'team', '2026-01-04');
    INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id)
      VALUES ('connected-model', 'team', 'Local', 'openai', 'local-model', '2026-01-01', 'shared-host', 'host'),
             ('legacy-model', 'team', 'Legacy', 'faux', 'faux-1', '2026-01-01', NULL, NULL);
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent', 'owner', '2026-01-01');
    INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
      VALUES ('connected-version', 'agent', 'owner', 'team', 1, 'Published', '', '', '["identity"]', 'connected-model', '2026-01-01'),
             ('legacy-version', 'agent', 'owner', NULL, 2, 'Private', '', '', '["identity"]', 'legacy-model', '2026-01-02');
    INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id)
      VALUES ('connected-session', 'team', 'owner', 'connected-version', 'Connected', 7, 'ready', '2026-01-01', 'shared-host', 'host'),
             ('legacy-session', 'team', 'owner', 'legacy-version', 'Legacy', 3, 'archived', '2026-01-02', NULL, NULL),
             ('ungranted-session', 'team', 'owner', 'legacy-version', 'Owner only', 1, 'error', '2026-01-03', NULL, NULL);
    INSERT INTO session_grants (session_id, user_id, permissions_json, created_at)
      VALUES ('connected-session', 'reader', '["read","ask"]', '2026-01-02'),
             ('connected-session', 'host', '["write","approve","manage"]', '2026-01-03'),
             ('legacy-session', 'reader', '["read"]', '2026-01-04');
    INSERT INTO backups (id, session_id, owner_id, object_key, sha256, size, created_at)
      VALUES ('backup', 'connected-session', 'owner', 'private-backup-key', 'digest', 1, '2026-01-04');
  `);
  return { sqlite, path };
}

test('sharing migration backfills every populated share without creating new grants or losing legacy rows', async t => {
  const { sqlite, path } = fixture(t);
  const tables = ['users', 'workspaces', 'workspace_members', 'connectors', 'connector_shares', 'models',
    'agents', 'agent_versions', 'sessions', 'session_grants', 'backups'];
  const original = tables.map(table => ({ table, rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
  const shares = sqlite.prepare('SELECT connector_id, workspace_id, created_at FROM connector_shares ORDER BY connector_id, workspace_id').all();
  migrate(sqlite, [sharingMigration]);
  for (const { table, rows } of original) {
    const columns = Object.keys(rows[0]!).join(', ');
    assert.deepEqual(sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all(), rows, table);
  }
  assert.deepEqual(sqlite.prepare('SELECT connector_id, workspace_id, created_at FROM connector_workspaces ORDER BY connector_id, workspace_id').all(), shares);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM connector_workspaces WHERE connector_id = 'unshared-host'").get()!.n, 0);
  assert.equal(sqlite.prepare("SELECT revoked_at FROM connectors WHERE id = 'revoked-host'").get()!.revoked_at, '2026-01-04');
  assert.deepEqual(sqlite.prepare('SELECT id, visibility FROM sessions ORDER BY id').all().map(row => ({ ...row })), [
    { id: 'connected-session', visibility: 'private' },
    { id: 'legacy-session', visibility: 'private' },
    { id: 'ungranted-session', visibility: 'private' },
  ]);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(sqlite.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  // Today's access checks read columns later migrations add.
  migrate(sqlite, migrationFiles.filter(file => file > sharingMigration));
  // Read the migrated file through the real provider; it must not re-run the hand-applied migrations.
  const db = await openDatabase(`sqlite://${path}`);
  t.after(() => db.close());
  const env: Env = {
    DB: db,
    APP_ORIGIN: 'http://localhost:8787', TEST_AUTH_ENABLED: 'true',
    TEST_AUTH_SECRET: 'sharing-migration-test-secret-not-for-deployment',
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
  };
  assert.deepEqual((await sessionAccess(env, 'connected-session', 'reader'))?.permissions, ['read', 'ask']);
  assert.deepEqual((await sessionAccess(env, 'connected-session', 'host'))?.permissions, ['read', 'write', 'approve', 'manage']);
  assert.deepEqual((await sessionAccess(env, 'legacy-session', 'reader'))?.permissions, ['read']);
  assert.deepEqual((await sessionAccess(env, 'ungranted-session', 'owner'))?.permissions, ['read', 'ask', 'write', 'approve', 'manage']);
  assert.equal(await sessionAccess(env, 'ungranted-session', 'reader'), null);
  assert.equal(await sessionAccess(env, 'ungranted-session', 'host'), null);
  assert.equal(await sessionAccess(env, 'legacy-session', 'host'), null);
});

test('sharing migration constrains visibility and associations while keeping association and runtime grants independent', t => {
  const { sqlite } = fixture(t);
  migrate(sqlite, [sharingMigration]);
  const insert = sqlite.prepare('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?, ?, ?)');
  assert.throws(() => insert.run('shared-host', 'team', '2026-01-05'), /UNIQUE/);
  assert.throws(() => insert.run('missing-host', 'team', '2026-01-05'), /FOREIGN KEY/);
  assert.throws(() => insert.run('shared-host', 'missing-team', '2026-01-05'), /FOREIGN KEY/);
  insert.run('unshared-host', 'team', '2026-01-05');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM connector_shares WHERE connector_id = 'unshared-host'").get()!.n, 0);
  sqlite.exec("DELETE FROM connector_shares WHERE connector_id = 'shared-host' AND workspace_id = 'team'");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM connector_workspaces WHERE connector_id = 'shared-host' AND workspace_id = 'team'").get()!.n, 1);
  const grants = sqlite.prepare('SELECT * FROM session_grants ORDER BY session_id, user_id').all();
  for (const visibility of ['workspace', 'private']) {
    sqlite.prepare("UPDATE sessions SET visibility = ? WHERE id = 'connected-session'").run(visibility);
    assert.equal(sqlite.prepare("SELECT visibility FROM sessions WHERE id = 'connected-session'").get()!.visibility, visibility);
    assert.deepEqual(sqlite.prepare('SELECT * FROM session_grants ORDER BY session_id, user_id').all(), grants);
  }
  for (const visibility of ['public', '', null, 'PRIVATE']) {
    assert.throws(() => sqlite.prepare("UPDATE sessions SET visibility = ? WHERE id = 'connected-session'").run(visibility), /CHECK|NOT NULL/);
  }
  assert.equal(sqlite.prepare("SELECT policy_version FROM sessions WHERE id = 'connected-session'").get()!.policy_version, 7);
  assert.throws(() => sqlite.exec("UPDATE sessions SET owner_id = 'host' WHERE id = 'connected-session'"), /immutable/);
  assert.throws(() => sqlite.exec("UPDATE sessions SET connector_id = 'unshared-host' WHERE id = 'connected-session'"), /immutable/);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
