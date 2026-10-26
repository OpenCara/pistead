import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assignableWorkspaceRoles, type AssignableWorkspaceRole } from '../../../packages/shared/src/types.js';
import { adminManagedRoles, workspaceManagerRoles } from '../../../packages/shared/src/policy.js';
import { maxPendingMembers, type WorkspaceInvite, type WorkspaceInviteLink, type WorkspaceJoinRequest } from '../../../packages/shared/src/invites.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { auditAfterChange, auditStatement, requireMember } from './db.js';
import { appOrigin, fail, identifier, id, jsonObject, now, randomToken, userIdentifier } from './http.js';
import type { Env, WorkerEnv } from './types.js';
import { decryptToken, encryptToken } from './vault.js';

/**
 * Invite links: a workspace's owner and admins can share one link with anyone. A registered user who opens it while
 * signed in can ask to join, which makes them a pending member: they are not in workspace_members, so they see and do
 * nothing in the workspace until an owner or admin accepts them with a role (or declines them). A link names no user
 * and admits nobody on its own; turning it off stops new requests but leaves the pending ones for a decision.
 */

const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_LINK = 'This invite link doesn\'t work. It may have been turned off or replaced.';
const roleList = (roles: readonly string[]) => roles.map(role => `'${role}'`).join(', ');

interface LinkRow { token_hash: string; token_ciphertext: string; created_at: string }

/** The vault's associated data binds each encrypted token to its own workspace. */
const linkIdentity = (workspaceId: string) => `workspace-invite:${workspaceId}`;

/** The token rides in the URL fragment, so opening the link sends it to neither the server nor a proxy's access log. */
const linkUrl = (env: Env, token: string) => `${appOrigin(env)}/#/join/${token}`;

function currentLink(env: Env, workspaceId: string): Promise<LinkRow | null> {
  return env.DB.query<LinkRow>('SELECT token_hash, token_ciphertext, created_at FROM workspace_invite_links WHERE workspace_id = ?')
    .bind(workspaceId).first();
}

async function presentLink(env: Env, workspaceId: string, link: LinkRow): Promise<WorkspaceInviteLink> {
  let token: string;
  try {
    token = await decryptToken(env, linkIdentity(workspaceId), link.token_ciphertext);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 503) throw error;
    token = '';
  }
  if (!INVITE_TOKEN.test(token) || await sha256(token) !== link.token_hash) {
    fail(500, 'link_unavailable', 'The invite link could not be read. Turn it off and on again to get a new link.');
  }
  return { url: linkUrl(env, token), createdAt: link.created_at };
}

/** The workspace an invite token opens right now, or one answer for every missing, malformed, unknown or turned-off link. */
async function requireInvitedWorkspace(env: Env, token: unknown): Promise<{ id: string; name: string }> {
  if (typeof token !== 'string' || !INVITE_TOKEN.test(token)) fail(404, 'not_found', INVALID_LINK);
  const workspace = await env.DB.query<{ id: string; name: string }>(`SELECT w.id, w.name FROM workspace_invite_links l
    JOIN workspaces w ON w.id = l.workspace_id WHERE l.token_hash = ?`).bind(await sha256(token)).first();
  if (!workspace) fail(404, 'not_found', INVALID_LINK);
  return workspace;
}

async function inviteFor(env: Env, workspace: { id: string; name: string }, userId: string): Promise<WorkspaceInvite> {
  const standing = await env.DB.query<{ member: number; pending: number }>(`SELECT
      EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?) AS member,
      EXISTS (SELECT 1 FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?) AS pending`)
    .bind(workspace.id, userId, workspace.id, userId).first();
  if (Number(standing?.member)) return { workspaceName: workspace.name, status: 'member', workspaceId: workspace.id };
  return { workspaceName: workspace.name, status: Number(standing?.pending) ? 'pending' : 'none' };
}

function joinRequests(env: Env, workspaceId: string) {
  return env.DB.query<WorkspaceJoinRequest>(`SELECT r.user_id AS userId, u.display_name AS displayName,
      u.github_login AS githubLogin, r.created_at AS createdAt
    FROM workspace_join_requests r JOIN users u ON u.id = r.user_id
    WHERE r.workspace_id = ? ORDER BY r.created_at, r.user_id`).bind(workspaceId);
}

