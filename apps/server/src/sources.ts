import type { Hono } from 'hono';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import {
  notionId, notionReadLimits, sourceLimits, validNotionId,
  type GrantSource, type NotionObject, type NotionReadView, type SourceAccountList, type WorkspaceNotionSource, type WorkspaceSourceList,
} from '../../../packages/shared/src/sources.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, requireMember, sessionAccess } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { decryptToken, encryptToken } from './vault.js';
import { requireCallbackScope } from './connectors.js';
import { requireToolCall } from './approval-reviews.js';
import { notionObject, readNotion, requireUnder, verifyNotion } from './notion.js';

/**
 * Workspace sources other than Git repositories (docs/design/external-sources.md): today Notion pages and databases.
 * Owners and admins bind them; every session in the workspace reads them, each with its owner's own Notion account,
 * through the control plane (notion_read). Tokens never reach a host.
 */
interface SourceAccountRow { id: string; user_id: string; provider: 'notion'; ciphertext: string; account_name: string; created_at: string }
interface NotionSourceRow { source_id: string; workspace_id: string; notion_id: string; object: NotionObject; title: string; url: string; created_by: string; created_at: string }

const notionSourceSelect = `SELECT n.*, s.created_at FROM notion_sources n JOIN workspace_sources s ON s.id = n.source_id AND s.kind = 'notion'`;

function publicNotionSource(row: NotionSourceRow): WorkspaceNotionSource {
  return { id: row.source_id, workspaceId: row.workspace_id, kind: 'notion', notionId: row.notion_id, object: row.object, title: row.title, url: row.url, createdAt: row.created_at };
}

export async function workspaceNotionSources(env: Env, workspaceId: string): Promise<WorkspaceNotionSource[]> {
  const rows = await env.DB.query<NotionSourceRow>(`${notionSourceSelect} WHERE n.workspace_id = ? ORDER BY s.created_at, n.source_id`).bind(workspaceId).all();
  return rows.map(publicNotionSource);
}

/** The workspace's non-Git sources as a session's grant lists them. */
export async function grantSources(env: Env, workspaceId: string): Promise<GrantSource[]> {
  return (await workspaceNotionSources(env, workspaceId)).map(source => ({ id: source.id, kind: 'notion', object: source.object, title: source.title }));
}

/** How many sources a workspace has, repositories included. */
export async function workspaceSourceCount(env: Env, workspaceId: string): Promise<number> {
  return Number(await env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM workspace_sources WHERE workspace_id = ?').bind(workspaceId).first('n') ?? 0);
}

interface LoadedNotion { token: string; ciphertext: string; userId: string }

async function loadNotion(env: Env, userId: string): Promise<LoadedNotion | null> {
  const row = await env.DB.query<SourceAccountRow>("SELECT * FROM source_accounts WHERE user_id = ? AND provider = 'notion'").bind(userId).first();
  return row ? { token: await decryptToken(env, userId, row.ciphertext), ciphertext: row.ciphertext, userId } : null;
}

/** The account that was used must still be the connected one before its result leaves the control plane. */
async function recheckNotion(env: Env, account: LoadedNotion): Promise<void> {
  const current = await env.DB.query<{ ciphertext: string }>("SELECT ciphertext FROM source_accounts WHERE user_id = ? AND provider = 'notion'").bind(account.userId).first('ciphertext');
  if (current !== account.ciphertext) fail(403, 'notion_access_changed', 'The Notion connection changed; try again with the current one.');
}

function notionRequired(): never {
  return fail(409, 'notion_account_required', 'Connect Notion in Settings → Profile first.');
}

/** A JSON value cut to fit `notionReadLimits.bytes`: rows and children first, then the page's Markdown. */
function fit(view: NotionReadView): NotionReadView {
  const size = () => Buffer.byteLength(JSON.stringify(view));
  while (size() > notionReadLimits.bytes && (view.rows?.length || view.children?.length)) {
    if (view.rows?.length) view.rows.pop(); else view.children!.pop();
    view.truncated = true;
  }
  if (size() > notionReadLimits.bytes && view.markdown) {
    let markdown = view.markdown;
    while (markdown && Buffer.byteLength(JSON.stringify({ ...view, markdown })) > notionReadLimits.bytes) markdown = markdown.slice(0, Math.floor(markdown.length * 0.9));
    view.markdown = markdown;
    view.truncated = true;
  }
  return view;
}

/**
 * notion_read: a page or database of one of the session's workspace sources, read with the session OWNER's Notion
 * account, within the requester's current write message, like github_read. The target must be the bound page or
 * database or lie under it.
 */
export async function notionRead(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'source', 'page'].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected Notion read field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  const sourceId = identifier(input.source, 'source');
  const page = input.page === undefined ? null : notionId(input.page);
  if (input.page !== undefined && !page) fail(400, 'invalid_input', 'page must be a Notion page or database id or URL.');
  const authorize = async (): Promise<{ row: SessionRow; source: NotionSourceRow }> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await c.env.DB.query<{ id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>(
      'SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'notion_read_not_admitted', 'Notion reads need a write message from the requester sent within the last hour.');
    }
    await requireToolCall(c.env, access.row, 'notion_read', { id: callId, requestedBy: actorId, admission, target: `${sourceId}${page ? `:${page}` : ''}` });
    const source = await c.env.DB.query<NotionSourceRow>(`${notionSourceSelect} WHERE n.source_id = ? AND n.workspace_id = ?`).bind(sourceId, access.row.workspace_id).first();
    if (!source) fail(404, 'source_not_found', 'This workspace has no such Notion source.');
    return { row: access.row, source };
  };
  const { row, source } = await authorize();
  const account = await loadNotion(c.env, row.owner_id);
  if (!account) fail(409, 'notion_account_required', 'The session owner has not connected Notion in Settings → Profile.');
  const target = await notionObject(account.token, page ?? source.notion_id);
  await requireUnder(account.token, source.notion_id, target);
  const view = fit(await readNotion(account.token, source.title, target));
  await recheckNotion(c.env, account);
  await authorize();
  await auditStatement(c.env, actorId, 'notion.read', row.workspace_id, sessionId, { source: source.source_id, page: target.id, object: target.object }).run();
  return c.json(view);
}

