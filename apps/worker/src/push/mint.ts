import type { GitProvider } from '../../../../packages/shared/src/repositories.js';
import { gitProviderNames } from '../../../../packages/shared/src/repositories.js';
import type { PushIdentityKind } from '../../../../packages/shared/src/types.js';
import type { Env, PushIdentityRow } from '../types.js';
import { appOrigin, fail, now } from '../http.js';
import { decryptToken, encryptToken } from '../vault.js';
import { importRsaPrivateKey, signJwt } from './jwt.js';
import { issuerAssertion, workspaceSubject } from './oidc.js';

export interface MintTarget {
  workspaceId: string; sessionId: string;
  provider: GitProvider; host: string; fullName: string; repositoryId: string; branch: string;
}
export interface MintedToken {
  kind: PushIdentityKind;            // 'github-app' for the operator app too
  identityId: string | null;         // null = operator GitHub App
  authorization: string;             // full Authorization header value for git smart HTTP
  expiresAt: number;                 // unix seconds
  revocation?: { kind: 'github-installation'; apiBase: string; token: string };
}
export interface OAuthSecret { clientSecret: string; refreshToken?: string }
interface GitHubApp { appId: string; slug: string; privateKey: string }
interface Upstream { status: number; body: Record<string, unknown> | null }
/** Minting failures are 502s; save-time verification reports rejected settings as 400s. */
type Purpose = 'mint' | 'verify';

const remoteTimeout = 20_000;
const jsonLimit = 64 * 1024;
const userAgent = 'OpenCara-Agent-Workspace';
const formType = 'application/x-www-form-urlencoded';
const entraScope = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const tokenPattern = /^[\x21-\x7e]{1,16384}$/;
// oauth-refresh rotation: a lease outlives one 20 s refresh; waiters retry for about 10 s.
const leaseSeconds = 60;
const leaseAttempts = 40;
const leaseRetryMs = 250;

/** Vault associated data for a push identity's secret. */
export function identitySecretContext(identityId: string): string {
  return `push-identity:${identityId}`;
}
export function oauthRedirectUri(env: Env): string {
  return `${appOrigin(env)}/api/push-identities/oauth/callback`;
}
/** GitLab and Gitea OAuth2 endpoints and the narrowest scope that allows pushing. */
export function oauthEndpoints(provider: GitProvider, host: string): { authorize: string; token: string; scope: string } {
  return provider === 'gitlab'
    ? { authorize: `https://${host}/oauth/authorize`, token: `https://${host}/oauth/token`, scope: 'write_repository' }
    : { authorize: `https://${host}/login/oauth/authorize`, token: `https://${host}/login/oauth/access_token`, scope: 'write:repository' };
}
export function githubApiBase(provider: GitProvider, host: string): string {
  return provider === 'github' ? 'https://api.github.com' : `https://${host}/api/v3`;
}
export function githubInstallUrl(provider: GitProvider, host: string, slug: string): string {
  return provider === 'github' ? `https://github.com/apps/${slug}/installations/new` : `https://${host}/github-apps/${slug}/installations/new`;
}
export function oauthSecret(value: string): OAuthSecret {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = null; }
  const secret = parsed as Partial<OAuthSecret> | null;
  if (!secret || typeof secret.clientSecret !== 'string' || !secret.clientSecret ||
      (secret.refreshToken !== undefined && (typeof secret.refreshToken !== 'string' || !tokenPattern.test(secret.refreshToken)))) {
    fail(500, 'vault_error', 'Unable to read connected account credentials.');
  }
  return secret.refreshToken === undefined ? { clientSecret: secret.clientSecret } : { clientSecret: secret.clientSecret, refreshToken: secret.refreshToken };
}

function unavailable(purpose: Purpose): never {
  return purpose === 'mint' ? fail(502, 'push_token_unavailable', 'The Git provider did not issue a push token. Try again later.')
    : fail(502, 'push_identity_unverifiable', 'The Git provider could not be reached to verify this push identity. Try again later.');
}
function rejected(purpose: Purpose): never {
  return purpose === 'mint' ? unavailable(purpose)
    : fail(400, 'push_identity_rejected', 'The Git provider rejected this push identity. Check its settings and try again.');
}
function expectStatus(purpose: Purpose, response: Upstream, status: number): Record<string, unknown> {
  if (response.status !== status) return response.status >= 400 && response.status < 500 ? rejected(purpose) : unavailable(purpose);
  return response.body ?? unavailable(purpose);
}
function basic(user: string, secret: string): string {
  return `Basic ${btoa(`${user}:${secret}`)}`;
}
function token(purpose: Purpose, value: unknown): string {
  if (typeof value !== 'string' || !tokenPattern.test(value)) unavailable(purpose);
  return value;
}
/** Provider-reported lifetime, bounded by the documented maximum. */
function expiresAt(expiresIn: unknown, maximum: number): number {
  const seconds = typeof expiresIn === 'number' && Number.isSafeInteger(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, maximum) : maximum;
  return Math.floor(Date.now() / 1000) + seconds;
}

