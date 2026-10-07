import type { Hono } from 'hono';
import type { GitAccount, GitProvider, ProviderRepository, TokenGitProvider } from '../../../../packages/shared/src/repositories.js';
import { gitProviderHosts, gitProviderNames, gitProviders, validGitHost, validRepositoryId, validRepositoryName } from '../../../../packages/shared/src/repositories.js';
import type { Env, GitCredentialRow, WorkerEnv } from '../types.js';
import { auditStatement, getUser } from '../db.js';
import { fail, id, identifier, jsonObject, now, testMode } from '../http.js';
import { decryptToken, encryptToken } from '../vault.js';
import { githubRepositoryPage, validRepositoryRef } from '../repositories.js';
import { gitProviderAdapters } from './providers.js';
import type { GitCredential } from './types.js';

/** A decrypted token account plus the exact ciphertext it was read from, for authority rechecks. */
export interface LoadedCredential {
  credential: GitCredential;
  ciphertext: string;
  userId: string;
}

const accountLimit = 20;
const organizationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

export function tokenProvider(value: unknown): value is TokenGitProvider {
  return typeof value === 'string' && value !== 'github' && (gitProviders as readonly string[]).includes(value);
}

/** True when `host` is the canonical API host for `provider`: the fixed host, or a public self-hosted name. */
export function validProviderHost(provider: GitProvider, host: unknown): host is string {
  const fixed = gitProviderHosts[provider].fixed;
  if (fixed) return host === fixed;
  // github.com is served by the sign-in OAuth connection, never by a personal access token.
  return validGitHost(host) && host !== 'github.com' && !host.endsWith('.github.com');
}

/** Normalizes a user-supplied host (case, an https:// prefix, trailing slashes) and applies the provider default. */
export function gitHost(provider: GitProvider, value: unknown): string {
  const name = gitProviderNames[provider];
  const hosts = gitProviderHosts[provider];
  if (value === undefined || value === null || value === '') {
    const fallback = hosts.fixed ?? hosts.default;
    if (!fallback) fail(400, 'invalid_git_host', `${name} requires the server host name.`);
    return fallback;
  }
  if (typeof value !== 'string' || value.length > 300) fail(400, 'invalid_git_host', `Use the ${name} server host name.`);
  const host = value.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (hosts.fixed && host !== hosts.fixed) fail(400, 'invalid_git_host', `${name} always uses ${hosts.fixed}.`);
  if (!validProviderHost(provider, host)) fail(400, 'invalid_git_host', `Use a public HTTPS host name for ${name}, such as git.example.com.`);
  return host;
}

/** Azure DevOps accounts are per organization (case-insensitive); other providers have none. */
export function credentialOrganization(provider: GitProvider, fullName: string): string {
  return provider === 'azure-devops' ? fullName.split('/')[0]!.toLowerCase() : '';
}

export function gitAccountRequired(provider: GitProvider, host: string, fullName: string): never {
  return fail(409, 'git_account_required', `Connect ${gitProviderNames[provider]} (${host}) in Settings → Profile to use ${fullName}.`);
}

async function loaded(env: Env, row: GitCredentialRow): Promise<LoadedCredential> {
  const token = await decryptToken(env, row.user_id, row.ciphertext);
  return { ciphertext: row.ciphertext, userId: row.user_id, credential: {
    id: row.id, provider: row.provider, host: row.host, organization: row.organization, username: row.username, token,
  } };
}

export async function loadCredential(env: Env, userId: string, provider: TokenGitProvider, host: string, organization: string): Promise<LoadedCredential | null> {
  const row = await env.DB.query<GitCredentialRow>('SELECT * FROM git_credentials WHERE user_id = ? AND provider = ? AND host = ? AND organization = ?')
    .bind(userId, provider, host, organization).first();
  return row ? loaded(env, row) : null;
}

