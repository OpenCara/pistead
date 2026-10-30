import { sourceLimits, sourceReadLimits, tencentDocsItem, type DocumentItemType, type SourceReadEntry } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { accountRejected, clean, json, notFound, outsideSource, rateLimited, upstream, type BoundItem, type DocumentAdapter, type ItemView } from './document-http.js';
import { docxText } from './office.js';

/**
 * Tencent Docs (docs.qq.com) through its open platform, signed in as the member. UNVERIFIED: the endpoints, fields and
 * codes below were written from memory of the open platform's documentation, without access to it or to the API, and
 * are tested only against a fake. Check them before enabling TENCENT_DOCS_CLIENT_ID in production.
 *
 * Calls carry the access token, the app's client id and the member's open id as headers. Folders list; a document
 * ("doc") is exported to .docx asynchronously and read as its text; other kinds are listed but not read. Tencent Docs
 * names no parent of a file, so "under" searches down from the bound folder, through at most 40 listings.
 */
export const tencentApi = 'https://docs.qq.com/openapi';
const share = 'your Tencent Docs account';
const searchListings = 40;
const exportPolls = 10;
const exportLimit = 8 * 1024 * 1024;

type Json = Record<string, unknown>;
interface Credential { accessToken: string; openId?: string; clientId?: string }

function headers(secret: string): Record<string, string> {
  const credential = JSON.parse(secret) as Credential;
  if (!credential.openId || !credential.clientId) accountRejected('Tencent Docs');
  return { 'Access-Token': credential.accessToken, 'Client-Id': credential.clientId!, 'Open-Id': credential.openId!, Accept: 'application/json' };
}

async function call(secret: string, path: string, init: RequestInit = {}): Promise<Json> {
  const answer = await upstream('Tencent Docs', `${tencentApi}${path}`, { ...init, headers: { ...headers(secret), ...(init.headers ?? {}) } });
  if (answer.status === 401) accountRejected('Tencent Docs');
  if (answer.status === 429) rateLimited('Tencent Docs');
  if (answer.status === 403 || answer.status === 404) notFound('Tencent Docs', share);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Tencent Docs could not complete the request. Try again later.');
  const body = json('Tencent Docs', answer);
  if (body.ret !== 0) notFound('Tencent Docs', share);
  return body.data && typeof body.data === 'object' ? body.data as Json : {};
}

const typeOf: Record<string, DocumentItemType> = { folder: 'folder', doc: 'document', sheet: 'spreadsheet', slide: 'presentation' };

function entryOf(value: Json): (SourceReadEntry & { folder: boolean; raw: string }) | null {
  if (typeof value.ID !== 'string') return null;
  const raw = typeof value.type === 'string' ? value.type : '';
  const folder = raw === 'folder' || value.isFolder === true;
  const url = typeof value.url === 'string' && /^https:\/\/docs\.qq\.com\//.test(value.url) ? value.url.slice(0, 2048) : undefined;
  const modified = typeof value.lastModifyTime === 'number' ? new Date(value.lastModifyTime * 1000).toISOString() : undefined;
  return { id: `${folder ? 'folder' : 'file'}:${value.ID}`, type: folder ? 'folder' : typeOf[raw] ?? 'file', title: clean(value.title, sourceLimits.title) || 'Untitled',
    folder, raw, ...(url ? { url } : {}), ...(modified ? { lastEdited: modified } : {}) };
}

async function listing(secret: string, folder: string): Promise<{ entries: ReturnType<typeof entryOf>[]; truncated: boolean }> {
  const entries: NonNullable<ReturnType<typeof entryOf>>[] = [];
  let start = 0;
  for (let page = 0; page < 10; page++) {
    const data = await call(secret, `/drive/v2/folders/${encodeURIComponent(folder)}?sortType=browse&asc=0&start=${start}&limit=20`);
    for (const value of Array.isArray(data.list) ? data.list.filter((item: unknown): item is Json => Boolean(item) && typeof item === 'object') : []) {
      const entry = entryOf(value);
      if (entry) entries.push(entry);
    }
    const next = typeof data.next === 'number' ? data.next : 0;
    if (!next || next <= start || entries.length >= sourceReadLimits.entries) return { entries, truncated: Boolean(next) && next > start };
    start = next;
  }
  return { entries, truncated: true };
}

