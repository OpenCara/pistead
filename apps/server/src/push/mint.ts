import type { ConnectorCapabilities } from '../../../../packages/shared/src/connector.js';
import type { GitProvider } from '../../../../packages/shared/src/repositories.js';
import { gitProviderNames } from '../../../../packages/shared/src/repositories.js';
import type { PushIdentityKind } from '../../../../packages/shared/src/types.js';
import type { Env, PushIdentityRow } from '../types.js';
import { appOrigin, fail, now } from '../http.js';
import { decryptToken, encryptToken } from '../vault.js';
import { resetGitHubToken } from '../auth.js';
import type { RepositoryAccess } from '../repositories.js';
import { importRsaPrivateKey, signJwt } from './jwt.js';
import { issuerAssertion, workspaceSubject } from './oidc.js';
import { ownerGitAuthorization } from './targets.js';

export interface MintTarget {
  workspaceId: string; sessionId: string;
  provider: GitProvider; host: string; fullName: string; repositoryId: string; branch: string;
  /** A tag push: the token is for creating refs/tags/<tag>, not for moving `branch`. */
  tag?: string;
  /** The session owner, and the host running the session with its owner; both null on the control plane's own runner. */
  ownerId: string; connectorId: string | null; hostOwnerId: string | null;
  /** The session owner's own account for the repository, already checked for push permission. */
  owner: RepositoryAccess;
  /**
   * The control plane pushes with the credential itself (the egress relay), so it never reaches the host: the owner's
   * token needs no reset afterwards, and the host's own Git credentials can't serve.
   */
  relay?: boolean;
}
export interface MintedToken {
  kind: PushIdentityKind;            // 'github-app' for the operator app too
  identityId: string | null;         // null = operator GitHub App
  authorization: string | null;      // full Authorization header value for git smart HTTP; null = the host's own Git credentials
  expiresAt: number;                 // unix seconds
  revocation?: PushRevocation;
}
/**
 * Undoing a credential once its push is over: an installation token is revoked; the owner's GitHub sign-in token is
 * reset, so the host's copy stops working while the vault (which held it as `ciphertext`) gets the replacement.
 */
export type PushRevocation = { kind: 'github-installation'; apiBase: string; token: string }
  | { kind: 'github-owner'; userId: string; token: string; ciphertext: string };
/** Vault-encrypted oauth-refresh secret; the current access token is cached so concurrent pushes reuse it (GitLab revokes it on refresh). */
export interface OAuthSecret { clientSecret: string; refreshToken?: string; accessToken?: string; accessExpiresAt?: number }
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
// A cached access token (expiry in epoch seconds) is handed out only while it outlives the longest push by a wide margin.
const accessReuseSeconds = 15 * 60;

