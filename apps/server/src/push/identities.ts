import type { Hono } from 'hono';
import type { GitProvider } from '../../../../packages/shared/src/repositories.js';
import { gitProviders, pushIdentityKindsByProvider } from '../../../../packages/shared/src/repositories.js';
import type { PushIdentity, PushIdentityKind } from '../../../../packages/shared/src/types.js';
import { sha256 } from '../../../../packages/shared/src/crypto.js';
import type { PushIdentityRow, WorkerEnv } from '../types.js';
import { auditStatement, requireMember } from '../db.js';
import { appOrigin, fail, id, identifier, jsonObject, now, randomToken } from '../http.js';
import { assertVaultConfigured, decryptToken, encryptToken } from '../vault.js';
import { gitHost } from '../git/accounts.js';
import { publicRepository, repositorySettingsSelect, type RepositorySettingsRow } from '../repositories.js';
import { workspaceSubject } from './oidc.js';
import {
  exchangeAuthorizationCode, githubInstallUrl, identitySecretContext, oauthEndpoints, oauthRedirectUri, oauthSecret, verifyIdentity,
} from './mint.js';

interface IdentityInput { provider: GitProvider; host: string; scope: string; kind: PushIdentityKind; config: Record<string, string>; secret: string | null }

const stateTtl = 10 * 60 * 1000;
const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const printable = /^[\x21-\x7e]{1,255}$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Owner/admin authority, re-checked inside every write (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;
// Public settings per kind: [field, pattern, lowercase?]. The owner's account and the host's credentials need none.
const configFields: Record<PushIdentityKind, readonly (readonly [string, RegExp, boolean])[]> = {
  'github-app': [['appId', /^[1-9]\d{0,15}$/, false], ['slug', /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/, false]],
  'entra-federation': [['tenantId', guid, true], ['clientId', guid, true]],
  'bitbucket-client-credentials': [['key', /^[A-Za-z0-9]{1,100}$/, false]],
  'oauth-refresh': [['clientId', printable, false]],
  'forgejo-integration': [['audience', printable, false]],
  'owner-account': [],
  'host-credentials': [],
};
const secretless: readonly PushIdentityKind[] = ['entra-federation', 'forgejo-integration', 'owner-account', 'host-credentials'];

function invalid(message: string): never {
  return fail(400, 'invalid_push_identity', message);
}

function identityInput(input: Record<string, unknown>): IdentityInput {
  if (Object.keys(input).some(key => !['provider', 'host', 'scope', 'kind', 'config', 'secret'].includes(key))) {
    invalid('Only provider, host, scope, kind, config and secret may be set.');
  }
  if (!(gitProviders as readonly unknown[]).includes(input.provider)) invalid('Choose a supported Git provider.');
  const provider = input.provider as GitProvider;
  if (!(pushIdentityKindsByProvider[provider] as readonly unknown[]).includes(input.kind)) invalid('This identity kind is not available for the provider.');
  const kind = input.kind as PushIdentityKind;
  const host = gitHost(provider, input.host);
  let scope = '';
  if (provider === 'azure-devops' || provider === 'bitbucket') {
    scope = typeof input.scope === 'string' ? input.scope.trim().toLowerCase() : '';
    const pattern = provider === 'azure-devops' ? /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/ : /^[a-z0-9][a-z0-9_.-]{0,61}$/;
    if (!pattern.test(scope)) invalid(provider === 'azure-devops' ? 'Enter the Azure DevOps organization.' : 'Enter the Bitbucket workspace.');
  } else if (input.scope !== undefined && input.scope !== '') invalid('This provider has no identity scope.');
  const raw = input.config;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Identity settings are required.');
  const fields = configFields[kind];
  if (Object.keys(raw).some(key => !fields.some(([field]) => field === key))) invalid('Unsupported identity setting.');
  const config: Record<string, string> = {};
  for (const [field, pattern, lower] of fields) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== 'string' || !pattern.test(value)) invalid(`Invalid ${field}.`);
    config[field] = lower ? value.toLowerCase() : value;
  }
  // Entra's federation audience would let this workspace's assertions double as Azure DevOps credentials.
  if (kind === 'forgejo-integration' && config.audience!.trim().toLowerCase() === 'api://azureadtokenexchange') {
    invalid('Choose an audience other than api://AzureADTokenExchange.');
  }
  let secret: string | null = null;
  if (secretless.includes(kind)) {
    if (input.secret !== undefined && input.secret !== null) invalid('This identity kind has no secret.');
  } else if (kind === 'github-app') {
    if (typeof input.secret !== 'string' || !input.secret || input.secret.length > 16_384 || input.secret.includes('\0')) invalid('The GitHub App private key is required.');
    secret = input.secret;
  } else {
    if (typeof input.secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(input.secret)) invalid('The client secret is required.');
    secret = input.secret;
  }
  return { provider, host, scope, kind, config, secret };
}

