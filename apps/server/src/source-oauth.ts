import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import { documentKindNames, oauthKinds, type DocumentKind } from '../../../packages/shared/src/sources.js';
import type { AppContext, Env, WorkerEnv } from './types.js';
import { auditStatement } from './db.js';
import { fail, id, now } from './http.js';
import { encryptToken } from './vault.js';
import { accountRejected, clean, json, rateLimited, upstream } from './document-http.js';

/**
 * Connecting a document source by signing in to its provider (OAuth 2.0 authorization code, with PKCE where the
 * provider takes it). The operator registers one app per provider (GOOGLE_CLIENT_ID, NOTION_CLIENT_ID,
 * DROPBOX_CLIENT_ID, MICROSOFT_CLIENT_ID, TENCENT_DOCS_CLIENT_ID and their secrets) with the redirect URI
 * APP_ORIGIN/api/source-accounts/<provider>/oauth/callback. Pistead keeps the member's tokens encrypted, refreshes them
 * on the control plane, and hands adapters only a current access token; none of it reaches a host.
 */
const STATE_TTL = 10 * 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{43}$/;

type Json = Record<string, unknown>;

/** What a member's OAuth connection stores (encrypted). */
export interface OAuthSecret {
  mode: 'oauth';
  accessToken: string;
  refreshToken?: string;
  /** Milliseconds since the epoch; absent where the provider's tokens don't expire (Notion). */
  expiresAt?: number;
  /** Tencent Docs' user id, which its API wants with every call. */
  openId?: string;
}

interface Provider {
  clientId: (env: Env) => string | undefined;
  clientSecret: (env: Env) => string | undefined;
  authorize: (env: Env) => string;
  /** Extra authorization parameters (scopes, offline access). */
  params: Record<string, string>;
  pkce: boolean;
  /** Exchanges a code or a refresh token; returns the provider's token JSON. */
  token: (env: Env, grant: Record<string, string>) => Promise<Json>;
  /** The account's name, as its owner recognizes it. */
  name: (secret: OAuthSecret, tokens: Json) => Promise<string>;
}

async function tokenAnswer(provider: string, answer: Awaited<ReturnType<typeof upstream>>): Promise<Json> {
  if (answer.status === 429) rateLimited(provider);
  if (answer.status === 400 || answer.status === 401 || answer.status === 403) accountRejected(provider);
  if (answer.status !== 200) fail(502, 'source_unavailable', `${provider} could not complete the sign-in. Try again later.`);
  return json(provider, answer);
}

/** A standard token endpoint: a form POST with the app's credentials in the body. */
function formToken(provider: string, url: (env: Env) => string, clientId: (env: Env) => string | undefined, clientSecret: (env: Env) => string | undefined) {
  return async (env: Env, grant: Record<string, string>) => tokenAnswer(provider, await upstream(provider, url(env), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...grant, client_id: clientId(env)!, client_secret: clientSecret(env)! }).toString(),
  }, 64 * 1024));
}

async function bearerJson(provider: string, url: string, token: string, init: RequestInit = {}): Promise<Json> {
  const answer = await upstream(provider, url, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers ?? {}) } }, 256 * 1024);
  if (answer.status === 401) accountRejected(provider);
  if (answer.status !== 200) fail(502, 'source_unavailable', `${provider} could not complete the sign-in. Try again later.`);
  return json(provider, answer);
}

const microsoftTenant = (env: Env) => /^[A-Za-z0-9.-]{1,100}$/.test(env.MICROSOFT_TENANT ?? '') ? env.MICROSOFT_TENANT! : 'common';