export function registerSources(app: Hono<WorkerEnv>): void {
  app.get('/api/source-accounts', async c => {
    const rows = await c.env.DB.query<SourceAccountRow>('SELECT * FROM source_accounts WHERE user_id = ? ORDER BY provider').bind(c.get('auth').userId).all();
    return c.json({ accounts: rows.map(row => ({ provider: row.provider, name: row.account_name, createdAt: row.created_at })) } satisfies SourceAccountList);
  });
  app.put('/api/source-accounts/notion', async c => {
    const actor = c.get('auth').userId;
    const input = await jsonObject(c, 8192);
    if (Object.keys(input).some(key => key !== 'token')) fail(400, 'invalid_input', 'Only the token is accepted.');
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!/^[A-Za-z0-9_-]{20,500}$/.test(token)) fail(400, 'invalid_notion_token', 'Paste a Notion internal integration secret (it starts with ntn_ or secret_).');
    const { name } = await verifyNotion(token);
    const ciphertext = await encryptToken(c.env, actor, token);
    const created = now();
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO source_accounts (id, user_id, provider, ciphertext, account_name, created_at) VALUES (?, ?, 'notion', ?, ?, ?)
        ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, account_name = excluded.account_name, created_at = excluded.created_at`)
        .bind(id(), actor, ciphertext, name, created),
      auditStatement(c.env, actor, 'source_account.connected', null, null, { provider: 'notion', name }),
    ]);
    return c.json({ provider: 'notion', name, createdAt: created });
  });
  app.delete('/api/source-accounts/notion', async c => {
    const actor = c.get('auth').userId;
    await c.env.DB.batch([
      c.env.DB.query("DELETE FROM source_accounts WHERE user_id = ? AND provider = 'notion'").bind(actor),
      auditStatement(c.env, actor, 'source_account.removed', null, null, { provider: 'notion' }),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/workspaces/:id/sources', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ sources: await workspaceNotionSources(c.env, workspaceId) } satisfies WorkspaceSourceList);
  });
  app.post('/api/workspaces/:id/sources', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 8192);
    if (Object.keys(input).some(key => !['kind', 'target'].includes(key))) fail(400, 'invalid_source', 'Only the kind and target are accepted.');
    if (input.kind !== 'notion') fail(400, 'invalid_source', 'Add Git repositories under Repositories; other sources are Notion pages and databases.');
    const notion = notionId(input.target);
    if (!notion) fail(400, 'invalid_source', 'Paste the link of a Notion page or database, or its id.');
    // The admin's own Notion account checks that the page exists and names it; sessions read it with their owners' accounts.
    const account = await loadNotion(c.env, actor) ?? notionRequired();
    const object = await notionObject(account.token, notion);
    if (!validNotionId(object.id)) fail(502, 'invalid_notion_response', 'Notion returned an unexpected response.');
    await recheckNotion(c.env, account);
    const sourceId = id(); const created = now();
    const results = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
        SELECT ?, ?, 'notion', NULL, ? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))
        AND (SELECT COUNT(*) FROM notion_sources WHERE workspace_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM notion_sources WHERE workspace_id = ? AND notion_id = ?) RETURNING id`)
        .bind(sourceId, workspaceId, created, workspaceId, actor, workspaceId, sourceLimits.notion, workspaceId, object.id),
      c.env.DB.query(`INSERT INTO notion_sources (source_id, workspace_id, notion_id, object, title, url, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_sources WHERE id = ?)`)
        .bind(sourceId, workspaceId, object.id, object.object, object.title, object.url, actor, sourceId),
    ]);
    if (!results[0].results[0]) {
      const existing = await c.env.DB.query('SELECT 1 FROM notion_sources WHERE workspace_id = ? AND notion_id = ?').bind(workspaceId, object.id).first();
      if (existing) fail(409, 'source_exists', 'This Notion page or database is already a source of the workspace.');
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      fail(409, 'source_limit', `A workspace has at most ${sourceLimits.notion} Notion sources.`);
    }
    await auditStatement(c.env, actor, 'workspace.source.added', workspaceId, null, { source: sourceId, kind: 'notion', object: object.object, notionId: object.id }).run();
    return c.json({ source: publicNotionSource({ source_id: sourceId, workspace_id: workspaceId, notion_id: object.id, object: object.object,
      title: object.title, url: object.url, created_by: actor, created_at: created }) }, 201);
  });
  app.delete('/api/workspaces/:id/sources/:sourceId', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    const sourceId = identifier(c.req.param('sourceId'), 'sourceId');
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const source = await c.env.DB.query<{ kind: string }>('SELECT kind FROM workspace_sources WHERE id = ? AND workspace_id = ?').bind(sourceId, workspaceId).first();
    if (!source) fail(404, 'not_found', 'Source not found.');
    if (source.kind === 'git') fail(409, 'invalid_source', 'Remove repositories under Repositories.');
    await c.env.DB.batch([
      c.env.DB.query(`DELETE FROM workspace_sources WHERE id = ? AND workspace_id = ? AND kind <> 'git'
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`).bind(sourceId, workspaceId, workspaceId, actor),
      auditStatement(c.env, actor, 'workspace.source.removed', workspaceId, null, { source: sourceId, kind: source.kind }),
    ]);
    return c.json({ ok: true });
  });
}
