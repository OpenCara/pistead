import { resolve } from 'node:path';
import { ConnectorHubRegistry } from './connector-hub.js';
import { openDatabase } from './db/index.js';
import { openStorage } from './storage/index.js';
import type { Env } from './types.js';
import { PostgresWorkspaceDatabases } from './workspace-databases/postgres.js';

export interface ServerConfig {
  env: Env;
  host: string;
  port: number;
  /** Honour `X-Forwarded-Proto`/`X-Forwarded-Host` from a TLS-terminating proxy. */
  trustProxy: boolean;
  /** Directory holding the built web client (`dist/web`). */
  staticDir: string;
  databaseUrl: string;
  storageUrl: string;
}

export class ConfigurationError extends Error {}

function flag(processEnv: NodeJS.ProcessEnv, name: string): boolean {
  const value = processEnv[name] || 'false';
  if (value !== 'true' && value !== 'false') throw new ConfigurationError(`${name} must be "true" or "false".`);
  return value === 'true';
}

export const defaultDatabaseUrl = 'sqlite:///data/pistead.sqlite';
const defaultStorageUrl = 'file:///data/backups';
const stringVars = [
  'APP_ORIGIN', 'RUNNER_URL', 'RUNNER_EVENT_TRANSPORT', 'RUNNER_SHARED_SECRET', 'SESSION_SECRET', 'VAULT_KEY',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'TEST_AUTH_ENABLED', 'TEST_AUTH_SECRET', 'TEST_AUTH_EXPIRES_AT',
  'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'OIDC_SIGNING_KEY',
] as const;

/**
 * Builds `Env` from process environment variables: opens the database and object storage named by
 * `DATABASE_URL`/`STORAGE_URL`, creates the connector hub and copies the documented string settings.
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
  const port = Number(processEnv.PORT ?? '8787');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigurationError('PORT must be a TCP port number.');
  const trustProxyValue = processEnv.TRUST_PROXY ?? 'false';
  if (!['true', 'false'].includes(trustProxyValue)) throw new ConfigurationError('TRUST_PROXY must be "true" or "false".');
  // Workspace owners may connect their own Postgres for session backups only when the operator opts in: the server then
  // opens connections to hosts they choose, public ones unless private hosts are allowed as well.
  const workspaceDatabases = flag(processEnv, 'WORKSPACE_DATABASES');
  const workspaceDatabasePrivateHosts = flag(processEnv, 'WORKSPACE_DATABASE_PRIVATE_HOSTS');
  const databaseUrl = processEnv.DATABASE_URL || defaultDatabaseUrl;
  const storageUrl = processEnv.STORAGE_URL || defaultStorageUrl;
  env.BUCKET = openStorage(storageUrl, processEnv);
  env.DB = await openDatabase(databaseUrl);
  if (workspaceDatabases) env.WORKSPACE_DATABASES = new PostgresWorkspaceDatabases({ privateHosts: workspaceDatabasePrivateHosts });
  env.CONNECTOR_HUB = new ConnectorHubRegistry(env);
  return {
    env, port, databaseUrl, storageUrl,
    host: processEnv.HOST || '0.0.0.0',
    trustProxy: trustProxyValue === 'true',
    staticDir: resolve(processEnv.STATIC_DIR || 'dist/web'),
  };
}
