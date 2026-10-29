import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { app } from "../apps/server/src/index.js";
import { hashPassword, verifyPassword } from "../apps/server/src/password-auth.js";
import type { Env } from "../apps/server/src/types.js";
import type { UserProfile } from "../packages/shared/src/types.js";
import { testDatabase } from "./helpers/control-plane.js";

const origin = "http://localhost:8787";
const password = "correct horse battery";

async function fixture(t: TestContext, overrides: Partial<Env> = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  // Test mode only allows plain HTTP on localhost; password accounts work without it.
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: "password-auth-test-secret-not-for-deployment",
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: "r".repeat(43),
    VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"), PASSWORD_AUTH: "true", PASSWORD_SIGNUP: "open", ...overrides };
  const request = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    app.request(path, { method, headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
  const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";
  async function signUp(body: Record<string, unknown>) {
    return request("POST", "/api/auth/password/signup", { headers: { Origin: origin }, body });
  }
  async function signIn(username: string, typed: string) {
    return request("POST", "/api/auth/password/login", { headers: { Origin: origin }, body: { username, password: typed } });
  }
  /** A signed-in browser: its cookie and a fresh CSRF token for changes. */
  async function browser(cookie: string) {
    const csrf = await (await request("GET", "/api/auth/csrf", { headers: { Cookie: cookie } })).json() as { csrfToken: string };
    return { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf.csrfToken };
  }
  /** A test-mode owner's workspace with its invite link turned on: its id and the link's token. */
  async function invitingWorkspace() {
    const login = await request("POST", "/api/auth/test", { headers: { Authorization: `Bearer ${env.TEST_AUTH_SECRET}`, Origin: origin }, body: { id: "inviter" } });
    const owner = cookieOf(login);
    const created = await request("POST", "/api/workspaces", { headers: await browser(owner), body: { name: "Team" } });
    const { workspace: { id } } = await created.json() as { workspace: { id: string } };
    const link = await request("PUT", `/api/workspaces/${id}/invite-link`, { headers: await browser(owner) });
    const { link: { url } } = await link.json() as { link: { url: string } };
    return { id, owner, token: url.split("#/join/")[1]! };
  }
  return { env, sqlite, request, cookieOf, signUp, signIn, browser, invitingWorkspace };
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

test("hashes are salted scrypt that verify only the same password, and refuse malformed or oversized parameters", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password + "!", first), false);
  // The same password in another Unicode form (a precomposed é against e + combining accent) matches.
  const accented = await hashPassword("caf\u00e9 au lait, s'il vous pla\u00eet");
  assert.equal(await verifyPassword("cafe\u0301 au lait, s'il vous pla\u00eet", accented), true);
  const [, , r, p, salt, key] = first.split("$");
  assert.equal(await verifyPassword(password, `scrypt$${2 ** 20}$${r}$${p}$${salt}$${key}`), false);
  assert.equal(await verifyPassword(password, `scrypt$1000$${r}$${p}$${salt}$${key}`), false);
  assert.equal(await verifyPassword(password, "plain"), false);
});

test("signing up creates a password account signed in with a cookie, and the username is then taken", async t => {
  const f = await fixture(t);
  const health = await (await f.request("GET", "/api/health")).json() as { passwordAuth: boolean };
  assert.equal(health.passwordAuth, true);

  const created = await f.signUp({ username: "  Alice ", password, displayName: "Alice Liddell" });
  assert.equal(created.status, 201);
  const { user } = await created.json() as { user: UserProfile };
  assert.equal(user.id, "password:alice");
  assert.equal(user.displayName, "Alice Liddell");
  assert.equal(user.passwordSignIn, true);
  assert.equal(user.githubConnected, false);
  assert.equal(user.githubLogin, null);
  assert.equal(user.gitEmail, "alice@users.pistead.invalid");
  const cookie = f.cookieOf(created);
  assert.match(cookie, /^test-auth=/);
  const me = await f.request("GET", "/api/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { user: UserProfile }).user.id, "password:alice");
  // Only the hash is stored.
  const stored = f.sqlite.prepare("SELECT password_hash FROM password_credentials WHERE user_id = 'password:alice'").get() as { password_hash: string };
  assert.ok(!stored.password_hash.includes(password));

  const again = await f.signUp({ username: "ALICE", password: "another long password" });
  assert.equal(again.status, 409);
  assert.equal(await errorCode(again), "username_taken");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 1);
});