export async function recheckCredential(env: Env, access: LoadedCredential): Promise<void> {
  const row = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM git_credentials WHERE id = ? AND user_id = ?')
    .bind(access.credential.id, access.userId).first();
  if (row?.ciphertext !== access.ciphertext) fail(403, 'git_access_changed', 'Git account access changed; retry with the current connection.');
}

/** Re-validates adapter output before it reaches a client or a binding. */
export function providerRepository(provider: GitProvider, value: unknown): ProviderRepository {
  const item = value as Partial<ProviderRepository> | null;
  if (!item || typeof item !== 'object' || !validRepositoryId(item.id) || !validRepositoryName(provider, item.fullName) ||
      !validRepositoryRef(item.defaultBranch) || typeof item.private !== 'boolean') {
    fail(502, 'invalid_git_response', `${gitProviderNames[provider]} returned invalid repository metadata.`);
  }
  return { id: item.id, fullName: item.fullName, defaultBranch: item.defaultBranch, private: item.private };
}

function publicAccount(row: Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization' | 'login' | 'created_at'>): GitAccount {
  return { id: row.id, provider: row.provider, host: row.host, organization: row.organization, login: row.login, createdAt: row.created_at };
}

function accountInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['provider', 'host', 'organization', 'username', 'token'].includes(key))) {
    fail(400, 'invalid_git_account', 'Only provider, host, organization, username and token are accepted.');
  }
  if (!tokenProvider(input.provider)) fail(400, 'invalid_git_provider', 'Choose a supported Git provider; GitHub.com uses the sign-in connection.');
  const provider = input.provider;
  const name = gitProviderNames[provider];
  const host = gitHost(provider, input.host);
  let organization = '';
  if (provider === 'azure-devops') {
    if (typeof input.organization !== 'string' || !organizationPattern.test(input.organization.trim())) {
      fail(400, 'invalid_git_organization', 'Azure DevOps requires the organization name from dev.azure.com/<organization>.');
    }
    organization = input.organization.trim().toLowerCase();
  } else if (input.organization !== undefined && input.organization !== '') {
    fail(400, 'invalid_git_organization', `${name} accounts do not take an organization.`);
  }
  let username: string | null = null;
  if (provider === 'bitbucket' && input.username !== undefined && input.username !== '') {
    // Basic auth: a colon or control character would change the credential's meaning.
    if (typeof input.username !== 'string' || !/^[^\s:\x00-\x1f\x7f]{1,254}$/.test(input.username.trim())) {
      fail(400, 'invalid_git_username', 'Use your Atlassian account email or username.');
    }
    username = input.username.trim();
  } else if (provider !== 'bitbucket' && input.username !== undefined && input.username !== '') {
    fail(400, 'invalid_git_username', `${name} accounts do not take a username.`);
  }
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) fail(400, 'invalid_git_token', `Paste a ${name} personal access token.`);
  return { provider, host, organization, username, token };
}

