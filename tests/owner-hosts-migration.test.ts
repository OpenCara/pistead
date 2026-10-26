import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const directory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const ownerHostsMigration = '0027_owner_hosts.sql';
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

test('hosts paired into one workspace are connected, privately, to every workspace their owner belongs to', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  assert.ok(migrationFiles.includes(ownerHostsMigration));
  migrate(sqlite, migrationFiles.filter(file => file < ownerHostsMigration));
  sqlite.exec(`
    INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
      VALUES ('host', 'Host', 'Host', 'host@example.test', 'test', '2026-01-01'),
             ('other', 'Other', 'Other', 'other@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at)
      VALUES ('paired', 'Paired', 'host', '2026-01-01'), ('joined', 'Joined', 'other', '2026-01-02'),
             ('foreign', 'Foreign', 'other', '2026-01-03');
    INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
      VALUES ('paired', 'host', 'owner', '2026-01-01'), ('joined', 'other', 'owner', '2026-01-02'),
             ('joined', 'host', 'member', '2026-01-05'), ('foreign', 'other', 'owner', '2026-01-03');
    INSERT INTO connectors (id, owner_id, name, credential_hash, models_json, created_at)
      VALUES ('active', 'host', 'Active', 'active-credential',
        '[{"provider":"openai","modelId":"local-model","name":"Local"}]', '2026-01-01'),
        ('revoked', 'host', 'Revoked', 'revoked-credential',
        '[{"provider":"openai","modelId":"local-model","name":"Local"}]', '2026-01-01');
    UPDATE connectors SET revoked_at = '2026-01-04' WHERE id = 'revoked';
    INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
      VALUES ('active', 'paired', '2026-01-01'), ('revoked', 'paired', '2026-01-01');
    INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
      VALUES ('paired-model', 'paired', 'Local', 'openai', 'local-model', '2026-01-01', 'active', 'host', 1);
  `);
  migrate(sqlite, [ownerHostsMigration]);
  const associations = sqlite.prepare('SELECT connector_id, workspace_id, created_at FROM connector_workspaces ORDER BY connector_id, workspace_id').all();
  assert.deepEqual(associations.map(row => ({ ...row })), [
    { connector_id: 'active', workspace_id: 'joined', created_at: '2026-01-05' },
    { connector_id: 'active', workspace_id: 'paired', created_at: '2026-01-01' },
    { connector_id: 'revoked', workspace_id: 'paired', created_at: '2026-01-01' },
  ]);
  const models = sqlite.prepare('SELECT id, workspace_id, name, provider, model_id, connector_id, connector_owner_id, available FROM models ORDER BY workspace_id').all();
  assert.equal(models.length, 2);
  assert.deepEqual({ ...models[0], id: undefined }, {
    id: undefined, workspace_id: 'joined', name: 'Local', provider: 'openai', model_id: 'local-model',
    connector_id: 'active', connector_owner_id: 'host', available: 1,
  });
  assert.equal(models[1].id, 'paired-model');
  // Nothing is shared by connecting a host for its owner's own use.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM connector_shares').get()!.n, 0);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  sqlite.close();
});