export function publicIdentity(row: PushIdentityRow): PushIdentity {
  return { id: row.id, workspaceId: row.workspace_id, provider: row.provider, host: row.host, scope: row.scope, kind: row.kind,
    config: JSON.parse(row.config_json) as Record<string, string>, status: row.status, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function registerPushIdentities(app: Hono<WorkerEnv>): void {
  app.get('/api/workspaces/:id/push-identities', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const rows = await c.env.DB.query<PushIdentityRow>('SELECT * FROM push_identities WHERE workspace_id = ? ORDER BY provider, host, scope, id')
      .bind(workspaceId).all();
    const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY } = c.env;
    return c.json({
      identities: rows.map(publicIdentity),
      oidc: c.env.OIDC_SIGNING_KEY ? { issuer: appOrigin(c.env), subject: workspaceSubject(workspaceId) } : null,
      redirectUri: c.env.APP_ORIGIN ? oauthRedirectUri(c.env) : null,
      githubApp: GITHUB_APP_ID && GITHUB_APP_SLUG && GITHUB_APP_PRIVATE_KEY
        ? { slug: GITHUB_APP_SLUG, installUrl: githubInstallUrl('github', 'github.com', GITHUB_APP_SLUG) } : null,
    });
  });

  app.post('/api/workspaces/:id/push-identities', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = identityInput(await jsonObject(c, 32_768));
    await assertVaultConfigured(c.env);
    const config = await verifyIdentity(c.env, { workspaceId, ...input });
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    // Replacing keeps the row id: the secret's vault context is bound to it.
    const existing = await c.env.DB.query<{ id: string }>('SELECT id FROM push_identities WHERE workspace_id = ? AND provider = ? AND host = ? AND scope = ?')
      .bind(workspaceId, input.provider, input.host, input.scope).first();
    const identityId = existing?.id ?? id();
    const stored = input.kind === 'oauth-refresh' ? JSON.stringify({ clientSecret: input.secret }) : input.secret;
    const ciphertext = stored === null ? null : await encryptToken(c.env, identitySecretContext(identityId), stored);
    const timestamp = now();
    const row = await c.env.DB.query<PushIdentityRow>(`INSERT INTO push_identities
      (id, workspace_id, provider, host, scope, kind, config_json, secret_ciphertext, status, lease_until, created_by, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,NULL,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id, provider, host, scope) DO UPDATE SET kind = excluded.kind, config_json = excluded.config_json,
        secret_ciphertext = excluded.secret_ciphertext, status = excluded.status, lease_until = NULL, created_by = excluded.created_by,
        updated_at = excluded.updated_at
        WHERE push_identities.id = excluded.id
      RETURNING *`)
      .bind(identityId, workspaceId, input.provider, input.host, input.scope, input.kind, JSON.stringify(config), ciphertext,
        input.kind === 'oauth-refresh' ? 'authorization_required' : 'ready', actor, timestamp, timestamp, workspaceId, actor)
      .first();
    if (!row) fail(409, 'push_identity_conflict', 'The push identity or workspace authority changed. Try again.');
    await c.env.DB.batch([
      // Pending authorizations were started for the replaced settings.
      c.env.DB.query('DELETE FROM push_oauth_states WHERE identity_id = ?').bind(row.id),
      auditStatement(c.env, actor, 'push.identity.saved', workspaceId, null, { identityId: row.id, provider: row.provider, host: row.host, scope: row.scope, kind: row.kind }),
    ]);
    return c.json({ identity: publicIdentity(row) }, 201);
  });

  app.delete('/api/workspaces/:id/push-identities/:identityId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const removed = await c.env.DB.query<Pick<PushIdentityRow, 'id' | 'provider' | 'host' | 'scope' | 'kind'>>(`DELETE FROM push_identities WHERE id = ? AND workspace_id = ? AND ${adminSql}
      RETURNING id, provider, host, scope, kind`).bind(identifier(c.req.param('identityId'), 'identityId'), workspaceId, workspaceId, actor)
      .first();
    if (!removed) fail(404, 'not_found', 'Push identity not found.');
    await auditStatement(c.env, actor, 'push.identity.removed', workspaceId, null,
      { identityId: removed.id, provider: removed.provider, host: removed.host, scope: removed.scope, kind: removed.kind }).run();
    return c.body(null, 204);
  });

  app.post('/api/workspaces/:id/push-identities/:identityId/authorize', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const row = await c.env.DB.query<PushIdentityRow>('SELECT * FROM push_identities WHERE id = ? AND workspace_id = ?')
      .bind(identifier(c.req.param('identityId'), 'identityId'), workspaceId).first();
    if (!row) fail(404, 'not_found', 'Push identity not found.');
    if (row.kind !== 'oauth-refresh') fail(400, 'push_identity_not_oauth', 'Only OAuth push identities are authorized by a bot account.');
    await assertVaultConfigured(c.env);
    const state = randomToken(); const verifier = randomToken();
    await c.env.DB.query('DELETE FROM push_oauth_states WHERE expires_at <= ?').bind(Date.now()).run();
    const inserted = await c.env.DB.query(`INSERT INTO push_oauth_states (state_hash, identity_id, user_id, verifier, expires_at, created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM push_identities WHERE id = ? AND workspace_id = ?) AND ${adminSql} RETURNING state_hash`)
      .bind(await sha256(state), row.id, actor, verifier, Date.now() + stateTtl, now(), row.id, workspaceId, workspaceId, actor).first();
    if (!inserted) fail(409, 'push_identity_conflict', 'The push identity or workspace authority changed. Try again.');
    const endpoints = oauthEndpoints(row.provider, row.host);
    const url = new URL(endpoints.authorize);
    url.search = new URLSearchParams({ client_id: (JSON.parse(row.config_json) as Record<string, string>).clientId!, redirect_uri: oauthRedirectUri(c.env),
      response_type: 'code', scope: endpoints.scope, state, code_challenge: await sha256(verifier), code_challenge_method: 'S256' }).toString();
    return c.json({ url: url.toString() });
  });

  app.get('/api/push-identities/oauth/callback', async c => {
    const actor = c.get('auth').userId;
    const states = c.req.queries('state');
    const state = states?.length === 1 ? states[0] : undefined;
    if (!state || !opaqueToken.test(state)) fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
    // Single use: DELETE RETURNING makes replays and concurrent callbacks fail before the code exchange.
    const saved = await c.env.DB.query<{ identity_id: string; verifier: string; expires_at: number }>('DELETE FROM push_oauth_states WHERE state_hash = ? AND user_id = ? RETURNING identity_id, verifier, expires_at')
      .bind(await sha256(state), actor).first();
    if (!saved || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= Date.now() || !opaqueToken.test(saved.verifier)) {
      fail(400, 'invalid_oauth_state', 'Invalid or expired OAuth state.');
    }
    const codes = c.req.queries('code');
    const code = codes?.length === 1 ? codes[0] : undefined;
    if (!code || !/^[\x21-\x7e]{1,2048}$/.test(code)) fail(400, 'invalid_oauth_code', 'The bot account did not grant access.');
    const row = await c.env.DB.query<PushIdentityRow>('SELECT * FROM push_identities WHERE id = ?').bind(saved.identity_id).first();
    if (!row || row.kind !== 'oauth-refresh' || !row.secret_ciphertext) fail(404, 'not_found', 'Push identity not found.');
    await requireMember(c.env, row.workspace_id, actor, ['owner', 'admin']);
    const { clientSecret } = oauthSecret(await decryptToken(c.env, identitySecretContext(row.id), row.secret_ciphertext));
    const { refreshToken, login } = await exchangeAuthorizationCode(c.env,
      { provider: row.provider, host: row.host, clientId: (JSON.parse(row.config_json) as Record<string, string>).clientId!, clientSecret }, code, saved.verifier);
    const ciphertext = await encryptToken(c.env, identitySecretContext(row.id), JSON.stringify({ clientSecret, refreshToken }));
    const updated = await c.env.DB.query(`UPDATE push_identities SET secret_ciphertext = ?, config_json = json_set(config_json, '$.login', ?),
      status = 'ready', lease_until = NULL, updated_at = ? WHERE id = ? AND secret_ciphertext = ? AND ${adminSql} RETURNING id`)
      .bind(ciphertext, login, now(), row.id, row.secret_ciphertext, row.workspace_id, actor).first();
    if (!updated) fail(409, 'push_identity_conflict', 'The push identity or workspace authority changed. Try again.');
    await auditStatement(c.env, actor, 'push.identity.authorized', row.workspace_id, null,
      { identityId: row.id, provider: row.provider, host: row.host, scope: row.scope, login }).run();
    return c.redirect(`${appOrigin(c.env)}/#/settings/workspaces/${encodeURIComponent(row.workspace_id)}`, 302);
  });

  app.put('/api/workspaces/:id/repositories/:bindingId/push-policy', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const bindingId = identifier(c.req.param('bindingId'), 'bindingId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).some(key => key !== 'forbidDefaultBranch') || typeof input.forbidDefaultBranch !== 'boolean') {
      fail(400, 'invalid_push_policy', 'Set forbidDefaultBranch to true or false.');
    }
    const saved = await c.env.DB.query(`INSERT INTO repository_push_policies (binding_id, workspace_id, forbid_default_branch, updated_by, updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_repositories WHERE id = ? AND workspace_id = ?) AND ${adminSql}
      ON CONFLICT (binding_id) DO UPDATE SET forbid_default_branch = excluded.forbid_default_branch, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at WHERE repository_push_policies.workspace_id = excluded.workspace_id
      RETURNING binding_id`)
      .bind(bindingId, workspaceId, input.forbidDefaultBranch ? 1 : 0, actor, now(), bindingId, workspaceId, workspaceId, actor).first();
    if (!saved) fail(404, 'not_found', 'Repository not found.');
    const repository = await c.env.DB.query<RepositorySettingsRow>(`${repositorySettingsSelect} WHERE r.id = ? AND r.workspace_id = ?`)
      .bind(bindingId, workspaceId).first();
    if (!repository) fail(404, 'not_found', 'Repository not found.');
    await auditStatement(c.env, actor, 'repository.push_policy.updated', workspaceId, null,
      { bindingId, forbidDefaultBranch: input.forbidDefaultBranch }).run();
    return c.json({ repository: publicRepository(repository) });
  });
}