export function registerGitAccounts(app: Hono<WorkerEnv>): void {
  app.get('/api/git/accounts', async c => {
    const userId = c.get('auth').userId;
    const user = await getUser(c.env, userId);
    if (!user) fail(404, 'not_found', 'User not found.');
    const rows = await c.env.DB.query<Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization' | 'login' | 'created_at'>>(`SELECT id, provider, host, organization, login, created_at FROM git_credentials
      WHERE user_id = ? ORDER BY provider, host, organization, id`).bind(userId)
      .all();
    const github: GitAccount[] = user.auth_kind === 'github' && user.github_connected
      ? [{ id: 'github', provider: 'github', host: 'github.com', organization: '', login: user.github_login ?? '', createdAt: null }] : [];
    return c.json({ accounts: [...github, ...rows.map(publicAccount)] });
  });

  app.post('/api/git/accounts', async c => {
    const userId = c.get('auth').userId;
    const input = accountInput(await jsonObject(c, 32768));
    const user = await getUser(c.env, userId);
    if (!user) fail(404, 'not_found', 'User not found.');
    if (user.auth_kind === 'test' && !testMode(c.env)) fail(403, 'test_mode_disabled', 'Synthetic users cannot connect Git accounts.');
    const credential: GitCredential = { id: id(), ...input };
    const { login } = await gitProviderAdapters[input.provider].verify(credential);
    if (typeof login !== 'string' || !login || login.length > 200 || /[\x00-\x1f\x7f]/.test(login)) {
      fail(502, 'invalid_git_response', `${gitProviderNames[input.provider]} returned an invalid account name.`);
    }
    const ciphertext = await encryptToken(c.env, userId, input.token);
    const timestamp = now();
    // Reconnecting the same provider/host/organization replaces the token in place and keeps the account id.
    const row = await c.env.DB.query<Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization' | 'login' | 'created_at'>>(`INSERT INTO git_credentials
      (id, user_id, provider, host, organization, username, login, ciphertext, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND (auth_kind = 'github' OR (? = 1 AND auth_kind = 'test')))
        AND ((SELECT COUNT(*) FROM git_credentials WHERE user_id = ?) < ? OR EXISTS (SELECT 1 FROM git_credentials
          WHERE user_id = ? AND provider = ? AND host = ? AND organization = ?))
      ON CONFLICT (user_id, provider, host, organization) DO UPDATE SET username = excluded.username, login = excluded.login,
        ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
      RETURNING id, provider, host, organization, login, created_at`)
      .bind(credential.id, userId, input.provider, input.host, input.organization, input.username, login, ciphertext, timestamp, timestamp,
        userId, testMode(c.env) ? 1 : 0, userId, accountLimit, userId, input.provider, input.host, input.organization)
      .first();
    if (!row) fail(409, 'git_account_limit', `Remove a connected Git account first; at most ${accountLimit} can be connected.`);
    await auditStatement(c.env, userId, 'git.account.connected', null, null,
      { accountId: row.id, provider: row.provider, host: row.host, organization: row.organization }).run();
    return c.json({ account: publicAccount(row) }, 201);
  });

  app.delete('/api/git/accounts/:id', async c => {
    const userId = c.get('auth').userId;
    if (c.req.param('id') === 'github') fail(400, 'github_account_fixed', 'The GitHub sign-in connection cannot be removed here.');
    const removed = await c.env.DB.query<Pick<GitCredentialRow, 'id' | 'provider' | 'host' | 'organization'>>('DELETE FROM git_credentials WHERE id = ? AND user_id = ? RETURNING id, provider, host, organization')
      .bind(identifier(c.req.param('id')), userId).first();
    if (!removed) fail(404, 'not_found', 'Git account not found.');
    await auditStatement(c.env, userId, 'git.account.removed', null, null,
      { accountId: removed.id, provider: removed.provider, host: removed.host, organization: removed.organization }).run();
    return c.body(null, 204);
  });

  app.get('/api/git/accounts/:id/repositories', async c => {
    const userId = c.get('auth').userId;
    const accountId = c.req.param('id');
    const rawPage = c.req.query('page') ?? '1';
    if (!/^[1-9]\d{0,3}$/.test(rawPage) || Number(rawPage) > 1000) fail(400, 'invalid_page', 'Repository page must be between 1 and 1000.');
    const page = Number(rawPage);
    if (accountId === 'github') return c.json(await githubRepositoryPage(c.env, userId, page));
    const row = await c.env.DB.query<GitCredentialRow>('SELECT * FROM git_credentials WHERE id = ? AND user_id = ?')
      .bind(identifier(accountId), userId).first();
    if (!row) fail(404, 'not_found', 'Git account not found.');
    const access = await loaded(c.env, row);
    const result = await gitProviderAdapters[row.provider].list(access.credential, page);
    if (!Array.isArray(result?.repositories) || result.repositories.length > 30) {
      fail(502, 'invalid_git_response', `${gitProviderNames[row.provider]} returned invalid repository metadata.`);
    }
    const repositories = result.repositories.map(item => providerRepository(row.provider, item));
    await recheckCredential(c.env, access);
    return c.json({ repositories, page, hasMore: result.hasMore === true && page < 1000 });
  });
}