const requireManager = (env: Env, workspaceId: string, actorId: string) => requireMember(env, workspaceId, actorId, workspaceManagerRoles);

/** Signed-in routes: register after the cookie authentication and CSRF guard. */
export function registerWorkspaceInvites(app: Hono<WorkerEnv>): void {
  // What the link opens, for the person holding it. The token comes in a header so it stays out of URLs and logs.
  app.get('/api/invite', async c => {
    const workspace = await requireInvitedWorkspace(c.env, c.req.header('x-invite-token'));
    return c.json({ invite: await inviteFor(c.env, workspace, c.get('auth').userId) });
  });

  // Asking to join is idempotent: a member stays a member and a pending member keeps their place in the queue.
  app.post('/api/invite', async c => {
    const body = await jsonObject(c, 1024);
    if (Object.keys(body).some(key => key !== 'token')) fail(400, 'invalid_input', 'Unexpected request field.');
    const workspace = await requireInvitedWorkspace(c.env, body.token);
    const userId = c.get('auth').userId;
    const before = await inviteFor(c.env, workspace, userId);
    if (before.status !== 'none') return c.json({ invite: before });
    const tokenHash = await sha256(body.token as string);
    // Admitted only while this same link is still on, the person isn't a member and the queue has room.
    const result = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO workspace_join_requests (workspace_id, user_id, created_at)
        SELECT l.workspace_id, ?, ? FROM workspace_invite_links l
        WHERE l.workspace_id = ? AND l.token_hash = ?
          AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = l.workspace_id AND m.user_id = ?)
          AND (SELECT COUNT(*) FROM workspace_join_requests r WHERE r.workspace_id = l.workspace_id) < ?
        ON CONFLICT (workspace_id, user_id) DO NOTHING`)
        .bind(userId, now(), workspace.id, tokenHash, userId, maxPendingMembers),
      auditAfterChange(c.env, userId, 'workspace.join.request', workspace.id, { userId }),
    ]);
    if (result[0].changes !== 1) {
      const after = await inviteFor(c.env, workspace, userId);
      if (after.status !== 'none') return c.json({ invite: after });
      if (!await currentLink(c.env, workspace.id).then(link => link?.token_hash === tokenHash)) fail(404, 'not_found', INVALID_LINK);
      fail(409, 'too_many_pending', 'This workspace has too many people waiting to join. Ask an owner or admin to review them first.');
    }
    return c.json({ invite: { workspaceName: workspace.name, status: 'pending' } satisfies WorkspaceInvite }, 201);
  });

  // Withdrawing one's own request.
  app.delete('/api/invite', async c => {
    const workspace = await requireInvitedWorkspace(c.env, c.req.header('x-invite-token'));
    const userId = c.get('auth').userId;
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?').bind(workspace.id, userId),
      auditAfterChange(c.env, userId, 'workspace.join.withdraw', workspace.id, { userId }),
    ]);
    return c.json({ invite: await inviteFor(c.env, workspace, userId) });
  });

  app.get('/api/workspaces/:id/invite-link', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    await requireManager(c.env, workspaceId, c.get('auth').userId);
    const link = await currentLink(c.env, workspaceId);
    return c.json({ link: link ? await presentLink(c.env, workspaceId, link) : null });
  });

  // Turning the link on is idempotent: while a link exists, every owner and admin asking gets that same link.
  app.put('/api/workspaces/:id/invite-link', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireManager(c.env, workspaceId, actorId);
    const existing = await currentLink(c.env, workspaceId);
    if (existing) return c.json({ link: await presentLink(c.env, workspaceId, existing) });
    const token = randomToken();
    const createdAt = now();
    const ciphertext = await encryptToken(c.env, linkIdentity(workspaceId), token);
    // Admit the link only while the actor still manages the workspace.
    const created = await c.env.DB.query(`INSERT INTO workspace_invite_links (workspace_id, token_hash, token_ciphertext, created_by, created_at)
      SELECT workspace_id, ?, ?, user_id, ? FROM workspace_members
      WHERE workspace_id = ? AND user_id = ? AND role IN (${roleList(workspaceManagerRoles)})
      ON CONFLICT (workspace_id) DO NOTHING RETURNING workspace_id`)
      .bind(await sha256(token), ciphertext, createdAt, workspaceId, actorId).first();
    if (!created) {
      // A concurrent request turned the link on first: answer with its link rather than a second one.
      const raced = await currentLink(c.env, workspaceId);
      if (raced) return c.json({ link: await presentLink(c.env, workspaceId, raced) });
      fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    }
    await auditStatement(c.env, actorId, 'workspace.invite_link.created', workspaceId).run();
    return c.json({ link: { url: linkUrl(c.env, token), createdAt } satisfies WorkspaceInviteLink }, 201);
  });

  // Turning the link off stops new requests at once; people already waiting stay pending for a decision.
  app.delete('/api/workspaces/:id/invite-link', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const actorId = c.get('auth').userId;
    await requireManager(c.env, workspaceId, actorId);
    const removed = await c.env.DB.query('DELETE FROM workspace_invite_links WHERE workspace_id = ? RETURNING workspace_id').bind(workspaceId).first();
    if (removed) await auditStatement(c.env, actorId, 'workspace.invite_link.revoked', workspaceId).run();
    return c.json({ ok: true });
  });

  app.get('/api/workspaces/:id/join-requests', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    await requireManager(c.env, workspaceId, c.get('auth').userId);
    return c.json({ requests: await joinRequests(c.env, workspaceId).all() });
  });

  // Accepting makes a pending member a member with the role chosen here; admins assign the roles below their own.
  app.post('/api/workspaces/:id/join-requests/:userId/accept', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    const body = await jsonObject(c, 1024);
    if (Object.keys(body).some(key => key !== 'role')) fail(400, 'invalid_input', 'Unexpected request field.');
    const role = body.role;
    if (typeof role !== 'string' || !(assignableWorkspaceRoles as readonly string[]).includes(role)) fail(400, 'invalid_input', 'Invalid role.');
    const actor = await requireManager(c.env, workspaceId, actorId);
    if (actor.role !== 'owner' && !adminManagedRoles.includes(role as AssignableWorkspaceRole)) {
      fail(403, 'forbidden', 'Only the workspace owner can make someone an administrator.');
    }
    const auditId = id();
    const result = await c.env.DB.batch([
      // From the pending request only, by an actor who still holds the authority checked above.
      c.env.DB.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
        SELECT r.workspace_id, r.user_id, ?, ?
        FROM workspace_join_requests r
        INNER JOIN workspaces w ON w.id = r.workspace_id
        INNER JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = ?
        WHERE r.workspace_id = ? AND r.user_id = ? AND r.user_id <> w.owner_id
          AND ((actor.role = 'owner' AND actor.user_id = w.owner_id)
            OR (actor.role = 'admin' AND ? IN (${roleList(adminManagedRoles)})))
        ON CONFLICT (workspace_id, user_id) DO NOTHING`)
        .bind(role, now(), actorId, workspaceId, targetId, role),
      auditAfterChange(c.env, actorId, 'workspace.join.accept', workspaceId, { userId: targetId, role }, auditId),
      c.env.DB.query(`DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM audit WHERE id = ?)`).bind(workspaceId, targetId, auditId),
    ]);
    if (result[0].changes !== 1) {
      const pending = await c.env.DB.query('SELECT 1 FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, targetId).first();
      if (!pending) fail(404, 'not_found', 'This person is no longer waiting to join.');
      fail(409, 'membership_changed', 'Membership changed. Refresh and try again.');
    }
    return c.json({ requests: await joinRequests(c.env, workspaceId).all() });
  });

  app.delete('/api/workspaces/:id/join-requests/:userId', async c => {
    const workspaceId = identifier(c.req.param('id'), 'workspaceId');
    const targetId = userIdentifier(c.req.param('userId'));
    const actorId = c.get('auth').userId;
    await requireManager(c.env, workspaceId, actorId);
    const result = await c.env.DB.batch([
      c.env.DB.query(`DELETE FROM workspace_join_requests WHERE workspace_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM workspace_members actor WHERE actor.workspace_id = ? AND actor.user_id = ?
          AND actor.role IN (${roleList(workspaceManagerRoles)}))`).bind(workspaceId, targetId, workspaceId, actorId),
      auditAfterChange(c.env, actorId, 'workspace.join.decline', workspaceId, { userId: targetId }),
    ]);
    if (result[0].changes !== 1) fail(404, 'not_found', 'This person is no longer waiting to join.');
    return c.json({ requests: await joinRequests(c.env, workspaceId).all() });
  });
}
