import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const directory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const sourcesMigration = '0032_workspace_sources.sql';
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

function fixture(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  assert.ok(migrationFiles.includes(sourcesMigration));
  assert.ok(readdirSync(new URL('../apps/server/migrations/postgres/', import.meta.url)).includes('0025_workspace_sources.sql'), 'Postgres has the same migration');
  migrate(sqlite, migrationFiles.filter(file => file < sourcesMigration));
  sqlite.exec(`INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
    VALUES ('owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('one', 'One', 'owner', '2026-01-01'), ('two', 'Two', 'owner', '2026-01-01');`);
  return sqlite;
}

const insertRepository = (sqlite: DatabaseSync, id: string, workspace: string, repositoryId: string, created = '2026-02-01') =>
  sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
    VALUES (?, ?, 'github', 'github.com', ?, ?, 'main', 0, ?)`).run(id, workspace, repositoryId, `acme/${id}`, created);
const sources = (sqlite: DatabaseSync) => sqlite.prepare('SELECT id, workspace_id, kind, repository_binding_id, created_at FROM workspace_sources ORDER BY id')
  .all().map(row => ({ ...row }));

test('every existing repository becomes a git source of its workspace, with its id and creation time', () => {
  const sqlite = fixture();
  insertRepository(sqlite, 'r1', 'one', '1', '2026-01-05');
  insertRepository(sqlite, 'r2', 'two', '2', '2026-01-06');
  migrate(sqlite, [sourcesMigration]);
  assert.deepEqual(sources(sqlite), [
    { id: 'r1', workspace_id: 'one', kind: 'git', repository_binding_id: 'r1', created_at: '2026-01-05' },
    { id: 'r2', workspace_id: 'two', kind: 'git', repository_binding_id: 'r2', created_at: '2026-01-06' },
  ]);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('binding a repository adds its source; removing it, or its workspace, removes the source', () => {
  const sqlite = fixture();
  migrate(sqlite, [sourcesMigration]);
  insertRepository(sqlite, 'r1', 'one', '1');
  insertRepository(sqlite, 'r2', 'one', '2');
  insertRepository(sqlite, 'r3', 'two', '3');
  assert.deepEqual(sources(sqlite).map(row => [row.id, row.workspace_id]), [['r1', 'one'], ['r2', 'one'], ['r3', 'two']]);
  sqlite.exec("DELETE FROM workspace_repositories WHERE id = 'r1'");
  assert.deepEqual(sources(sqlite).map(row => row.id), ['r2', 'r3']);
  sqlite.exec("DELETE FROM workspaces WHERE id = 'one'");
  assert.deepEqual(sources(sqlite).map(row => row.id), ['r3']);
  // A repository that can't be bound (the per-workspace limit) leaves no source behind.
  for (const index of [4, 5, 6, 7]) insertRepository(sqlite, `r${index}`, 'two', String(index));
  assert.throws(() => insertRepository(sqlite, 'r8', 'two', '8'), /limit/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_sources WHERE workspace_id = 'two'").get()!.n, 5);
});

test('sources are immutable, and a git source needs its own repository in its own workspace', () => {
  const sqlite = fixture();
  migrate(sqlite, [sourcesMigration]);
  insertRepository(sqlite, 'r1', 'one', '1');
  assert.throws(() => sqlite.exec("UPDATE workspace_sources SET workspace_id = 'two' WHERE id = 'r1'"), /immutable/);
  const insert = sqlite.prepare(`INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at) VALUES (?, ?, ?, ?, '2026-03-01')`);
  assert.throws(() => insert.run('missing', 'one', 'git', 'missing'), /needs its workspace repository/);
  assert.throws(() => insert.run('r1-elsewhere', 'two', 'git', 'r1'), /needs its workspace repository|CHECK|UNIQUE/);
  assert.throws(() => insert.run('other-id', 'one', 'git', 'r1'), /CHECK|UNIQUE/);
  assert.throws(() => insert.run('no-binding', 'one', 'git', null), /needs its workspace repository|CHECK/);
  assert.throws(() => insert.run('notion', 'one', 'notion', null), /CHECK/);
  assert.deepEqual(sources(sqlite).map(row => row.id), ['r1']);
});
