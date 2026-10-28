import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConfigurationError, loadConfig } from "../apps/server/src/config.js";
import { app } from "../apps/server/src/index.js";
import { startLocalHost } from "../apps/server/src/local/host.js";
import { startLocalServer } from "../apps/server/src/local/launch.js";
import { loadLocalState, LocalStateError, openLocalState, peekLocalState } from "../apps/server/src/local/state.js";
import type { Env } from "../apps/server/src/types.js";
import { createFauxLocalModels } from "../apps/runner/src/local-pi.js";
import { testDatabase } from "./helpers/control-plane.js";

const claimSecret = "c".repeat(43);
const origin = "http://127.0.0.1:7878";

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pistead-local-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("a local server's state is created once, owner-only, and keeps its secrets as its GitHub app and port change", async t => {
  const stateDir = join(await directory(t), "server");
  const first = await loadLocalState(stateDir);
  assert.equal(first.port, 7878);
  assert.equal(first.github, undefined);
  for (const value of [first.sessionSecret, first.vaultKey, first.claimSecret]) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([first.sessionSecret, first.vaultKey, first.claimSecret]).size, 3);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stateDir, "server.json"))).mode & 0o777, 0o600);

  const github = { clientId: "Ov23liAbCdEf", clientSecret: "0123456789abcdef0123456789abcdef01234567" };
  const changed = await loadLocalState(stateDir, { github, port: 9000 });
  assert.deepEqual(changed, { ...first, github, port: 9000 });
  assert.deepEqual(await loadLocalState(stateDir), changed);

  await assert.rejects(loadLocalState(stateDir, { github: { clientId: "has space", clientSecret: "x" } }), LocalStateError);
  await assert.rejects(loadLocalState(stateDir, { port: 80 }), LocalStateError);
  await writeFile(join(stateDir, "server.json"), "{}", { mode: 0o600 });
  await assert.rejects(loadLocalState(stateDir), /damaged/);
});

test("processes creating a local server's state at once all get the same secrets", async t => {
  const stateDir = join(await directory(t), "server");
  const states = await Promise.all(Array.from({ length: 8 }, () => loadLocalState(stateDir)));
  for (const state of states) assert.deepEqual(state, states[0]);
  assert.deepEqual(await loadLocalState(stateDir), states[0]);
  // Concurrent changes are each applied to the state the last one left.
  const github = { clientId: "Ov23liAbCdEf", clientSecret: "0123456789abcdef0123456789abcdef01234567" };
  await Promise.all([loadLocalState(stateDir, { github }), loadLocalState(stateDir, { port: 9001 })]);
  assert.deepEqual(await loadLocalState(stateDir), { ...states[0], github, port: 9001 });
});

test("a running local server holds its state's lease: another can't open it, a left-over lock file doesn't stop the next", async t => {
  const stateDir = join(await directory(t), "server");
  // A lock file a crashed holder left: the kernel lock it named went with that process.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, "runner.lock"), "4242", { mode: 0o600 });
  const held = await openLocalState(stateDir);
  t.after(() => held.release());
  await assert.rejects(openLocalState(stateDir), /already running with this state directory/);
  // Reading it needs no lease, and creates nothing.
  assert.deepEqual(await peekLocalState(stateDir), held.state);
  assert.equal(await peekLocalState(join(stateDir, "other")), undefined);
  await held.release();
  assert.deepEqual(await loadLocalState(stateDir), held.state);
});

test("a local server refuses state others could read or that a symlink points to", async t => {
  const parent = await directory(t);
  const stateDir = join(parent, "server");
  await loadLocalState(stateDir);
  await chmod(join(stateDir, "server.json"), 0o644);
  await assert.rejects(loadLocalState(stateDir), /mode 0600/);
  await chmod(join(stateDir, "server.json"), 0o600);
  await chmod(stateDir, 0o755);
  await assert.rejects(loadLocalState(stateDir), /mode 0700/);
  await chmod(stateDir, 0o700);
  await symlink(stateDir, join(parent, "link"));
  await assert.rejects(loadLocalState(join(parent, "link")), /not a symlink/);
});

