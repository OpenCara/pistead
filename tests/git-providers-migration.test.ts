import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { applySqliteMigrations } from './helpers/sqlite-migrations.js';

const directory = new URL('../apps/server/migrations/sqlite/', import.meta.url);
const providerMigration = '0007_git_providers.sql';
const migrationFiles = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const pins = JSON.stringify([{ bindingId: 'binding-1', repositoryId: 123, fullName: 'Owner/Project',
  ref: 'main', commit: 'a'.repeat(40), path: 'Owner/Project' }]);

function migrate(sqlite: DatabaseSync, files: string[]) {
  applySqliteMigrations(sqlite, directory, files);
}

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  assert.ok(migrationFiles.includes(providerMigration));
  migrate(sqlite, migrationFiles.filter(file => file < providerMigration));
  sqlite.exec(`
    INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at)
      VALUES ('owner', 'Owner', 'Owner', 'owner@example.test', 'test', '2026-01-01'),
             ('other', 'Other', 'Other', 'other@example.test', 'test', '2026-01-01');
    INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('workspace', 'Workspace', 'owner', '2026-01-01');
    INSERT INTO models (id, workspace_id, name, provider, model_id, created_at)
      VALUES ('model', 'workspace', 'Faux', 'faux', 'faux-v1', '2026-01-01');
    INSERT INTO agents (id, author_id, created_at) VALUES ('agent', 'owner', '2026-01-01');
    INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
      VALUES ('version', 'agent', 'owner', 'workspace', 1, 'Agent', '', '', '[]', 'model', '2026-01-01');
    INSERT INTO workspace_repositories (id, workspace_id, repository_id, full_name, ref, private, created_at)
      VALUES ('binding-1', 'workspace', 123, 'Owner/Project', 'main', 1, '2026-01-01'),
             ('binding-2', 'workspace', 9007199254740991, 'Owner/Large', 'release/v1', 0, '2026-01-02');
  `);
  sqlite.prepare(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, status, created_at, repositories_json)
    VALUES ('pinned', 'workspace', 'owner', 'version', 'Pinned', 'ready', '2026-01-01', ?)`).run(pins);
  migrate(sqlite, [providerMigration]);
  return sqlite;
}

test('existing bindings become GitHub bindings with decimal-text identities and sessions keep their exact pins', t => {
  const sqlite = fixture(t);
  assert.deepEqual(sqlite.prepare(`SELECT id, workspace_id, provider, host, repository_id, typeof(repository_id) AS type, full_name, ref, private, created_at
    FROM workspace_repositories ORDER BY id`).all().map(row => ({ ...row })), [
    { id: 'binding-1', workspace_id: 'workspace', provider: 'github', host: 'github.com', repository_id: '123', type: 'text',
      full_name: 'Owner/Project', ref: 'main', private: 1, created_at: '2026-01-01' },
    { id: 'binding-2', workspace_id: 'workspace', provider: 'github', host: 'github.com', repository_id: '9007199254740991', type: 'text',
      full_name: 'Owner/Large', ref: 'release/v1', private: 0, created_at: '2026-01-02' },
  ]);
  assert.equal(sqlite.prepare("SELECT repositories_json FROM sessions WHERE id = 'pinned'").get()!.repositories_json, pins);
  assert.throws(() => sqlite.prepare("UPDATE sessions SET repositories_json = '[]' WHERE id = 'pinned'").run(), /immutable/);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('rebuilt bindings keep the cap and immutability triggers and scope uniqueness by provider and host', t => {
  const sqlite = fixture(t);
  const insert = sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
    VALUES (?, 'workspace', ?, ?, ?, ?, 'main', 0, '2026-01-03')`);
  for (const column of ['id', 'provider', 'host', 'repository_id', 'full_name', 'ref', 'private']) {
    assert.throws(() => sqlite.exec(`UPDATE workspace_repositories SET ${column} = ${column}`), /immutable/);
  }
  assert.throws(() => insert.run('same-id', 'github', 'github.com', '123', 'Other/Name'), /UNIQUE/);
  assert.throws(() => insert.run('same-name', 'github', 'github.com', '456', 'owner/PROJECT'), /UNIQUE/);
  // The same identity or name on another provider or host is a different repository.
  insert.run('gitlab', 'gitlab', 'gitlab.com', '123', 'owner/project');
  insert.run('gitea', 'gitea', 'git.acme.dev', '123', 'owner/project');
  assert.throws(() => insert.run('gitea-name', 'gitea', 'git.acme.dev', '124', 'OWNER/Project'), /UNIQUE/);
  insert.run('fifth', 'bitbucket', 'bitbucket.org', '{c0ffee}', 'owner/project');
  assert.throws(() => insert.run('sixth', 'azure-devops', 'dev.azure.com', 'uuid', 'org/project/repo'), /repository limit/);
  sqlite.exec("DELETE FROM workspace_repositories WHERE id = 'fifth'");
  for (const [provider, host, repositoryId] of [
    ['svn', 'svn.example.com', '1'], ['github', 'ghe.acme.dev', '1'], ['github', 'github.com', 'abc'], ['github', 'github.com', '0'],
    ['github', 'github.com', '01'], ['github', 'github.com', '12345678901234567'], ['gitlab', 'gitlab.com', ''], ['gitlab', '', '1'],
  ]) assert.throws(() => insert.run('invalid', provider!, host!, repositoryId!, 'x/y'), /CHECK/, `${provider} ${host} ${repositoryId}`);
});

test('git credentials are unique per user, provider, host and organization, token providers only, and cascade with the user', t => {
  const sqlite = fixture(t);
  const insert = sqlite.prepare(`INSERT INTO git_credentials (id, user_id, provider, host, organization, username, login, ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'login', 'v1.cipher', '2026-01-01', '2026-01-01')`);
  insert.run('gitlab', 'owner', 'gitlab', 'gitlab.com', '', null);
  assert.throws(() => insert.run('gitlab-again', 'owner', 'gitlab', 'gitlab.com', '', null), /UNIQUE/);
  insert.run('gitlab-other-user', 'other', 'gitlab', 'gitlab.com', '', null);
  insert.run('gitlab-self-managed', 'owner', 'gitlab', 'gitlab.acme.dev', '', null);
  insert.run('azure-a', 'owner', 'azure-devops', 'dev.azure.com', 'contoso', null);
  insert.run('azure-b', 'owner', 'azure-devops', 'dev.azure.com', 'fabrikam', null);
  insert.run('bitbucket', 'owner', 'bitbucket', 'bitbucket.org', '', 'me@example.test');
  assert.throws(() => insert.run('github', 'owner', 'github', 'github.com', '', null), /CHECK/);
  assert.throws(() => insert.run('missing-user', 'nobody', 'gitea', 'git.acme.dev', '', null), /FOREIGN KEY/);
  assert.equal(sqlite.prepare("SELECT organization FROM git_credentials WHERE id = 'gitlab'").get()!.organization, '');
  sqlite.exec("DELETE FROM users WHERE id = 'other'");
  assert.deepEqual(sqlite.prepare('SELECT id FROM git_credentials ORDER BY id').all().map(row => row.id),
    ['azure-a', 'azure-b', 'bitbucket', 'gitlab', 'gitlab-self-managed']);
});
