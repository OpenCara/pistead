import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

const directory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const repositoryMigration = '0005_repositories.sql';
const migrationFiles = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();

function migrate(sqlite: DatabaseSync, files: string[]) {
  for (const file of files) {
    sqlite.exec('BEGIN');
    try { sqlite.exec(readFileSync(new URL(file, directory), 'utf8')); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  assert.ok(migrationFiles.includes(repositoryMigration));
  migrate(sqlite, migrationFiles.filter(file => file < repositoryMigration));
  sqlite.exec(`
    INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
      VALUES ('owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at)
      VALUES ('workspace', 'Workspace', 'owner', '2026-01-01'), ('other', 'Other', 'owner', '2026-01-01');
    INSERT INTO models (id, workspace_id, name, provider, model_id, created_at)
      VALUES ('model', 'workspace', 'Faux', 'faux', 'faux-v1', '2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent', 'owner', '2026-01-01');
    INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
      VALUES ('version', 'agent', 'owner', 'workspace', 1, 'Agent', '', '', '[]', 'model', '2026-01-01');
    INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, status, created_at)
      VALUES ('legacy', 'workspace', 'owner', 'version', 'Legacy', 'ready', '2026-01-01');
    INSERT INTO connector_pairings (id, owner_id, name, code_hash, expires_at, created_at)
      VALUES ('legacy-pairing', 'owner', 'Local Pi', 'code-hash', 1234567890, '2026-01-01');
  `);
  migrate(sqlite, [repositoryMigration]);
  return sqlite;
}

test('repository migration preserves legacy sessions and pairings and enforces immutable JSON arrays', t => {
  const sqlite = fixture(t);
  assert.equal(sqlite.prepare("SELECT repositories_json FROM sessions WHERE id = 'legacy'").get()!.repositories_json, '[]');
  assert.equal(sqlite.prepare("SELECT workspace_id FROM connector_pairings WHERE id = 'legacy-pairing'").get()!.workspace_id, null);
  const insert = sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, status, created_at, repositories_json)
    VALUES (?, 'workspace', 'owner', 'version', 'Pinned', 'ready', '2026-01-01', ?)`);
  const pins = JSON.stringify([{ bindingId: 'removed-binding', repositoryId: 123, fullName: 'Owner/Project',
    ref: 'main', commit: 'a'.repeat(40), path: 'Owner/Project' }]);
  insert.run('pinned', pins);
  assert.equal(sqlite.prepare("SELECT repositories_json FROM sessions WHERE id = 'pinned'").get()!.repositories_json, pins);
  for (const value of [null, '{', '{}', 'null', '"text"', '1']) {
    assert.throws(() => insert.run('invalid', value));
  }
  for (const value of ['[]', pins]) {
    assert.throws(() => sqlite.prepare("UPDATE sessions SET repositories_json = ? WHERE id = 'pinned'").run(value), /immutable/);
  }
  sqlite.exec("UPDATE sessions SET title = 'Renamed', status = 'archived' WHERE id = 'pinned'");
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('workspace bindings enforce immutable rows, numeric identity and case-insensitive names per workspace', t => {
  const sqlite = fixture(t);
  const insert = sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at)
    VALUES (?, ?, ?, ?, 'main', ?, '2026-01-01')`);
  insert.run('first', 'workspace', 123, 'Owner/Project', 1);
  assert.throws(() => insert.run('same-id', 'workspace', 123, 'Other/Project', 0), /UNIQUE/);
  assert.throws(() => insert.run('same-name', 'workspace', 456, 'owner/PROJECT', 0), /UNIQUE/);
  insert.run('other-workspace', 'other', 123, 'owner/project', 0);
  assert.throws(() => insert.run('missing-workspace', 'missing', 456, 'Other/Project', 0), /FOREIGN KEY/);
  for (const value of [0, -1, 1.5, 9007199254740992, 'not-a-number']) {
    assert.throws(() => insert.run('invalid-id', 'workspace', value, 'Other/Project', 0), /CHECK/);
  }
  assert.throws(() => insert.run('invalid-private', 'workspace', 456, 'Other/Project', 2), /CHECK/);
  for (const column of ['id', 'workspace_id', 'repository_id', 'full_name', 'ref', 'private', 'created_at']) {
    assert.throws(() => sqlite.exec(`UPDATE workspace_repositories SET ${column} = ${column}`), /immutable/);
  }
  sqlite.exec("DELETE FROM workspace_repositories WHERE id = 'first'");
  insert.run('replacement', 'workspace', 123, 'OWNER/project', 1);
  sqlite.exec("DELETE FROM workspaces WHERE id = 'other'");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_repositories WHERE workspace_id = 'other'").get()!.n, 0);
});

test('workspace cap rejects a multi-row overflow atomically and allows reuse of a deleted slot', t => {
  const sqlite = fixture(t);
  const insert = sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at)
    VALUES (?, 'workspace', ?, ?, 'main', 0, '2026-01-01')`);
  for (let index = 1; index <= 4; index++) insert.run(`binding-${index}`, index, `Owner/Repo${index}`);
  assert.throws(() => sqlite.exec(`INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at)
    VALUES ('fifth', 'workspace', 5, 'Owner/Repo5', 'main', 0, '2026-01-01'),
           ('sixth', 'workspace', 6, 'Owner/Repo6', 'main', 0, '2026-01-01')`), /repository limit/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 4);
  insert.run('fifth', 5, 'Owner/Repo5');
  assert.throws(() => insert.run('sixth', 6, 'Owner/Repo6'), /repository limit/);
  sqlite.exec("DELETE FROM workspace_repositories WHERE id = 'binding-1'");
  insert.run('sixth', 6, 'Owner/Repo6');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_repositories').get()!.n, 5);
});

test('new connector pairings may be workspace-bound and reject nonexistent workspace references', t => {
  const sqlite = fixture(t);
  const insert = sqlite.prepare(`INSERT INTO connector_pairings (id, owner_id, name, code_hash, expires_at, created_at, workspace_id)
    VALUES (?, 'owner', 'Local Pi', 'code-hash', 1234567890, '2026-01-01', ?)`);
  insert.run('bound', 'workspace');
  insert.run('unbound', null);
  assert.throws(() => insert.run('invalid', 'missing'), /FOREIGN KEY/);
  assert.equal(sqlite.prepare("SELECT workspace_id FROM connector_pairings WHERE id = 'bound'").get()!.workspace_id, 'workspace');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