test("sign-up refuses weak passwords, bad usernames, extra fields and cross-site requests", async t => {
  const f = await fixture(t);
  for (const [body, code] of [
    [{ username: "bob", password: "short" }, "weak_password"],
    [{ username: "bobby-tables", password: "BOBBY-TABLES" + "" }, "weak_password"],
    [{ username: "bobby-tables", password: "x".repeat(257) }, "invalid_password"],
    [{ username: "b", password }, "invalid_username"],
    [{ username: "bob smith", password }, "invalid_username"],
    [{ username: "-bob", password }, "invalid_username"],
    [{ username: "bob", password, admin: true }, "invalid_input"],
  ] as const) {
    const response = await f.signUp(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await errorCode(response), code, JSON.stringify(body));
  }
  // The username equals the password, ignoring case: refused as well.
  assert.equal(await errorCode(await f.signUp({ username: "longusername1", password: "LongUsername1" })), "weak_password");
  const crossSite = await f.request("POST", "/api/auth/password/signup", { headers: { Origin: "https://evil.example" }, body: { username: "bob", password } });
  assert.equal(crossSite.status, 403);
  const fetchSite = await f.request("POST", "/api/auth/password/login", { headers: { "Sec-Fetch-Site": "cross-site" }, body: { username: "bob", password } });
  assert.equal(fetchSite.status, 403);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 0);
});

test("signing in takes the username in any case, and a wrong password or unknown user get the same answer", async t => {
  const f = await fixture(t);
  assert.equal((await f.signUp({ username: "carol", password })).status, 201);
  const signedIn = await f.signIn("Carol", password);
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json() as { user: UserProfile }).user.id, "password:carol");
  assert.match(f.cookieOf(signedIn), /^test-auth=/);

  const wrong = await f.signIn("carol", "not the password at all");
  const unknown = await f.signIn("nobody", password);
  const malformed = await f.signIn("no body", password);
  for (const response of [wrong, unknown, malformed]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "The username or password is incorrect.", code: "invalid_credentials" });
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("five failed sign-ins in a row are allowed, then the account pauses even for the right password", async t => {
  const f = await fixture(t);
  assert.equal((await f.signUp({ username: "dave", password })).status, 201);
  for (let attempt = 0; attempt < 4; attempt++) assert.equal((await f.signIn("dave", "wrong password " + attempt)).status, 401);
  // A success resets the count.
  assert.equal((await f.signIn("dave", password)).status, 200);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await f.signIn("dave", "wrong password " + attempt)).status, 401);
  const locked = await f.signIn("dave", password);
  assert.equal(locked.status, 429);
  assert.equal(await errorCode(locked), "sign_in_locked");
  const row = f.sqlite.prepare("SELECT failed_attempts, locked_until FROM password_credentials WHERE user_id = 'password:dave'").get() as { failed_attempts: number; locked_until: number };
  assert.equal(row.failed_attempts, 5);
  assert.ok(row.locked_until > Date.now() + 20_000 && row.locked_until <= Date.now() + 30_000);
  // Once the pause is over the right password works again, and clears the count.
  f.sqlite.prepare("UPDATE password_credentials SET locked_until = ? WHERE user_id = 'password:dave'").run(Date.now() - 1);
  assert.equal((await f.signIn("dave", password)).status, 200);
  assert.deepEqual({ ...f.sqlite.prepare("SELECT failed_attempts, locked_until FROM password_credentials WHERE user_id = 'password:dave'").get() },
    { failed_attempts: 0, locked_until: null });
});

