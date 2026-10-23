import type { Hono } from 'hono';
import { adminListLimit, type AdminHost, type AdminList, type AdminOverview, type AdminUser, type AdminWorkspace } from '../../../packages/shared/src/admin.js';
import { auditAfterChange } from './db.js';
import { fail, now, testMode, userIdentifier } from './http.js';
import type { Env, WorkerEnv } from './types.js';

/**
 * Instance administration: the user IDs the operator lists in ADMIN_USER_IDS see every account, workspace and host on
 * the server and can suspend accounts. The role comes only from the server's configuration, never from the API, and it
 * grants nothing inside workspaces or sessions: no session titles, prompts, repositories or credentials are shown here.
 */

/** Whether ADMIN_USER_IDS may list `value`: a GitHub user, or a test identity while test mode lasts, where it can sign in at all. */
export function adminUserId(env: Env, value: string): boolean {
  return /^github:[1-9][0-9]*$/.test(value) || (testMode(env) && /^test:[A-Za-z0-9_-]{1,128}$/.test(value));
}

/** The configured administrators. */
export function instanceAdmins(env: Env): Set<string> {
  return new Set((env.ADMIN_USER_IDS ?? '').split(',').map(item => item.trim()).filter(item => adminUserId(env, item)));
}

export function isInstanceAdmin(env: Env, userId: string): boolean {
  return instanceAdmins(env).has(userId);
}

interface AdminUserRow {
  id: string; github_login: string | null; display_name: string; created_at: string; suspended_at: string | null;
  workspaces: number; hosts: number; sessions: number;
}
interface AdminWorkspaceRow {
  id: string; name: string; owner_id: string; owner_name: string; owner_github_login: string | null; created_at: string;
  members: number; repositories: number; hosts: number; sessions: number;
}
interface AdminHostRow {
  id: string; name: string; owner_id: string; owner_name: string; owner_github_login: string | null; created_at: string;
  last_seen_at: string | null; revoked_at: string | null; workspaces: number; sessions: number;
}

/** Paired hosts count until they are revoked or removed. */
const liveHost = 'c.revoked_at IS NULL AND c.removed_at IS NULL';

function list<T>(rows: T[]): AdminList<T> {
  return { items: rows.slice(0, adminListLimit), truncated: rows.length > adminListLimit };
}

async function adminUsers(env: Env, userId?: string): Promise<AdminUserRow[]> {
  return env.DB.query<AdminUserRow>(`SELECT u.id, u.github_login, u.display_name, u.created_at, u.suspended_at,
      (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspaces,
      (SELECT COUNT(*) FROM connectors c WHERE c.owner_id = u.id AND ${liveHost}) AS hosts,
      (SELECT COUNT(*) FROM sessions s WHERE s.owner_id = u.id) AS sessions
    FROM users u WHERE (? IS NULL OR u.id = ?) ORDER BY u.created_at DESC, u.id DESC LIMIT ?`)
    .bind(userId ?? null, userId ?? null, adminListLimit + 1).all();
}

function adminUser(admins: Set<string>, row: AdminUserRow): AdminUser {
  return { id: row.id, githubLogin: row.github_login, displayName: row.display_name, createdAt: row.created_at,
    instanceAdmin: admins.has(row.id), suspendedAt: row.suspended_at,
    workspaces: Number(row.workspaces), hosts: Number(row.hosts), sessions: Number(row.sessions) };
}

/** Whether each host has a live, authorized connection, a few at a time like the hosts settings page. */
async function onlineHosts(env: Env, ids: string[]): Promise<Set<string>> {
  const online = new Set<string>();
  const hub = env.CONNECTOR_HUB;
  if (!hub) return online;
  for (let offset = 0; offset < ids.length; offset += 8) {
    await Promise.all(ids.slice(offset, offset + 8).map(async id => {
      try { if (await hub.status(id, 2000)) online.add(id); }
      catch { /* Offline is safe metadata; transport errors are not exposed. */ }
    }));
  }
  return online;
}

async function liveHostIds(env: Env, ownerId?: string): Promise<string[]> {
  return (await env.DB.query<{ id: string }>(`SELECT c.id FROM connectors c WHERE ${liveHost} AND (? IS NULL OR c.owner_id = ?)`)
    .bind(ownerId ?? null, ownerId ?? null).all()).map(row => row.id);
}

async function requireUser(env: Env, userId: string): Promise<void> {
  if (!await env.DB.query('SELECT 1 FROM users WHERE id = ?').bind(userId).first()) fail(404, 'not_found', 'User not found.');
}

