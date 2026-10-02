import type { Hono, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import { validateUserEnv } from '../../../packages/shared/src/policy.js';
import { getUser, userProfile } from './db.js';
import { appOrigin, fail, id, identifier, jsonObject, now, randomToken, requireOrigin, testMode, text } from './http.js';
import type { AppContext, AuthIdentity, Env, UserRow, WorkerEnv } from './types.js';
import { assertVaultConfigured, encryptToken } from './vault.js';

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = '/api/auth/github/callback';
const PROFILE_FIELDS: Record<string, true> = { displayName: true, gitName: true, gitEmail: true, env: true };

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
  const token = getCookie(c, cookies(c.env).auth);
  if (!token || !OPAQUE_TOKEN.test(token)) fail(401, 'unauthorized', 'Authentication is required.');
  const tokenHash = await sha256(token);
  const session = await dbResult(c.env.DB.prepare(`SELECT s.user_id, s.csrf_token, s.expires_at, u.auth_kind
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .bind(tokenHash).first<{ user_id: string; csrf_token: string; expires_at: number; auth_kind: string }>());
  if (!session || session.expires_at <= Date.now() || !Number.isSafeInteger(session.expires_at) ||
      !OPAQUE_TOKEN.test(session.csrf_token) ||
      (session.auth_kind !== 'github' && session.auth_kind !== 'test') ||
      (session.auth_kind === 'test' && (!testMode(c.env) || !session.user_id.startsWith('test:'))) ||
      (session.auth_kind === 'github' && session.user_id.startsWith('test:'))) {
    expireCookie(c, 'auth');
    fail(401, 'unauthorized', 'Authentication is required.');
  }
  c.set('auth', { userId: session.user_id, tokenHash, csrfToken: session.csrf_token });
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
      const token = c.req.header('x-csrf-token');
      if (!auth) fail(401, 'unauthorized', 'Authentication is required.');
      if (!token || !OPAQUE_TOKEN.test(token) || !constantTimeEqual(token, auth.csrfToken)) {
        fail(403, 'invalid_csrf', 'A valid CSRF token is required.');
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

async function newSession(env: Env, userId: string, kind: 'github' | 'test') {
  const issuedAt = Date.now();
  let expiresAt = issuedAt + SESSION_TTL;
  if (kind === 'test') {
    if (!testMode(env)) fail(404, 'not_found', 'Not found.');
    expiresAt = Math.min(expiresAt, Date.parse(env.TEST_AUTH_EXPIRES_AT!));
  }
  const token = randomToken();
  const csrfToken = randomToken();
  const tokenHash = await sha256(token);
  return {
    token, expiresAt,
    statement: env.DB.prepare(`INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(tokenHash, userId, csrfToken, expiresAt, new Date(issuedAt).toISOString()),
  };
}

function sessionCookie(c: AppContext, session: { token: string; expiresAt: number }): void {
  const config = cookies(c.env);
  setCookie(c, config.auth, session.token, {
    ...config.options, expires: new Date(session.expiresAt),
    maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
  });
}

function githubConfig(env: Env) {
  const origin = appOrigin(env);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET ||
      env.GITHUB_CLIENT_ID.length > 256 || env.GITHUB_CLIENT_SECRET.length > 4096 ||
      /\s/.test(env.GITHUB_CLIENT_ID) || /\s/.test(env.GITHUB_CLIENT_SECRET)) {
    fail(503, 'github_unavailable', 'GitHub authentication is not configured.');
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: origin + CALLBACK_PATH };
}