/** Every upstream call: no redirects, bounded time and body, fixed errors; upstream bodies are never surfaced. */
async function upstream(purpose: Purpose, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Upstream> {
  let response: Response;
  try {
    response = await fetch(url, { method: init.method ?? 'GET', headers: { Accept: 'application/json', 'User-Agent': userAgent, ...init.headers },
      body: init.body, redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout) });
  } catch { return unavailable(purpose); }
  const declared = Number(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number.isFinite(declared) && declared > jsonLimit) throw new Error('Body too large.');
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > jsonLimit) throw new Error('Body too large.');
      chunks.push(part.value);
    }
  } catch {
    await reader?.cancel().catch(() => {});
    return unavailable(purpose);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown = null;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { /* Non-JSON bodies are treated as absent. */ }
  return { status: response.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null };
}

function identityRequired(target: MintTarget, scope: string): never {
  return fail(409, 'push_identity_required', `No push identity is configured for ${gitProviderNames[target.provider]} (${target.host}${scope ? `, ${scope}` : ''}). ` +
    'A workspace owner or admin can add one in Settings → Workspaces.');
}
function reauthorize(provider: GitProvider, host: string): never {
  return fail(409, 'push_identity_reauthorize', `The ${gitProviderNames[provider]} (${host}) push identity must be authorized again in Settings → Workspaces.`);
}
async function identitySecret(env: Env, row: Pick<PushIdentityRow, 'id' | 'secret_ciphertext'>): Promise<string> {
  if (!row.secret_ciphertext) return fail(500, 'vault_error', 'Unable to read connected account credentials.');
  return decryptToken(env, identitySecretContext(row.id), row.secret_ciphertext);
}

async function appJwt(purpose: Purpose, app: GitHubApp): Promise<string> {
  let key: CryptoKey;
  try { key = await importRsaPrivateKey(app.privateKey); }
  catch {
    return purpose === 'verify' ? fail(400, 'invalid_private_key', 'Use the GitHub App private key: an RSA key (PEM) of at least 2048 bits.') : unavailable(purpose);
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  return signJwt(key, { alg: 'RS256', typ: 'JWT' }, { iat: issuedAt - 60, exp: issuedAt + 540, iss: app.appId });
}
function githubHeaders(bearer: string): Record<string, string> {
  return { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function mintGitHub(target: MintTarget, app: GitHubApp, identityId: string | null): Promise<MintedToken> {
  const repositoryId = Number(target.repositoryId);
  if (!/^[1-9]\d{0,15}$/.test(target.repositoryId) || !Number.isSafeInteger(repositoryId)) fail(400, 'invalid_repository', 'A GitHub numeric repository identity is required.');
  const api = githubApiBase(target.provider, target.host);
  const jwt = await appJwt('mint', app);
  const installation = await upstream('mint', `${api}/repos/${target.fullName.split('/').map(encodeURIComponent).join('/')}/installation`, { headers: githubHeaders(jwt) });
  if (installation.status === 404) {
    fail(409, 'push_app_not_installed', `Install the GitHub App on ${target.fullName} to push: ${githubInstallUrl(target.provider, target.host, app.slug)}`);
  }
  const installationId = expectStatus('mint', installation, 200).id;
  if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId) || installationId <= 0) unavailable('mint');
  const issued = expectStatus('mint', await upstream('mint', `${api}/app/installations/${installationId}/access_tokens`, {
    method: 'POST', headers: { ...githubHeaders(jwt), 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [repositoryId], permissions: { contents: 'write' } }),
  }), 201);
  const installationToken = token('mint', issued.token);
  const expiry = typeof issued.expires_at === 'string' ? Math.floor(Date.parse(issued.expires_at) / 1000) : NaN;
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) unavailable('mint');
  return { kind: 'github-app', identityId, authorization: basic('x-access-token', installationToken),
    expiresAt: Math.min(expiry, expiresAt(undefined, 3600)), revocation: { kind: 'github-installation', apiBase: api, token: installationToken } };
}

