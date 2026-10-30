import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { app } from "../apps/server/src/index.js";
import type { Env } from "../apps/server/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { testDatabase } from "./helpers/control-plane.js";

const origin = "http://localhost:8787";
const testSecret = "github-signup-test-secret-not-for-deployment";

/** A server whose GitHub answers as whichever account `as` names next. */
async function fixture(t: TestContext, overrides: Partial<Env> = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"),
    GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", ...overrides };
  let account = { id: 1001, login: "newcomer" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: `gho_${account.id}`, token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id: account.id, login: account.login, name: account.login });
    if (url === "https://api.github.com/user/emails?per_page=100") return Response.json([{ email: `${account.login}@example.test`, verified: true, primary: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  const request = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    app.request(path, { method, headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
  const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/)
    .map(part => part.trim().split(";")[0]!).find(part => part.startsWith(`${name}=`) && part.length > name.length + 1);
  /** GitHub's callback for a sign-in that `start` began; returns where the browser goes next. */
  async function finish(start: Response | { url: string; cookie: string }) {
    const location = start instanceof Response ? start.headers.get("location")! : start.url;
    const cookie = start instanceof Response ? cookieOf(start, "test-oauth-state")! : start.cookie;
    const state = new URL(location).searchParams.get("state")!;
    return request("GET", `/api/auth/github/callback?code=github-code&state=${state}`, { headers: { Cookie: cookie } });
  }
  const signIn = async (as: { id: number; login: string }) => { account = as; return finish(await request("GET", "/api/auth/github")); };
  /** A sign-in started from an invite link, as the web app starts it: the token in a POST body. */
  async function invitedSignIn(as: { id: number; login: string }, inviteToken: string) {
    account = as;
    const started = await request("POST", "/api/auth/github/start", { headers: { Origin: origin }, body: { inviteToken } });
    if (started.status !== 200) return started;
    const { url } = await started.json() as { url: string };
    assert.ok(!url.includes(inviteToken), "the invite token never travels in a URL");
    return finish({ url, cookie: cookieOf(started, "test-oauth-state")! });
  }
  async function browser(cookie: string) {
    const csrf = await (await request("GET", "/api/auth/csrf", { headers: { Cookie: cookie } })).json() as { csrfToken: string };
    return { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf.csrfToken };
  }
  /** A workspace owned by an existing GitHub account, with its invite link on. */
  async function invitingWorkspace() {
    const owner = cookieOf(await signIn({ id: 1, login: "owner" }), "test-auth")!;
    const created = await request("POST", "/api/workspaces", { headers: await browser(owner), body: { name: "Team" } });
    const { workspace: { id } } = await created.json() as { workspace: { id: string } };
    const link = await request("PUT", `/api/workspaces/${id}/invite-link`, { headers: await browser(owner) });
    const { link: { url } } = await link.json() as { link: { url: string } };
    return { id, owner, token: url.split("#/join/")[1]! };
  }
  const users = () => sqlite.prepare("SELECT id FROM users ORDER BY id").all().map(row => row.id);
  const answerAs = (as: { id: number; login: string }) => { account = as; };
  return { env, sqlite, request, cookieOf, signIn, invitedSignIn, invitingWorkspace, browser, users, answerAs };
}

/** Where a refused browser sign-in goes: the sign-in page, saying why. */
function refusal(response: Response): string {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin + location.pathname, `${origin}/`);
  // No session: the only cookie it sets is the expired sign-in state.
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /test-auth=[A-Za-z0-9_-]{43}/);
  return location.searchParams.get("error")!;
}

test("unset, SIGNUP leaves GitHub sign-up open as it was, and says so", async t => {
  const f = await fixture(t);
  const health = await (await f.request("GET", "/api/health")).json() as { githubSignup: string; passwordSignup?: string };
  assert.equal(health.githubSignup, "open");
  assert.equal(health.passwordSignup, undefined);
  const response = await f.signIn({ id: 1001, login: "newcomer" });
  assert.equal(response.headers.get("location"), `${origin}/`);
  assert.deepEqual(f.users(), ["github:1001"]);
});

test("with SIGNUP=invite a new GitHub account needs an invite link, and existing ones sign in as before", async t => {
  const f = await fixture(t);
  await f.signIn({ id: 7, login: "veteran" });
  f.env.SIGNUP = "invite";
  assert.equal((await (await f.request("GET", "/api/health")).json() as { githubSignup: string }).githubSignup, "invite");

  const refused = await f.signIn({ id: 1001, login: "newcomer" });
  assert.match(refusal(refused), /need an invite link/);
  assert.deepEqual(f.users(), ["github:7"]);
  // Refused before GitHub's token was kept.
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens WHERE user_id = 'github:1001'").get()!.n, 0);

  const veteran = await f.signIn({ id: 7, login: "veteran" });
  assert.equal(veteran.headers.get("location"), `${origin}/`);
  assert.ok(f.cookieOf(veteran, "test-auth"));
});

test("a GitHub sign-up through an invite link creates the account with its request to join", async t => {
  const f = await fixture(t, { SIGNUP: "invite" });
  // The workspace's owner exists already; ADMIN_USER_IDS lets that first account in.
  f.env.ADMIN_USER_IDS = "github:1";
  const { id, owner, token } = await f.invitingWorkspace();
  f.env.ADMIN_USER_IDS = "";

  assert.equal((await f.request("POST", "/api/auth/github/start", { headers: { Origin: origin }, body: { inviteToken: "x".repeat(43) } })).status, 404);
  assert.equal((await f.request("POST", "/api/auth/github/start", { headers: { Origin: "https://evil.example" }, body: { inviteToken: token } })).status, 403);

  const joined = await f.invitedSignIn({ id: 1001, login: "newcomer" }, token);
  assert.equal(joined.headers.get("location"), `${origin}/`);
  assert.ok(f.cookieOf(joined, "test-auth"));
  assert.deepEqual(f.sqlite.prepare("SELECT workspace_id, user_id FROM workspace_join_requests").all().map(row => ({ ...row })),
    [{ workspace_id: id, user_id: "github:1001" }]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'workspace.join.request' AND actor_id = 'github:1001'").get()!.n, 1);
  // Only the token's hash was kept with the sign-in.
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!.n, 0);

  // Signing in again through the link doesn't file a second request.
  await f.invitedSignIn({ id: 1001, login: "newcomer" }, token);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_join_requests").get()!.n, 1);

  // A link turned off between starting and GitHub's callback admits nobody new.
  f.env.SIGNUP = "invite";
  const started = await f.request("POST", "/api/auth/github/start", { headers: { Origin: origin }, body: { inviteToken: token } });
  const { url } = await started.json() as { url: string };
  await f.request("DELETE", `/api/workspaces/${id}/invite-link`, { headers: await f.browser(owner) });
  f.answerAs({ id: 1002, login: "latecomer" });
  const state = new URL(url).searchParams.get("state")!;
  const late = await f.request("GET", `/api/auth/github/callback?code=github-code&state=${state}`, { headers: { Cookie: f.cookieOf(started, "test-oauth-state")! } });
  assert.match(refusal(late), /turned off or replaced/);
  assert.ok(!f.users().includes("github:1002"));
});

test("an invite link whose workspace has a full queue creates no GitHub account", async t => {
  const f = await fixture(t, { SIGNUP: "invite", ADMIN_USER_IDS: "github:1" });
  const { id, token } = await f.invitingWorkspace();
  const insertUser = f.sqlite.prepare("INSERT INTO users (id, display_name, git_name, git_email, auth_kind, created_at) VALUES (?, 'W', 'W', 'w@example.test', 'test', '2026-01-01')");
  const insertRequest = f.sqlite.prepare("INSERT INTO workspace_join_requests (workspace_id, user_id, created_at) VALUES (?, ?, '2026-01-01')");
  for (let index = 0; index < 200; index++) { insertUser.run(`test:waiting-${index}`); insertRequest.run(id, `test:waiting-${index}`); }
  const refused = await f.invitedSignIn({ id: 1001, login: "newcomer" }, token);
  assert.match(refusal(refused), /too many people waiting/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'github:1001'").get()!.n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens WHERE user_id = 'github:1001'").get()!.n, 0);
});

