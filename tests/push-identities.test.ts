import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { decryptToken, encryptToken } from '../apps/server/src/vault.js';
import { importRsaPrivateKey, publicJwk, signJwt } from '../apps/server/src/push/jwt.js';
import { mintPushToken, oauthEndpoints, revokePushToken, type MintTarget } from '../apps/server/src/push/mint.js';
import { sha256 } from '../packages/shared/src/crypto.js';
import { testDatabase } from './helpers/control-plane.js';

const origin = 'http://localhost:8787';
const testSecret = 'push-identities-test-secret-not-for-deployment';
const rsa = (format: 'pkcs1' | 'pkcs8', modulusLength = 2048) =>
  generateKeyPairSync('rsa', { modulusLength, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: format, format: 'pem' } });
const appKey = rsa('pkcs1');
const oidcKey = rsa('pkcs8');

async function fixture(t: TestContext, extra: Partial<Env> = {}) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'), ...extra };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` }) }, env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const user = (await login.json() as { user: { id: string } }).user;
    const csrf = (await (await app.request('/api/auth/csrf', { headers: { Cookie: cookie } }, env)).json() as { csrfToken: string }).csrfToken;
    return { user, async request(method: string, path: string, body?: unknown) {
      return app.request(path, { method, headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    } };
  }
  /** Owner alice, admin carol, member bob. */
  async function team() {
    const alice = await client('alice'); const bob = await client('bob'); const carol = await client('carol');
    const workspace = (await (await alice.request('POST', '/api/workspaces', { name: 'push' })).json() as { workspace: { id: string } }).workspace;
    assert.equal((await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: 'member' })).status, 200);
    assert.equal((await alice.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: carol.user.id, role: 'admin' })).status, 200);
    return { alice, bob, carol, workspaceId: workspace.id };
  }
  async function identity(row: { workspaceId: string; provider: string; host: string; scope?: string; kind: string; config: Record<string, string>; secret?: string; status?: string; createdBy: string }) {
    const identityId = `identity-${row.kind}-${row.provider}`;
    const ciphertext = row.secret === undefined ? null : await encryptToken(env, `push-identity:${identityId}`, row.secret);
    sqlite.prepare(`INSERT INTO push_identities (id, workspace_id, provider, host, scope, kind, config_json, secret_ciphertext, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(identityId, row.workspaceId, row.provider, row.host, row.scope ?? '', row.kind, JSON.stringify(row.config),
      ciphertext, row.status ?? 'ready', row.createdBy, '2026-01-01', '2026-01-01');
    return identityId;
  }
  return { sqlite, env, client, team, identity };
}

interface Call { method: string; url: string; headers: Record<string, string>; body: string; redirect: RequestRedirect | undefined }
type Route = (call: Call) => Response;
/** Serves `routes` keyed by "METHOD url"; unknown requests fail the test. */
function mockFetch(t: TestContext, routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key.toLowerCase()] = String(value);
    const call = { method: init?.method ?? 'GET', url: String(input), headers, body: typeof init?.body === 'string' ? init.body : '', redirect: init?.redirect };
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    if (!route) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    return route(call);
  });
  return calls;
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException, String(error));
    const body = await error.getResponse().json() as { code: string; error: string };
    return { status: error.status, code: body.code, message: body.error };
  }
  return assert.fail('expected failure');
}
async function errorCode(response: Response): Promise<{ status: number; code: string }> {
  return { status: response.status, code: (await response.json() as { code: string }).code };
}
/** Verifies an RS256 JWT against `publicKey` and returns its header and claims. */
function decodeJwt(jwt: string, publicKey: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), 'JWT signature must verify');
  return { header: JSON.parse(Buffer.from(header, 'base64url').toString()), claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) };
}
const basicHeader = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
const target = (workspaceId: string, values: Partial<MintTarget>): MintTarget =>
  ({ workspaceId, sessionId: 'session-1', provider: 'github', host: 'github.com', fullName: 'acme/app', repositoryId: '7', branch: 'feature/x', ...values });

test('PKCS#1 and PKCS#8 keys sign verifiable RS256 JWTs; JWKS kid is the RFC 7638 thumbprint', async t => {
  for (const format of ['pkcs1', 'pkcs8'] as const) {
    const pair = rsa(format);
    const jwt = await signJwt(await importRsaPrivateKey(pair.privateKey), { alg: 'RS256', typ: 'JWT' }, { sub: format });
    assert.deepEqual(decodeJwt(jwt, pair.publicKey).claims, { sub: format });
    const jwk = createPublicKey(pair.publicKey).export({ format: 'jwk' });
    const thumbprint = createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })).digest('base64url');
    assert.deepEqual(await publicJwk(pair.privateKey), { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid: thumbprint });
  }
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await assert.rejects(importRsaPrivateKey(ec.privateKey), /RSA key/);
  await assert.rejects(importRsaPrivateKey(rsa('pkcs8', 1024).privateKey), /2048 bits/);
  await assert.rejects(importRsaPrivateKey('not a key'), /RSA key/);

  const disabled = await fixture(t);
  const missing = await app.request('/.well-known/jwks.json', {}, disabled.env);
  assert.deepEqual(await errorCode(missing), { status: 404, code: 'oidc_unavailable' });
  const enabled = await fixture(t, { OIDC_SIGNING_KEY: oidcKey.privateKey });
  const discovery = await (await app.request('/.well-known/openid-configuration', {}, enabled.env)).json() as Record<string, unknown>;
  assert.deepEqual(discovery, { issuer: origin, jwks_uri: `${origin}/.well-known/jwks.json`, response_types_supported: ['id_token'],
    subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
  const jwks = await (await app.request('/.well-known/jwks.json', {}, enabled.env)).json() as { keys: { kid: string; n: string }[] };
  assert.deepEqual(jwks.keys, [await publicJwk(oidcKey.privateKey)]);
});

test('GitHub App identities mint repository-scoped installation tokens and report missing installations', async t => {
  const f = await fixture(t);
  const { alice, workspaceId } = await f.team();
  await f.identity({ workspaceId, provider: 'github-enterprise', host: 'git.example.com', kind: 'github-app', config: { appId: '42', slug: 'pistead' },
    secret: appKey.privateKey, createdBy: alice.user.id });
  const api = 'https://git.example.com/api/v3';
  const expires = new Date(Date.now() + 3600_000).toISOString();
  let installed = true;
  const calls = mockFetch(t, {
    [`GET ${api}/repos/acme/app/installation`]: () => installed ? Response.json({ id: 55 }) : Response.json({ message: 'Not Found' }, { status: 404 }),
    [`POST ${api}/app/installations/55/access_tokens`]: () => Response.json({ token: 'ghs_install', expires_at: expires }, { status: 201 }),
    [`DELETE ${api}/installation/token`]: () => new Response(null, { status: 204 }),
  });
  const minted = await mintPushToken(f.env, target(workspaceId, { provider: 'github-enterprise', host: 'git.example.com' }));
  assert.deepEqual(minted, { kind: 'github-app', identityId: 'identity-github-app-github-enterprise', authorization: basicHeader('x-access-token', 'ghs_install'),
    expiresAt: Math.floor(Date.parse(expires) / 1000), revocation: { kind: 'github-installation', apiBase: api, token: 'ghs_install' } });
  assert.deepEqual(JSON.parse(calls[1]!.body), { repository_ids: [7], permissions: { contents: 'write' } });
  for (const call of calls) {
    assert.equal(call.redirect, 'manual');
    const { claims } = decodeJwt(call.headers.authorization!.replace(/^Bearer /, ''), appKey.publicKey);
    assert.equal(claims.iss, '42');
    assert.equal(Number(claims.exp) - Number(claims.iat), 600);
  }
  await revokePushToken(minted.revocation!);
  assert.equal(calls[2]!.headers.authorization, 'Bearer ghs_install');

  installed = false;
  const missing = await failure(mintPushToken(f.env, target(workspaceId, { provider: 'github-enterprise', host: 'git.example.com' })));
  assert.equal(missing.code, 'push_app_not_installed');
  assert.equal(missing.status, 409);
  assert.match(missing.message, /https:\/\/git\.example\.com\/github-apps\/pistead\/installations\/new/);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await revokePushToken(minted.revocation!);
});

test('github.com falls back to the operator GitHub App only when it is configured', async t => {
  const plain = await fixture(t);
  const owner = await plain.client('owner');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'w' })).json() as { workspace: { id: string } }).workspace;
  const required = await failure(mintPushToken(plain.env, target(workspace.id, {})));
  assert.deepEqual([required.status, required.code], [409, 'push_identity_required']);
  assert.match(required.message, /Settings → Workspaces/);

  const f = await fixture(t, { GITHUB_APP_ID: '9', GITHUB_APP_SLUG: 'pistead-operator', GITHUB_APP_PRIVATE_KEY: appKey.privateKey });
  const { bob, workspaceId } = await f.team();
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const calls = mockFetch(t, {
    'GET https://api.github.com/repos/acme/app/installation': () => Response.json({ id: 3 }),
    'POST https://api.github.com/app/installations/3/access_tokens': () => Response.json({ token: 'ghs_operator', expires_at: expires }, { status: 201 }),
  });
  const minted = await mintPushToken(f.env, target(workspaceId, {}));
  assert.equal(minted.identityId, null);
  assert.equal(minted.kind, 'github-app');
  assert.equal(minted.authorization, basicHeader('x-access-token', 'ghs_operator'));
  assert.equal(minted.revocation?.apiBase, 'https://api.github.com');
  assert.equal(decodeJwt(calls[0]!.headers.authorization!.replace(/^Bearer /, ''), appKey.publicKey).claims.iss, '9');
  const listed = await (await bob.request('GET', `/api/workspaces/${workspaceId}/push-identities`)).json() as Record<string, unknown>;
  assert.deepEqual(listed, { identities: [], oidc: null, redirectUri: `${origin}/api/push-identities/oauth/callback`,
    githubApp: { slug: 'pistead-operator', installUrl: 'https://github.com/apps/pistead-operator/installations/new' } });
});

test('Entra federation exchanges a Pistead assertion; Bitbucket uses client credentials; Forgejo gets a scoped JWT', async t => {
  const f = await fixture(t, { OIDC_SIGNING_KEY: oidcKey.privateKey });
  const { alice, workspaceId } = await f.team();
  const tenantId = '11111111-2222-3333-4444-555555555555'; const clientId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await f.identity({ workspaceId, provider: 'azure-devops', host: 'dev.azure.com', scope: 'contoso', kind: 'entra-federation', config: { tenantId, clientId }, createdBy: alice.user.id });
  await f.identity({ workspaceId, provider: 'bitbucket', host: 'bitbucket.org', scope: 'acme', kind: 'bitbucket-client-credentials', config: { key: 'consumerKey' },
    secret: 'consumer-secret', createdBy: alice.user.id });
  await f.identity({ workspaceId, provider: 'gitea', host: 'forge.example.org', kind: 'forgejo-integration', config: { audience: 'forgejo-push', login: 'bot' }, createdBy: alice.user.id });
  const calls = mockFetch(t, {
    [`POST https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`]: () => Response.json({ access_token: 'entra-token', expires_in: 3599 }),
    'POST https://bitbucket.org/site/oauth2/access_token': () => Response.json({ access_token: 'bb-token', expires_in: 7200 }),
  });

  const entra = await mintPushToken(f.env, target(workspaceId, { provider: 'azure-devops', host: 'dev.azure.com', fullName: 'Contoso/Project/repo', repositoryId: 'r' }));
  assert.equal(entra.authorization, 'Bearer entra-token');
  assert.equal(entra.kind, 'entra-federation');
  const form = new URLSearchParams(calls[0]!.body);
  assert.equal(calls[0]!.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([form.get('client_id'), form.get('scope'), form.get('grant_type'), form.get('client_assertion_type')],
    [clientId, '499b84ac-1321-427f-aa17-267ca6975798/.default', 'client_credentials', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer']);
  const assertion = decodeJwt(form.get('client_assertion')!, oidcKey.publicKey);
  assert.equal(assertion.header.kid, (await publicJwk(oidcKey.privateKey)).kid);
  assert.deepEqual([assertion.claims.iss, assertion.claims.sub, assertion.claims.aud, Number(assertion.claims.exp) - Number(assertion.claims.iat)],
    [origin, `pistead:workspace:${workspaceId}`, 'api://AzureADTokenExchange', 300]);
  assert.equal(typeof assertion.claims.jti, 'string');

  const bitbucket = await mintPushToken(f.env, target(workspaceId, { provider: 'bitbucket', host: 'bitbucket.org', fullName: 'ACME/app', repositoryId: '{x}' }));
  assert.equal(bitbucket.authorization, basicHeader('x-token-auth', 'bb-token'));
  assert.equal(calls[1]!.headers.authorization, basicHeader('consumerKey', 'consumer-secret'));
  assert.equal(calls[1]!.body, 'grant_type=client_credentials');
  assert.ok(calls.every(call => call.redirect === 'manual'));

  const forgejo = await mintPushToken(f.env, target(workspaceId, { provider: 'gitea', host: 'forge.example.org', fullName: 'team/app', repositoryId: '12', branch: 'main' }));
  assert.equal(calls.length, 2);
  const jwt = decodeJwt(forgejo.authorization.replace(/^Bearer /, ''), oidcKey.publicKey).claims;
  assert.deepEqual([jwt.iss, jwt.sub, jwt.aud, jwt.repository, jwt.ref, jwt.session, Number(jwt.exp) - Number(jwt.iat)],
    [origin, `pistead:workspace:${workspaceId}`, 'forgejo-push', 'team/app', 'refs/heads/main', 'session-1', 600]);

  const otherScope = await failure(mintPushToken(f.env, target(workspaceId, { provider: 'bitbucket', host: 'bitbucket.org', fullName: 'other/app', repositoryId: '{x}' })));
  assert.equal(otherScope.code, 'push_identity_required');
});

test('OAuth refresh identities reuse a fresh access token, rotate the refresh token, serialize with a lease, and require reauthorization on invalid_grant', async t => {
  const f = await fixture(t);
  const { alice, workspaceId } = await f.team();
  const identityId = await f.identity({ workspaceId, provider: 'gitlab', host: 'gitlab.com', kind: 'oauth-refresh', config: { clientId: 'gl-client', login: 'bot' },
    secret: JSON.stringify({ clientSecret: 'gl-secret', refreshToken: 'refresh-1' }), createdBy: alice.user.id });
  let grant: 'ok' | 'invalid' = 'ok';
  const calls = mockFetch(t, {
    'POST https://gitlab.com/oauth/token': () => grant === 'ok'
      ? Response.json({ access_token: `access-${calls.length}`, refresh_token: `refresh-${calls.length + 1}`, expires_in: 7200 })
      : Response.json({ error: 'invalid_grant' }, { status: 400 }),
  });
  const gitlab = target(workspaceId, { provider: 'gitlab', host: 'gitlab.com', fullName: 'group/app', repositoryId: '99' });
  const minted = await mintPushToken(f.env, gitlab);
  assert.equal(minted.authorization, basicHeader('oauth2', 'access-1'));
  assert.equal(minted.identityId, identityId);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]!.body)), { client_id: 'gl-client', client_secret: 'gl-secret', refresh_token: 'refresh-1',
    grant_type: 'refresh_token', redirect_uri: `${origin}/api/push-identities/oauth/callback` });
  const stored = () => f.sqlite.prepare('SELECT status, lease_until, secret_ciphertext FROM push_identities WHERE id = ?').get(identityId) as { status: string; lease_until: number | null; secret_ciphertext: string };
  const secret = async () => JSON.parse(await decryptToken(f.env, `push-identity:${identityId}`, stored().secret_ciphertext)) as Record<string, unknown>;
  const seconds = () => Math.floor(Date.now() / 1000);
  assert.equal(stored().lease_until, null);
  const first = await secret();
  assert.ok(Math.abs((first.accessExpiresAt as number) - (seconds() + 7200)) <= 2);
  assert.deepEqual(first, { clientSecret: 'gl-secret', refreshToken: 'refresh-2', accessToken: 'access-1', accessExpiresAt: first.accessExpiresAt });
  assert.equal(minted.expiresAt, first.accessExpiresAt);

  // With at least 15 minutes left the cached token is handed out without a refresh, even while another request holds the lease.
  f.sqlite.prepare('UPDATE push_identities SET lease_until = ? WHERE id = ?').run(seconds() + 60, identityId);
  const reused = await mintPushToken(f.env, gitlab);
  assert.deepEqual([reused.authorization, reused.expiresAt], [basicHeader('oauth2', 'access-1'), first.accessExpiresAt]);
  assert.equal(calls.length, 1);
  f.sqlite.prepare('UPDATE push_identities SET lease_until = NULL WHERE id = ?').run(identityId);
  const setSecret = async (value: Record<string, unknown>) => f.sqlite.prepare('UPDATE push_identities SET secret_ciphertext = ? WHERE id = ?')
    .run(await encryptToken(f.env, `push-identity:${identityId}`, JSON.stringify(value)), identityId);
  await setSecret({ ...first, accessExpiresAt: seconds() + 15 * 60 + 30 });
  assert.equal((await mintPushToken(f.env, gitlab)).authorization, basicHeader('oauth2', 'access-1'));
  assert.equal(calls.length, 1);

  // Under 15 minutes left: refresh and persist the new access token, its expiry and the rotated refresh token.
  await setSecret({ ...first, accessExpiresAt: seconds() + 14 * 60 });
  const refreshed = await mintPushToken(f.env, gitlab);
  assert.equal(refreshed.authorization, basicHeader('oauth2', 'access-2'));
  assert.equal(new URLSearchParams(calls[1]!.body).get('refresh_token'), 'refresh-2');
  const second = await secret();
  assert.deepEqual(second, { clientSecret: 'gl-secret', refreshToken: 'refresh-3', accessToken: 'access-2', accessExpiresAt: refreshed.expiresAt });
  assert.equal(stored().lease_until, null);

  // A concurrent refresh holds the lease and the cache is stale: waiters give up with a busy error (retry sleeps run immediately here).
  await setSecret({ ...second, accessExpiresAt: seconds() + 60 });
  f.sqlite.prepare('UPDATE push_identities SET lease_until = ? WHERE id = ?').run(seconds() + 60, identityId);
  const sleep = t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout);
  assert.deepEqual(await failure(mintPushToken(f.env, gitlab)).then(({ status, code }) => ({ status, code })), { status: 409, code: 'push_identity_busy' });
  assert.ok(sleep.mock.callCount() >= 10);
  assert.equal(calls.length, 2);
  sleep.mock.restore();
  f.sqlite.prepare('UPDATE push_identities SET lease_until = NULL WHERE id = ?').run(identityId);

  grant = 'invalid';
  const rejected = await failure(mintPushToken(f.env, gitlab));
  assert.deepEqual([rejected.status, rejected.code], [409, 'push_identity_reauthorize']);
  assert.equal(new URLSearchParams(calls[2]!.body).get('refresh_token'), 'refresh-3');
  assert.equal(stored().status, 'authorization_required');
  assert.equal(stored().lease_until, null);
  assert.deepEqual(await secret(), { clientSecret: 'gl-secret' });
  assert.equal((await failure(mintPushToken(f.env, gitlab))).code, 'push_identity_reauthorize');
  assert.equal(calls.length, 3);
});

test('only workspace owners and admins manage push identities, and settings are verified live', async t => {
  const f = await fixture(t, { OIDC_SIGNING_KEY: oidcKey.privateKey });
  const { alice, bob, carol, workspaceId } = await f.team();
  let appId = 123; let appSlug = 'pistead-bot'; let appStatus = 200;
  mockFetch(t, {
    'GET https://api.github.com/app': () => Response.json({ id: appId, slug: appSlug }, { status: appStatus }),
    'GET https://forge.example.org/api/v1/user': call => {
      decodeJwt(call.headers.authorization!.replace(/^Bearer /, ''), oidcKey.publicKey);
      return Response.json({ login: 'forgejo-bot' });
    },
  });
  const path = `/api/workspaces/${workspaceId}/push-identities`;
  const githubApp = { provider: 'github', kind: 'github-app', config: { appId: '123', slug: 'pistead-bot' }, secret: appKey.privateKey };
  assert.deepEqual(await errorCode(await bob.request('POST', path, githubApp)), { status: 403, code: 'forbidden' });
  const created = await carol.request('POST', path, githubApp);
  assert.equal(created.status, 201);
  const { identity } = await created.json() as { identity: Record<string, unknown> };
  assert.deepEqual([identity.provider, identity.host, identity.scope, identity.kind, identity.config, identity.status, identity.createdBy],
    ['github', 'github.com', '', 'github-app', { appId: '123', slug: 'pistead-bot' }, 'ready', carol.user.id]);

  appId = 999;
  assert.deepEqual(await errorCode(await carol.request('POST', path, githubApp)), { status: 400, code: 'push_identity_rejected' });
  appId = 123; appSlug = 'someone-elses-app';
  assert.deepEqual(await errorCode(await carol.request('POST', path, githubApp)), { status: 400, code: 'push_identity_rejected' });
  appSlug = 'pistead-bot'; appStatus = 401;
  assert.deepEqual(await errorCode(await carol.request('POST', path, githubApp)), { status: 400, code: 'push_identity_rejected' });
  assert.deepEqual(await errorCode(await carol.request('POST', path, { ...githubApp, secret: rsa('pkcs8', 1024).privateKey })), { status: 400, code: 'invalid_private_key' });
  assert.deepEqual(await errorCode(await carol.request('POST', path, { ...githubApp, config: { appId: '123' } })), { status: 400, code: 'invalid_push_identity' });
  assert.deepEqual(await errorCode(await carol.request('POST', path, { provider: 'gitlab', kind: 'github-app', config: githubApp.config })), { status: 400, code: 'invalid_push_identity' });
  assert.deepEqual(await errorCode(await carol.request('POST', path, { provider: 'azure-devops', kind: 'entra-federation',
    config: { tenantId: 'not-a-guid', clientId: 'x' }, scope: 'contoso' })), { status: 400, code: 'invalid_push_identity' });

  for (const audience of ['api://AzureADTokenExchange', 'API://azureadtokenexchange']) {
    assert.deepEqual(await errorCode(await alice.request('POST', path, { provider: 'gitea', host: 'forge.example.org', kind: 'forgejo-integration', config: { audience } })),
      { status: 400, code: 'invalid_push_identity' });
  }
  const forgejo = await alice.request('POST', path, { provider: 'gitea', host: 'https://Forge.Example.org/', kind: 'forgejo-integration', config: { audience: 'forgejo-push' } });
  assert.equal(forgejo.status, 201);
  const forgejoIdentity = (await forgejo.json() as { identity: { id: string; host: string; config: Record<string, string> } }).identity;
  assert.deepEqual([forgejoIdentity.host, forgejoIdentity.config], ['forge.example.org', { audience: 'forgejo-push', login: 'forgejo-bot' }]);

  const listed = await bob.request('GET', path);
  const listedText = await listed.text();
  assert.ok(!listedText.includes('PRIVATE KEY') && !listedText.includes('ciphertext'));
  const body = JSON.parse(listedText) as { identities: { id: string }[]; oidc: unknown; redirectUri: unknown; githubApp: unknown };
  assert.equal(body.identities.length, 2);
  assert.deepEqual(body.oidc, { issuer: origin, subject: `pistead:workspace:${workspaceId}` });
  assert.equal(body.githubApp, null);
  assert.equal(body.redirectUri, `${origin}/api/push-identities/oauth/callback`);

  assert.deepEqual(await errorCode(await bob.request('DELETE', `${path}/${forgejoIdentity.id}`)), { status: 403, code: 'forbidden' });
  assert.equal((await carol.request('DELETE', `${path}/${forgejoIdentity.id}`)).status, 204);
  assert.equal((await carol.request('DELETE', `${path}/${forgejoIdentity.id}`)).status, 404);
  const audit = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'push.identity.%' ORDER BY rowid").all().map(row => row.action);
  assert.deepEqual(audit, ['push.identity.saved', 'push.identity.saved', 'push.identity.removed']);
});

test('OAuth authorization binds a single-use PKCE state to the starting admin and stores the bot refresh token', async t => {
  const f = await fixture(t);
  const { alice, carol, workspaceId } = await f.team();
  const calls = mockFetch(t, {
    'POST https://git.example.org/login/oauth/access_token': () => Response.json({ access_token: 'gitea-access', refresh_token: 'gitea-refresh', token_type: 'bearer' }),
    'GET https://git.example.org/api/v1/user': () => Response.json({ login: 'gitea-bot' }),
  });
  const created = await carol.request('POST', `/api/workspaces/${workspaceId}/push-identities`,
    { provider: 'gitea', host: 'git.example.org', kind: 'oauth-refresh', config: { clientId: 'client-1' }, secret: 'client-secret' });
  assert.equal(created.status, 201);
  const identity = (await created.json() as { identity: { id: string; status: string } }).identity;
  assert.equal(identity.status, 'authorization_required');
  assert.equal(calls.length, 0);

  const authorize = async () => {
    const response = await carol.request('POST', `/api/workspaces/${workspaceId}/push-identities/${identity.id}/authorize`, {});
    assert.equal(response.status, 200);
    return new URL((await response.json() as { url: string }).url);
  };
  const url = await authorize();
  assert.equal(`${url.origin}${url.pathname}`, 'https://git.example.org/login/oauth/authorize');
  assert.deepEqual([url.searchParams.get('client_id'), url.searchParams.get('scope'), url.searchParams.get('response_type'),
    url.searchParams.get('code_challenge_method'), url.searchParams.get('redirect_uri')],
    ['client-1', 'write:repository read:user', 'code', 'S256', `${origin}/api/push-identities/oauth/callback`]);
  assert.equal(oauthEndpoints('gitlab', 'gitlab.com').scope, 'write_repository read_user');
  const state = url.searchParams.get('state')!;
  const callback = (code: string, value = state) => `/api/push-identities/oauth/callback?code=${code}&state=${value}`;

  assert.deepEqual(await errorCode(await alice.request('GET', callback('code-1'))), { status: 400, code: 'invalid_oauth_state' });
  const completed = await carol.request('GET', callback('code-1'));
  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get('location'), `${origin}/#/settings/workspaces/${workspaceId}`);
  const exchange = Object.fromEntries(new URLSearchParams(calls[0]!.body));
  assert.deepEqual({ ...exchange, code_verifier: undefined }, { client_id: 'client-1', client_secret: 'client-secret', code: 'code-1',
    grant_type: 'authorization_code', redirect_uri: `${origin}/api/push-identities/oauth/callback`, code_verifier: undefined });
  assert.equal(await sha256(exchange.code_verifier!), url.searchParams.get('code_challenge'));
  assert.equal(calls[1]!.headers.authorization, 'Bearer gitea-access');
  const row = f.sqlite.prepare('SELECT status, config_json, secret_ciphertext FROM push_identities WHERE id = ?').get(identity.id) as { status: string; config_json: string; secret_ciphertext: string };
  assert.equal(row.status, 'ready');
  assert.deepEqual(JSON.parse(row.config_json), { clientId: 'client-1', login: 'gitea-bot' });
  assert.deepEqual(JSON.parse(await decryptToken(f.env, `push-identity:${identity.id}`, row.secret_ciphertext)), { clientSecret: 'client-secret', refreshToken: 'gitea-refresh' });

  assert.deepEqual(await errorCode(await carol.request('GET', callback('code-2'))), { status: 400, code: 'invalid_oauth_state' });
  const expired = (await authorize()).searchParams.get('state')!;
  f.sqlite.prepare('UPDATE push_oauth_states SET expires_at = 1').run();
  assert.deepEqual(await errorCode(await carol.request('GET', callback('code-3', expired))), { status: 400, code: 'invalid_oauth_state' });
  assert.equal(calls.length, 2);
  assert.ok(f.sqlite.prepare("SELECT 1 FROM audit WHERE action = 'push.identity.authorized'").get());
});

