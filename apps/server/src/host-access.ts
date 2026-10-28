import type { Hono } from 'hono';
import type { ConnectorAdmin, ConnectorCapabilities, HostCommandGrant } from '../../../packages/shared/src/connector.js';
import { hasPermission, readOnlyRoles } from '../../../packages/shared/src/policy.js';
import { hostCommandLevels, type HostCommandLevel, type Permission, type RunnerAction } from '../../../packages/shared/src/types.js';
import type { AppContext, Env, SessionAccess, SessionRow, WorkerEnv } from './types.js';
import type { ConnectorRow } from './connectors.js';
import { auditStatement, requireMember } from './db.js';
import { fail, identifier, jsonObject, now, text, userIdentifier } from './http.js';

/*
 * A host is its owner's machine. Its owner may let other members manage its sharing and which of its models it offers
 * (admins, see host-models.ts for the models), and let members of a workspace it is shared with decide host commands, or
 * run those of their own Auto-approve messages without asking (host command grants), and, with a grant that includes it,
 * start their own sessions directly on the host, without the sandbox. Admins manage shares and grants but
 * hold no host command authority of their own until a grant gives it to them, so each one is visible in the host's grant
 * list. Only the owner adds admins, revokes or removes the host.
 */

const maxAdmins = 20;
const maxGrants = 200;
const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ');

export type ManagedConnector = ConnectorRow & { role: 'owner' | 'admin' };

/**
 * SQL true while a user owns connector `c` or is one of its admins, as managedConnectorFor reads it; binds the user's id
 * twice. Writes that need that authority check it again in their own statement.
 */
export const managesConnectorSQL = `(c.owner_id = ? OR EXISTS (SELECT 1 FROM connector_admins a JOIN users u ON u.id = a.user_id
  WHERE a.connector_id = c.id AND a.user_id = ? AND u.suspended_at IS NULL))`;

/** The connector `id` names, when `userId` owns it or is one of its admins. */
export async function managedConnectorFor(env: Env, connectorId: string, userId: string): Promise<ManagedConnector | null> {
  const row = await env.DB.query<ConnectorRow>(`SELECT c.* FROM connectors c WHERE c.id = ? AND c.removed_at IS NULL
    AND ${managesConnectorSQL}`).bind(connectorId, userId, userId).first();
  return row ? { ...row, role: row.owner_id === userId ? 'owner' : 'admin' } : null;
}

/** The route's connector, for its owner or an admin: sharing is managed by either. */
export async function managedConnector(c: AppContext): Promise<ManagedConnector> {
  const row = await managedConnectorFor(c.env, identifier(c.req.param('id')), c.get('auth').userId);
  if (!row) fail(404, 'not_found', 'Connector not found.');
  return row;
}

/** What a member holds on a host in one workspace: their host command level, and whether they may run sessions on it. */
export type HostAuthority = { level: 'owner' | HostCommandLevel; sessions: boolean };

/**
 * What `userId` may do on the host of `row`, a session (or a workspace) on a connector: everything for the host's owner,
 * else what their unexpired grants in the workspace give, for them or for all its members, while the host is still
 * shared there and they are a member who can write: the highest level of those grants, and sessions on the host when
 * any of them includes that. Undefined when they hold none.
 */
export async function hostAuthority(env: Env, row: Pick<SessionRow, 'connector_id' | 'connector_owner_id' | 'workspace_id'>,
  userId: string): Promise<HostAuthority | undefined> {
  if (!row.connector_id || !row.connector_owner_id) return undefined;
  if (row.connector_owner_id === userId) return { level: 'owner', sessions: true };
  const grants = await env.DB.query<{ level: HostCommandLevel; host_sessions: number | string }>(`SELECT g.level, g.host_sessions FROM connector_host_grants g
    JOIN connectors c ON c.id = g.connector_id
    JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.user_id = ?
    JOIN users u ON u.id = m.user_id
    WHERE g.connector_id = ? AND c.owner_id = ? AND g.workspace_id = ? AND (g.user_id = ? OR g.user_id = '')
      AND (g.expires_at IS NULL OR g.expires_at > ?) AND c.revoked_at IS NULL AND c.removed_at IS NULL
      AND u.suspended_at IS NULL AND m.role NOT IN (${sqlList(readOnlyRoles)})
      AND EXISTS (SELECT 1 FROM connector_shares sh WHERE sh.connector_id = c.id AND sh.workspace_id = g.workspace_id)`)
    .bind(userId, row.connector_id, row.connector_owner_id, row.workspace_id, userId, Math.floor(Date.now() / 1000)).all();
  if (!grants.length) return undefined;
  return { level: grants.some(grant => grant.level === 'auto') ? 'auto' : 'approve', sessions: grants.some(grant => Number(grant.host_sessions) === 1) };
}

