import { resolve } from 'node:path';
import { adminUserId } from './admin.js';
import { ConnectorHubRegistry } from './connector-hub.js';
import { openDatabase } from './db/index.js';
import { openStorage } from './storage/index.js';
import type { Env } from './types.js';
import { webSearchConfigurationError } from './web-search.js';

export interface ServerConfig {
  env: Env;
  host: string;
  port: number;
  /** Honour `X-Forwarded-Proto`/`X-Forwarded-Host` from a TLS-terminating proxy. */
  trustProxy: boolean;
  /** Directory holding the built web client (`dist/web`). */
  staticDir: string;
  databaseUrl: string;
  /** `STORAGE_URL`, or null when it is unset: the server then stores no session backups. */
  storageUrl: string | null;
}

export class ConfigurationError extends Error {}

function flag(processEnv: NodeJS.ProcessEnv, name: string): boolean {
  const value = processEnv[name] || 'false';
  if (value !== 'true' && value !== 'false') throw new ConfigurationError(`${name} must be "true" or "false".`);
  return value === 'true';
}

export const defaultDatabaseUrl = 'sqlite:///data/pistead.sqlite';
const stringVars = [
  'APP_ORIGIN', 'RUNNER_URL', 'RUNNER_EVENT_TRANSPORT', 'RUNNER_SHARED_SECRET', 'SESSION_SECRET', 'VAULT_KEY',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'TEST_AUTH_ENABLED', 'TEST_AUTH_SECRET', 'TEST_AUTH_EXPIRES_AT',
  'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'OIDC_SIGNING_KEY', 'ADMIN_USER_IDS', 'GIT_DIRECT', 'SANDBOX_GITHUB_API',
  'WEB_SEARCH', 'WEB_SEARCH_API_KEY', 'WEB_SEARCH_URL',
  'LOCAL_MODE', 'LOCAL_CLAIM_SECRET', 'PASSWORD_AUTH', 'SIGNUP',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'DROPBOX_CLIENT_ID', 'DROPBOX_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'TENCENT_DOCS_CLIENT_ID', 'TENCENT_DOCS_CLIENT_SECRET',
] as const;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

/**
 * Builds `Env` from process environment variables: opens the database named by `DATABASE_URL` and, only when it is set,
 * the backup storage named by `STORAGE_URL`, creates the connector hub and copies the documented string settings.
 * Throws `ConfigurationError` naming the offending variable; values are never included.
 */
