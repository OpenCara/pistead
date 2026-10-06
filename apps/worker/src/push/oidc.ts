import type { Hono } from 'hono';
import type { Env, WorkerEnv } from '../types.js';
import { appOrigin, fail } from '../http.js';
import { importRsaPrivateKey, publicJwk, signJwt, type RsaPublicJwk } from './jwt.js';

interface SigningKey { pem: string; key: CryptoKey; jwk: RsaPublicJwk }
let cached: SigningKey | null = null;

async function signingKey(env: Env, missingStatus: 404 | 503): Promise<SigningKey> {
  const pem = env.OIDC_SIGNING_KEY;
  if (!pem) fail(missingStatus, 'oidc_unavailable', 'Pistead OIDC federation is not configured.');
  if (cached?.pem === pem) return cached;
  let loaded: SigningKey;
  try { loaded = { pem, key: await importRsaPrivateKey(pem), jwk: await publicJwk(pem) }; }
  catch { fail(503, 'oidc_unavailable', 'Pistead OIDC signing is not configured correctly.'); }
  cached = loaded;
  return loaded;
}

/** Federation subject naming a workspace; identity providers trust it per workspace. */
export function workspaceSubject(workspaceId: string): string {
  return `pistead:workspace:${workspaceId}`;
}

/** A short-lived RS256 assertion from Pistead's OIDC issuer. Standard claims always win over `claims`. */
export async function issuerAssertion(env: Env, input: { subject: string; audience: string; ttlSeconds: number; claims?: Record<string, string> }): Promise<string> {
  const { key, jwk } = await signingKey(env, 503);
  const issuedAt = Math.floor(Date.now() / 1000);
  return signJwt(key, { alg: 'RS256', typ: 'JWT', kid: jwk.kid }, { ...input.claims, iss: appOrigin(env), sub: input.subject, aud: input.audience,
    iat: issuedAt, nbf: issuedAt - 30, exp: issuedAt + input.ttlSeconds, jti: crypto.randomUUID() });
}

/** Public discovery documents (no authentication or CSRF); registered before the /api auth middleware. */
export function registerOidc(app: Hono<WorkerEnv>): void {
  app.get('/.well-known/openid-configuration', async c => {
    await signingKey(c.env, 404);
    const issuer = appOrigin(c.env);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, response_types_supported: ['id_token'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
  });
  app.get('/.well-known/jwks.json', async c => {
    const { jwk } = await signingKey(c.env, 404);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ keys: [jwk] });
  });
}