/** What `userId` may do with host commands in `row`: `owner` for the host's owner, else their grants' highest level. */
export async function hostCommandAuthority(env: Env, row: Pick<SessionRow, 'connector_id' | 'connector_owner_id' | 'workspace_id'>,
  userId: string): Promise<'owner' | HostCommandLevel | undefined> {
  return (await hostAuthority(env, row, userId))?.level;
}

/** Whether `userId` may decide host commands in `row` (the owner, or a grant of either level). */
export async function mayDecideHostCommands(env: Env, row: SessionRow, userId: string): Promise<boolean> {
  return (await hostCommandAuthority(env, row, userId)) !== undefined;
}

/** Whether `userId` owns the host session `row` runs on. */
export function ownsSessionHost(row: Pick<SessionRow, 'connector_id' | 'connector_owner_id'>, userId: string): boolean {
  return !!row.connector_id && !!row.connector_owner_id && row.connector_owner_id === userId;
}

/**
 * Whether `userId` decides the host commands of session `row` as its host's owner with any access to the session,
 * without approve permission on it: a host command runs as the host's OS user, so deciding it is theirs. Members granted
 * host commands still need approve permission, as does everything else. Only on a connector that checks decisions so
 * (`hostOwnerDecides`); an older one asks for approve permission on every decision, its owner's included.
 */
export async function hostOwnerDecides(env: Env, row: Pick<SessionRow, 'connector_id' | 'connector_owner_id'>, userId: string): Promise<boolean> {
  if (!row.connector_id || !ownsSessionHost(row, userId)) return false;
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(row.connector_id).first();
  try { return (JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities).hostOwnerDecides === true; }
  catch { return false; }
}

/**
 * Whether `access` lets its actor send the runner `action`, which needs `permission`. A decision also goes for the
 * session's host owner with any access to it, on a host that lets its owner decide host commands so (hostOwnerDecides):
 * the approvals route and the host check that it decides a host command.
 */
export async function mayRequestAction(env: Env, access: SessionAccess, actorId: string, action: RunnerAction, permission: Permission): Promise<boolean> {
  if (hasPermission(access.permissions, permission)) return true;
  return action === 'approve' && await hostOwnerDecides(env, access.row, actorId);
}

export async function connectorAdmins(env: Env, connectorId: string): Promise<ConnectorAdmin[]> {
  return (await env.DB.query<{ user_id: string; display_name: string; created_at: string }>(`SELECT a.user_id, u.display_name, a.created_at
    FROM connector_admins a JOIN users u ON u.id = a.user_id WHERE a.connector_id = ? ORDER BY a.created_at LIMIT ${maxAdmins}`)
    .bind(connectorId).all()).map(item => ({ userId: item.user_id, name: item.display_name, createdAt: item.created_at }));
}

/**
 * The host's grants, as `viewer` may see them: all of them for its owner, an admin only those in workspaces they belong
 * to too, as their listing shows.
 */
export async function visibleHostGrants(env: Env, row: ManagedConnector, viewer: string): Promise<HostCommandGrant[]> {
  const grants = await connectorHostGrants(env, row.id);
  if (row.role === 'owner') return grants;
  const memberships = new Set((await env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_members WHERE user_id = ?')
    .bind(viewer).all()).map(item => item.workspace_id));
  return grants.filter(grant => memberships.has(grant.workspaceId));
}

/** An admin acts on a host's sharing only in workspaces they belong to; its owner, in any of theirs. */
export async function requireManagedWorkspace(env: Env, row: ManagedConnector, workspaceId: string, actorId: string): Promise<void> {
  if (row.role === 'admin') await requireMember(env, workspaceId, actorId);
}

