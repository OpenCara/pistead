import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { EntryView, SessionView } from '../../../packages/shared/src/types.js';
import type { SessionLink, SharedSession, SharedSessionView } from '../../../packages/shared/src/sharing.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { briefEntry, type ToolOutput } from '../../../packages/shared/src/transcript-display.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, getUser, requireSession, sessionAccess } from './db.js';
import { appOrigin, fail, identifier, now, randomToken } from './http.js';
import { ownerViewRequest, runnerJSON } from './runner.js';
import { requireConnectorSession } from './connectors.js';
import { decryptToken, encryptToken } from './vault.js';

/**
 * Share links: the session owner can let anyone who has a session's link view its shared conversation, read-only and
 * without signing in. A link is a capability for that one read; it never names a user, so it can't ask, write, approve,
 * see side asks or approvals, or reach anything but the transcript. The control plane checks the link, reads the view
 * as the owner (who must still be able to see the session) and passes on only the shared conversation.
 */

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_LINK = 'This share link doesn\'t work. It may have been turned off.';

interface LinkRow { token_hash: string; token_ciphertext: string; created_at: string }

/** The vault's associated data binds each encrypted token to its own session. */
const linkIdentity = (sessionId: string) => `session-link:${sessionId}`;

/** The token rides in the URL fragment, so opening the link sends it to neither the server nor a proxy's access log. */
const linkUrl = (env: Env, token: string) => `${appOrigin(env)}/#/shared/${token}`;

function currentLink(env: Env, sessionId: string): Promise<LinkRow | null> {
  return env.DB.query<LinkRow>('SELECT token_hash, token_ciphertext, created_at FROM session_links WHERE session_id = ?').bind(sessionId).first();
}

export async function isLinkShared(env: Env, sessionId: string): Promise<boolean> {
  return !!await env.DB.query('SELECT 1 FROM session_links WHERE session_id = ?').bind(sessionId).first();
}

async function presentLink(env: Env, sessionId: string, link: LinkRow): Promise<SessionLink> {
  let token: string;
  try {
    token = await decryptToken(env, linkIdentity(sessionId), link.token_ciphertext);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 503) throw error;
    token = '';
  }
  if (!SHARE_TOKEN.test(token) || await sha256(token) !== link.token_hash) {
    fail(500, 'link_unavailable', 'The share link could not be read. Turn link sharing off and on again to get a new link.');
  }
  return { url: linkUrl(env, token), createdAt: link.created_at };
}

/**
 * The session a share token opens, as its owner sees it right now. A link stops working once it's turned off, and while
 * the owner can't see the session themselves (for example after leaving its workspace).
 */
async function linkedSession(env: Env, token: string | undefined): Promise<SessionRow | null> {
  if (!token || !SHARE_TOKEN.test(token)) return null;
  const link = await env.DB.query<{ session_id: string; owner_id: string }>(`SELECT l.session_id, s.owner_id FROM session_links l
    JOIN sessions s ON s.id = l.session_id WHERE l.token_hash = ?`).bind(await sha256(token)).first();
  if (!link) return null;
  return (await sessionAccess(env, link.session_id, link.owner_id))?.row ?? null;
}

async function requireLinkedSession(c: AppContext, token: string | undefined): Promise<SessionRow> {
  const row = await linkedSession(c.env, token);
  // One answer for every missing, malformed, unknown or turned-off link.
  if (!row) fail(404, 'not_found', INVALID_LINK);
  return row;
}

function sharedEntry(entry: EntryView): EntryView {
  const { id, kind, role, text, error, durationMs } = entry;
  return { id, kind, role, text: redactSecrets(text),
    ...(error ? { error: {
      ...(error.provider !== undefined ? { provider: error.provider } : {}),
      ...(error.modelId !== undefined ? { modelId: error.modelId } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
    } } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}) };
}

/**
 * Only the shared conversation, as the session screen shows it: no side asks, approvals or queue, no record of who sent
 * each message, none of the owner's identity beyond their display name, and secrets redacted as in every view. Entries
 * keep only the fields a transcript shows, so nothing a newer runner adds reaches a link without a decision here.
 * It fails closed: an entry shows only when it names a conversation the view lists as the shared one, so a view that
 * drops or mislabels its conversations shows less, never a side ask. A session showing brief tool output shows it here too.
 */