export function registerAdmin(app: Hono<WorkerEnv>): void {
  app.use('/api/admin/*', async (c, next) => {
    if (!isInstanceAdmin(c.env, c.get('auth').userId)) fail(403, 'forbidden', 'Instance administrator access is required.');
    await next();
  });
  app.get('/api/admin/overview', async c => {
    const counts = await c.env.DB.query<{ users: number; suspended_users: number; workspaces: number; sessions: number; active_sessions: number }>(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE suspended_at IS NOT NULL) AS suspended_users,
        (SELECT COUNT(*) FROM workspaces) AS workspaces,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM sessions WHERE status <> 'archived') AS active_sessions`).first();
    const hosts = await liveHostIds(c.env);
    const overview: AdminOverview = {
      users: Number(counts?.users ?? 0), suspendedUsers: Number(counts?.suspended_users ?? 0), workspaces: Number(counts?.workspaces ?? 0),
      hosts: hosts.length, onlineHosts: (await onlineHosts(c.env, hosts)).size,
      sessions: Number(counts?.sessions ?? 0), activeSessions: Number(counts?.active_sessions ?? 0),
    };
    return c.json({ overview });
  });
  app.get('/api/admin/users', async c => {
    const admins = instanceAdmins(c.env);
    return c.json(list((await adminUsers(c.env)).map(row => adminUser(admins, row))) satisfies AdminList<AdminUser>);
  });
  app.get('/api/admin/workspaces', async c => {
    const rows = await c.env.DB.query<AdminWorkspaceRow>(`SELECT w.id, w.name, w.owner_id, w.created_at,
        u.display_name AS owner_name, u.github_login AS owner_github_login,
        (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
        (SELECT COUNT(*) FROM workspace_repositories r WHERE r.workspace_id = w.id) AS repositories,
        (SELECT COUNT(*) FROM connector_workspaces cw JOIN connectors c ON c.id = cw.connector_id
          WHERE cw.workspace_id = w.id AND ${liveHost}) AS hosts,
        (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id) AS sessions
      FROM workspaces w JOIN users u ON u.id = w.owner_id ORDER BY w.created_at DESC, w.id DESC LIMIT ?`)
      .bind(adminListLimit + 1).all();
    const workspaces: AdminWorkspace[] = rows.map(row => ({ id: row.id, name: row.name, ownerId: row.owner_id, ownerName: row.owner_name,
      ownerGithubLogin: row.owner_github_login, createdAt: row.created_at, members: Number(row.members),
      repositories: Number(row.repositories), hosts: Number(row.hosts), sessions: Number(row.sessions) }));
    return c.json(list(workspaces) satisfies AdminList<AdminWorkspace>);
  });
  app.get('/api/admin/hosts', async c => {
    const rows = await c.env.DB.query<AdminHostRow>(`SELECT c.id, c.name, c.owner_id, c.created_at, c.last_seen_at, c.revoked_at,
        u.display_name AS owner_name, u.github_login AS owner_github_login,
        (SELECT COUNT(*) FROM connector_workspaces cw WHERE cw.connector_id = c.id) AS workspaces,
        (SELECT COUNT(*) FROM sessions s WHERE s.connector_id = c.id) AS sessions
      FROM connectors c JOIN users u ON u.id = c.owner_id WHERE c.removed_at IS NULL
      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`).bind(adminListLimit + 1).all();
    const shown = rows.slice(0, adminListLimit);
    const online = await onlineHosts(c.env, shown.filter(row => !row.revoked_at).map(row => row.id));
    const hosts: AdminHost[] = rows.map(row => ({ id: row.id, name: row.name, ownerId: row.owner_id, ownerName: row.owner_name,
      ownerGithubLogin: row.owner_github_login, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at,
      online: online.has(row.id), workspaces: Number(row.workspaces), sessions: Number(row.sessions) }));
    return c.json(list(hosts) satisfies AdminList<AdminHost>);
  });
  // Suspending signs the account out everywhere and closes its hosts' connections. While it lasts, sign-in, the
  // account's hosts and every session it owns are refused (see `suspended_at` in auth, sessions and connectors), as
  // though it had left its workspaces; nothing is deleted, so unsuspending restores it as it was.
  app.post('/api/admin/users/:id/suspend', async c => {
    const actor = c.get('auth').userId;
    const userId = userIdentifier(c.req.param('id'));
    // Covers the actor too: administrators are removed from ADMIN_USER_IDS, never locked out from the panel.
    if (isInstanceAdmin(c.env, userId)) fail(409, 'instance_admin', 'Instance administrators can\'t be suspended. Remove them from ADMIN_USER_IDS first.');
    await requireUser(c.env, userId);
    // Only the request that suspends the account records it; any repeat still signs it out again.
    await c.env.DB.batch([
      c.env.DB.query('UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL').bind(now(), userId),
      auditAfterChange(c.env, actor, 'user.suspended', null, { userId }),
      c.env.DB.query('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId),
      c.env.DB.query('DELETE FROM native_auth_codes WHERE user_id = ?').bind(userId),
      c.env.DB.query('DELETE FROM connector_pairings WHERE owner_id = ?').bind(userId),
    ]);
    // Their hosts can't reconnect while the account is suspended; this closes the connections they already have.
    for (const hostId of await liveHostIds(c.env, userId)) await c.env.CONNECTOR_HUB?.revoke(hostId).catch(() => undefined);
    return c.json({ user: adminUser(instanceAdmins(c.env), (await adminUsers(c.env, userId))[0]) });
  });
  app.post('/api/admin/users/:id/unsuspend', async c => {
    const actor = c.get('auth').userId;
    const userId = userIdentifier(c.req.param('id'));
    await requireUser(c.env, userId);
    await c.env.DB.batch([
      c.env.DB.query('UPDATE users SET suspended_at = NULL WHERE id = ? AND suspended_at IS NOT NULL').bind(userId),
      auditAfterChange(c.env, actor, 'user.unsuspended', null, { userId }),
    ]);
    return c.json({ user: adminUser(instanceAdmins(c.env), (await adminUsers(c.env, userId))[0]) });
  });
}
