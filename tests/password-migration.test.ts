import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "../apps/server/src/db/sqlite.js";

const directory = fileURLToPath(new URL("../apps/server/migrations/sqlite/", import.meta.url));
const passwordMigration = "0038_password_sign_in.sql";
const migrationFiles = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();

/** A database migrated up to (not including) the password migration, through the server's own runner. */
async function before(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pistead-password-migration-"));
  const migrations = join(root, "migrations");
  const path = join(root, "control-plane.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(migrations);
  assert.ok(migrationFiles.includes(passwordMigration));
  for (const file of migrationFiles.filter(name => name < passwordMigration)) copyFileSync(join(directory, file), join(migrations, file));
  const db = new SqliteDatabase(path, migrations);
  t.after(() => db.close());
  await db.migrate();
  return { db, migrations };
}

test("rebuilding users keeps every row that references it, also those whose references cascade on delete", async t => {
  const { db, migrations } = await before(t);
  db.handle.exec(`
    INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, auth_kind, created_at, suspended_at)
      VALUES ('github:1', '1', 'octo', 'Octo', 'Octo', 'octo@example.test', 'github', '2026-01-01', NULL),
             ('test:t', NULL, NULL, 'T', 'T', 't@example.test', 'test', '2026-01-02', '2026-02-01');
    INSERT INTO github_tokens (user_id, ciphertext, updated_at) VALUES ('github:1', 'sealed', '2026-01-01');
    INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, created_at, client) VALUES ('h', 'github:1', 'c', 99999999999999, '2026-01-01', 'browser');
    INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('w', 'Team', 'github:1', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('w', 'github:1', 'owner', '2026-01-01'), ('w', 'test:t', 'member', '2026-01-01');
  `);
  const users = db.handle.prepare("SELECT * FROM users ORDER BY id").all();

  copyFileSync(join(directory, passwordMigration), join(migrations, passwordMigration));
  await db.migrate();

  assert.deepEqual(db.handle.prepare("SELECT * FROM users ORDER BY id").all(), users);
  assert.equal(db.handle.prepare("SELECT COUNT(*) AS n FROM github_tokens").get()!.n, 1);
  assert.equal(db.handle.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()!.n, 1);
  assert.equal(db.handle.prepare("SELECT COUNT(*) AS n FROM workspace_members").get()!.n, 2);
  assert.deepEqual(db.handle.prepare("PRAGMA foreign_key_check").all(), []);
  // Foreign keys are on again, and the references still point at users.
  assert.equal(db.handle.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.throws(() => db.handle.exec("INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, created_at, client) VALUES ('x', 'nobody', 'c', 1, '2026-01-01', 'browser')"), /FOREIGN KEY/);
  db.handle.exec("DELETE FROM users WHERE id = 'github:1' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_id = 'github:1')");
  // Password accounts are allowed now; other kinds still aren't.
  db.handle.exec("INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('password:alice', 'A', 'A', 'a@example.test', 'password', '2026-03-01')");
  assert.throws(() => db.handle.exec("INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('x', 'X', 'X', 'x@example.test', 'saml', '2026-03-01')"), /CHECK/);
  // The unique GitHub ID survived the rebuild.
  assert.throws(() => db.handle.exec("INSERT INTO users (id, github_id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('github:2', '1', 'X', 'X', 'x@example.test', 'github', '2026-03-01')"), /UNIQUE/);
});

test("a foreign-keys-off migration that leaves a broken reference rolls back, and foreign keys come back on", async t => {
  const { db, migrations } = await before(t);
  db.handle.exec(`INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('test:t', 'T', 'T', 't@example.test', 'test', '2026-01-02');
    INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, created_at, client) VALUES ('h', 'test:t', 'c', 1, '2026-01-01', 'browser');`);
  writeFileSync(join(migrations, "9999_broken.sql"), "-- pistead: foreign-keys-off\nDELETE FROM users;\n");
  await assert.rejects(db.migrate(), /references/);
  assert.equal(db.handle.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 1);
  assert.equal(db.handle.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '9999_broken.sql'").get()!.n, 0);
  assert.equal(db.handle.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
});
