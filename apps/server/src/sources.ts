import type { Hono } from 'hono';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import {
  documentKind, documentKindNames, secretKinds, sourceLimits, validSourceItem,
  type DocumentItemType, type DocumentKind, type GrantSource, type SourceAccountList, type SourceReadView, type WorkspaceDocumentSource, type WorkspaceSourceList,
} from '../../../packages/shared/src/sources.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { auditStatement, requireMember, sessionAccess } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { decryptToken, encryptToken } from './vault.js';
import { requireCallbackScope } from './connectors.js';
import { requireToolCall } from './approval-reviews.js';
import { fit, type DocumentAdapter } from './document-http.js';
import { notionAdapter } from './notion.js';
import { googleDriveAdapter } from './google-drive.js';
import { feishuAdapter } from './feishu.js';
import { dropboxAdapter } from './dropbox.js';
import { onedriveAdapter } from './onedrive.js';
import { tencentDocsAdapter } from './tencent-docs.js';
import { configuredOAuth, refreshedSecret, type OAuthSecret } from './source-oauth.js';

/**
 * Workspace sources other than Git repositories (docs/design/external-sources.md): Notion pages and databases, Google
 * Drive folders and files, Feishu/Lark folders, documents and wiki pages. Owners and admins bind them; every session in
 * the workspace reads them, each with its owner's own connected account of that kind, through the control plane
 * (source_read). Secrets never reach a host.
 */
export const documentAdapters: Record<DocumentKind, DocumentAdapter> = {
  notion: notionAdapter, 'google-drive': googleDriveAdapter, feishu: feishuAdapter, dropbox: dropboxAdapter, onedrive: onedriveAdapter, 'tencent-docs': tencentDocsAdapter,
};

interface SourceAccountRow { id: string; user_id: string; provider: DocumentKind; ciphertext: string; account_name: string; method: 'secret' | 'oauth'; created_at: string }
interface DocumentSourceRow { source_id: string; workspace_id: string; kind: DocumentKind; item_id: string; item_type: DocumentItemType; title: string; url: string; created_by: string; created_at: string }

const documentSourceSelect = `SELECT d.*, s.created_at FROM document_sources d JOIN workspace_sources s ON s.id = d.source_id AND s.kind = d.kind`;

function publicSource(row: DocumentSourceRow): WorkspaceDocumentSource {
  return { id: row.source_id, workspaceId: row.workspace_id, kind: row.kind, itemId: row.item_id, itemType: row.item_type, title: row.title, url: row.url, createdAt: row.created_at };
}

export async function workspaceDocumentSources(env: Env, workspaceId: string): Promise<WorkspaceDocumentSource[]> {
  const rows = await env.DB.query<DocumentSourceRow>(`${documentSourceSelect} WHERE d.workspace_id = ? ORDER BY s.created_at, d.source_id`).bind(workspaceId).all();
  return rows.map(publicSource);
}

/** The workspace's document sources as a session's grant lists them. */
export async function grantSources(env: Env, workspaceId: string): Promise<GrantSource[]> {
  return (await workspaceDocumentSources(env, workspaceId)).map(source => ({ id: source.id, kind: source.kind, type: source.itemType, title: source.title }));
}

interface LoadedAccount { secret: string; ciphertext: string; userId: string; provider: DocumentKind; method: 'secret' | 'oauth' }

async function loadAccount(env: Env, userId: string, provider: DocumentKind): Promise<LoadedAccount | null> {
  const row = await env.DB.query<SourceAccountRow>('SELECT * FROM source_accounts WHERE user_id = ? AND provider = ?').bind(userId, provider).first();
  return row ? { secret: await decryptToken(env, userId, row.ciphertext), ciphertext: row.ciphertext, userId, provider, method: row.method } : null;
}

/**
 * What an adapter gets: a pasted secret as it is, or for a sign-in only a current access token (refreshed here, and
 * stored again, when it is about to expire). The refresh token never reaches an adapter. A refresh that races another
 * keeps whichever was stored first, so the account the read uses is always the stored one.
 */
