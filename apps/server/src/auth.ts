import type { Hono, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import { validateUserEnv } from '../../../packages/shared/src/policy.js';
import type { NativeSignIn, SignedInDevice } from '../../../packages/shared/src/types.js';
import { isInstanceAdmin } from './admin.js';
import { getUser, userProfile } from './db.js';
import type { Query, SqlValue } from './db/types.js';
import { appOrigin, fail, id, identifier, jsonObject, now, randomToken, requireOrigin, testMode, text } from './http.js';
import type { AppContext, AuthIdentity, Env, UserRow, WorkerEnv } from './types.js';
import { assertVaultConfigured, encryptToken } from './vault.js';

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
/** Native apps keep their sign-in longer than a browser; a device can be revoked from the web app any time. */
const NATIVE_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;
/** The app has this long to exchange the code it received at its callback. */
const NATIVE_CODE_TTL = 2 * 60 * 1000;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = '/api/auth/github/callback';
/** Where the server hands a native sign-in back to the app (the apps register the `pistead` URL scheme). */
const NATIVE_CALLBACK = 'pistead://auth';
/** A PKCE verifier (RFC 7636: 43-128 unreserved characters; the apps use base64url) or an app's opaque state. */
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const APP_STATE = /^[A-Za-z0-9_-]{16,128}$/;
const PROFILE_FIELDS: Record<string, true> = { displayName: true, gitName: true, gitEmail: true, env: true };
const SUSPENDED = 'This account is suspended. Ask the administrator of this Pistead server to restore it.';

function cookies(env: Env) {
  const secure = new URL(appOrigin(env)).protocol === 'https:';
  return {
    auth: secure ? '__Host-auth' : 'test-auth',
    state: secure ? '__Host-oauth-state' : 'test-oauth-state',
    options: { secure, httpOnly: true, sameSite: 'Lax' as const, path: '/' },
  };
}

function expireCookie(c: AppContext, kind: 'auth' | 'state'): void {
  const config = cookies(c.env);
  setCookie(c, config[kind], '', { ...config.options, maxAge: 0, expires: new Date(0) });
}

async function dbResult<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch { fail(503, 'auth_unavailable', 'Authentication storage is temporarily unavailable.'); }
}

export const authenticate: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  // A native app sends only its bearer token: a browser cookie never stands in for it, nor a bearer for a browser.
  // Other Authorization schemes (e.g. a reverse proxy's Basic auth) leave the browser's cookie in charge.
  const authorization = c.req.header('authorization');
  // The scheme is case-insensitive, and one or more spaces separate it from the token (RFC 9110).
  const bearer = authorization === undefined ? undefined : /^Bearer +(.*)$/i.exec(authorization)?.[1];
  const client = bearer === undefined ? 'browser' : 'native';
  const token = bearer ?? getCookie(c, cookies(c.env).auth);
  if (!token || !OPAQUE_TOKEN.test(token)) fail(401, 'unauthorized', 'Authentication is required.');
  const tokenHash = await sha256(token);
  const session = await dbResult(c.env.DB.query<{ user_id: string; csrf_token: string; expires_at: number; auth_kind: string; client: string }>(`SELECT s.user_id, s.csrf_token, s.expires_at, s.client, u.auth_kind
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.suspended_at IS NULL`)
    .bind(tokenHash).first());
  if (!session || session.client !== client || session.expires_at <= Date.now() || !Number.isSafeInteger(session.expires_at) ||
      !OPAQUE_TOKEN.test(session.csrf_token) ||
      (session.auth_kind !== 'github' && session.auth_kind !== 'test') ||
      (session.auth_kind === 'test' && (!testMode(c.env) || !session.user_id.startsWith('test:'))) ||
      (session.auth_kind === 'github' && session.user_id.startsWith('test:'))) {
    if (client === 'browser') expireCookie(c, 'auth');
    fail(401, 'unauthorized', 'Authentication is required.');
  }
  c.set('auth', { userId: session.user_id, tokenHash, csrfToken: session.csrf_token, client });
  await next();
};