export async function loadConfig(processEnv: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const env = { APP_ORIGIN: '' } as Env;
  for (const name of stringVars) {
    const value = processEnv[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  if (!env.APP_ORIGIN) throw new ConfigurationError('APP_ORIGIN is required (the public https origin of this server).');
  try {
    const origin = new URL(env.APP_ORIGIN);
    if (origin.origin !== env.APP_ORIGIN) throw new Error();
  } catch {
    throw new ConfigurationError('APP_ORIGIN must be an origin such as https://pistead.example.com (no path, credentials or trailing slash).');
  }
  if (!env.SESSION_SECRET) throw new ConfigurationError('SESSION_SECRET is required: set it to a random string of at least 32 characters.');
  if (env.SESSION_SECRET.length < 32) throw new ConfigurationError('SESSION_SECRET must be at least 32 characters long.');
  if (!env.VAULT_KEY) throw new ConfigurationError('VAULT_KEY is required: set it to a base64url-encoded random 32-byte key.');
  if (!/^(?:[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43}=?)$/.test(env.VAULT_KEY)) throw new ConfigurationError('VAULT_KEY must be a base64url-encoded 32-byte key.');
  if (env.ADMIN_USER_IDS && env.ADMIN_USER_IDS.split(',').some(item => !adminUserId(env, item.trim()))) {
    throw new ConfigurationError('ADMIN_USER_IDS must list user IDs such as github:12345 or password:alice, separated by commas.');
  }
  if (env.PASSWORD_AUTH !== undefined) {
    if (!['true', 'false'].includes(env.PASSWORD_AUTH)) throw new ConfigurationError('PASSWORD_AUTH must be "true" or "false".');
    if (env.PASSWORD_AUTH === 'true' && env.LOCAL_MODE === 'true') throw new ConfigurationError('PASSWORD_AUTH is for shared servers: a LOCAL_MODE server admits only the GitHub account that claimed it.');
  }
  const webSearch = webSearchConfigurationError(env);
  if (webSearch) throw new ConfigurationError(webSearch);
  if (env.SIGNUP !== undefined && !['open', 'invite', 'off'].includes(env.SIGNUP)) {
    throw new ConfigurationError('SIGNUP must be "open", "invite" or "off" (unset: GitHub sign-ups are open and password sign-ups need an invite).');
  }
  const listenHost = processEnv.HOST || (env.LOCAL_MODE === 'true' ? '127.0.0.1' : '0.0.0.0');
  // A local server is reachable from this machine only, and admits only the GitHub account that claimed it.
  if (env.LOCAL_MODE !== undefined) {
    if (!['true', 'false'].includes(env.LOCAL_MODE)) throw new ConfigurationError('LOCAL_MODE must be "true" or "false".');
    if (env.LOCAL_MODE === 'true') {
      if (!env.LOCAL_CLAIM_SECRET || !/^[A-Za-z0-9_-]{43}$/.test(env.LOCAL_CLAIM_SECRET)) throw new ConfigurationError('LOCAL_MODE needs LOCAL_CLAIM_SECRET, a base64url-encoded random 32-byte value.');
      if (!LOOPBACK.includes(new URL(env.APP_ORIGIN).hostname.replace(/^\[|\]$/g, ''))) throw new ConfigurationError('LOCAL_MODE needs APP_ORIGIN on this machine, such as http://127.0.0.1:8787.');
      if (!LOOPBACK.includes(listenHost)) throw new ConfigurationError('LOCAL_MODE listens on loopback only: leave HOST unset or set it to 127.0.0.1.');
    }
  }
  const port = Number(processEnv.PORT ?? '8787');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigurationError('PORT must be a TCP port number.');
  const trustProxyValue = processEnv.TRUST_PROXY ?? 'false';
  if (!['true', 'false'].includes(trustProxyValue)) throw new ConfigurationError('TRUST_PROXY must be "true" or "false".');
  // Workspace owners may connect their own Postgres for session backups only when the operator opts in: the server then
  // opens connections to hosts they choose, public ones unless private hosts are allowed as well.
  const workspaceDatabases = flag(processEnv, 'WORKSPACE_DATABASES');
  const workspaceDatabasePrivateHosts = flag(processEnv, 'WORKSPACE_DATABASE_PRIVATE_HOSTS');
  const databaseUrl = processEnv.DATABASE_URL || defaultDatabaseUrl;
  // A backup holds a whole session, its owner's personal environment values included, so none is stored anywhere unless
  // the operator names the store. Without one, only workspaces whose owner connected a database can keep backups.
  const storageUrl = processEnv.STORAGE_URL || null;
  if (storageUrl) env.BUCKET = openStorage(storageUrl, processEnv);
  env.DB = await openDatabase(databaseUrl);
  // Loaded only when enabled, so a server without them (a local one, say) needs no Postgres driver installed.
  if (workspaceDatabases) {
    const { PostgresWorkspaceDatabases } = await import('./workspace-databases/postgres.js');
    env.WORKSPACE_DATABASES = new PostgresWorkspaceDatabases({ privateHosts: workspaceDatabasePrivateHosts });
  }
  env.CONNECTOR_HUB = new ConnectorHubRegistry(env);
  return {
    env, port, databaseUrl, storageUrl,
    host: listenHost,
    trustProxy: trustProxyValue === 'true',
    staticDir: resolve(processEnv.STATIC_DIR || 'dist/web'),
  };
}