// Never follow redirects with a client secret or bearer token, or expose upstream error bodies.
async function githubJson(url: string, init: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error('GitHub request failed.');
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function githubStart(c: AppContext) {
  requireOrigin(c);
  await assertVaultConfigured(c.env);
  const config = githubConfig(c.env);
  const state = randomToken();
  const verifier = randomToken();
  const expiresAt = Date.now() + STATE_TTL;
  await dbResult(c.env.DB.prepare('INSERT INTO oauth_states (state_hash, verifier, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(state), verifier, expiresAt, now()).run());
  const cookieConfig = cookies(c.env);
  setCookie(c, cookieConfig.state, state, { ...cookieConfig.options, maxAge: STATE_TTL / 1000, expires: new Date(expiresAt) });
  const authorization = new URL('https://github.com/login/oauth/authorize');
  authorization.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'read:user user:email repo',
    state, code_challenge: await sha256(verifier), code_challenge_method: 'S256',
  }).toString();
  return c.redirect(authorization.toString());
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
  const saved = await dbResult(c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier, expires_at')
    .bind(await sha256(state)).first<{ verifier: string; expires_at: number }>());
  expireCookie(c, 'state');
  if (!saved || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= Date.now() || !OPAQUE_TOKEN.test(saved.verifier)) {
    fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
  }
  const codes = c.req.queries('code');
  const code = codes?.length === 1 ? codes[0] : undefined;
  if (c.req.query('error') !== undefined || !code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code)) {
    fail(400, 'oauth_denied', 'GitHub authorization was not completed.');
  }
  const exchange = await githubJson('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, code, code_verifier: saved.verifier }),
  });
  if (!record(exchange) || exchange.error !== undefined || typeof exchange.access_token !== 'string' ||
      !exchange.access_token || exchange.access_token.length > 16_384 || /[^\x21-\x7e]/.test(exchange.access_token) ||
      typeof exchange.token_type !== 'string' || exchange.token_type.toLowerCase() !== 'bearer') {
    fail(502, 'github_error', 'GitHub authentication could not be completed.');
  }
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${exchange.access_token}`,
    'User-Agent': 'agent-workspace', 'X-GitHub-Api-Version': '2022-11-28' };
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
  const user = await dbResult(c.env.DB.prepare(`INSERT INTO users
    (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'github', ?)
    ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login
    WHERE users.auth_kind = 'github' AND users.id NOT LIKE 'test:%'
    RETURNING *`).bind(`github:${githubId}`, githubId, identity.login, displayName, displayName, email, now()).first<UserRow>());
  if (!user || user.auth_kind !== 'github' || user.id.startsWith('test:')) {
    fail(409, 'identity_conflict', 'GitHub identity cannot be used for this account.');
  }
  const ciphertext = await encryptToken(c.env, user.id, exchange.access_token);
  const session = await newSession(c.env, user.id, 'github');
  await dbResult(c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO github_tokens (user_id, ciphertext, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
      .bind(user.id, ciphertext, now()),
    session.statement,
  ]));
  sessionCookie(c, session);
  return c.redirect(appOrigin(c.env) + '/');
}

async function testLogin(c: AppContext) {
  requireTestBearer(c);
  const body = await jsonObject(c, 131_072);
  const { githubLogin: requestedGithubLogin, ...profileBody } = body;
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
  // Omitted fields preserve an existing identity's profile; names and emails never select an identity.
  const displayName = profile.displayName ?? existing?.display_name ?? stableId;
  const gitName = profile.gitName ?? existing?.git_name ?? displayName;
  const gitEmail = profile.gitEmail ?? existing?.git_email ?? 'test@example.test';
  const environment = profile.env ? JSON.stringify(profile.env) : existing?.env_json ?? '{}';
  // Test-only display metadata is never a GitHub identity or evidence of a connection.
  const githubLogin = requestedGithubLogin ?? existing?.github_login ?? null;
  const session = await newSession(c.env, userId, 'test');
  await dbResult(c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO users
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
  sessionCookie(c, session);
  return c.json({ user: userProfile(user) });
}

// Register before a parent's /api/* authenticate + csrfGuard stack. These routes own their guards.
export function registerAuth(app: Hono<WorkerEnv>): void {
  app.get('/api/auth/github', privateResponse, githubStart);
  app.get(CALLBACK_PATH, privateResponse, githubCallback);
  app.post('/api/auth/test', privateResponse, csrfGuard, testLogin);
  app.get('/api/auth/csrf', privateResponse, authenticate, (c) => c.json({ csrfToken: c.get('auth').csrfToken }));
  app.get('/api/me', privateResponse, authenticate, async (c) => c.json({ user: userProfile(await currentUser(c)) }));
  app.patch('/api/me', privateResponse, authenticate, csrfGuard, async (c) => {
    const profile = profileInput(await jsonObject(c, 131_072));
    const assignments: string[] = [];
    const values: string[] = [];
    for (const [key, column] of [['displayName', 'display_name'], ['gitName', 'git_name'], ['gitEmail', 'git_email']] as const) {
      if (profile[key] !== undefined) { assignments.push(`${column} = ?`); values.push(profile[key]); }
    }
    if (profile.env !== undefined) { assignments.push('env_json = ?'); values.push(JSON.stringify(profile.env)); }
    if (!assignments.length) fail(400, 'invalid_profile', 'Provide at least one editable profile field.');
    await dbResult(c.env.DB.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`)
      .bind(...values, c.get('auth').userId).run());
    return c.json({ user: userProfile(await currentUser(c)) });
  });
  app.post('/api/auth/logout', privateResponse, authenticate, csrfGuard, async (c) => {
    await dbResult(c.env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(c.get('auth').tokenHash).run());
    expireCookie(c, 'auth');
    return c.json({ ok: true });
  });
}
