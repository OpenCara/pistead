import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applySqliteMigrations } from './helpers/sqlite-migrations.js';

const directory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const hostConfigMigration = '0031_host_configuration.sql';
const migrationFiles = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();

function migrate(sqlite: DatabaseSync, files: string[]) {
  applySqliteMigrations(sqlite, directory, files);
}

test('hosts started with --git-credentials or --repo-cache keep them once configured in Pistead; others get no row', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  assert.ok(migrationFiles.includes(hostConfigMigration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0024_host_configuration.sql'), 'Postgres has the same migration');
  migrate(sqlite, migrationFiles.filter(file => file < hostConfigMigration));
  const capabilities = (extra: object) => JSON.stringify({ platform: 'linux', sandbox: false, productionShell: false, gitPush: true, ...extra });
  sqlite.exec(`INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
    VALUES ('host', 'Host', 'Host', 'host@example.test', 'test', '2026-01-01')`);
  const insert = sqlite.prepare(`INSERT INTO connectors (id, owner_id, name, credential_hash, capabilities_json, created_at, last_seen_at)
    VALUES (?, 'host', ?, ?, ?, '2026-01-01', ?)`);
  insert.run('credentials', 'Credentials', 'credentials-hash', capabilities({ gitCredentials: true }), '2026-02-01');
  insert.run('cache', 'Cache', 'cache-hash', capabilities({ repositoryCache: true }), null);
  insert.run('both', 'Both', 'both-hash', capabilities({ gitCredentials: true, repositoryCache: true }), '2026-03-01');
  insert.run('plain', 'Plain', 'plain-hash', capabilities({}), '2026-02-01');
  migrate(sqlite, [hostConfigMigration]);
  const rows = sqlite.prepare(`SELECT connector_id, command_timeout_seconds, gpu, git_credentials, repository_cache, updated_by, updated_at
    FROM connector_configs ORDER BY connector_id`).all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { connector_id: 'both', command_timeout_seconds: 30, gpu: 0, git_credentials: 1, repository_cache: 'host', updated_by: null, updated_at: '2026-03-01' },
    { connector_id: 'cache', command_timeout_seconds: 30, gpu: 0, git_credentials: 0, repository_cache: 'host', updated_by: null, updated_at: '2026-01-01' },
    { connector_id: 'credentials', command_timeout_seconds: 30, gpu: 0, git_credentials: 1, repository_cache: 'off', updated_by: null, updated_at: '2026-02-01' },
  ]);
  // Nothing runs on a host without the sandbox until its owner turns that on.
  assert.deepEqual(sqlite.prepare('SELECT DISTINCT host_sessions FROM connector_configs').all().map(row => row.host_sessions), [0]);
  // Every session, existing or new, runs in the sandbox unless it was started on the host.
  assert.deepEqual(sqlite.prepare(`SELECT name, dflt_value, "notnull" FROM pragma_table_info('sessions') WHERE name = 'host_environment'`).all().map(row => ({ ...row })),
    [{ name: 'host_environment', dflt_value: '0', notnull: 1 }]);
  // The table holds only what the web app can set.
  for (const [column, value] of [['command_timeout_seconds', 29], ['command_timeout_seconds', 3601], ['gpu', 2], ['repository_cache', 'shared'], ['host_sessions', 2]] as const) {
    assert.throws(() => sqlite.prepare(`INSERT INTO connector_configs (connector_id, ${column}, updated_at) VALUES ('plain', ?, '2026-04-01')`).run(value), /CHECK constraint/);
  }
});
