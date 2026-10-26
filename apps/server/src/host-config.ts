import type { Hono } from 'hono';
import { defaultHostConfig, ownerOnlyHostConfig, parseHostConfig, type HostConfig, type RepositoryCacheMode } from '../../../packages/shared/src/host-config.js';
import type { Env, WorkerEnv } from './types.js';
import { auditStatement } from './db.js';
import { fail, jsonObject, now } from './http.js';
import { managedConnector } from './host-access.js';

/*
 * How a host runs its sessions (HostConfig): its command time limit, whether sandboxed commands get its GPU, whether
 * pushes in its owner's sessions may use its Git credentials, its repository cache, and whether its owner's sessions may
 * run directly on it, without the sandbox. Its owner sets them here, as do its admins, except the ones that decide whose
 * credentials the host uses and what runs on it unsandboxed. Connectors read them back (`/api/connectors/self/config`)
 * instead of taking connect options.
 */

interface ConfigRow { command_timeout_seconds: number; gpu: number; git_credentials: number; repository_cache: RepositoryCacheMode; host_sessions: number }

/** The configuration of `connectorId`; the defaults until its owner or an admin changes one. */
export async function connectorHostConfig(env: Env, connectorId: string): Promise<HostConfig> {
  const row = await env.DB.query<ConfigRow>(`SELECT command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions
    FROM connector_configs WHERE connector_id = ?`).bind(connectorId).first();
  if (!row) return { ...defaultHostConfig };
  return { commandTimeoutSeconds: Number(row.command_timeout_seconds), gpu: Number(row.gpu) === 1,
    gitCredentials: Number(row.git_credentials) === 1, repositoryCache: row.repository_cache, hostSessions: Number(row.host_sessions) === 1 };
}

const upsert = `INSERT INTO connector_configs (connector_id, command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, updated_by, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connectors WHERE id = ? AND revoked_at IS NULL AND removed_at IS NULL)
  ON CONFLICT (connector_id) DO UPDATE SET command_timeout_seconds = excluded.command_timeout_seconds, gpu = excluded.gpu, %OWNER%
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  RETURNING connector_id`;
/** The owner writes every setting. An admin's write never touches the owner's: a concurrent change of theirs stays. */
const ownerUpsert = upsert.replace('%OWNER%',
  'git_credentials = excluded.git_credentials, repository_cache = excluded.repository_cache, host_sessions = excluded.host_sessions,');
const adminUpsert = upsert.replace('%OWNER%', '');

export function registerHostConfig(app: Hono<WorkerEnv>): void {
  // The whole configuration, as the host's page shows it. Applying it is the connector's: it reads it within a minute.
  app.put('/api/connectors/:id/config', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    let config: HostConfig;
    try { config = parseHostConfig(await jsonObject(c, 4096)); }
    catch (error) { return fail(400, 'invalid_host_config', error instanceof Error ? error.message : 'Invalid host configuration.'); }
    const owner = row.role === 'owner';
    if (!owner) {
      const current = await connectorHostConfig(c.env, row.id);
      if (ownerOnlyHostConfig.some(key => config[key] !== current[key])) {
        fail(403, 'host_owner_required', 'Only the host\'s owner decides whether it uses its Git credentials, keeps a repository cache or runs sessions without the sandbox.');
      }
      // An admin's insert, on a host with no configuration yet, keeps the owner's settings at their defaults.
      config = { ...config, gitCredentials: current.gitCredentials, repositoryCache: current.repositoryCache, hostSessions: current.hostSessions };
    }
    const saved = await c.env.DB.query(owner ? ownerUpsert : adminUpsert)
      .bind(row.id, config.commandTimeoutSeconds, config.gpu ? 1 : 0, config.gitCredentials ? 1 : 0, config.repositoryCache, config.hostSessions ? 1 : 0,
        actorId, now(), row.id).first();
    if (!saved) fail(409, 'connector_revoked', 'Connector is revoked.');
    const effective = await connectorHostConfig(c.env, row.id);
    await auditStatement(c.env, actorId, 'host.config.updated', null, null, { connectorId: row.id, ...effective }).run();
    return c.json({ config: effective });
  });
}