test("changing the password needs the current one and signs out every other browser", async t => {
  const f = await fixture(t);
  const created = await f.signUp({ username: "erin", password });
  const first = f.cookieOf(created);
  const second = f.cookieOf(await f.signIn("erin", password));
  const headers = await f.browser(first);

  const noCsrf = await f.request("POST", "/api/me/password", { headers: { Cookie: first, Origin: origin }, body: { currentPassword: password, newPassword: "a brand new passphrase" } });
  assert.equal(noCsrf.status, 403);
  const wrong = await f.request("POST", "/api/me/password", { headers, body: { currentPassword: "not my password!", newPassword: "a brand new passphrase" } });
  assert.equal(wrong.status, 403);
  assert.equal(await errorCode(wrong), "invalid_credentials");
  const weak = await f.request("POST", "/api/me/password", { headers: await f.browser(first), body: { currentPassword: password, newPassword: "short" } });
  assert.equal(await errorCode(weak), "weak_password");

  const changed = await f.request("POST", "/api/me/password", { headers: await f.browser(first), body: { currentPassword: password, newPassword: "a brand new passphrase" } });
  assert.equal(changed.status, 200);
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: first } })).status, 200);
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: second } })).status, 401);
  assert.equal((await f.signIn("erin", password)).status, 401);
  assert.equal((await f.signIn("erin", "a brand new passphrase")).status, 200);
});

test("a GitHub account has no password to change", async t => {
  const f = await fixture(t);
  const login = await f.request("POST", "/api/auth/test", { headers: { Authorization: `Bearer ${f.env.TEST_AUTH_SECRET}`, Origin: origin }, body: { id: "frank" } });
  const cookie = f.cookieOf(login);
  const response = await f.request("POST", "/api/me/password", { headers: await f.browser(cookie), body: { currentPassword: password, newPassword: "a brand new passphrase" } });
  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "no_password");
});

test("without PASSWORD_AUTH the routes don't exist, and turning it off ends password sign-ins", async t => {
  const f = await fixture(t);
  const cookie = f.cookieOf(await f.signUp({ username: "grace", password }));
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: cookie } })).status, 200);
  f.env.PASSWORD_AUTH = "false";
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await f.signIn("grace", password)).status, 404);
  assert.equal((await f.signUp({ username: "heidi", password })).status, 404);
  assert.equal(((await (await f.request("GET", "/api/health")).json()) as { passwordAuth: boolean }).passwordAuth, false);
  // A local server never offers it, whatever PASSWORD_AUTH says.
  f.env.PASSWORD_AUTH = "true";
  f.env.LOCAL_MODE = "true";
  f.env.LOCAL_CLAIM_SECRET = "c".repeat(43);
  assert.equal((await f.signIn("grace", password)).status, 404);
});

test("a suspended password account can't sign in, and says so only to the right password", async t => {
  const f = await fixture(t);
  const cookie = f.cookieOf(await f.signUp({ username: "ivan", password }));
  f.sqlite.prepare("UPDATE users SET suspended_at = ? WHERE id = 'password:ivan'").run(new Date().toISOString());
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await f.signIn("ivan", "the wrong password")).status, 401);
  const right = await f.signIn("ivan", password);
  assert.equal(right.status, 403);
  assert.equal(await errorCode(right), "account_suspended");
});

test("ADMIN_USER_IDS may list a password account, which nobody can sign up as while it is listed", async t => {
  const f = await fixture(t, { ADMIN_USER_IDS: "password:root" });
  const reserved = await f.signUp({ username: "Root", password });
  assert.equal(reserved.status, 409);
  assert.equal(await errorCode(reserved), "username_reserved");
  // Signed up while not listed, then listed: that account is the administrator.
  f.env.ADMIN_USER_IDS = "";
  const created = await f.signUp({ username: "root", password });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as { user: UserProfile }).user.instanceAdmin, undefined);
  f.env.ADMIN_USER_IDS = "password:root";
  const me = await f.request("GET", "/api/me", { headers: { Cookie: f.cookieOf(created) } });
  assert.equal((await me.json() as { user: UserProfile }).user.instanceAdmin, true);
  const overview = await f.request("GET", "/api/admin/overview", { headers: { Cookie: f.cookieOf(created) } });
  assert.equal(overview.status, 200);
});

test("workspace owners add a password account as a member by its user ID", async t => {
  const f = await fixture(t);
  const owner = f.cookieOf(await f.signUp({ username: "owner", password }));
  await f.signUp({ username: "judy", password });
  const workspace = await f.request("POST", "/api/workspaces", { headers: await f.browser(owner), body: { name: "Team" } });
  assert.equal(workspace.status, 201);
  const { workspace: { id } } = await workspace.json() as { workspace: { id: string } };
  const added = await f.request("POST", `/api/workspaces/${id}/members`, { headers: await f.browser(owner), body: { userId: "password:judy", role: "member" } });
  assert.ok(added.status === 200 || added.status === 201, String(added.status));
});