export function sharedView(view: SessionView, toolOutput: ToolOutput = 'full'): SharedSessionView {
  const conversations = Array.isArray(view.conversations) ? view.conversations : [];
  const shared = new Set(conversations.filter(conversation => !!conversation && typeof conversation === 'object' && conversation.mode === 'write')
    .map(conversation => conversation.id));
  const entries = (Array.isArray(view.entries) ? view.entries : [])
    .filter(entry => !!entry && typeof entry === 'object' && typeof entry.conversationId === 'string' && shared.has(entry.conversationId))
    .map(sharedEntry)
    // After redaction, as in the session's own views.
    .map(entry => toolOutput === 'brief' ? briefEntry(entry) : entry);
  return { entries, busy: view.busy === true };
}

/** Public and read-only: register before the cookie authentication every other `/api/*` route requires. */
export function registerSharedSessions(app: Hono<WorkerEnv>): void {
  // The token comes in a header rather than the path, so it stays out of URLs and access logs here too.
  app.get('/api/shared', async c => {
    const row = await requireLinkedSession(c, c.req.header('x-share-token'));
    const owner = await getUser(c.env, row.owner_id);
    if (!owner) fail(404, 'not_found', INVALID_LINK);
    const session: SharedSession = { title: row.title, status: row.status, createdAt: row.created_at, ownerName: owner.display_name };
    return c.json({ session });
  });
  app.get('/api/shared/view', async c => {
    const token = c.req.header('x-share-token');
    const row = await requireLinkedSession(c, token);
    const result = await runnerJSON<{ view: SessionView }>(await ownerViewRequest(c, row));
    if (!result?.view || result.view.sessionId !== row.id || result.view.owner?.id !== row.owner_id) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session binding.');
    // Never answer with a view fetched before the link was turned off or the owner lost access to the session.
    const fresh = await linkedSession(c.env, token);
    if (!fresh || fresh.id !== row.id) fail(404, 'not_found', INVALID_LINK);
    if (fresh.connector_id) await requireConnectorSession(c.env, fresh.connector_id, fresh);
    return c.json({ view: sharedView(result.view, fresh.tool_output === 'brief' ? 'brief' : 'full') });
  });
}

async function requireOwner(c: AppContext, permission: 'read' | 'manage', message: string): Promise<SessionRow> {
  const { row } = await requireSession(c, identifier(c.req.param('id')), permission);
  if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', message);
  return row;
}

/** Share links expose a session beyond its workspace, so only its owner can see, create or turn off its link. */
export function registerSessionLinks(app: Hono<WorkerEnv>): void {
  app.get('/api/sessions/:id/link', async c => {
    const row = await requireOwner(c, 'read', 'Only the session owner can see its share link.');
    const link = await currentLink(c.env, row.id);
    return c.json({ link: link ? await presentLink(c.env, row.id, link) : null });
  });
  // Turning link sharing on is idempotent: while a link exists, everyone asking gets that same link.
  app.put('/api/sessions/:id/link', async c => {
    // A new link is a policy change, so an archived session, which admits only reads, can't get one.
    const row = await requireOwner(c, 'manage', 'Only the session owner can share it by link.');
    const existing = await currentLink(c.env, row.id);
    if (existing) return c.json({ link: await presentLink(c.env, row.id, existing) });
    const token = randomToken();
    const createdAt = now();
    const ciphertext = await encryptToken(c.env, linkIdentity(row.id), token);
    // Admit the link only while the owner still sees the session in the state this request was checked against.
    const created = await c.env.DB.query(`INSERT INTO session_links (session_id, token_hash, token_ciphertext, created_at)
      SELECT id, ?, ?, ? FROM sessions WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> 'archived'
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = sessions.workspace_id AND user_id = sessions.owner_id)
      ON CONFLICT (session_id) DO NOTHING RETURNING session_id`)
      .bind(await sha256(token), ciphertext, createdAt, row.id, row.owner_id, row.policy_version).first();
    if (!created) {
      // A concurrent request turned link sharing on first: answer with its link rather than a second one.
      const raced = await currentLink(c.env, row.id);
      if (raced) return c.json({ link: await presentLink(c.env, row.id, raced) });
      fail(409, 'policy_changed', 'Session membership or status changed; reload and retry.');
    }
    await auditStatement(c.env, row.owner_id, 'session.link.created', row.workspace_id, row.id).run();
    return c.json({ link: { url: linkUrl(c.env, token), createdAt } satisfies SessionLink }, 201);
  });
  // Turning a link off only takes access away, so it also works on an archived session.
  app.delete('/api/sessions/:id/link', async c => {
    const row = await requireOwner(c, 'read', 'Only the session owner can turn off its share link.');
    const removed = await c.env.DB.query('DELETE FROM session_links WHERE session_id = ? RETURNING session_id').bind(row.id).first();
    if (removed) await auditStatement(c.env, row.owner_id, 'session.link.revoked', row.workspace_id, row.id).run();
    return c.json({ ok: true });
  });
}
