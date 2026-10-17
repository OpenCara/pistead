import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { app } from "../apps/server/src/index.js";
import type { Env } from "../apps/server/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { NativeSignIn, SignedInDevice } from "../packages/shared/src/types.js";
import { testDatabase } from "./helpers/control-plane.js";

const origin = "http://localhost:8787";
const testSecret = "native-auth-test-secret-not-for-deployment";
const verifier = "v".repeat(43) + "-native_verifier";
const appState = "app-state-0123456789";

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: "r".repeat(43),
    VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"), GITHUB_CLIENT_ID: "native-client", GITHUB_CLIENT_SECRET: "native-secret" };
  // GitHub's token exchange, user and verified email for the user signing in.
  const github: string[] = [];
  let denyExchange = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    github.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("code"), "github-code");
      return Response.json(denyExchange ? { error: "bad_verification_code" } : { access_token: "gho_native", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 4242, login: "octo", name: "Octo Cat" });
    if (url === "https://api.github.com/user/emails?per_page=100") return Response.json([{ email: "octo@example.test", verified: true, primary: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  const request = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    app.request(path, { method, headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
  /** Runs the app's sign-in through GitHub and returns where the server sends the authentication browser back to. */
  async function signInThroughGitHub(challenge: string, query = "code=github-code") {
    const start = await request("GET", `/api/auth/native/start?challenge=${challenge}&state=${appState}`);
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(authorize.origin + authorize.pathname, "https://github.com/login/oauth/authorize");
    const state = authorize.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await request("GET", `/api/auth/github/callback?${query}&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(callback.status, 302);
    // The authentication browser gets no Pistead session cookie of its own.
    assert.ok(!(callback.headers.get("set-cookie") ?? "").includes("test-auth="));
    return new URL(callback.headers.get("location")!);
  }
  return { env, sqlite, github, request, signInThroughGitHub, deny: () => { denyExchange = true; } };
}

test("a native app signs in through GitHub with PKCE and gets a bearer session that needs no CSRF token", async t => {
  const f = await fixture(t);
  const challenge = await sha256(verifier);
  const callback = await f.signInThroughGitHub(challenge);
  assert.equal(`${callback.protocol}//${callback.host}`, "pistead://auth");
  assert.equal(callback.searchParams.get("state"), appState);
  const code = callback.searchParams.get("code")!;

  // Only the verifier behind the challenge redeems the code, and a code works once even when that attempt fails.
  const wrong = await f.request("POST", "/api/auth/native/token", { body: { code, verifier: "w".repeat(43) } });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json() as { code: string }).code, "invalid_grant");
  assert.equal((await f.request("POST", "/api/auth/native/token", { body: { code, verifier } })).status, 400);

  const fresh = await f.signInThroughGitHub(challenge);
  const exchanged = await f.request("POST", "/api/auth/native/token", { body: { code: fresh.searchParams.get("code"), verifier, deviceName: "Octo's iPhone" } });
  assert.equal(exchanged.status, 200);
  const signIn = await exchanged.json() as NativeSignIn;
  assert.equal(signIn.user.id, "github:4242");
  assert.ok(Date.parse(signIn.expiresAt) > Date.now() + 29 * 24 * 3600_000);
  const bearer = { Authorization: `Bearer ${signIn.token}` };
  assert.equal((await f.request("GET", "/api/me", { headers: bearer })).status, 200);
  // The scheme is case-insensitive and may be followed by several spaces.
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: `bearer  ${signIn.token}` } })).status, 200);
  // An app that has no device name may send null for it.
  const unnamed = await f.signInThroughGitHub(challenge);
  assert.equal((await f.request("POST", "/api/auth/native/token", { body: { code: unnamed.searchParams.get("code"), verifier, deviceName: null } })).status, 200);
  // Changes need no CSRF token: a bearer token is never sent by a browser on its own.
  const created = await f.request("POST", "/api/workspaces", { headers: bearer, body: { name: "From the phone" } });
  assert.equal(created.status, 201);

  // The token is a bearer credential only, never a cookie, and a browser cookie is never a bearer token.
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: `test-auth=${signIn.token}` } })).status, 401);
  const browser = await f.request("POST", "/api/auth/test", { headers: { Authorization: `Bearer ${testSecret}` }, body: { id: "web" } });
  const cookieToken = browser.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: `Bearer ${cookieToken}` } })).status, 401);
  // A proxy's Basic credentials leave the browser's cookie in charge.
  assert.equal((await f.request("GET", "/api/me", { headers: { Cookie: `test-auth=${cookieToken}`, Authorization: "Basic dXNlcjpwYXNz" } })).status, 200);
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: "Bearer not-a-token" } })).status, 401);
});