test("by default sign-up needs a workspace's invite link, and files the request to join with the account", async t => {
  const f = await fixture(t, { PASSWORD_SIGNUP: undefined });
  const health = await (await f.request("GET", "/api/health")).json() as { passwordSignup: string };
  assert.equal(health.passwordSignup, "invite");
  const uninvited = await f.signUp({ username: "kim", password });
  assert.equal(uninvited.status, 403);
  assert.equal(await errorCode(uninvited), "invite_required");
  const forged = await f.signUp({ username: "kim", password, inviteToken: "x".repeat(43) });
  assert.equal(forged.status, 404);

  const { id, owner, token } = await f.invitingWorkspace();
  const invited = await f.signUp({ username: "kim", password, inviteToken: token });
  assert.equal(invited.status, 201);
  assert.deepEqual(f.sqlite.prepare("SELECT workspace_id, user_id FROM workspace_join_requests").all().map(row => ({ ...row })),
    [{ workspace_id: id, user_id: "password:kim" }]);
  const requests = await f.request("GET", `/api/workspaces/${id}/join-requests`, { headers: { Cookie: owner } });
  assert.deepEqual((await requests.json() as { requests: { userId: string }[] }).requests.map(request => request.userId), ["password:kim"]);
  // The new account sees its request, and nothing of the workspace yet.
  const own = await f.request("GET", "/api/join-requests", { headers: { Cookie: f.cookieOf(invited) } });
  assert.equal((await own.json() as { requests: unknown[] }).requests.length, 1);
  assert.equal((await f.request("GET", `/api/workspaces/${id}/members`, { headers: { Cookie: f.cookieOf(invited) } })).status, 404);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.join.request' AND actor_id = 'password:kim'").get()!.n, 1);

  // A link turned off admits nobody new; signing in still works.
  await f.request("DELETE", `/api/workspaces/${id}/invite-link`, { headers: await f.browser(owner) });
  assert.equal((await f.signUp({ username: "lee", password, inviteToken: token })).status, 404);
  assert.equal((await f.signIn("kim", password)).status, 200);
});

test("an invite link whose workspace has a full queue creates no account", async t => {
  const f = await fixture(t, { PASSWORD_SIGNUP: "invite" });
  const { id, token } = await f.invitingWorkspace();
  const insertUser = f.sqlite.prepare("INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES (?, 'W', 'W', 'w@example.test', 'test', '2026-01-01')");
  const insertRequest = f.sqlite.prepare("INSERT INTO workspace_join_requests (workspace_id, user_id, created_at) VALUES (?, ?, '2026-01-01')");
  for (let index = 0; index < 200; index++) { insertUser.run(`test:waiting-${index}`); insertRequest.run(id, `test:waiting-${index}`); }
  const refused = await f.signUp({ username: "mia", password, inviteToken: token });
  assert.equal(refused.status, 409);
  assert.equal(await errorCode(refused), "too_many_pending");
  assert.equal(refused.headers.get("set-cookie"), null);
  for (const table of ["password_credentials", "auth_sessions"]) {
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 'password:mia'`).get()!.n, 0, table);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'password:mia'").get()!.n, 0);
});

test("with PASSWORD_SIGNUP=off nobody signs up, invited or not, and existing accounts still sign in", async t => {
  const f = await fixture(t);
  assert.equal((await f.signUp({ username: "nina", password })).status, 201);
  const { token } = await f.invitingWorkspace();
  f.env.PASSWORD_SIGNUP = "off";
  for (const body of [{ username: "omar", password }, { username: "omar", password, inviteToken: token }]) {
    const response = await f.signUp(body);
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "signup_closed");
  }
  assert.equal((await f.signIn("nina", password)).status, 200);
});

test("open sign-up through an invite link also asks to join its workspace", async t => {
  const f = await fixture(t);
  const { id, token } = await f.invitingWorkspace();
  assert.equal((await f.signUp({ username: "pat", password, inviteToken: token })).status, 201);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_join_requests WHERE workspace_id = ? AND user_id = 'password:pat'").get(id)!.n, 1);
});