export const oauthProviders: Record<Exclude<DocumentKind, 'feishu'>, Provider> = {
  'google-drive': {
    clientId: env => env.GOOGLE_CLIENT_ID, clientSecret: env => env.GOOGLE_CLIENT_SECRET,
    authorize: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    params: { scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    pkce: true,
    token: formToken('Google', () => 'https://oauth2.googleapis.com/token', env => env.GOOGLE_CLIENT_ID, env => env.GOOGLE_CLIENT_SECRET),
    name: async secret => {
      const about = await bearerJson('Google Drive', 'https://www.googleapis.com/drive/v3/about?fields=user', secret.accessToken);
      return clean((about.user as Json | undefined)?.emailAddress) || 'Google Drive';
    },
  },
  notion: {
    clientId: env => env.NOTION_CLIENT_ID, clientSecret: env => env.NOTION_CLIENT_SECRET,
    authorize: () => 'https://api.notion.com/v1/oauth/authorize',
    params: { owner: 'user' },
    pkce: false,
    // Notion's token endpoint takes JSON with the app's credentials as Basic auth.
    token: async (env, grant) => tokenAnswer('Notion', await upstream('Notion', 'https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(grant),
    }, 64 * 1024)),
    name: async (_secret, tokens) => clean(tokens.workspace_name) || 'Notion',
  },
  dropbox: {
    clientId: env => env.DROPBOX_CLIENT_ID, clientSecret: env => env.DROPBOX_CLIENT_SECRET,
    authorize: () => 'https://www.dropbox.com/oauth2/authorize',
    params: { token_access_type: 'offline', scope: 'account_info.read files.metadata.read files.content.read sharing.read' },
    pkce: true,
    token: formToken('Dropbox', () => 'https://api.dropboxapi.com/oauth2/token', env => env.DROPBOX_CLIENT_ID, env => env.DROPBOX_CLIENT_SECRET),
    name: async secret => {
      const account = await bearerJson('Dropbox', 'https://api.dropboxapi.com/2/users/get_current_account', secret.accessToken, { method: 'POST' });
      return clean(account.email) || clean((account.name as Json | undefined)?.display_name) || 'Dropbox';
    },
  },
  onedrive: {
    clientId: env => env.MICROSOFT_CLIENT_ID, clientSecret: env => env.MICROSOFT_CLIENT_SECRET,
    authorize: env => `https://login.microsoftonline.com/${microsoftTenant(env)}/oauth2/v2.0/authorize`,
    params: { scope: 'offline_access User.Read Files.Read.All Sites.Read.All', response_mode: 'query' },
    pkce: true,
    token: formToken('Microsoft', env => `https://login.microsoftonline.com/${microsoftTenant(env)}/oauth2/v2.0/token`, env => env.MICROSOFT_CLIENT_ID, env => env.MICROSOFT_CLIENT_SECRET),
    name: async secret => {
      const me = await bearerJson('Microsoft', 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', secret.accessToken);
      return clean(me.mail) || clean(me.userPrincipalName) || 'Microsoft';
    },
  },
  'tencent-docs': {
    clientId: env => env.TENCENT_DOCS_CLIENT_ID, clientSecret: env => env.TENCENT_DOCS_CLIENT_SECRET,
    authorize: () => 'https://docs.qq.com/oauth/v2/authorize',
    params: { scope: 'all' },
    pkce: false,
    // Tencent Docs' token endpoint is a GET with everything in the query (verify against its documentation).
    token: async (env, grant) => {
      const query = new URLSearchParams({ ...grant, client_id: env.TENCENT_DOCS_CLIENT_ID!, client_secret: env.TENCENT_DOCS_CLIENT_SECRET! });
      return tokenAnswer('Tencent Docs', await upstream('Tencent Docs', `https://docs.qq.com/oauth/v2/token?${query}`, { headers: { Accept: 'application/json' } }, 64 * 1024));
    },
    name: async secret => {
      const info = await bearerJson('Tencent Docs', `https://docs.qq.com/oauth/v2/userinfo?access_token=${encodeURIComponent(secret.accessToken)}`, secret.accessToken);
      return clean((info.data as Json | undefined)?.nick) || 'Tencent Docs';
    },
  },
};

export function oauthProvider(kind: DocumentKind): Provider | null {
  return kind === 'feishu' ? null : oauthProviders[kind];
}
/** The kinds this server offers sign-in for: those whose app the operator configured. */
export function configuredOAuth(env: Env): DocumentKind[] {
  return oauthKinds.filter(kind => { const provider = oauthProvider(kind); return Boolean(provider?.clientId(env) && provider.clientSecret(env)); });
}

function redirectUri(env: Env, kind: DocumentKind): string {
  return `${env.APP_ORIGIN}/api/source-accounts/${kind}/oauth/callback`;
}

/** A token response as what Pistead stores; refreshes keep the refresh token a provider doesn't repeat. */
export function oauthSecret(tokens: Json, previous?: OAuthSecret): OAuthSecret {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) fail(502, 'invalid_source_response', 'The provider returned no access token.');
  const lifetime = typeof tokens.expires_in === 'number' ? tokens.expires_in : typeof tokens.expires_in === 'string' ? Number(tokens.expires_in) : NaN;
  const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : previous?.refreshToken;
  const openId = typeof tokens.user_id === 'string' ? tokens.user_id : previous?.openId;
  return { mode: 'oauth', accessToken: tokens.access_token, ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(lifetime) && lifetime > 0 ? { expiresAt: Date.now() + lifetime * 1000 } : {}), ...(openId ? { openId } : {}) };
}

/** A fresh secret from the refresh token, when the access token is (nearly) expired; null when still current. */
export async function refreshedSecret(env: Env, kind: DocumentKind, secret: OAuthSecret): Promise<OAuthSecret | null> {
  if (!secret.expiresAt || secret.expiresAt > Date.now() + 60_000) return null;
  const provider = oauthProvider(kind);
  if (!secret.refreshToken || !provider?.clientId(env) || !provider.clientSecret(env)) accountRejected(documentKindNames[kind]);
  return oauthSecret(await provider.token(env, { grant_type: 'refresh_token', refresh_token: secret.refreshToken }), secret);
}