/** Vault associated data for a push identity's secret. */
export function identitySecretContext(identityId: string): string {
  return `push-identity:${identityId}`;
}
export function oauthRedirectUri(env: Env): string {
  return `${appOrigin(env)}/api/push-identities/oauth/callback`;
}
/** GitLab and Gitea OAuth2 endpoints and the narrowest scopes that allow pushing and reading the bot's login. */
export function oauthEndpoints(provider: GitProvider, host: string): { authorize: string; token: string; scope: string } {
  return provider === 'gitlab'
    ? { authorize: `https://${host}/oauth/authorize`, token: `https://${host}/oauth/token`, scope: 'write_repository read_user' }
    : { authorize: `https://${host}/login/oauth/authorize`, token: `https://${host}/login/oauth/access_token`, scope: 'write:repository read:user' };
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
      [secret.refreshToken, secret.accessToken].some(value => value !== undefined && (typeof value !== 'string' || !tokenPattern.test(value))) ||
      (secret.accessToken === undefined) !== (secret.accessExpiresAt === undefined) ||
      (secret.accessExpiresAt !== undefined && !Number.isSafeInteger(secret.accessExpiresAt))) {
    fail(500, 'vault_error', 'Unable to read connected account credentials.');
  }
  const result: OAuthSecret = { clientSecret: secret.clientSecret };
  if (secret.refreshToken !== undefined) result.refreshToken = secret.refreshToken;
  if (secret.accessToken !== undefined) { result.accessToken = secret.accessToken; result.accessExpiresAt = secret.accessExpiresAt!; }
  return result;
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
    'A workspace owner or admin can add one in Settings → Workspaces → Push access: an app or bot identity, the session owner\'s account, or the host\'s Git credentials.');
}
/** The owner's account and the host's Git credentials only serve sessions on the session owner's own host. */
function requireOwnHost(target: MintTarget, kind: 'owner-account' | 'host-credentials'): void {
  if (target.connectorId && target.hostOwnerId === target.ownerId) return;
  fail(409, 'push_identity_own_host_required', `Pushes to ${gitProviderNames[target.provider]} (${target.host}) use ${kind === 'owner-account'
    ? 'the session owner\'s account, so they run only in sessions on the owner\'s own hosts'
    : 'the host\'s Git credentials, so they run only in sessions the host\'s owner starts on it'}. ` +
    'Start the session on one of your hosts, or ask a workspace owner or admin to change the push identity in Settings → Workspaces.');
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

async function mintGitHub(target: Pick<MintTarget, 'provider' | 'host' | 'fullName' | 'repositoryId'>, app: GitHubApp, identityId: string | null,
  permissions: Record<string, 'read' | 'write'> = { contents: 'write' }): Promise<MintedToken> {
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
    body: JSON.stringify({ repository_ids: [repositoryId], permissions }),
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
    const leased = await env.DB.query<PushIdentityRow>(`UPDATE push_identities SET lease_until = ? WHERE id = ? AND kind = 'oauth-refresh' AND status = 'ready'
      AND (lease_until IS NULL OR lease_until < ?) RETURNING *`).bind(time + leaseSeconds, row.id, time).first();
    if (leased) return leased;
    const current = await env.DB.query<{ status: string }>('SELECT status FROM push_identities WHERE id = ?').bind(row.id).first();
    if (current?.status !== 'ready') reauthorize(row.provider, row.host);
    if (attempt >= leaseAttempts) fail(409, 'push_identity_busy', 'Another push is refreshing this push identity. Try again in a moment.');
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, leaseRetryMs);
    await pause.promise;
  }
}

function cachedAccess(row: PushIdentityRow, secret: OAuthSecret): MintedToken | null {
  if (secret.accessToken === undefined || secret.refreshToken === undefined ||
      secret.accessExpiresAt! - Math.floor(Date.now() / 1000) < accessReuseSeconds) return null;
  return { kind: 'oauth-refresh', identityId: row.id, authorization: basic('oauth2', secret.accessToken), expiresAt: secret.accessExpiresAt! };
}

async function mintOAuth(env: Env, row: PushIdentityRow): Promise<MintedToken> {
  if (row.secret_ciphertext) {
    const cached = cachedAccess(row, oauthSecret(await identitySecret(env, row)));
    if (cached) return cached;
  }
  const leased = await acquireLease(env, row);
  let released = false;
  try {
    const config = JSON.parse(leased.config_json) as Record<string, string>;
    const secret = oauthSecret(await identitySecret(env, leased));
    // A concurrent request may have refreshed while this one waited for the lease.
    const cached = cachedAccess(leased, secret);
    if (cached) return cached;
    const response = secret.refreshToken === undefined ? null : await upstream('mint', oauthEndpoints(leased.provider, leased.host).token, {
      method: 'POST', headers: { 'Content-Type': formType },
      body: new URLSearchParams({ client_id: config.clientId!, client_secret: secret.clientSecret, refresh_token: secret.refreshToken,
        grant_type: 'refresh_token', redirect_uri: oauthRedirectUri(env) }).toString(),
    });
    if (!response || response.status === 400 || response.status === 401 || response.body?.error === 'invalid_grant') {
      // The refresh token is dead: drop it and require a new authorization by the bot account.
      const cleared = await encryptToken(env, identitySecretContext(leased.id), JSON.stringify({ clientSecret: secret.clientSecret }));
      await env.DB.query(`UPDATE push_identities SET status = 'authorization_required', secret_ciphertext = ?, lease_until = NULL, updated_at = ?
        WHERE id = ? AND secret_ciphertext = ?`).bind(cleared, now(), leased.id, leased.secret_ciphertext).run();
      released = true;
      reauthorize(leased.provider, leased.host);
    }
    const body = expectStatus('mint', response, 200);
    const accessToken = token('mint', body.access_token);
    const refreshToken = body.refresh_token === undefined ? secret.refreshToken! : token('mint', body.refresh_token);
    const accessExpiresAt = expiresAt(body.expires_in, leased.provider === 'gitlab' ? 7200 : 3600);
    const rotated = await encryptToken(env, identitySecretContext(leased.id),
      JSON.stringify({ clientSecret: secret.clientSecret, refreshToken, accessToken, accessExpiresAt } satisfies OAuthSecret));
    // Store the new tokens and release the lease together; a replaced identity keeps its own secret.
    await env.DB.query('UPDATE push_identities SET secret_ciphertext = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND secret_ciphertext = ?')
      .bind(rotated, now(), leased.id, leased.secret_ciphertext).run();
    released = true;
    return { kind: 'oauth-refresh', identityId: leased.id, authorization: basic('oauth2', accessToken), expiresAt: accessExpiresAt };
  } finally {
    if (!released) await env.DB.query('UPDATE push_identities SET lease_until = NULL WHERE id = ? AND lease_until = ?').bind(leased.id, leased.lease_until).run();
  }
}