async function adapterSecret(env: Env, account: LoadedAccount): Promise<{ account: LoadedAccount; secret: string }> {
  if (account.method !== 'oauth') return { account, secret: account.secret };
  let stored = JSON.parse(account.secret) as OAuthSecret;
  const fresh = await refreshedSecret(env, account.provider, stored);
  if (fresh) {
    const plaintext = JSON.stringify(fresh);
    const ciphertext = await encryptToken(env, account.userId, plaintext);
    const updated = await env.DB.query('UPDATE source_accounts SET ciphertext = ? WHERE user_id = ? AND provider = ? AND ciphertext = ? RETURNING id')
      .bind(ciphertext, account.userId, account.provider, account.ciphertext).first();
    if (updated) { account = { ...account, secret: plaintext, ciphertext }; stored = fresh; }
    else {
      const current = await loadAccount(env, account.userId, account.provider);
      if (!current || current.method !== 'oauth') fail(403, 'source_access_changed', 'The connected account changed; try again with the current one.');
      account = current; stored = JSON.parse(current.secret) as OAuthSecret;
    }
  }
  const clientId = account.provider === 'tencent-docs' ? env.TENCENT_DOCS_CLIENT_ID : undefined;
  return { account, secret: JSON.stringify({ mode: 'oauth', accessToken: stored.accessToken, ...(stored.openId ? { openId: stored.openId } : {}), ...(clientId ? { clientId } : {}) }) };
}

/** The account that was used must still be the connected one before its result leaves the control plane. */
async function recheckAccount(env: Env, account: LoadedAccount): Promise<void> {
  const current = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM source_accounts WHERE user_id = ? AND provider = ?')
    .bind(account.userId, account.provider).first('ciphertext');
  if (current !== account.ciphertext) fail(403, 'source_access_changed', 'The connected account changed; try again with the current one.');
}

function providerParam(value: string | undefined): DocumentKind {
  return documentKind(value) ? value : fail(404, 'not_found', 'No such kind of connected account.');
}

/**
 * source_read: an item of one of the session's workspace sources, read with the session OWNER's account of that kind,
 * within the requester's current write message, like github_read. The item must be the bound one or lie under it.
 */
export async function sourceRead(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 8192);
  if (Object.keys(input).some(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'source', 'item'].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected source read field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  const sourceId = identifier(input.source, 'source');
  if (input.item !== undefined && !validSourceItem(input.item)) fail(400, 'invalid_input', 'item must be an id or link of one line.');
  const item = input.item === undefined ? null : (input.item as string).trim();
  const authorize = async (): Promise<{ row: SessionRow; source: DocumentSourceRow }> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await c.env.DB.query<{ id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>(
      'SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'source_read_not_admitted', 'Source reads need a write message from the requester sent within the last hour.');
    }
    // The target a one-call permission card showed: the source and the item exactly as the agent passed it.
    await requireToolCall(c.env, access.row, 'source_read', { id: callId, requestedBy: actorId, admission, target: item === null ? sourceId : `${sourceId}: ${item}` });
    const source = await c.env.DB.query<DocumentSourceRow>(`${documentSourceSelect} WHERE d.source_id = ? AND d.workspace_id = ?`).bind(sourceId, access.row.workspace_id).first();
    if (!source) fail(404, 'source_not_found', 'This workspace has no such source, or it is a repository (clone those with Git).');
    return { row: access.row, source };
  };
  const { row, source } = await authorize();
  const adapter = documentAdapters[source.kind];
  const loaded = await loadAccount(c.env, row.owner_id, source.kind);
  if (!loaded) fail(409, 'source_account_required', `The session owner has not connected ${adapter.name} in Settings → Profile → Connected accounts.`);
  const { account, secret } = await adapterSecret(c.env, loaded);
  const read = await adapter.read(secret, { id: source.item_id, type: source.item_type, title: source.title, url: source.url }, item);
  const view = fit<SourceReadView>({ source: source.title, kind: source.kind, ...read });
  await recheckAccount(c.env, account);
  await authorize();
  await auditStatement(c.env, actorId, 'source.read', row.workspace_id, sessionId, { source: source.source_id, kind: source.kind, item: view.id, type: view.type }).run();
  return c.json(view);
}