function requireTestBearer(c: AppContext): void {
  if (!testMode(c.env)) fail(404, 'not_found', 'Not found.');
  const authorization = c.req.header('authorization');
  const expected = `Bearer ${c.env.TEST_AUTH_SECRET!}`;
  if (!authorization || authorization.length !== expected.length || !constantTimeEqual(authorization, expected)) {
    fail(401, 'unauthorized', 'Valid test authorization is required.');
  }
}

export const csrfGuard: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    requireOrigin(c);
    // Only this public endpoint authenticates independently of ambient cookies.
    if (c.req.method === 'POST' && c.req.path === '/api/auth/test') {
      requireTestBearer(c);
    } else {
      const auth: AuthIdentity | undefined = c.get('auth');
      if (!auth) fail(401, 'unauthorized', 'Authentication is required.');
      // A bearer token is never sent by the browser on its own, so it needs no CSRF token.
      if (auth.client === 'browser') {
        const token = c.req.header('x-csrf-token');
        if (!token || !OPAQUE_TOKEN.test(token) || !constantTimeEqual(token, auth.csrfToken)) {
          fail(403, 'invalid_csrf', 'A valid CSRF token is required.');
        }
      }
    }
  }
  await next();
};

const privateResponse: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  await next();
};

function safeText(value: unknown, field: string, max: number): string {
  const result = text(value, field, max);
  if (!result.trim() || /[\u0000-\u001f\u007f]/.test(result)) fail(400, 'invalid_input', `Invalid ${field}.`);
  return result;
}

function profileInput(body: Record<string, unknown>, allowId = false) {
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(PROFILE_FIELDS, key) && !(allowId && key === 'id')) {
      fail(400, 'invalid_profile', 'Only editable profile fields are accepted.');
    }
  }
  const result: { displayName?: string; gitName?: string; gitEmail?: string; env?: Record<string, string> } = {};
  if ('displayName' in body) result.displayName = safeText(body.displayName, 'displayName', 200);
  if ('gitName' in body) result.gitName = safeText(body.gitName, 'gitName', 200);
  if ('gitEmail' in body) {
    result.gitEmail = safeText(body.gitEmail, 'gitEmail', 254);
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(result.gitEmail)) fail(400, 'invalid_profile', 'Invalid gitEmail.');
  }
  if ('env' in body) {
    try { result.env = validateUserEnv(body.env); }
    catch { fail(400, 'invalid_profile', 'Invalid personal environment values.'); }
  }
  return result;
}

async function currentUser(c: AppContext): Promise<UserRow> {
  const user = await dbResult(getUser(c.env, c.get('auth').userId));
  if (!user) fail(401, 'unauthorized', 'Authentication is required.');
  return user;
}

/** The signed-in user's own profile, which also says whether they administer this server. */
function ownProfile(env: Env, user: UserRow) {
  return { ...userProfile(user), ...(isInstanceAdmin(env, user.id) ? { instanceAdmin: true as const } : {}) };
}