async function entraToken(purpose: Purpose, env: Env, workspaceId: string, config: Record<string, string>): Promise<{ token: string; expiresAt: number }> {
  const assertion = await issuerAssertion(env, { subject: workspaceSubject(workspaceId), audience: 'api://AzureADTokenExchange', ttlSeconds: 300 });
  const body = expectStatus(purpose, await upstream(purpose, `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId!)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': formType },
    body: new URLSearchParams({ client_id: config.clientId!, scope: entraScope, grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }).toString(),
  }), 200);
  return { token: token(purpose, body.access_token), expiresAt: expiresAt(body.expires_in, 3600) };
}

async function bitbucketToken(purpose: Purpose, key: string, secret: string): Promise<{ token: string; expiresAt: number }> {
  const body = expectStatus(purpose, await upstream(purpose, 'https://bitbucket.org/site/oauth2/access_token', {
    method: 'POST', headers: { Authorization: basic(key, secret), 'Content-Type': formType },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  }), 200);
  return { token: token(purpose, body.access_token), expiresAt: expiresAt(body.expires_in, 7200) };
}

/** Takes the rotation lease, waiting about 10 s for a concurrent refresh to finish. */
async function acquireLease(env: Env, row: PushIdentityRow): Promise<PushIdentityRow> {
  for (let attempt = 0; ; attempt++) {
    const time = Math.floor(Date.now() / 1000);
    const leased = await env.DB.prepare(`UPDATE push_identities SET lease_until = ? WHERE id = ? AND kind = 'oauth-refresh' AND status = 'ready'
      AND (lease_until IS NULL OR lease_until < ?) RETURNING *`).bind(time + leaseSeconds, row.id, time).first<PushIdentityRow>();
    if (leased) return leased;
    const current = await env.DB.prepare('SELECT status FROM push_identities WHERE id = ?').bind(row.id).first<{ status: string }>();
    if (current?.status !== 'ready') reauthorize(row.provider, row.host);
    if (attempt >= leaseAttempts) fail(409, 'push_identity_busy', 'Another push is refreshing this push identity. Try again in a moment.');
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, leaseRetryMs);
    await pause.promise;
  }
}

async function mintOAuth(env: Env, row: PushIdentityRow): Promise<MintedToken> {
  const leased = await acquireLease(env, row);
  let released = false;
  try {
    const config = JSON.parse(leased.config_json) as Record<string, string>;
    const secret = oauthSecret(await identitySecret(env, leased));
    const response = secret.refreshToken === undefined ? null : await upstream('mint', oauthEndpoints(leased.provider, leased.host).token, {
      method: 'POST', headers: { 'Content-Type': formType },
      body: new URLSearchParams({ client_id: config.clientId!, client_secret: secret.clientSecret, refresh_token: secret.refreshToken,
        grant_type: 'refresh_token', redirect_uri: oauthRedirectUri(env) }).toString(),
    });
    if (!response || response.status === 400 || response.status === 401 || response.body?.error === 'invalid_grant') {
      // The refresh token is dead: drop it and require a new authorization by the bot account.
      const cleared = await encryptToken(env, identitySecretContext(leased.id), JSON.stringify({ clientSecret: secret.clientSecret }));
      await env.DB.prepare(`UPDATE push_identities SET status = 'authorization_required', secret_ciphertext = ?, lease_until = NULL, updated_at = ?
        WHERE id = ? AND secret_ciphertext = ?`).bind(cleared, now(), leased.id, leased.secret_ciphertext).run();
      released = true;
      reauthorize(leased.provider, leased.host);
    }
    const body = expectStatus('mint', response, 200);
    const accessToken = token('mint', body.access_token);
    const refreshToken = body.refresh_token === undefined ? secret.refreshToken! : token('mint', body.refresh_token);
    const rotated = await encryptToken(env, identitySecretContext(leased.id), JSON.stringify({ clientSecret: secret.clientSecret, refreshToken }));
    // Store the rotated refresh token and release the lease together; a replaced identity keeps its own secret.
    await env.DB.prepare('UPDATE push_identities SET secret_ciphertext = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND secret_ciphertext = ?')
      .bind(rotated, now(), leased.id, leased.secret_ciphertext).run();
    released = true;
    return { kind: 'oauth-refresh', identityId: leased.id, authorization: basic('oauth2', accessToken),
      expiresAt: expiresAt(body.expires_in, leased.provider === 'gitlab' ? 7200 : 3600) };
  } finally {
    if (!released) await env.DB.prepare('UPDATE push_identities SET lease_until = NULL WHERE id = ? AND lease_until = ?').bind(leased.id, leased.lease_until).run();
  }
}

/** Finds the identity (or operator app) for the target and mints a token; fails with fixed messages. */
export async function mintPushToken(env: Env, target: MintTarget): Promise<MintedToken> {
  // Azure DevOps identities are per organization and Bitbucket identities per workspace; others cover the host.
  const scope = target.provider === 'azure-devops' || target.provider === 'bitbucket' ? target.fullName.split('/')[0]!.toLowerCase() : '';
  const row = await env.DB.prepare('SELECT * FROM push_identities WHERE workspace_id = ? AND provider = ? AND host = ? AND scope = ?')
    .bind(target.workspaceId, target.provider, target.host, scope).first<PushIdentityRow>();
  if (!row) {
    if (target.provider === 'github' && env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY) {
      return mintGitHub(target, { appId: env.GITHUB_APP_ID, slug: env.GITHUB_APP_SLUG, privateKey: env.GITHUB_APP_PRIVATE_KEY }, null);
    }
    identityRequired(target, scope);
  }
  if (row.status !== 'ready') reauthorize(row.provider, row.host);
  const config = JSON.parse(row.config_json) as Record<string, string>;
  switch (row.kind) {
    case 'github-app':
      return mintGitHub(target, { appId: config.appId!, slug: config.slug!, privateKey: await identitySecret(env, row) }, row.id);
    case 'entra-federation': {
      const minted = await entraToken('mint', env, target.workspaceId, config);
      return { kind: row.kind, identityId: row.id, authorization: `Bearer ${minted.token}`, expiresAt: minted.expiresAt };
    }
    case 'bitbucket-client-credentials': {
      const minted = await bitbucketToken('mint', config.key!, await identitySecret(env, row));
      return { kind: row.kind, identityId: row.id, authorization: basic('x-token-auth', minted.token), expiresAt: minted.expiresAt };
    }
    case 'oauth-refresh':
      return mintOAuth(env, row);
    case 'forgejo-integration': {
      const expiry = expiresAt(undefined, 600);
      const jwt = await issuerAssertion(env, { subject: workspaceSubject(target.workspaceId), audience: config.audience!, ttlSeconds: 600,
        claims: { repository: target.fullName, ref: `refs/heads/${target.branch}`, session: target.sessionId } });
      return { kind: row.kind, identityId: row.id, authorization: `Bearer ${jwt}`, expiresAt: expiry };
    }
  }
}

/** Best effort; never throws. */
export async function revokePushToken(revocation: NonNullable<MintedToken['revocation']>): Promise<void> {
  try {
    const response = await fetch(`${revocation.apiBase}/installation/token`, { method: 'DELETE', headers: { ...githubHeaders(revocation.token), 'User-Agent': userAgent },
      redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout) });
    await response.body?.cancel().catch(() => {});
  } catch { /* Installation tokens also expire within an hour. */ }
}

/** Live check of new identity settings before they are stored; returns the config to store (with the bot login when known). */
export async function verifyIdentity(env: Env, input: {
  workspaceId: string; provider: GitProvider; host: string; kind: PushIdentityKind; config: Record<string, string>; secret: string | null;
}): Promise<Record<string, string>> {
  const { config } = input;
  switch (input.kind) {
    case 'github-app': {
      const jwt = await appJwt('verify', { appId: config.appId!, slug: config.slug!, privateKey: input.secret ?? '' });
      const app = expectStatus('verify', await upstream('verify', `${githubApiBase(input.provider, input.host)}/app`, { headers: githubHeaders(jwt) }), 200);
      if (app.id !== Number(config.appId)) rejected('verify');
      return config;
    }
    case 'entra-federation':
      await entraToken('verify', env, input.workspaceId, config);
      return config;
    case 'bitbucket-client-credentials':
      await bitbucketToken('verify', config.key!, input.secret ?? '');
      return config;
    case 'oauth-refresh':
      // Verified when the bot account authorizes the OAuth app.
      return config;
    case 'forgejo-integration': {
      const jwt = await issuerAssertion(env, { subject: workspaceSubject(input.workspaceId), audience: config.audience!, ttlSeconds: 600 });
      const user = expectStatus('verify', await upstream('verify', `https://${input.host}/api/v1/user`, { headers: { Authorization: `Bearer ${jwt}` } }), 200);
      return { ...config, login: botLogin(user.login) };
    }
  }
}

function botLogin(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) unavailable('verify');
  return value;
}

/** Exchanges a bot account's authorization code (PKCE) for its refresh token and reads the bot's login. */
export async function exchangeAuthorizationCode(env: Env, identity: { provider: GitProvider; host: string; clientId: string; clientSecret: string },
  code: string, verifier: string): Promise<{ refreshToken: string; login: string }> {
  const body = expectStatus('verify', await upstream('verify', oauthEndpoints(identity.provider, identity.host).token, {
    method: 'POST', headers: { 'Content-Type': formType },
    body: new URLSearchParams({ client_id: identity.clientId, client_secret: identity.clientSecret, code, grant_type: 'authorization_code',
      redirect_uri: oauthRedirectUri(env), code_verifier: verifier }).toString(),
  }), 200);
  const accessToken = token('verify', body.access_token);
  const refreshToken = token('verify', body.refresh_token);
  const user = expectStatus('verify', await upstream('verify', `https://${identity.host}/api/${identity.provider === 'gitlab' ? 'v4' : 'v1'}/user`,
    { headers: { Authorization: `Bearer ${accessToken}` } }), 200);
  return { refreshToken, login: botLogin(identity.provider === 'gitlab' ? user.username : user.login) };
}