test("a code expires after two minutes, and a GitHub failure returns the app to its callback with the reason", async t => {
  const f = await fixture(t);
  const challenge = await sha256(verifier);
  const callback = await f.signInThroughGitHub(challenge);
  f.sqlite.prepare("UPDATE native_auth_codes SET expires_at = ?").run(Date.now() - 1);
  assert.equal((await f.request("POST", "/api/auth/native/token", { body: { code: callback.searchParams.get("code"), verifier } })).status, 400);

  const denied = await f.signInThroughGitHub(challenge, "error=access_denied");
  assert.equal(denied.searchParams.get("error"), "oauth_denied");
  assert.equal(denied.searchParams.get("state"), appState);
  assert.equal(denied.searchParams.get("code"), null);
  f.deny();
  const failed = await f.signInThroughGitHub(challenge);
  assert.equal(failed.searchParams.get("error"), "github_error");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM native_auth_codes").get()!.n, 0);

  for (const query of [`challenge=${challenge}&state=short`, `challenge=not-a-challenge&state=${appState}`, `state=${appState}`]) {
    assert.equal((await f.request("GET", `/api/auth/native/start?${query}`)).status, 400);
  }
});

test("storage failing after GitHub answers still returns the app to its callback, with no code and no saved GitHub token", async t => {
  const f = await fixture(t);
  f.sqlite.exec("DROP TABLE native_auth_codes");
  const callback = await f.signInThroughGitHub(await sha256(verifier));
  assert.equal(callback.searchParams.get("error"), "auth_unavailable");
  assert.equal(callback.searchParams.get("state"), appState);
  assert.equal(callback.searchParams.get("code"), null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM github_tokens").get()!.n, 0);
});

test("signed-in apps are listed for their user and revoked one by one, and signing out ends only that app", async t => {
  const f = await fixture(t);
  const token = async (id: string, deviceName?: string) => {
    const response = await f.request("POST", "/api/auth/test", { headers: { Authorization: `Bearer ${testSecret}` }, body: { id, client: "native", ...(deviceName ? { deviceName } : {}) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    return (await response.json() as NativeSignIn).token;
  };
  const phone = await token("alice", "Alice's iPhone");
  const tablet = await token("alice", "Alice's iPad");
  const other = await token("bob");
  const devices = async (bearer: string) => (await (await f.request("GET", "/api/me/devices", { headers: { Authorization: `Bearer ${bearer}` } })).json() as { devices: SignedInDevice[] }).devices;
  const listed = await devices(phone);
  assert.deepEqual(listed.map(device => [device.name, device.current]).sort(), [["Alice's iPad", false], ["Alice's iPhone", true]]);
  assert.ok(!JSON.stringify(listed).includes(phone));
  const ipad = listed.find(device => device.name === "Alice's iPad")!;
  // Another user cannot revoke Alice's apps.
  assert.equal((await f.request("DELETE", `/api/me/devices/${ipad.id}`, { headers: { Authorization: `Bearer ${other}` } })).status, 404);
  assert.equal((await f.request("DELETE", `/api/me/devices/${ipad.id}`, { headers: { Authorization: `Bearer ${phone}` } })).status, 200);
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: `Bearer ${tablet}` } })).status, 401);
  assert.equal((await f.request("POST", "/api/auth/logout", { headers: { Authorization: `Bearer ${phone}` }, body: {} })).status, 200);
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: `Bearer ${phone}` } })).status, 401);
  assert.equal((await f.request("GET", "/api/me", { headers: { Authorization: `Bearer ${other}` } })).status, 200);
});
