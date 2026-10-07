import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConstraintError, openDatabase, sqliteHandle, type Database } from '../apps/server/src/db/index.js';

// Conformance suite: every provider must give application code the same observable behaviour.

const postgresUrl = process.env.TEST_DATABASE_URL;
const providers: { name: 'sqlite' | 'postgres'; url: string | undefined }[] = [
  { name: 'sqlite', url: 'sqlite::memory:' },
  { name: 'postgres', url: postgresUrl },
];

async function open(t: TestContext, url: string): Promise<Database> {
  const db = await openDatabase(url);
  t.after(() => db.close());
  if (db.provider === 'postgres') {
    // The test database is disposable: start every test from an empty schema.
    await db.query('DROP SCHEMA public CASCADE').run();
    await db.query('CREATE SCHEMA public').run();
  }
  await db.migrate();
  return db;
}

const at = '2026-01-01T00:00:00.000Z';
async function seed(db: Database): Promise<void> {
  await db.batch([
    db.query('INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('u1', 'Ada', 'Ada', 'ada@example.com', 'test', at),
    db.query('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').bind('w1', 'Workspace', 'u1', at),
    db.query('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind('w1', 'u1', 'owner', at),
    db.query('INSERT INTO models (id, workspace_id, name, provider, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('m1', 'w1', 'Model', 'openai', 'gpt', at),
    db.query('INSERT INTO agents (id, author_id, created_at) VALUES (?, ?, ?)').bind('a1', 'u1', at),
  ]);
}
const insertVersion = `INSERT INTO agent_versions (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`;
const versionValues = (id: string, version: number) => [id, 'a1', 'u1', version, 'Agent', 'desc', 'do things', '["read"]', 'm1', at] as const;

async function constraintError(operation: Promise<unknown>): Promise<ConstraintError> {
  try { await operation; } catch (error) {
    assert.ok(error instanceof ConstraintError, `expected ConstraintError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the statement to be rejected');
}

for (const provider of providers) {
  test(`${provider.name} provider`, { skip: provider.url ? false : 'TEST_DATABASE_URL is not set; skipping the Postgres conformance run' }, async t => {
    const url = provider.url!;

    await t.test('migrates from empty, records every file once, and is idempotent', async t => {
      const db = await open(t, url);
      assert.equal(db.provider, provider.name);
      const files = readdirSync(new URL(`../apps/server/migrations/${provider.name}/`, import.meta.url)).filter(name => name.endsWith('.sql')).sort();
      assert.ok(files.length > 0);
      const applied = await db.query<{ name: string; applied_at: string }>('SELECT name, applied_at FROM schema_migrations ORDER BY name').all();
      assert.deepEqual(applied.map(row => row.name), files);
      assert.ok(applied.every(row => !Number.isNaN(Date.parse(row.applied_at))));
      await db.migrate();
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM schema_migrations').first('n'), files.length);
      // The final schema is reachable: the last migration's table and the first one's trigger both exist.
      assert.deepEqual(await db.query('SELECT * FROM push_credentials').all(), []);
      await seed(db);
      await db.query(insertVersion).bind(...versionValues('v1', 1)).run();
      const error = await constraintError(db.query('DELETE FROM agent_versions WHERE id = ?').bind('v1').run());
      assert.equal(error.constraint, 'agent versions are immutable');
    });

    await t.test('first, all and run semantics', async t => {
      const db = await open(t, url);
      await seed(db);
      assert.deepEqual(await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ?').bind('u1').first(),
        { id: 'u1', display_name: 'Ada' });
      assert.equal(await db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?').bind('u1').first('display_name'), 'Ada');
      assert.equal(await db.query('SELECT * FROM users WHERE id = ?').bind('nobody').first(), null);
      assert.equal(await db.query<{ id: string }>('SELECT id FROM users WHERE id = ?').bind('nobody').first('id'), null);
      assert.equal(await db.query<{ github_id: string | null }>('SELECT github_id FROM users WHERE id = ?').bind('u1').first('github_id'), null);
      assert.deepEqual(await db.query('SELECT * FROM workspace_members ORDER BY user_id').all(), [{ workspace_id: 'w1', user_id: 'u1', role: 'owner', created_at: at }]);
      assert.deepEqual(await db.query('SELECT id FROM users WHERE id = ?').bind('nobody').all(), []);
      // run(): changes counts written rows and is 0 for reads.
      assert.deepEqual(await db.query('SELECT * FROM users').run(), { changes: 0 });
      assert.deepEqual(await db.query('UPDATE users SET display_name = ? WHERE id = ?').bind('Grace', 'u1').run(), { changes: 1 });
      assert.deepEqual(await db.query('UPDATE users SET display_name = ? WHERE id = ?').bind('Grace', 'nobody').run(), { changes: 0 });
      const expiresAt = Date.now() + 60_000;
      await db.query('INSERT INTO oauth_states (state_hash, verifier, expires_at, created_at) VALUES (?, ?, ?, ?)').bind('s1', 'v', expiresAt, at).run();
      await db.query('INSERT INTO oauth_states (state_hash, verifier, expires_at, created_at) VALUES (?, ?, ?, ?)').bind('s2', 'v', expiresAt, at).run();
      // RETURNING statements work through run() (changes reported) and through first().
      assert.deepEqual(await db.query('DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier').bind('s1').run(), { changes: 1 });
      assert.deepEqual(await db.query<{ verifier: string; expires_at: number }>('DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier, expires_at').bind('s2').first(),
        { verifier: 'v', expires_at: expiresAt });
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM oauth_states').first('n'), 0);
    });

    await t.test('integers round-trip as numbers beyond 32 bits and counts are numbers', async t => {
      const db = await open(t, url);
      await seed(db);
      const expiresAt = Date.now() + 3_600_000;
      await db.query('INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind('t1', 'u1', 'csrf', expiresAt, at).run();
      const row = await db.query<{ expires_at: number }>('SELECT expires_at FROM auth_sessions WHERE token_hash = ?').bind('t1').first();
      assert.deepEqual(row, { expires_at: expiresAt });
      assert.equal(typeof row!.expires_at, 'number');
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at > ?').bind(Date.now()).first('n'), 1);
      assert.equal(await db.query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_versions WHERE agent_id = ?').bind('a1').first('next'), 1);
    });

    await t.test('batch returns results and changes in order and is atomic', async t => {
      const db = await open(t, url);
      await seed(db);
      const results = await db.batch([
        db.query(insertVersion).bind(...versionValues('v1', 1)),
        db.query<{ id: string; version: number }>('SELECT id, version FROM agent_versions WHERE agent_id = ? ORDER BY version').bind('a1'),
        db.query('UPDATE users SET display_name = ? WHERE id = ?').bind('Grace', 'u1'),
      ]);
      assert.deepEqual(results, [
        { results: [], changes: 1 },
        { results: [{ id: 'v1', version: 1 }], changes: 0 },
        { results: [], changes: 1 },
      ]);
      // A CHECK failure in the second statement rolls back the first.
      const error = await constraintError(db.batch([
        db.query(insertVersion).bind(...versionValues('v2', 2)),
        db.query('INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind('u2', 'Bad', 'Bad', 'bad@example.com', 'bogus', at),
      ]));
      assert.match(error.constraint, /auth_kind/);
      assert.deepEqual(await db.query<{ id: string }>('SELECT id FROM agent_versions ORDER BY id').all(), [{ id: 'v1' }]);
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM users').first('n'), 1);
      // The database stays usable after a rolled-back batch.
      assert.deepEqual(await db.query('UPDATE users SET display_name = ? WHERE id = ?').bind('Ada', 'u1').run(), { changes: 1 });
    });

    await t.test('changes() inside a batch refers to the previous statement of that batch', async t => {
      const db = await open(t, url);
      await seed(db);
      const audit = (id: string) => db.query(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
        SELECT ?, ?, NULL, ?, ?, ?, ? WHERE changes() = 1`).bind(id, 'w1', 'u1', 'test', '{}', at);
      const results = await db.batch([
        db.query('UPDATE workspaces SET name = ? WHERE id = ?').bind('Renamed', 'w1'),
        audit('audit-1'),
        db.query('UPDATE workspaces SET name = ? WHERE id = ?').bind('Nope', 'missing'),
        audit('audit-2'),
        db.query('SELECT 1 AS one'),
        audit('audit-3'),
      ]);
      assert.deepEqual(results.map(result => result.changes), [1, 1, 0, 0, 0, 0]);
      assert.deepEqual(await db.query<{ id: string }>('SELECT id FROM audit ORDER BY id').all(), [{ id: 'audit-1' }]);
    });

    await t.test('transaction commits, rolls back on failure, and exposes changes() per transaction', async t => {
      const db = await open(t, url);
      await seed(db);
      const committed = await db.transaction(async tx => {
        await tx.query('UPDATE workspaces SET name = ? WHERE id = ?').bind('Inside', 'w1').run();
        return tx.query<{ n: number }>('SELECT 1 AS n WHERE changes() = 1').first('n');
      });
      assert.equal(committed, 1);
      assert.equal(await db.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind('w1').first('name'), 'Inside');
      await assert.rejects(db.transaction(async tx => {
        await tx.query('UPDATE workspaces SET name = ? WHERE id = ?').bind('Rolled back', 'w1').run();
        throw new Error('abort');
      }), /abort/);
      assert.equal(await db.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind('w1').first('name'), 'Inside');
      const error = await constraintError(db.transaction(async tx => {
        await tx.query(insertVersion).bind(...versionValues('v1', 1)).run();
        await tx.query(insertVersion).bind(...versionValues('v2', 1)).run();
      }));
      assert.match(error.constraint, /agent_versions/);
      assert.deepEqual(await db.query('SELECT id FROM agent_versions').all(), []);
    });

    await t.test('ConstraintError for UNIQUE, trigger RAISE, CHECK and FOREIGN KEY violations', async t => {
      const db = await open(t, url);
      await seed(db);
      await db.query(insertVersion).bind(...versionValues('v1', 1)).run();
      const unique = await constraintError(db.query(insertVersion).bind(...versionValues('v2', 1)).run());
      // Both providers' texts match the pattern catalog.ts uses to report a version conflict.
      assert.match(unique.constraint, /agent_versions\.agent_id,\s*agent_versions\.version|agent_versions_agent_id_version_key/);
      assert.ok(unique.cause instanceof Error);
      const trigger = await constraintError(db.query('UPDATE agent_versions SET name = ? WHERE id = ?').bind('Renamed', 'v1').run());
      assert.equal(trigger.constraint, 'agent versions are immutable');
      assert.equal(trigger.message, 'agent versions are immutable');
      const check = await constraintError(db.query(insertVersion).bind(...versionValues('v3', 0)).run());
      assert.match(check.constraint, /version/);
      const foreignKey = await constraintError(db.query('INSERT INTO agents (id, author_id, created_at) VALUES (?, ?, ?)').bind('a2', 'ghost', at).run());
      assert.match(foreignKey.constraint, /FOREIGN KEY|foreign key/);
      const paired = await constraintError(db.query(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('s1', 'w1', 'u1', 'v1', 'Title', 1, 'ready', at, 'c1', null).run());
      assert.equal(paired.constraint, 'session connector binding must be paired');
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM agent_versions').first('n'), 1);
    });

    await t.test('binary values round-trip', async t => {
      const db = await open(t, url);
      await db.query(`CREATE TABLE blobs (id TEXT PRIMARY KEY, body ${provider.name === 'sqlite' ? 'BLOB' : 'BYTEA'} NOT NULL)`).run();
      const body = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 39, 92]);
      assert.deepEqual(await db.query('INSERT INTO blobs (id, body) VALUES (?, ?)').bind('b1', body).run(), { changes: 1 });
      const stored = await db.query<{ body: Uint8Array }>('SELECT body FROM blobs WHERE id = ?').bind('b1').first('body');
      assert.ok(stored instanceof Uint8Array);
      assert.deepEqual([...stored], [...body]);
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM blobs WHERE body = ?').bind(body).first('n'), 1);
    });

    await t.test('dialect features behave the same at runtime', async t => {
      const db = await open(t, url);
      await seed(db);
      await db.query(`INSERT INTO connectors (id, owner_id, name, credential_hash, created_at, connection_hash, models_json, capabilities_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind('c1', 'u1', 'Host', 'cred', at, null,
        '[{"provider":"openai","modelId":"gpt","name":"GPT"},{"provider":"anthropic","modelId":"claude","name":"Claude"}]',
        '{"platform":"linux","sandbox":true,"gitPush":true}').run();
      await db.query('INSERT INTO connector_workspaces (connector_id, workspace_id, created_at) VALUES (?, ?, ?)').bind('c1', 'w1', at).run();
      // json_each over a column with json_extract on each element (connectors.ts model sync, with randomblob ids).
      const synced = await db.query(`INSERT INTO models
        (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
        SELECT lower(hex(randomblob(16))), cw.workspace_id, json_extract(local.value, '$.name'),
          json_extract(local.value, '$.provider'), json_extract(local.value, '$.modelId'), ?, c.id, c.owner_id, 1
        FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
        JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
        JOIN json_each(c.models_json) local
        WHERE c.id = ? AND c.revoked_at IS NULL AND c.models_json = ? AND (? IS NULL OR cw.workspace_id = ?)
        ON CONFLICT (workspace_id, connector_id, provider, model_id) DO UPDATE SET name = excluded.name, available = 1`)
        .bind(at, 'c1', await db.query<{ models_json: string }>('SELECT models_json FROM connectors WHERE id = ?').bind('c1').first('models_json'), null, null).run();
      assert.deepEqual(synced, { changes: 2 });
      const models = await db.query<{ id: string; name: string; provider: string; model_id: string }>('SELECT id, name, provider, model_id FROM models WHERE connector_id = ? ORDER BY provider').bind('c1').all();
      assert.deepEqual(models.map(({ name, provider, model_id }) => ({ name, provider, model_id })),
        [{ name: 'Claude', provider: 'anthropic', model_id: 'claude' }, { name: 'GPT', provider: 'openai', model_id: 'gpt' }]);
      assert.ok(models.every(model => /^[0-9a-f]{32}$/.test(model.id)));
      // json_each over a bound JSON array of strings.
      assert.deepEqual(await db.query<{ id: string }>('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').bind('["u1","zz"]').all(), [{ id: 'u1' }]);
      // IS ? with null and with a value; ? IS NULL guards.
      assert.deepEqual(await db.query('UPDATE connectors SET connection_hash = ? WHERE id = ? AND connection_hash IS ?').bind('h1', 'c1', null).run(), { changes: 1 });
      assert.deepEqual(await db.query('UPDATE connectors SET connection_hash = ? WHERE id = ? AND connection_hash IS ?').bind('h2', 'c1', null).run(), { changes: 0 });
      assert.deepEqual(await db.query('UPDATE connectors SET connection_hash = ? WHERE id = ? AND connection_hash IS ?').bind('h2', 'c1', 'h1').run(), { changes: 1 });
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM connectors WHERE (? IS NULL OR id = ?)').bind(null, 'other').first('n'), 1);
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM connectors WHERE (? IS NULL OR id = ?)').bind('x', 'other').first('n'), 0);
      // json_type on capabilities (sessions.ts) and the canonical json() comparison of an ordered aggregate.
      assert.equal(await db.query("SELECT COUNT(*) AS n FROM connectors WHERE json_type(capabilities_json, '$.gitPush') = 'true'").first('n'), 1);
      assert.equal(await db.query("SELECT COUNT(*) AS n FROM connectors WHERE json_type(capabilities_json, '$.gitProviders') = 'true'").first('n'), 0);
      await db.query(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('r2', 'w1', 'github', 'github.com', '2', 'Acme/Two', 'main', 0, at).run();
      await db.query(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('r1', 'w1', 'github', 'github.com', '1', 'Acme/One', 'main', 1, at).run();
      const same = (ids: string[]) => db.query('SELECT COUNT(*) AS n FROM users WHERE (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories WHERE workspace_id = ?) = json(?)')
        .bind('w1', JSON.stringify(ids)).first('n');
      assert.equal(await same(['r1', 'r2']), 1);
      assert.equal(await same(['r2', 'r1']), 0);
      assert.equal(await same([]), 0);
      assert.equal(await db.query('SELECT COUNT(*) AS n FROM users WHERE (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories WHERE workspace_id = ?) = json(?)').bind('none', '[]').first('n'), 1);
      // COLLATE NOCASE equality and uniqueness; GLOB-derived CHECKs.
      assert.equal(await db.query('SELECT id FROM workspace_repositories WHERE workspace_id = ? AND full_name = ? COLLATE NOCASE').bind('w1', 'acme/one').first('id'), 'r1');
      const duplicate = await constraintError(db.query(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('r3', 'w1', 'github', 'github.com', '3', 'ACME/ONE', 'main', 0, at).run());
      assert.match(duplicate.constraint, /full_name/);
      const leadingZero = await constraintError(db.query(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('r4', 'w1', 'github', 'github.com', '01', 'Acme/Four', 'main', 0, at).run());
      assert.match(leadingZero.constraint, /repository_id/);
      // json_array / json_group_array columns parse as JSON arrays; json_set updates one key.
      const arrays = await db.query<{ one: string; none: string; every: string }>(`SELECT json_array(id) AS one, json_array() AS none,
        (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories) AS every FROM workspaces WHERE id = ?`).bind('w1').first();
      assert.deepEqual({ one: JSON.parse(arrays!.one), none: JSON.parse(arrays!.none), every: JSON.parse(arrays!.every) }, { one: ['w1'], none: [], every: ['r1', 'r2'] });
      await db.query(`INSERT INTO push_identities (id, workspace_id, provider, host, scope, kind, config_json, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('p1', 'w1', 'gitlab', 'gitlab.com', '', 'oauth-refresh', '{"clientId":"abc"}', 'authorization_required', 'u1', at, at).run();
      await db.query("UPDATE push_identities SET config_json = json_set(config_json, '$.login', ?) WHERE id = ?").bind('octo', 'p1').run();
      assert.deepEqual(JSON.parse((await db.query<{ config_json: string }>('SELECT config_json FROM push_identities WHERE id = ?').bind('p1').first('config_json'))!),
        { clientId: 'abc', login: 'octo' });
      // Mixed-case aliases keep their case.
      assert.deepEqual(await db.query('SELECT user_id AS userId, role AS memberRole FROM workspace_members').all(), [{ userId: 'u1', memberRole: 'owner' }]);
      // The workspace repository cap trigger fires with the SQLite message.
      for (const n of [5, 6, 7]) {
        await db.query(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(`r${n}`, 'w1', 'github', 'github.com', String(n), `Acme/${n}`, 'main', 0, at).run();
      }
      const limit = await constraintError(db.query(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('r8', 'w1', 'github', 'github.com', '8', 'Acme/8', 'main', 0, at).run());
      assert.equal(limit.constraint, 'workspace repository limit reached');
    });

    await t.test('concurrent transactions and outside statements do not interleave', async t => {
      const db = await open(t, url);
      await seed(db);
      const insert = (id: string) => db.query('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').bind(id, id, 'u1', at);
      const failing = db.transaction(async tx => {
        await tx.query('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').bind('in-failed', 'x', 'u1', at).run();
        await sleep(40);
        throw new Error('abort');
      });
      await sleep(5);
      // Issued while the failing transaction is open: a plain statement, a second transaction, and a batch.
      const outside = insert('outside').run();
      const second = db.transaction(async tx => {
        await tx.query('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').bind('in-second', 'x', 'u1', at).run();
        await sleep(10);
        return tx.query('SELECT COUNT(*) AS n FROM workspaces WHERE id IN (?, ?)').bind('in-second', 'in-failed').first('n');
      });
      const batch = db.batch([insert('in-batch'), db.query('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').bind('in-failed')]);
      await assert.rejects(failing, /abort/);
      await outside;
      assert.equal(await second, 1);
      assert.equal((await batch)[1].results[0]?.n, 0);
      assert.deepEqual(await db.query<{ id: string }>('SELECT id FROM workspaces WHERE id <> ? ORDER BY id').bind('w1').all(),
        [{ id: 'in-batch' }, { id: 'in-second' }, { id: 'outside' }]);
      if (db.provider === 'sqlite') {
        // Read-modify-write transactions are serialized on the single connection: no lost update.
        await db.query('UPDATE workspaces SET name = ? WHERE id = ?').bind('0', 'w1').run();
        await Promise.all([1, 2, 3].map(() => db.transaction(async tx => {
          const name = await tx.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind('w1').first('name');
          await sleep(5);
          await tx.query('UPDATE workspaces SET name = ? WHERE id = ?').bind(String(Number(name) + 1), 'w1').run();
        })));
        assert.equal(await db.query<{ name: string }>('SELECT name FROM workspaces WHERE id = ?').bind('w1').first('name'), '3');
      }
    });
  });
}

test('sqlite file databases use WAL, foreign keys and relative URLs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pistead-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = await openDatabase(`sqlite://${join(directory, 'nested', 'control-plane.sqlite')}`);
  t.after(() => db.close());
  const handle = sqliteHandle(db);
  assert.equal(handle.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(handle.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.equal(handle.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
  await db.migrate();
  assert.equal(await db.query('SELECT COUNT(*) AS n FROM schema_migrations').first('n'), readdirSync(new URL('../apps/server/migrations/sqlite/', import.meta.url)).length);
  const previous = process.cwd();
  process.chdir(directory);
  try {
    const relative = await openDatabase('sqlite:./relative.sqlite');
    t.after(() => relative.close());
    await relative.query('CREATE TABLE t (a INTEGER)').run();
    assert.ok(readdirSync(directory).includes('relative.sqlite'));
  } finally {
    process.chdir(previous);
  }
  await assert.rejects(openDatabase('sqlite://host/db'), /sqlite::memory:/);
  await assert.rejects(openDatabase('mysql://x'), /DATABASE_URL/);
  assert.throws(() => sqliteHandle({ provider: 'postgres' } as unknown as Database), /sqlite provider/);
});