function stateCookie(env: Env) {
  const secure = new URL(env.APP_ORIGIN).protocol === 'https:';
  return { name: secure ? '__Host-source-oauth' : 'test-source-oauth', options: { secure, httpOnly: true, sameSite: 'Lax' as const, path: '/' } };
}

/** Back to the profile, with what happened for the page to show. */
function finish(c: AppContext, kind: string, result: 'connected' | 'error', reason?: string): Response {
  const query = new URLSearchParams({ source_account: kind, result, ...(reason ? { reason } : {}) });
  return c.redirect(`${c.env.APP_ORIGIN}/?${query}#/settings/profile`);
}

function kindParam(c: AppContext): DocumentKind {
  const kind = c.req.param('provider') as DocumentKind;
  if (!oauthProvider(kind) || !configuredOAuth(c.env).includes(kind)) fail(404, 'oauth_unavailable', 'This server does not offer signing in to that provider.');
  return kind;
}

export function registerSourceOAuth(app: Hono<WorkerEnv>): void {
  app.get('/api/source-accounts/:provider/oauth/start', async c => {
    const kind = kindParam(c);
    const provider = oauthProvider(kind)!;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + STATE_TTL;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM source_oauth_states WHERE expires_at < ? OR user_id = ?').bind(Date.now(), c.get('auth').userId),
      c.env.DB.query('INSERT INTO source_oauth_states (state_hash, user_id, provider, verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await sha256(state), c.get('auth').userId, kind, verifier, expiresAt, now()),
    ]);
    const cookie = stateCookie(c.env);
    setCookie(c, cookie.name, state, { ...cookie.options, maxAge: STATE_TTL / 1000, expires: new Date(expiresAt) });
    const query = new URLSearchParams({ client_id: provider.clientId(c.env)!, redirect_uri: redirectUri(c.env, kind), response_type: 'code', state, ...provider.params,
      ...(provider.pkce ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}) });
    return c.redirect(`${provider.authorize(c.env)}?${query}`);
  });

  app.get('/api/source-accounts/:provider/oauth/callback', async c => {
    const kind = kindParam(c);
    const provider = oauthProvider(kind)!;
    const actor = c.get('auth').userId;
    const cookie = stateCookie(c.env);
    const cookieState = getCookie(c, cookie.name);
    setCookie(c, cookie.name, '', { ...cookie.options, maxAge: 0, expires: new Date(0) });
    const states = c.req.queries('state');
    const state = states?.length === 1 ? states[0]! : '';
    // The state must be the one this browser was given, for this member and provider, used once, within 10 minutes.
    if (!STATE.test(state) || !cookieState || !STATE.test(cookieState) || !constantTimeEqual(state, cookieState)) return finish(c, kind, 'error', 'invalid_state');
    const saved = await c.env.DB.query<{ verifier: string; expires_at: number; user_id: string; provider: string }>(
      'DELETE FROM source_oauth_states WHERE state_hash = ? RETURNING verifier, expires_at, user_id, provider').bind(await sha256(state)).first();
    if (!saved || saved.user_id !== actor || saved.provider !== kind || Number(saved.expires_at) < Date.now()) return finish(c, kind, 'error', 'invalid_state');
    const error = c.req.query('error');
    if (error) return finish(c, kind, 'error', error === 'access_denied' ? 'access_denied' : 'provider_error');
    const code = c.req.query('code');
    if (!code || code.length > 4096) return finish(c, kind, 'error', 'provider_error');
    try {
      const tokens = await provider.token(c.env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(c.env, kind), ...(provider.pkce ? { code_verifier: saved.verifier } : {}) });
      const secret = oauthSecret(tokens);
      const name = (await provider.name(secret, tokens)).slice(0, 300) || documentKindNames[kind];
      const ciphertext = await encryptToken(c.env, actor, JSON.stringify(secret));
      await c.env.DB.batch([
        c.env.DB.query(`INSERT INTO source_accounts (id, user_id, provider, ciphertext, account_name, method, created_at) VALUES (?, ?, ?, ?, ?, 'oauth', ?)
          ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, account_name = excluded.account_name, method = 'oauth', created_at = excluded.created_at`)
          .bind(id(), actor, kind, ciphertext, name, now()),
        auditStatement(c.env, actor, 'source_account.connected', null, null, { provider: kind, name, method: 'oauth' }),
      ]);
      return finish(c, kind, 'connected');
    } catch (failure) {
      const reason = failure && typeof failure === 'object' && 'getResponse' in failure
        ? await (failure as { getResponse(): Response }).getResponse().json().then((body: { code?: string }) => body.code ?? 'provider_error', () => 'provider_error') : 'provider_error';
      return finish(c, kind, 'error', reason);
    }
  });
}