export async function connectorHostGrants(env: Env, connectorId: string): Promise<HostCommandGrant[]> {
  const rows = await env.DB.query<{ workspace_id: string; user_id: string; display_name: string | null; level: HostCommandLevel;
    host_sessions: number | string; expires_at: number | null; created_by: string; created_at: string }>(`SELECT g.workspace_id, g.user_id, u.display_name, g.level, g.host_sessions, g.expires_at,
      g.created_by, g.created_at FROM connector_host_grants g LEFT JOIN users u ON u.id = g.user_id
    WHERE g.connector_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?) ORDER BY g.workspace_id, g.user_id LIMIT ${maxGrants}`)
    .bind(connectorId, Math.floor(Date.now() / 1000)).all();
  return rows.map(item => ({ workspaceId: item.workspace_id, userId: item.user_id || null, ...(item.user_id && item.display_name ? { userName: item.display_name } : {}),
    level: item.level, ...(Number(item.host_sessions) === 1 ? { hostSessions: true as const } : {}), expiresAt: item.expires_at === null ? null : new Date(item.expires_at * 1000).toISOString(),
    createdBy: item.created_by, createdAt: item.created_at }));
}

/** The viewer's own authority on a connector in `workspaceId`, as listings show it. */
export async function viewerHostAuthority(env: Env, connector: Pick<ConnectorRow, 'id' | 'owner_id'>, workspaceId: string, userId: string): Promise<HostAuthority | undefined> {
  return hostAuthority(env, { connector_id: connector.id, connector_owner_id: connector.owner_id, workspace_id: workspaceId }, userId);
}

/** An optional grant expiry: an ISO time in the future, or null/absent for none. */
function expiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const at = Date.parse(text(value, 'expiresAt', 64));
  if (!Number.isFinite(at) || at <= Date.now()) fail(400, 'invalid_expiry', 'A grant expires at a time in the future.');
  return Math.floor(at / 1000);
}