test("LOCAL_MODE listens on loopback only and needs its claim secret", async () => {
  const base = { APP_ORIGIN: origin, SESSION_SECRET: "s".repeat(32), VAULT_KEY: Buffer.alloc(32, 1).toString("base64url"), DATABASE_URL: "sqlite::memory:" };
  const refused = async (settings: Record<string, string>, message: RegExp) => {
    await assert.rejects(loadConfig({ ...base, ...settings }), (error: unknown) => error instanceof ConfigurationError && message.test(error.message));
  };
  await refused({ LOCAL_MODE: "true" }, /LOCAL_CLAIM_SECRET/);
  await refused({ LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret, HOST: "0.0.0.0" }, /loopback only/);
  await refused({ LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret, APP_ORIGIN: "https://pistead.example.com" }, /on this machine/);
  await refused({ LOCAL_MODE: "yes" }, /"true" or "false"/);
  const config = await loadConfig({ ...base, LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret });
  assert.equal(config.host, "127.0.0.1");
  await config.env.CONNECTOR_HUB?.close();
  await config.env.DB.close();
});

/** GitHub's token exchange, user and verified email: the account signing in is `account.id`. */
async function localFixture(t: TestContext, local = true) {
  const { db, sqlite, setBeforeQuery } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"),
    GITHUB_CLIENT_ID: "local-client", GITHUB_CLIENT_SECRET: "local-secret",
    ...(local ? { LOCAL_MODE: "true", LOCAL_CLAIM_SECRET: claimSecret } : {}) };
  const account = { id: 4242, login: "octo" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: `gho_${account.id}`, token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id: account.id, login: account.login, name: account.login });
    if (url === "https://api.github.com/user/emails?per_page=100") return Response.json([{ email: `${account.login}@example.test`, verified: true, primary: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  const request = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, env);
  const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(";")[0]!).filter(cookie => !cookie.endsWith("="));
  /** Starts at `start` (the claim link or "Continue with GitHub") and comes back through GitHub's callback. */
  async function signIn(start: string) {
    const begun = await request(start);
    if (begun.status !== 302) return begun;
    const state = new URL(begun.headers.get("location")!).searchParams.get("state")!;
    return request(`/api/auth/github/callback?code=github-code&state=${state}`, { Cookie: cookies(begun).join("; ") });
  }
  const health = async () => (await (await request("/api/health")).json() as { localServer?: { claimed: boolean } }).localServer;
  return { env, sqlite, setBeforeQuery, account, request, signIn, health, cookies };
}

const errorCode = async (response: Response) => (await response.json() as { code: string }).code;