test("with SIGNUP=off nobody new signs up with GitHub, invited or not, except an administrator ADMIN_USER_IDS lists", async t => {
  const f = await fixture(t, { SIGNUP: "invite", ADMIN_USER_IDS: "github:1" });
  const { token } = await f.invitingWorkspace();
  f.env.SIGNUP = "off";
  assert.match(refusal(await f.signIn({ id: 1001, login: "newcomer" })), /doesn't take new accounts/);
  assert.match(refusal(await f.invitedSignIn({ id: 1001, login: "newcomer" }, token)), /doesn't take new accounts/);
  f.env.ADMIN_USER_IDS = "github:1,github:2";
  const admin = await f.signIn({ id: 2, login: "operator" });
  assert.equal(admin.headers.get("location"), `${origin}/`);
  assert.deepEqual(f.users(), ["github:1", "github:2"]);
  // And existing accounts still sign in.
  assert.equal((await f.signIn({ id: 1, login: "owner" })).headers.get("location"), `${origin}/`);
});

test("an app can't create a GitHub account where SIGNUP=invite, and is told to use the invite link in a browser", async t => {
  const f = await fixture(t, { SIGNUP: "invite" });
  const challenge = await sha256("v".repeat(43));
  const start = await f.request("GET", `/api/auth/native/start?challenge=${challenge}&state=app-state-0123456789`);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await f.request("GET", `/api/auth/github/callback?code=github-code&state=${state}`,
    { headers: { Cookie: f.cookieOf(start, "test-oauth-state")! } });
  const location = new URL(callback.headers.get("location")!);
  assert.equal(`${location.protocol}//${location.host}`, "pistead://auth");
  assert.equal(location.searchParams.get("error"), "invite_required");
  assert.deepEqual(f.users(), []);
});

test("SIGNUP=open admits anyone, and a GitHub sign-up through an invite link still asks to join", async t => {
  const f = await fixture(t, { SIGNUP: "open" });
  const { id, token } = await f.invitingWorkspace();
  await f.invitedSignIn({ id: 1001, login: "newcomer" }, token);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_join_requests WHERE workspace_id = ? AND user_id = 'github:1001'").get(id)!.n, 1);
  await f.signIn({ id: 1002, login: "walk-in" });
  assert.ok(f.users().includes("github:1002"));
});