async function describe(secret: string, item: { type: 'folder' | 'file'; id: string }): Promise<BoundItem & { raw: string }> {
  const data = await call(secret, `/drive/v2/${item.type === 'folder' ? 'folders' : 'files'}/${encodeURIComponent(item.id)}/metadata`);
  const entry = entryOf({ ...data, ID: typeof data.ID === 'string' ? data.ID : item.id, ...(item.type === 'folder' ? { type: 'folder' } : {}) });
  if (!entry) return fail(502, 'invalid_source_response', 'Tencent Docs returned an unexpected response.');
  return { id: entry.id, type: entry.type, title: entry.title, url: entry.url ?? `https://docs.qq.com/${item.type === 'folder' ? 'desktop/mydoc/folder' : 'doc'}/${item.id}`, raw: entry.raw };
}

async function requireUnder(secret: string, root: { type: 'folder' | 'file'; id: string }, target: { type: 'folder' | 'file'; id: string }): Promise<void> {
  if (root.type === target.type && root.id === target.id) return;
  if (root.type !== 'folder') outsideSource();
  const queue = [root.id];
  const wanted = `${target.type}:${target.id}`;
  for (let listed = 0; queue.length && listed < searchListings; listed++) {
    const { entries } = await listing(secret, queue.shift()!);
    if (entries.some(entry => entry!.id === wanted)) return;
    queue.push(...entries.filter(entry => entry!.folder).map(entry => entry!.id.slice('folder:'.length)));
  }
  outsideSource();
}

/** A document's text: exported to .docx (polling the export a few seconds), downloaded from docs.qq.com's storage, read. */
async function documentText(secret: string, id: string): Promise<{ content?: string; note?: string; truncated: boolean }> {
  const started = await call(secret, `/drive/v2/files/${encodeURIComponent(id)}/async-export`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ exportType: 'docx' }).toString() });
  const operation = typeof started.operationID === 'string' ? started.operationID : '';
  if (!operation) return { note: 'Tencent Docs did not start an export of this document.', truncated: true };
  for (let poll = 0; poll < exportPolls; poll++) {
    const progress = await call(secret, `/drive/v2/files/${encodeURIComponent(id)}/export-progress?operationID=${encodeURIComponent(operation)}`);
    if (progress.progress === 100 && typeof progress.url === 'string') {
      let url: URL;
      try { url = new URL(progress.url); } catch { return fail(502, 'invalid_source_response', 'Tencent Docs returned an unexpected download link.'); }
      if (url.protocol !== 'https:' || !/(^|\.)(qq\.com|myqcloud\.com|gtimg\.com)$/.test(url.hostname)) fail(502, 'invalid_source_response', 'Tencent Docs returned an unexpected download link.');
      const file = await upstream('Tencent Docs', url.href, {}, exportLimit);
      if (file.status !== 200) fail(502, 'source_unavailable', 'Tencent Docs could not download the export. Try again later.');
      const text = file.headers.get('x-pistead-truncated') ? null : docxText(file.bytes);
      return text === null ? { note: 'This document is too large or its export unreadable.', truncated: true } : { content: text, truncated: false };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { note: 'Tencent Docs is still exporting this document. Try again in a moment.', truncated: true };
}

export const tencentDocsAdapter: DocumentAdapter = {
  name: 'Tencent Docs',
  async connect() { return fail(400, 'oauth_required', 'Connect Tencent Docs by signing in to it.'); },
  async resolve(secret, target): Promise<BoundItem> {
    const item = tencentDocsItem(target);
    if (!item) fail(400, 'invalid_source', 'Paste a Tencent Docs link to a folder or document (docs.qq.com/…).');
    const found = await describe(secret, item);
    return { id: found.id, type: found.type, title: found.title, url: found.url };
  },
  async read(secret, root, raw): Promise<ItemView> {
    const bound = tencentDocsItem(root.id) ?? fail(500, 'invalid_source', 'The bound Tencent Docs item is malformed.');
    const item = raw === null ? bound : tencentDocsItem(raw);
    if (!item) fail(400, 'invalid_input', 'item must be a Tencent Docs link, or an id from an earlier result (file:… or folder:…).');
    await requireUnder(secret, bound, item);
    const described = await describe(secret, item);
    const base = { id: described.id, type: described.type, title: described.title, url: described.url, lastEdited: '' };
    if (item.type === 'folder') {
      const { entries, truncated } = await listing(secret, item.id);
      return { ...base, entries: entries.map(entry => ({ id: entry!.id, type: entry!.type, title: entry!.title, ...(entry!.url ? { url: entry!.url } : {}), ...(entry!.lastEdited ? { lastEdited: entry!.lastEdited } : {}) })), truncated };
    }
    if (described.raw !== 'doc') return { ...base, note: `A Tencent Docs ${described.raw || 'file'} can't be read as text yet; only documents are.`, truncated: false };
    return { ...base, ...await documentText(secret, item.id) };
  },
};