/** A new sign-in. Native sessions are bearer tokens listed as devices under the app's `deviceName`. */
async function newSession(env: Env, userId: string, kind: 'github' | 'test', native?: { deviceName: string | null }) {
  const issuedAt = Date.now();
  let expiresAt = issuedAt + (native ? NATIVE_SESSION_TTL : SESSION_TTL);
  if (kind === 'test') {
    if (!testMode(env)) fail(404, 'not_found', 'Not found.');
    expiresAt = Math.min(expiresAt, Date.parse(env.TEST_AUTH_EXPIRES_AT!));
  }
  const token = randomToken();
  const csrfToken = randomToken();
  const tokenHash = await sha256(token);
  return {
    token, expiresAt,
    statement: env.DB.query(`INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, created_at, client, device_id, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(tokenHash, userId, csrfToken, expiresAt, new Date(issuedAt).toISOString(),
      native ? 'native' : 'browser', native ? id() : null, native?.deviceName ?? null),
  };
}

function sessionCookie(c: AppContext, session: { token: string; expiresAt: number }): void {
  const config = cookies(c.env);
  setCookie(c, config.auth, session.token, {
    ...config.options, expires: new Date(session.expiresAt),
    maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
  });
}

interface GitHubConfig { clientId: string; clientSecret: string; redirectUri: string }
/** A user GitHub just signed in, and the statement that stores their GitHub token with their new sign-in. */
interface GitHubSignIn { user: UserRow; tokenStatement: Query<Record<string, SqlValue>> }

function githubConfig(env: Env): GitHubConfig {
  const origin = appOrigin(env);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET ||
      env.GITHUB_CLIENT_ID.length > 256 || env.GITHUB_CLIENT_SECRET.length > 4096 ||
      /\s/.test(env.GITHUB_CLIENT_ID) || /\s/.test(env.GITHUB_CLIENT_SECRET)) {
    fail(503, 'github_unavailable', 'GitHub authentication is not configured.');
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: origin + CALLBACK_PATH };
}

/** One bounded GitHub JSON exchange that never follows redirects. Non-2xx answers carry no body; transport, size and JSON failures throw. */
async function githubRequest(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return { status: response.status, body: undefined };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 131_072) {
      await reader.cancel();
      throw new Error('GitHub response too large.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
}

// Upstream error bodies are never exposed.
async function githubJson(url: string, init: RequestInit): Promise<unknown> {
  try {
    const result = await githubRequest(url, init);
    if (result.body === undefined) throw new Error('GitHub request failed.');
    return result.body;
  } catch {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
}

/**
 * Resets a GitHub sign-in token through Pistead's OAuth app: the token stops working at once, and the replacement GitHub
 * issues with the same scopes takes its place in the vault while the vault still holds it (`ciphertext`), so the owner
 * stays connected. Returns false only when the reset could not be completed and should be retried.
 */
export async function resetGitHubToken(env: Env, userId: string, token: string, ciphertext: string): Promise<boolean> {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) return false;
  // The OAuth app API authenticates as the app and names the user's token in the body.
  const request = (method: 'PATCH' | 'DELETE', accessToken: string) => githubRequest(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
    method, body: JSON.stringify({ access_token: accessToken }),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/json',
      'User-Agent': 'pistead', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  let replacement: string;
  try {
    const reset = await request('PATCH', token);
    // A token GitHub no longer knows was reset or revoked already.
    if (reset.status === 404) return true;
    const issued = record(reset.body) ? reset.body.token : undefined;
    if (reset.status !== 200 || typeof issued !== 'string' || !issued || issued.length > 16_384 || /[^\x21-\x7e]/.test(issued)) return false;
    replacement = issued;
  } catch {
    return false;
  }
  const stored = await env.DB.query('UPDATE github_tokens SET ciphertext = ?, updated_at = ? WHERE user_id = ? AND ciphertext = ? RETURNING user_id')
    .bind(await encryptToken(env, userId, replacement), now(), userId, ciphertext).first();
  // The owner signed in again meanwhile, so the vault holds a newer token and the replacement is not needed.
  if (!stored) await request('DELETE', replacement).catch(() => undefined);
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Starts GitHub's OAuth. A native app's sign-in carries its PKCE challenge and state through to the callback. */
async function githubStart(c: AppContext, native?: { challenge: string; state: string }) {
  requireOrigin(c);
  await assertVaultConfigured(c.env);
  const config = githubConfig(c.env);
  const state = randomToken();
  const verifier = randomToken();
  const expiresAt = Date.now() + STATE_TTL;
  await dbResult(c.env.DB.query('INSERT INTO oauth_states (state_hash, verifier, expires_at, created_at, native_challenge, native_state) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(state), verifier, expiresAt, now(), native?.challenge ?? null, native?.state ?? null).run());
  const cookieConfig = cookies(c.env);
  setCookie(c, cookieConfig.state, state, { ...cookieConfig.options, maxAge: STATE_TTL / 1000, expires: new Date(expiresAt) });
  const authorization = new URL('https://github.com/login/oauth/authorize');
  authorization.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'read:user user:email repo workflow',
    state, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
  }).toString();
  return c.redirect(authorization.toString());
}

/**
 * A native app's sign-in, opened in the system's authentication browser: `challenge` is base64url(SHA-256) of the
 * app's PKCE verifier and `state` the app's own nonce, both returned to `pistead://auth` after GitHub.
 */
function nativeStart(c: AppContext) {
  const challenges = c.req.queries('challenge');
  const states = c.req.queries('state');
  const challenge = challenges?.length === 1 ? challenges[0] : undefined;
  const state = states?.length === 1 ? states[0] : undefined;
  if (!challenge || !OPAQUE_TOKEN.test(challenge) || !state || !APP_STATE.test(state)) fail(400, 'invalid_native_request', 'Invalid native sign-in request.');
  return githubStart(c, { challenge, state });
}

function nativeCallback(params: Record<string, string>): string {
  return `${NATIVE_CALLBACK}?${new URLSearchParams(params).toString()}`;
}

/** The app's authentication browser closes on its callback, so the app shows a failure, not a JSON page. */
async function nativeFailure(c: AppContext, error: unknown, state: string): Promise<Response> {
  if (!(error instanceof HTTPException)) throw error;
  const body = await error.getResponse().json().catch(() => null) as { code?: unknown } | null;
  return c.redirect(nativeCallback({ error: typeof body?.code === 'string' ? body.code : 'sign_in_failed', state }));
}

/** Exchanges GitHub's code, then creates or updates the user it names; the token statement stores their GitHub token. */
async function githubUser(c: AppContext, config: GitHubConfig, code: string, verifier: string): Promise<GitHubSignIn> {
  const exchange = await githubJson('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, code, code_verifier: verifier }),
  });
  if (!record(exchange) || exchange.error !== undefined || typeof exchange.access_token !== 'string' ||
      !exchange.access_token || exchange.access_token.length > 16_384 || /[^\x21-\x7e]/.test(exchange.access_token) ||
      typeof exchange.token_type !== 'string' || exchange.token_type.toLowerCase() !== 'bearer') {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${exchange.access_token}`,
    'User-Agent': 'pistead', 'X-GitHub-Api-Version': '2022-11-28' };
  const identity = await githubJson('https://api.github.com/user', { headers });
  const emails = await githubJson('https://api.github.com/user/emails?per_page=100', { headers });
  if (!record(identity) || typeof identity.id !== 'number' || !Number.isSafeInteger(identity.id) || identity.id <= 0 ||
      typeof identity.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(identity.login) || !Array.isArray(emails)) {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
  const verified = emails.filter((entry): entry is Record<string, unknown> => record(entry) && entry.verified === true &&
    typeof entry.email === 'string' && entry.email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(entry.email) &&
    !/[\u0000-\u001f\u007f]/.test(entry.email));
  const email = (verified.find((entry) => entry.primary === true) ?? verified[0])?.email;
  if (typeof email !== 'string') fail(403, 'verified_email_required', 'A verified GitHub email address is required.');
  const displayName = typeof identity.name === 'string' && identity.name.trim() && identity.name.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(identity.name) ? identity.name : identity.login;
  const githubId = String(identity.id);
  // Identity comes exclusively from GitHub, never the current cookie (especially test cookies).
  const user = await dbResult(c.env.DB.query<UserRow>(`INSERT INTO users
    (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'github', ?)
    ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login
    WHERE users.auth_kind = 'github' AND users.id NOT LIKE 'test:%'
    RETURNING *`).bind(`github:${githubId}`, githubId, identity.login, displayName, displayName, email, now()).first());
  if (!user || user.auth_kind !== 'github' || user.id.startsWith('test:')) {
    fail(409, 'identity_conflict', 'GitHub identity cannot be used for this account.');
  }
  // Refused before the new token is stored, so a suspended account keeps none it didn't already have.
  if (user.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const ciphertext = await encryptToken(c.env, user.id, exchange.access_token);
  return { user, tokenStatement: c.env.DB.query(`INSERT INTO github_tokens (user_id, ciphertext, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
    .bind(user.id, ciphertext, now()) };
}

async function githubCallback(c: AppContext) {
  await assertVaultConfigured(c.env);
  const config = githubConfig(c.env);
  const states = c.req.queries('state');
  const cookieState = getCookie(c, cookies(c.env).state);
  const state = states?.length === 1 ? states[0] : undefined;
  if (!state || !cookieState || !OPAQUE_TOKEN.test(state) || !OPAQUE_TOKEN.test(cookieState) ||
      !constantTimeEqual(state, cookieState)) {
    fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
  }
  // DELETE RETURNING makes concurrent callbacks and replay fail before code exchange.
  const saved = await dbResult(c.env.DB.query<{ verifier: string; expires_at: number; native_challenge: string | null; native_state: string | null }>(
    'DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier, expires_at, native_challenge, native_state')
    .bind(await sha256(state)).first());
  expireCookie(c, 'state');
  if (!saved || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= Date.now() || !OPAQUE_TOKEN.test(saved.verifier)) {
    fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
  }
  const native = saved.native_challenge !== null && saved.native_state !== null ? { challenge: saved.native_challenge, state: saved.native_state } : undefined;
  let signedIn: GitHubSignIn;
  try {
    const codes = c.req.queries('code');
    const code = codes?.length === 1 ? codes[0] : undefined;
    if (c.req.query('error') !== undefined || !code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code)) {
      fail(400, 'oauth_denied', 'GitHub authorization was not completed.');
    }
    signedIn = await githubUser(c, config, code, saved.verifier);
  } catch (error) {
    if (!native) throw error;
    return nativeFailure(c, error, native.state);
  }
  const { user, tokenStatement } = signedIn;
  if (native) {
    const code = randomToken();
    try {
      await dbResult(c.env.DB.batch([
        tokenStatement,
        c.env.DB.query('DELETE FROM native_auth_codes WHERE expires_at <= ?').bind(Date.now()),
        c.env.DB.query('INSERT INTO native_auth_codes (code_hash, user_id, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(await sha256(code), user.id, native.challenge, Date.now() + NATIVE_CODE_TTL, now()),
      ]));
    } catch (error) {
      return nativeFailure(c, error, native.state);
    }
    return c.redirect(nativeCallback({ code, state: native.state }));
  }
  const session = await newSession(c.env, user.id, 'github');
  await dbResult(c.env.DB.batch([tokenStatement, session.statement]));
  sessionCookie(c, session);
  return c.redirect(appOrigin(c.env) + '/');
}

/**
 * The app exchanges the code from its callback, with the PKCE verifier only it holds, for a bearer session. A code
 * works once, also when the verifier is wrong, and only for two minutes.
 */
async function nativeToken(c: AppContext) {
  const body = await jsonObject(c, 4096);
  if (Object.keys(body).some(key => !['code', 'verifier', 'deviceName'].includes(key))) fail(400, 'invalid_input', 'Only code, verifier and deviceName are accepted.');
  const { code, verifier } = body;
  if (typeof code !== 'string' || !OPAQUE_TOKEN.test(code) || typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
    fail(400, 'invalid_grant', 'The sign-in has expired or was already used. Sign in again.');
  }
  const deviceName = body.deviceName === undefined || body.deviceName === null ? null : safeText(body.deviceName, 'deviceName', 100);
  const saved = await dbResult(c.env.DB.query<{ user_id: string; challenge: string; expires_at: number }>(
    'DELETE FROM native_auth_codes WHERE code_hash = ? RETURNING user_id, challenge, expires_at').bind(await sha256(code)).first());
  if (!saved || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= Date.now() || !constantTimeEqual(await sha256(verifier), saved.challenge)) {
    fail(400, 'invalid_grant', 'The sign-in has expired or was already used. Sign in again.');
  }
  const user = await dbResult(getUser(c.env, saved.user_id));
  if (!user || user.auth_kind !== 'github' || user.id.startsWith('test:')) fail(401, 'unauthorized', 'Authentication is required.');
  if (user.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  const session = await newSession(c.env, user.id, 'github', { deviceName });
  await dbResult(session.statement.run());
  return c.json({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), user: userProfile(user) } satisfies NativeSignIn);
}

async function testLogin(c: AppContext) {
  requireTestBearer(c);
  const body = await jsonObject(c, 131_072);
  const { githubLogin: requestedGithubLogin, client, deviceName, ...profileBody } = body;
  // Development of the native apps: a test-mode bearer session instead of the cookie.
  if (client !== undefined && client !== 'browser' && client !== 'native') fail(400, 'invalid_input', 'Invalid test client.');
  // An app with no name for its device may send null or leave it out.
  if (client !== 'native' && deviceName !== undefined && deviceName !== null) fail(400, 'invalid_input', 'Only native test sessions have a device name.');
  const native = client === 'native' ? { deviceName: deviceName === undefined || deviceName === null ? null : safeText(deviceName, 'deviceName', 100) } : undefined;
  const profile = profileInput(profileBody, true);
  if (requestedGithubLogin !== undefined &&
      (typeof requestedGithubLogin !== 'string' ||
       !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(requestedGithubLogin))) {
    fail(400, 'invalid_profile', 'Invalid test githubLogin.');
  }
  const suppliedId = body.id;
  const stableId = suppliedId === undefined ? id() : identifier(
    typeof suppliedId === 'string' && suppliedId.startsWith('test:') ? suppliedId.slice(5) : suppliedId,
  );
  const userId = `test:${stableId}`;
  const existing = await dbResult(getUser(c.env, userId));
  if (existing && (existing.auth_kind !== 'test' || existing.github_id !== null || existing.github_connected)) {
    fail(409, 'identity_conflict', 'Test identity cannot be used for this account.');
  }
  if (existing?.suspended_at) fail(403, 'account_suspended', SUSPENDED);
  // Omitted fields preserve an existing identity's profile; names and emails never select an identity.
  const displayName = profile.displayName ?? existing?.display_name ?? stableId;
  const gitName = profile.gitName ?? existing?.git_name ?? displayName;
  const gitEmail = profile.gitEmail ?? existing?.git_email ?? 'test@example.test';
  const environment = profile.env ? JSON.stringify(profile.env) : existing?.env_json ?? '{}';
  // Test-only display metadata is never a GitHub identity or evidence of a connection.
  const githubLogin = requestedGithubLogin ?? existing?.github_login ?? null;
  const session = await newSession(c.env, userId, 'test', native);
  await dbResult(c.env.DB.batch([
    c.env.DB.query(`INSERT INTO users
      (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'test', ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, git_name = excluded.git_name,
        git_email = excluded.git_email, env_json = excluded.env_json, github_login = excluded.github_login
      WHERE users.auth_kind = 'test' AND users.github_id IS NULL`)
      .bind(userId, githubLogin, displayName, gitName, gitEmail, environment, now()),
    session.statement,
  ]));
  const user = await dbResult(getUser(c.env, userId));
  if (!user || user.auth_kind !== 'test' || user.github_id !== null || user.github_connected) {
    fail(409, 'identity_conflict', 'Test identity cannot be used for this account.');
  }
  if (!testMode(c.env)) fail(404, 'not_found', 'Not found.');
  if (native) return c.json({ user: userProfile(user), token: session.token, expiresAt: new Date(session.expiresAt).toISOString() } satisfies NativeSignIn);
  sessionCookie(c, session);
  return c.json({ user: userProfile(user) });
}

// Register before a parent's /api/* authenticate + csrfGuard stack. These routes own their guards.
export function registerAuth(app: Hono<WorkerEnv>): void {
  app.get('/api/auth/github', privateResponse, c => githubStart(c));
  app.get(CALLBACK_PATH, privateResponse, githubCallback);
  app.get('/api/auth/native/start', privateResponse, nativeStart);
  app.post('/api/auth/native/token', privateResponse, nativeToken);
  app.post('/api/auth/test', privateResponse, csrfGuard, testLogin);
  app.get('/api/auth/csrf', privateResponse, authenticate, (c) => c.json({ csrfToken: c.get('auth').csrfToken }));
  app.get('/api/me', privateResponse, authenticate, async (c) => c.json({ user: ownProfile(c.env, await currentUser(c)) }));
  app.patch('/api/me', privateResponse, authenticate, csrfGuard, async (c) => {
    const profile = profileInput(await jsonObject(c, 131_072));
    const assignments: string[] = [];
    const values: string[] = [];
    for (const [key, column] of [['displayName', 'display_name'], ['gitName', 'git_name'], ['gitEmail', 'git_email']] as const) {
      if (profile[key] !== undefined) { assignments.push(`${column} = ?`); values.push(profile[key]); }
    }
    if (profile.env !== undefined) { assignments.push('env_json = ?'); values.push(JSON.stringify(profile.env)); }
    if (!assignments.length) fail(400, 'invalid_profile', 'Provide at least one editable profile field.');
    await dbResult(c.env.DB.query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`)
      .bind(...values, c.get('auth').userId).run());
    return c.json({ user: ownProfile(c.env, await currentUser(c)) });
  });
  app.post('/api/auth/logout', privateResponse, authenticate, csrfGuard, async (c) => {
    await dbResult(c.env.DB.query('DELETE FROM auth_sessions WHERE token_hash = ?').bind(c.get('auth').tokenHash).run());
    if (c.get('auth').client === 'browser') expireCookie(c, 'auth');
    return c.json({ ok: true });
  });
  // The native apps signed in as this user, so a lost device can be cut off from the web app.
  app.get('/api/me/devices', privateResponse, authenticate, async (c) => {
    const auth = c.get('auth');
    const rows = await dbResult(c.env.DB.query<{ device_id: string; device_name: string | null; created_at: string; expires_at: number; token_hash: string }>(
      `SELECT device_id, device_name, created_at, expires_at, token_hash FROM auth_sessions
      WHERE user_id = ? AND client = 'native' AND device_id IS NOT NULL AND expires_at > ? ORDER BY created_at DESC`)
      .bind(auth.userId, Date.now()).all());
    const devices: SignedInDevice[] = rows.map(row => ({ id: row.device_id, name: row.device_name, createdAt: row.created_at,
      expiresAt: new Date(Number(row.expires_at)).toISOString(), current: row.token_hash === auth.tokenHash }));
    return c.json({ devices });
  });
  app.delete('/api/me/devices/:id', privateResponse, authenticate, csrfGuard, async (c) => {
    const removed = await dbResult(c.env.DB.query(`DELETE FROM auth_sessions WHERE device_id = ? AND user_id = ? AND client = 'native' RETURNING device_id`)
      .bind(identifier(c.req.param('id'), 'deviceId'), c.get('auth').userId).first());
    if (!removed) fail(404, 'not_found', 'Device not found.');
    return c.json({ ok: true });
  });
}
