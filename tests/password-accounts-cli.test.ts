import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { app } from "../apps/server/src/index.js";
import { openDatabase } from "../apps/server/src/db/index.js";
import { passwordCommand, PasswordCommandError, runPasswordCommand } from "../apps/server/src/password-accounts-cli.js";
import type { Env } from "../apps/server/src/types.js";
import type { UserProfile } from "../packages/shared/src/types.js";
import { testDatabase } from "./helpers/control-plane.js";

const origin = "http://localhost:8787";
const password = "correct horse battery";
const settings = { PASSWORD_AUTH: "true", ADMIN_USER_IDS: "github:1,password:root" };

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "password-cli-test-secret-not-for-deployment",
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"),
    PASSWORD_AUTH: "true", ADMIN_USER_IDS: settings.ADMIN_USER_IDS };
  const signIn = (username: string, typed: string) => app.request("/api/auth/password/login", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username, password: typed }) }, env);
  return { db, sqlite, env, signIn };
}

const fails = (message: RegExp) => (error: unknown) => error instanceof PasswordCommandError && message.test(error.message);

test("the command line names one account command at a time", () => {
  assert.equal(passwordCommand(["--migrate-only"]), null);
  assert.deepEqual(passwordCommand(["--create-admin", "Root"]), { kind: "create-admin", username: "Root" });
  assert.deepEqual(passwordCommand(["--reset-password=alice"]), { kind: "reset-password", username: "alice" });
  assert.throws(() => passwordCommand(["--create-admin"]), PasswordCommandError);
  assert.throws(() => passwordCommand(["--create-admin", "--reset-password", "a"]), PasswordCommandError);
  assert.throws(() => passwordCommand(["--create-admin", "a", "--reset-password", "b"]), PasswordCommandError);
});

test("--create-admin creates only an administrator ADMIN_USER_IDS already lists, who then signs in as one", async t => {
  const f = await fixture(t);
  const read = async () => password;
  await assert.rejects(runPasswordCommand(f.db, { ...settings, PASSWORD_AUTH: undefined }, { kind: "create-admin", username: "root" }, read), fails(/PASSWORD_AUTH=true/));
  await assert.rejects(runPasswordCommand(f.db, settings, { kind: "create-admin", username: "alice" }, read), fails(/list password:alice in ADMIN_USER_IDS/));
  await assert.rejects(runPasswordCommand(f.db, settings, { kind: "create-admin", username: "root" }, async () => "short"), fails(/at least 12 characters/));
  await assert.rejects(runPasswordCommand(f.db, settings, { kind: "create-admin", username: "r" }, read), fails(/Usernames are 3 to 39/));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 0);

  const outcome = await runPasswordCommand(f.db, settings, { kind: "create-admin", username: " Root " }, read);
  assert.match(outcome, /created password:root/);
  const signedIn = await f.signIn("root", password);
  assert.equal(signedIn.status, 200);
  const { user } = await signedIn.json() as { user: UserProfile };
  assert.equal(user.id, "password:root");
  assert.equal(user.instanceAdmin, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'account.password.created_by_operator' AND actor_id IS NULL").get()!.n, 1);
  await assert.rejects(runPasswordCommand(f.db, settings, { kind: "create-admin", username: "root" }, read), fails(/exists already; --reset-password root/));
});

test("--reset-password sets a new password, clears failed sign-ins and signs the account out everywhere", async t => {
  const f = await fixture(t);
  const read = async () => password;
  await assert.rejects(runPasswordCommand(f.db, settings, { kind: "reset-password", username: "root" }, read), fails(/no password account password:root/));
  await runPasswordCommand(f.db, settings, { kind: "create-admin", username: "root" }, read);
  const cookie = (await f.signIn("root", password)).headers.get("set-cookie")!.split(";")[0]!;
  for (let attempt = 0; attempt < 5; attempt++) await f.signIn("root", "wrong password " + attempt);
  assert.equal((await f.signIn("root", password)).status, 429);

  await assert.rejects(runPasswordCommand(f.db, settings, { kind: "reset-password", username: "root" }, async () => "root"), fails(/at least 12/));
  assert.match(await runPasswordCommand(f.db, settings, { kind: "reset-password", username: "root" }, async () => "a fresh long passphrase"), /signed it out everywhere/);
  assert.equal((await app.request("/api/me", { headers: { Cookie: cookie } }, f.env)).status, 401);
  assert.equal((await f.signIn("root", password)).status, 401);
  assert.equal((await f.signIn("root", "a fresh long passphrase")).status, 200);
  // Any password account, not only administrators: the way back in for someone who forgot theirs.
  f.sqlite.prepare("INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES ('password:alice', 'A', 'A', 'a@example.test', 'password', '2026-01-01')").run();
  f.sqlite.prepare("INSERT INTO password_credentials (user_id, password_hash, created_at, updated_at) VALUES ('password:alice', 'scrypt$x', '2026-01-01', '2026-01-01')").run();
  await runPasswordCommand(f.db, {}, { kind: "reset-password", username: "alice" }, read);
  assert.equal((await f.signIn("alice", password)).status, 200);
});

test("the server's entry point creates the administrator from a password piped to it, and never takes one on argv", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pistead-password-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const url = `sqlite:${join(directory, "control-plane.sqlite")}`;
  const main = fileURLToPath(new URL("../apps/server/src/main.ts", import.meta.url));
  const run = (args: string[], input: string) => spawnSync(process.execPath, ["--import", "tsx", main, ...args], { input, encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, PASSWORD_AUTH: "true", ADMIN_USER_IDS: "password:root" }, timeout: 60_000 });
  const created = run(["--create-admin", "root"], `${password}\nignored second line\n`);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /created password:root/);
  const again = run(["--create-admin=root"], `${password}\n`);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /exists already/);
  const empty = run(["--reset-password", "root"], "");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no password on standard input/);

  const db = await openDatabase(url);
  t.after(() => db.close());
  const row = await db.query<{ password_hash: string }>("SELECT password_hash FROM password_credentials WHERE user_id = 'password:root'").first();
  assert.match(row!.password_hash, /^scrypt\$/);
  assert.ok(!row!.password_hash.includes(password));
});