export function registerSources(app: Hono<WorkerEnv>): void {
  app.get('/api/source-accounts', async c => {
    const rows = await c.env.DB.query<SourceAccountRow>('SELECT * FROM source_accounts WHERE user_id = ? ORDER BY provider').bind(c.get('auth').userId).all();
    return c.json({ accounts: rows.map(row => ({ provider: row.provider, method: row.method, name: row.account_name, createdAt: row.created_at })),
      oauth: configuredOAuth(c.env) } satisfies SourceAccountList);
  });
  app.put('/api/source-accounts/:provider', async c => {
    const actor = c.get('auth').userId;
    const provider = providerParam(c.req.param('provider'));
    if (!secretKinds.includes(provider)) fail(400, 'oauth_required', `Connect ${documentKindNames[provider]} by signing in to it.`);
    const input = await jsonObject(c, 16384);
    // The adapter verifies what was pasted with its provider and keeps only what reads need.
    const { secret, name } = await documentAdapters[provider].connect(input);
    const ciphertext = await encryptToken(c.env, actor, secret);
    const created = now();
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO source_accounts (id, user_id, provider, ciphertext, account_name, method, created_at) VALUES (?, ?, ?, ?, ?, 'secret', ?)
        ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, account_name = excluded.account_name, method = 'secret', created_at = excluded.created_at`)
        .bind(id(), actor, provider, ciphertext, name.slice(0, sourceLimits.title), created),
      auditStatement(c.env, actor, 'source_account.connected', null, null, { provider, name }),
    ]);
    return c.json({ provider, method: 'secret', name, createdAt: created });
  });
  app.delete('/api/source-accounts/:provider', async c => {
    const actor = c.get('auth').userId;
    const provider = providerParam(c.req.param('provider'));
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM source_accounts WHERE user_id = ? AND provider = ?').bind(actor, provider),
      auditStatement(c.env, actor, 'source_account.removed', null, null, { provider }),
    ]);
    return c.json({ ok: true });
  });

  app.get('/api/workspaces/:id/sources', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ sources: await workspaceDocumentSources(c.env, workspaceId) } satisfies WorkspaceSourceList);
  });
  app.post('/api/workspaces/:id/sources', async c => {
    const workspaceId = identifier(c.req.param('id')); const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 8192);
    if (Object.keys(input).some(key => !['kind', 'target'].includes(key))) fail(400, 'invalid_source', 'Only the kind and target are accepted.');
    if (!documentKind(input.kind)) fail(400, 'invalid_source', 'Add Git repositories under Repositories; other sources are documents: Notion, Google Drive, Feishu/Lark, Dropbox, OneDrive or Tencent Docs.');
    const kind = input.kind;
    const adapter = documentAdapters[kind];
    // The admin's own account checks the item and names it; sessions read it with their owners' accounts.
    const loaded = await loadAccount(c.env, actor, kind) ?? fail(409, 'source_account_required', `Connect ${adapter.name} in Settings → Profile → Connected accounts first.`);
    const { account, secret } = await adapterSecret(c.env, loaded);
    const item = await adapter.resolve(secret, input.target);
    await recheckAccount(c.env, account);
    const sourceId = id(); const created = now();
    const limit = () => fail(409, 'source_limit', `A workspace has at most ${sourceLimits.documents} sources besides its repositories.`);
    // The count below keeps a lone admin within the limit; the database's trigger keeps concurrent adds within it too.
    const results = await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
        SELECT ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))
        AND (SELECT COUNT(*) FROM document_sources WHERE workspace_id = ?) < ?
        AND NOT EXISTS (SELECT 1 FROM document_sources WHERE workspace_id = ? AND kind = ? AND item_id = ?) RETURNING id`)
        .bind(sourceId, workspaceId, kind, created, workspaceId, actor, workspaceId, sourceLimits.documents, workspaceId, kind, item.id),
      c.env.DB.query(`INSERT INTO document_sources (source_id, workspace_id, kind, item_id, item_type, title, url, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_sources WHERE id = ?)`)
        .bind(sourceId, workspaceId, kind, item.id, item.type, item.title, item.url, actor, sourceId),
    ]).catch((error: unknown) => { if (/document source limit/.test(String(error instanceof Error ? error.message : error))) limit(); throw error; });
    if (!results[0].results[0]) {
      const existing = await c.env.DB.query('SELECT 1 FROM document_sources WHERE workspace_id = ? AND kind = ? AND item_id = ?').bind(workspaceId, kind, item.id).first();
      if (existing) fail(409, 'source_exists', 'This item is already a source of the workspace.');
      await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
      limit();
    }
    await auditStatement(c.env, actor, 'workspace.source.added', workspaceId, null, { source: sourceId, kind, type: item.type, item: item.id }).run();
    return c.json({ source: publicSource({ source_id: sourceId, workspace_id: workspaceId, kind, item_id: item.id, item_type: item.type,
      title: item.title, url: item.url, created_by: actor, created_at: created }) }, 201);
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