/**
 * Finds the identity (or operator app) for the target and issues its push credential: a minted token, the owner's own
 * token, or none when the host pushes with its own Git credentials. Fails with fixed messages.
 */
export async function mintPushToken(env: Env, target: MintTarget): Promise<MintedToken> {
  // Azure DevOps identities are per organization and Bitbucket identities per workspace; others cover the host.
  const scope = target.provider === 'azure-devops' || target.provider === 'bitbucket' ? target.fullName.split('/')[0]!.toLowerCase() : '';
  const row = await env.DB.query<PushIdentityRow>('SELECT * FROM push_identities WHERE workspace_id = ? AND provider = ? AND host = ? AND scope = ?')
    .bind(target.workspaceId, target.provider, target.host, scope).first();
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
        claims: { repository: target.fullName, ref: target.tag === undefined ? `refs/heads/${target.branch}` : `refs/tags/${target.tag}`, session: target.sessionId } });
      return { kind: row.kind, identityId: row.id, authorization: `Bearer ${jwt}`, expiresAt: expiry };
    }
    case 'owner-account': {
      // The owner's token goes only to the owner's own host, for this one push.
      requireOwnHost(target, row.kind);
      const minted = { kind: row.kind, identityId: row.id, authorization: ownerGitAuthorization(target.owner), expiresAt: expiresAt(undefined, 3600) };
      if (target.owner.provider !== 'github' || target.relay) return minted;
      // The GitHub sign-in token is reset after the push, which needs Pistead's OAuth app.
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        fail(409, 'owner_token_reset_unavailable', 'Pushes with the session owner\'s GitHub account need Pistead\'s GitHub sign-in app to reset the token afterwards, and it is not configured.');
      }
      const { userId, token, ciphertext } = target.owner.github;
      return { ...minted, revocation: { kind: 'github-owner', userId, token, ciphertext } };
    }
    case 'host-credentials': {
      if (target.relay) {
        fail(409, 'host_git_credentials_relay', `Pushes to ${gitProviderNames[target.provider]} (${target.host}) use the host's Git credentials, which the session's ` +
          'egress proxy can\'t use. Push with the git_push tool instead, or ask a workspace owner or admin to change the push identity in Settings → Workspaces.');
      }
      requireOwnHost(target, row.kind);
      const host = await env.DB.query<{ capabilities_json: string; git_credentials: number | null }>(`SELECT c.capabilities_json, cfg.git_credentials
        FROM connectors c LEFT JOIN connector_configs cfg ON cfg.connector_id = c.id WHERE c.id = ? AND c.owner_id = ?`)
        .bind(target.connectorId, target.ownerId).first();
      const capabilities = JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities;
      // A connector configured in Pistead offers them once its owner turned them on there; an older one, once started with
      // --git-credentials.
      const offered = capabilities.hostConfig ? Number(host?.git_credentials ?? 0) === 1 : capabilities.gitCredentials === true;
      if (!offered) {
        fail(409, 'host_git_credentials_disabled', `Pushes to ${gitProviderNames[target.provider]} (${target.host}) use the host's Git credentials, which this host doesn't offer. ` +
          'Its owner can turn them on in Pistead (Settings → Hosts → the host → Configuration), with a current connector (npx pistead@latest connect).');
      }
      return { kind: row.kind, identityId: row.id, authorization: null, expiresAt: expiresAt(undefined, 3600) };
    }
  }
}

