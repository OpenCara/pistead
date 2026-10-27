import type { Hono } from 'hono';
import { defaultHostConfig, ownerOnlyHostConfig, parseHostCompaction, parseHostConfigChange, type HostConfig, type RepositoryCacheMode } from '../../../packages/shared/src/host-config.js';
import type { Env, WorkerEnv } from './types.js';
import { auditStatement } from './db.js';
import { fail, jsonObject, now } from './http.js';
import { managedConnector } from './host-access.js';

/*
 * How a host runs its sessions (HostConfig): its command time limit, whether sandboxed commands get its GPU, whether
 * pushes in its owner's sessions may use its Git credentials, its repository cache, whether its owner's sessions may
 * run directly on it, without the sandbox, and when its long conversations are summarized (compaction). Its owner sets them here, as do its admins, except the ones that decide whose
 * credentials the host uses and what runs on it unsandboxed. Connectors read them back (`/api/connectors/self/config`)
 * instead of taking connect options.
 */

interface ConfigRow { command_timeout_seconds: number; gpu: number; git_credentials: number; repository_cache: RepositoryCacheMode; host_sessions: number; compaction_json: string }

/** The configuration of `connectorId`; the defaults until its owner or an admin changes one. */
export async function connectorHostConfig(env: Env, connectorId: string): Promise<HostConfig> {
  const row = await env.DB.query<ConfigRow>(`SELECT command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, compaction_json
    FROM connector_configs WHERE connector_id = ?`).bind(connectorId).first();
  if (!row) return { ...defaultHostConfig };
  return { commandTimeoutSeconds: Number(row.command_timeout_seconds), gpu: Number(row.gpu) === 1,
    gitCredentials: Number(row.git_credentials) === 1, repositoryCache: row.repository_cache, hostSessions: Number(row.host_sessions) === 1,
    compaction: storedCompaction(row.compaction_json) };
}

/** The saved compaction setting; one that no longer reads as valid (a database edited by hand, say) is none. */
function storedCompaction(json: string): HostConfig['compaction'] {
  try { return parseHostCompaction(JSON.parse(json)); }
  catch { return {}; }
}

/** Each setting's column; the only names `upsert` puts in its SQL. */
const columns: Readonly<Record<keyof HostConfig, string>> = Object.freeze({ commandTimeoutSeconds: 'command_timeout_seconds', gpu: 'gpu',
  gitCredentials: 'git_credentials', repositoryCache: 'repository_cache', hostSessions: 'host_sessions', compaction: 'compaction_json' });

/**
 * Saves a change of `settings`. A host with no configuration yet gets a whole one: the change over what it had (the
 * defaults). A host with one gets only those settings, so a concurrent change of another setting stays: an admin's
 * write, which never names the owner's settings, never touches them.
 */
function upsert(settings: readonly (keyof HostConfig)[]): string {
  return `INSERT INTO connector_configs (connector_id, command_timeout_seconds, gpu, git_credentials, repository_cache, host_sessions, compaction_json, updated_by, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connectors WHERE id = ? AND revoked_at IS NULL AND removed_at IS NULL)
  ON CONFLICT (connector_id) DO UPDATE SET ${settings.map(key => `${columns[key]} = excluded.${columns[key]}, `).join('')}
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  RETURNING connector_id`;
}

export function registerHostConfig(app: Hono<WorkerEnv>): void {
  // The settings to change, as the host's page sends what its user changed; the rest keep their values. Compaction is
  // one setting, sent whole. Applying them is the connector's: it reads them within a minute.
  app.patch('/api/connectors/:id/config', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    let change: Partial<HostConfig>;
    // Room for compaction counts of the most models, with the longest names a host advertises (about 67 KB).
    try { change = parseHostConfigChange(await jsonObject(c, 131_072)); }
    catch (error) { return fail(400, 'invalid_host_config', error instanceof Error ? error.message : 'Invalid host configuration.'); }
    const current = await connectorHostConfig(c.env, row.id);
    let settings = Object.keys(change) as (keyof HostConfig)[];
    if (row.role !== 'owner') {
      // An admin may name one of the owner's settings only as it is: changing it is the owner's.
      if (settings.some(key => ownerOnlyHostConfig.includes(key) && change[key] !== current[key])) {
        fail(403, 'host_owner_required', 'Only the host\'s owner decides whether it uses its Git credentials, keeps a repository cache or runs sessions without the sandbox.');
      }
      settings = settings.filter(key => !ownerOnlyHostConfig.includes(key));
      if (!settings.length) return c.json({ config: current });
    }
    const config: HostConfig = { ...current, ...Object.fromEntries(settings.map(key => [key, change[key]])) };
    const saved = await c.env.DB.query(upsert(settings))
      .bind(row.id, config.commandTimeoutSeconds, config.gpu ? 1 : 0, config.gitCredentials ? 1 : 0, config.repositoryCache, config.hostSessions ? 1 : 0,
        JSON.stringify(config.compaction), actorId, now(), row.id).first();
    if (!saved) fail(409, 'connector_revoked', 'Connector is revoked.');
    const effective = await connectorHostConfig(c.env, row.id);
    await auditStatement(c.env, actorId, 'host.config.updated', null, null, { connectorId: row.id, ...effective }).run();
    return c.json({ config: effective });
  });
}