test('repository push policy is admin-managed and reflected in the workspace repository list', async t => {
  const f = await fixture(t);
  const { alice, bob, carol, workspaceId } = await f.team();
  const other = (await (await alice.request('POST', '/api/workspaces', { name: 'other' })).json() as { workspace: { id: string } }).workspace;
  const insert = f.sqlite.prepare(`INSERT INTO workspace_repositories (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run('binding-1', workspaceId, 'github', 'github.com', '7', 'acme/app', 'main', 0, '2026-01-01');
  insert.run('binding-2', other.id, 'github', 'github.com', '8', 'acme/other', 'main', 0, '2026-01-01');
  const policy = (bindingId: string) => `/api/workspaces/${workspaceId}/repositories/${bindingId}/push-policy`;
  const listed = async () => (await (await bob.request('GET', `/api/workspaces/${workspaceId}/repositories`)).json() as { repositories: { id: string; forbidDefaultBranchPush: boolean }[] }).repositories;

  assert.equal((await listed())[0]!.forbidDefaultBranchPush, false);
  assert.deepEqual(await errorCode(await bob.request('PUT', policy('binding-1'), { forbidDefaultBranch: true })), { status: 403, code: 'forbidden' });
  assert.deepEqual(await errorCode(await carol.request('PUT', policy('binding-1'), { forbidDefaultBranch: 'yes' })), { status: 400, code: 'invalid_push_policy' });
  assert.deepEqual(await errorCode(await carol.request('PUT', policy('binding-2'), { forbidDefaultBranch: true })), { status: 404, code: 'not_found' });
  const updated = await carol.request('PUT', policy('binding-1'), { forbidDefaultBranch: true });
  assert.equal(updated.status, 200);
  const { repository } = await updated.json() as { repository: { id: string; fullName: string; forbidDefaultBranchPush: boolean } };
  assert.deepEqual([repository.id, repository.fullName, repository.forbidDefaultBranchPush], ['binding-1', 'acme/app', true]);
  assert.equal((await listed())[0]!.forbidDefaultBranchPush, true);
  assert.equal((await alice.request('PUT', policy('binding-1'), { forbidDefaultBranch: false })).status, 200);
  assert.equal((await listed())[0]!.forbidDefaultBranchPush, false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM audit WHERE action = 'repository.push_policy.updated'").get()!.count, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM repository_push_policies').get()!.count, 1);
});