/** A repository read token handed out again while it outlives the longest Git command by a wide margin. */
const readReuseSeconds = 20 * 60;
const readTokens = new Map<string, MintedToken>();

/**
 * A token that can only read one repository, for a host's direct Git reads (GitDirectGrant): a GitHub App installation
 * token limited to the repository and to `contents: read`, from the workspace's GitHub App push identity for the host or
 * the operator's app on github.com. Null when there is none, the app isn't installed on the repository, or the provider
 * has no such tokens; the read is then relayed, or made with the owner's account on their own host. Tokens are shared
 * by the sessions that read the same repository with the same app, for as long as they last; the caller has checked
 * the session's authority for this request.
 */
export async function mintRepositoryReadToken(env: Env, target: { workspaceId: string; provider: GitProvider; host: string; fullName: string; repositoryId: string })
  : Promise<MintedToken | null> {
  if (target.provider !== 'github' && target.provider !== 'github-enterprise') return null;
  const row = await env.DB.query<PushIdentityRow>("SELECT * FROM push_identities WHERE workspace_id = ? AND provider = ? AND host = ? AND scope = ''")
    .bind(target.workspaceId, target.provider, target.host).first();
  let app: GitHubApp;
  let identityId: string | null = null;
  if (row?.kind === 'github-app' && row.status === 'ready') {
    const config = JSON.parse(row.config_json) as Record<string, string>;
    app = { appId: config.appId!, slug: config.slug!, privateKey: await identitySecret(env, row) };
    identityId = row.id;
  } else if (target.provider === 'github' && env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY) {
    app = { appId: env.GITHUB_APP_ID, slug: env.GITHUB_APP_SLUG, privateKey: env.GITHUB_APP_PRIVATE_KEY };
  } else return null;
  const key = `${target.provider}\0${target.host}\0${app.appId}\0${target.repositoryId}`;
  const cached = readTokens.get(key);
  if (cached && cached.expiresAt - Math.floor(Date.now() / 1000) > readReuseSeconds) return cached;
  readTokens.delete(key);
  let minted: MintedToken;
  try { minted = await mintGitHub(target, app, identityId, { contents: 'read' }); }
  catch { return null; }
  // Shared tokens are never revoked by one session's request; they expire within the hour.
  const token: MintedToken = { kind: minted.kind, identityId: minted.identityId, authorization: minted.authorization, expiresAt: minted.expiresAt };
  if (readTokens.size >= 1000) readTokens.clear();
  readTokens.set(key, token);
  return token;
}

/** Forgets the shared read tokens (tests). */
export function forgetRepositoryReadTokens(): void {
  readTokens.clear();
}

/**
 * Never throws. Returns false only when the owner's token could not be reset yet and the revocation should be retried;
 * installation tokens are revoked best effort, as they expire within an hour anyway.
 */
export async function revokePushToken(env: Env, revocation: PushRevocation): Promise<boolean> {
  try {
    if (revocation.kind === 'github-owner') return await resetGitHubToken(env, revocation.userId, revocation.token, revocation.ciphertext);
    const response = await fetch(`${revocation.apiBase}/installation/token`, { method: 'DELETE', headers: { ...githubHeaders(revocation.token), 'User-Agent': userAgent },
      redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout) });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return revocation.kind !== 'github-owner';
  }
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
      if (app.id !== Number(config.appId) || app.slug !== config.slug) rejected('verify');
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
    case 'owner-account':
    case 'host-credentials':
      // Nothing to verify: each push checks the owner's account, or the host, when it runs.
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