test("two claims at once leave one owner: the later sign-in is undone before its token is stored", async t => {
  const f = await localFixture(t);
  // Another claim's user is written between this callback's owner check and its own user's insert.
  let raced = false;
  f.setBeforeQuery(sql => {
    if (raced || !sql.trimStart().startsWith("INSERT INTO users")) return;
    raced = true;
    f.sqlite.prepare(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
      VALUES ('github:1', '1', 'early', 'Early', 'Early', 'e@example.test', '{}', 'github', '2000-01-01T00:00:00.000Z')`).run();
  });
  const late = await f.signIn(`/api/auth/local/claim?token=${claimSecret}`);
  assert.ok(raced);
  assert.equal(late.status, 403);
  assert.equal(await errorCode(late), "local_server_owner_only");
  assert.deepEqual(f.sqlite.prepare("SELECT id FROM users").all().map(row => row.id), ["github:1"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens").get()!.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()!.n, 0);
});

test("a local server admits the GitHub account that claims it with its sign-in link, and no one else", async t => {
  const f = await localFixture(t);
  assert.deepEqual(await f.health(), { claimed: false });

  // "Continue with GitHub" can't claim it: only the launcher's link can.
  const unclaimed = await f.signIn("/api/auth/github");
  assert.equal(unclaimed.status, 403);
  assert.equal(await errorCode(unclaimed), "local_server_unclaimed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens").get()!.n, 0);

  const wrong = await f.request(`/api/auth/local/claim?token=${"x".repeat(43)}`);
  assert.equal(wrong.status, 403);
  assert.equal(await errorCode(wrong), "invalid_claim");

  const claimed = await f.signIn(`/api/auth/local/claim?token=${claimSecret}`);
  assert.equal(claimed.status, 302);
  assert.equal(claimed.headers.get("location"), `${origin}/`);
  // The claim cookie ends with the sign-in.
  assert.ok(claimed.headers.getSetCookie().some(cookie => cookie.startsWith("local-claim=;")));
  const session = f.cookies(claimed).find(cookie => cookie.startsWith("test-auth="))!;
  assert.equal((await f.request("/api/me", { Cookie: session })).status, 200);
  assert.deepEqual(await f.health(), { claimed: true });

  // Another GitHub account is refused, even with the link, and its token is never kept.
  f.account.id = 5151; f.account.login = "mallory";
  for (const start of ["/api/auth/github", `/api/auth/local/claim?token=${claimSecret}`]) {
    const other = await f.signIn(start);
    assert.equal(other.status, 403);
    assert.equal(await errorCode(other), "local_server_owner_only");
  }
  assert.deepEqual(f.sqlite.prepare("SELECT user_id FROM github_tokens").all().map(row => row.user_id), ["github:4242"]);

  // The owner signs in again as on any server.
  f.account.id = 4242; f.account.login = "octo";
  assert.equal((await f.signIn("/api/auth/github")).status, 302);
});

test("a server outside local mode has no claim link and says nothing of one", async t => {
  const f = await localFixture(t, false);
  assert.equal(await f.health(), undefined);
  assert.equal((await f.request(`/api/auth/local/claim?token=${claimSecret}`)).status, 404);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("a relative state directory still names its database and backups correctly", async t => {
  const parent = await directory(t);
  const previous = process.cwd();
  process.chdir(parent);
  t.after(() => process.chdir(previous));
  const state = await loadLocalState("server", { port: await freePort() });
  const web = join(parent, "web");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html>");
  const server = await startLocalServer({ stateDir: "server", state, staticDir: web });
  await server.close();
  assert.ok((await stat(join(parent, "server", "pistead.sqlite"))).isFile());
  assert.ok((await stat(join(parent, "server", "backups"))).isDirectory());
});

test("pistead serve's server pairs this computer as its owner's host once claimed, and reuses that pairing", async t => {
  const stateDir = join(await directory(t), "server");
  const state = await loadLocalState(stateDir, { port: await freePort() });
  const web = await directory(t);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Pistead</title>");
  await mkdir(join(web, "assets"));
  // Test mode lets the host offer the fixture model; everything else is the local server as `pistead serve` runs it.
  const testMode = { TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "t".repeat(43), TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString() };
  const hostOptions = {
    localModels: createFauxLocalModels("faux-1"), allowFaux: true, unsandboxed: true, pollMs: 50,
    acquireLease: () => Promise.resolve(() => Promise.resolve()),
    runtimeFactory: () => Promise.resolve({ fetch: () => Response.json({ ok: true }), close: () => Promise.resolve() }),
  };
  const server = await startLocalServer({ stateDir, state, staticDir: web, extraEnv: testMode });
  t.after(() => server.close());
  assert.equal(server.origin, `http://127.0.0.1:${state.port}`);
  assert.match(await (await fetch(server.origin)).text(), /<title>Pistead<\/title>/);
  assert.equal(await server.claimUrl(), `${server.origin}/api/auth/local/claim?token=${state.claimSecret}`);

  let waiting = false;
  const host = startLocalHost(server, stateDir, { ...hostOptions, onWaiting: () => { waiting = true; } });
  t.after(() => host.stop());
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(waiting);
  const connectors = () => server.env.DB.query<{ id: string; owner_id: string }>("SELECT id, owner_id FROM connectors WHERE revoked_at IS NULL").all();
  assert.deepEqual(await connectors(), []);

  // Someone claims it (the sign-in above, here written directly): the host pairs itself for them, with no code to copy.
  await server.env.DB.query(`INSERT INTO users (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES ('github:4242', '4242', 'octo', 'Octo', 'Octo', 'octo@example.test', '{}', 'github', ?)`).bind(new Date().toISOString()).run();
  await host.started;
  const [paired] = await connectors();
  assert.equal(paired?.owner_id, "github:4242");
  assert.equal(await server.claimUrl(), null);
  await host.stop();

  // The next start reuses the saved pairing.
  const again = startLocalHost(server, stateDir, hostOptions);
  t.after(() => again.stop());
  await again.started;
  assert.deepEqual((await connectors()).map(row => row.id), [paired!.id]);
});