export function registerHostAccess(app: Hono<WorkerEnv>): void {
  // Only the owner adds admins: a member who shares a workspace with the host, other than as a viewer there.
  app.put('/api/connectors/:id/admins/:userId', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.role !== 'owner') fail(403, 'host_owner_required', 'Only the host\'s owner can add admins.');
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const userId = userIdentifier(c.req.param('userId'), 'userId');
    if (userId === row.owner_id) fail(400, 'invalid_admin', 'The host\'s owner already manages it.');
    const inserted = await c.env.DB.query(`INSERT INTO connector_admins (connector_id, user_id, created_by, created_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM connector_admins WHERE connector_id = ?) < ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND suspended_at IS NULL)
        AND EXISTS (SELECT 1 FROM connector_workspaces cw
          JOIN workspace_members owner ON owner.workspace_id = cw.workspace_id AND owner.user_id = ?
          JOIN workspace_members admin ON admin.workspace_id = cw.workspace_id AND admin.user_id = ?
          WHERE cw.connector_id = ? AND admin.role NOT IN (${sqlList(readOnlyRoles)}))
      ON CONFLICT (connector_id, user_id) DO UPDATE SET created_at = connector_admins.created_at RETURNING user_id`)
      .bind(row.id, userId, actorId, now(), row.id, maxAdmins, userId, row.owner_id, userId, row.id).first();
    if (!inserted) fail(409, 'admin_unavailable', 'Admins must be members (not viewers) of a workspace this host is connected to, and a host has at most 20.');
    await auditStatement(c.env, actorId, 'connector.admin.added', null, null, { connectorId: row.id, userId }).run();
    return c.json({ admins: await connectorAdmins(c.env, row.id) });
  });
  // The owner removes any admin; an admin may step down.
  app.delete('/api/connectors/:id/admins/:userId', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    const userId = userIdentifier(c.req.param('userId'), 'userId');
    if (row.role !== 'owner' && userId !== actorId) fail(403, 'host_owner_required', 'Only the host\'s owner can remove another admin.');
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM connector_admins WHERE connector_id = ? AND user_id = ?').bind(row.id, userId),
      auditStatement(c.env, actorId, 'connector.admin.removed', null, null, { connectorId: row.id, userId }),
    ]);
    return c.body(null, 204);
  });

  // Grants host command authority in a workspace the host is shared with: to one member, or to all of them.
  app.put('/api/connectors/:id/host-grants/:workspaceId', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const workspaceId = identifier(c.req.param('workspaceId'));
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(key => !['userId', 'level', 'hostSessions', 'expiresAt'].includes(key))) fail(400, 'invalid_grant', 'Unexpected grant field.');
    if (!hostCommandLevels.includes(input.level as HostCommandLevel)) fail(400, 'invalid_grant', 'A grant is approve or auto.');
    const level = input.level as HostCommandLevel;
    // Sessions on the host: theirs run as the host's OS user, as the owner's own do there. Only the owner, who alone lets
    // the host accept those (HostConfig.hostSessions), grants them; an admin may take them away. Absent, a grant keeps
    // what it had (none for a new one).
    if (input.hostSessions !== undefined && typeof input.hostSessions !== 'boolean') fail(400, 'invalid_grant', 'hostSessions must be true or false.');
    if (input.hostSessions === true && row.role !== 'owner') fail(403, 'host_owner_required', 'Only the host\'s owner grants sessions on the host.');
    const keepSessions = input.hostSessions === undefined;
    const hostSessions = input.hostSessions === true;
    const userId = input.userId === undefined || input.userId === null ? '' : userIdentifier(input.userId, 'userId');
    if (userId === row.owner_id) fail(400, 'invalid_grant', 'The host\'s owner already decides its host commands.');
    const expiresAt = expiry(input.expiresAt);
    // An admin grants only where they are a member; the owner, where the host is shared (checked by the insert).
    await requireManagedWorkspace(c.env, row, workspaceId, actorId);
    if (userId) {
      const member = await requireMember(c.env, workspaceId, userId);
      if (readOnlyRoles.includes(member.role)) fail(400, 'viewer_role', 'Viewers cannot be granted host commands.');
    }
    const inserted = await c.env.DB.query<{ host_sessions: number | string }>(`INSERT INTO connector_host_grants (connector_id, workspace_id, user_id, level, host_sessions, expires_at, created_by, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ((SELECT COUNT(*) FROM connector_host_grants WHERE connector_id = ?) < ?
          OR EXISTS (SELECT 1 FROM connector_host_grants WHERE connector_id = ? AND workspace_id = ? AND user_id = ?))
        AND EXISTS (SELECT 1 FROM connector_shares WHERE connector_id = ? AND workspace_id = ?)
        AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND revoked_at IS NULL AND removed_at IS NULL)
      ON CONFLICT (connector_id, workspace_id, user_id) DO UPDATE SET level = excluded.level,
        host_sessions = CASE WHEN ? = 1 THEN connector_host_grants.host_sessions ELSE excluded.host_sessions END, expires_at = excluded.expires_at,
        created_by = excluded.created_by, created_at = excluded.created_at
      RETURNING host_sessions`)
      .bind(row.id, workspaceId, userId, level, hostSessions ? 1 : 0, expiresAt, actorId, now(), row.id, maxGrants, row.id, workspaceId, userId, row.id, workspaceId, row.id, keepSessions ? 1 : 0).first();
    if (!inserted) fail(409, 'grant_unavailable', 'Share the host with this workspace first; a host has at most 200 grants.');
    await auditStatement(c.env, actorId, 'host.grant.set', workspaceId, null, { connectorId: row.id, userId: userId || null, level,
      ...(Number(inserted.host_sessions) === 1 ? { hostSessions: true } : {}), expiresAt }).run();
    return c.json({ hostGrants: await visibleHostGrants(c.env, row, actorId) });
  });
  // `?userId=` names the member's grant; without it, the workspace-wide one.
  app.delete('/api/connectors/:id/host-grants/:workspaceId', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    const workspaceId = identifier(c.req.param('workspaceId'));
    await requireManagedWorkspace(c.env, row, workspaceId, actorId);
    const named = c.req.query('userId');
    const userId = named === undefined || named === '' ? '' : userIdentifier(named, 'userId');
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM connector_host_grants WHERE connector_id = ? AND workspace_id = ? AND user_id = ?').bind(row.id, workspaceId, userId),
      auditStatement(c.env, actorId, 'host.grant.removed', workspaceId, null, { connectorId: row.id, userId: userId || null }),
    ]);
    return c.body(null, 204);
  });
}
