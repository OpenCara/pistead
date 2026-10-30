import { dropboxItem, sourceLimits, sourceReadLimits, type DocumentItemType, type SourceReadEntry } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { accountRejected, clean, json, notFound, outsideSource, rateLimited, textBody, upstream, type BoundItem, type DocumentAdapter, type ItemView, type Upstream } from './document-http.js';
import { docxFile, docxText, textFile } from './office.js';

/**
 * Dropbox, signed in as its member (files.metadata.read, files.content.read, sharing.read). A bound folder or file is
 * kept by its id; "under" compares Dropbox paths, read again by id on every read so a move doesn't break it. Paper
 * documents export as Markdown, .docx files as their text, text files as they are; folders list.
 */
export const dropboxApi = 'https://api.dropboxapi.com/2';
export const dropboxContent = 'https://content.dropboxapi.com/2';
const share = 'your Dropbox account (add shared folders to your Dropbox)';
const textLimit = 512 * 1024;

type Json = Record<string, unknown>;

function token(secret: string): string {
  return (JSON.parse(secret) as { accessToken: string }).accessToken;
}

function refused(answer: Upstream): void {
  if (answer.status === 401) accountRejected('Dropbox');
  if (answer.status === 429) rateLimited('Dropbox');
  // 409 is Dropbox's "path not found", "restricted" and the like; 400 a malformed path.
  if (answer.status === 409 || answer.status === 400 || answer.status === 403 || answer.status === 404) notFound('Dropbox', share);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Dropbox could not complete the request. Try again later.');
}

async function rpc(secret: string, path: string, body: unknown): Promise<Json> {
  const answer = await upstream('Dropbox', `${dropboxApi}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token(secret)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  refused(answer);
  return json('Dropbox', answer);
}

/** A content endpoint (download, export): its argument travels in a header, as ASCII-only JSON. */
async function content(secret: string, path: string, argument: Json): Promise<Upstream> {
  const header = JSON.stringify(argument).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const answer = await upstream('Dropbox', `${dropboxContent}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token(secret)}`, 'Dropbox-API-Arg': header } }, textLimit);
  refused(answer);
  return answer;
}

interface Entry { id: string; type: DocumentItemType; folder: boolean; title: string; path: string; display: string; lastEdited: string; exportable: boolean }

function entry(value: Json): Entry {
  const tag = value['.tag'];
  if (typeof value.id !== 'string' || (tag !== 'file' && tag !== 'folder')) fail(502, 'invalid_source_response', 'Dropbox returned an unexpected response.');
  const display = typeof value.path_display === 'string' ? value.path_display : '';
  return { id: value.id, folder: tag === 'folder', type: tag === 'folder' ? 'folder' : 'file', title: clean(value.name, sourceLimits.title) || 'Untitled',
    path: typeof value.path_lower === 'string' ? value.path_lower : '', display, lastEdited: typeof value.server_modified === 'string' ? value.server_modified : '',
    exportable: Boolean(value.export_info) };
}

function url(item: Entry): string {
  return item.display ? `https://www.dropbox.com/home${item.display.split('/').map(encodeURIComponent).join('/')}` : 'https://www.dropbox.com/home';
}

async function metadata(secret: string, item: { path: string } | { url: string }): Promise<Entry> {
  const found = entry('url' in item ? await rpc(secret, '/sharing/get_shared_link_metadata', { url: item.url }) : await rpc(secret, '/files/get_metadata', { path: item.path }));
  // A shared link to something outside the member's Dropbox has no path, so nothing can be under it.
  if (!found.path) fail(409, 'source_not_in_account', 'Add this shared item to your Dropbox first; Pistead reads Dropbox items by their place in your account.');
  return found;
}

export const dropboxAdapter: DocumentAdapter = {
  name: 'Dropbox',
  async connect() { return fail(400, 'oauth_required', 'Connect Dropbox by signing in to it.'); },
  async resolve(secret, target): Promise<BoundItem> {
    const item = dropboxItem(target);
    if (!item) fail(400, 'invalid_source', 'Paste a Dropbox folder or file link, or its path in your Dropbox (/Specs).');
    const found = await metadata(secret, item);
    return { id: found.id, type: found.type, title: found.title, url: url(found) };
  },
  async read(secret, root, raw): Promise<ItemView> {
    const item = raw === null ? { path: root.id } : dropboxItem(raw);
    if (!item) fail(400, 'invalid_input', 'item must be a Dropbox id (id:…), a path, or a dropbox.com link.');
    const bound = await metadata(secret, { path: root.id });
    const target = raw === null ? bound : await metadata(secret, item);
    if (target.path !== bound.path && !(bound.folder && target.path.startsWith(`${bound.path}/`))) outsideSource();
    const base = { id: target.id, type: target.type, title: target.title, url: url(target), lastEdited: target.lastEdited };
    if (target.folder) {
      const entries: SourceReadEntry[] = [];
      let page = await rpc(secret, '/files/list_folder', { path: target.id, limit: 200 });
      for (;;) {
        for (const value of Array.isArray(page.entries) ? page.entries.filter((item: unknown): item is Json => Boolean(item) && typeof item === 'object') : []) {
          if (value['.tag'] !== 'file' && value['.tag'] !== 'folder') continue;
          const child = entry(value);
          entries.push({ id: child.id, type: child.type, title: child.title, url: url(child), ...(child.lastEdited ? { lastEdited: child.lastEdited } : {}) });
        }
        if (page.has_more !== true || typeof page.cursor !== 'string' || entries.length >= sourceReadLimits.entries) break;
        page = await rpc(secret, '/files/list_folder/continue', { cursor: page.cursor });
      }
      return { ...base, entries: entries.slice(0, sourceReadLimits.entries), truncated: page.has_more === true || entries.length > sourceReadLimits.entries };
    }
    if (target.exportable) {
      const body = textBody(await content(secret, '/files/export', { path: target.id, export_format: 'markdown' }));
      return { ...base, type: 'document', content: body.text, truncated: body.truncated };
    }
    const isDocx = docxFile.name.test(target.title);
    if (!isDocx && !textFile.names.test(target.title)) return { ...base, note: 'A binary file can\'t be read as text.', truncated: false };
    const answer = await content(secret, '/files/download', { path: target.id });
    if (isDocx) {
      const text = answer.headers.get('x-pistead-truncated') ? null : docxText(answer.bytes);
      return text === null ? { ...base, note: 'This Word document is too large or unreadable.', truncated: true } : { ...base, type: 'document', content: text, truncated: false };
    }
    const body = textBody(answer);
    return { ...base, content: body.text, truncated: body.truncated };
  },
};
