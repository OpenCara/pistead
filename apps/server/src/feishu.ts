import { createHash } from 'node:crypto';
import { feishuDomains, feishuItem, sourceLimits, sourceReadLimits, type DocumentItemType, type FeishuDomain, type FeishuItem, type SourceReadEntry } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { accountRejected, clean, json, notFound, outsideSource, rateLimited, upstream, type BoundItem, type DocumentAdapter, type ItemView } from './document-http.js';

/**
 * Feishu (open.feishu.cn) or Lark (open.larksuite.com) as a custom app: its owner adds the app to the folders, documents
 * or wiki spaces it may read, and sessions read what is under the bound one with the app's tenant token. The app's
 * secret and tokens never leave the control plane. Docx documents read as plain text; folders and wiki nodes list
 * what is in them. Older docs, sheets, bases and files are listed but not read.
 */
export const feishuOrigins: Record<FeishuDomain, string> = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' };
const share = 'the Feishu/Lark app';
/** A search for an item under the bound folder or wiki node lists at most this many folders or nodes. */
const searchListings = 40;

type Json = Record<string, unknown>;
interface AppSecret { appId: string; appSecret: string; domain: FeishuDomain }

const tokens = new Map<string, { token: string; expires: number }>();

async function tenantToken(secret: string): Promise<string> {
  const cacheKey = createHash('sha256').update(secret).digest('hex');
  const cached = tokens.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.token;
  const app = JSON.parse(secret) as AppSecret;
  const answer = await upstream('Feishu', `${feishuOrigins[app.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
  }, 64 * 1024);
  if (answer.status === 429) rateLimited('Feishu');
  if (answer.status >= 500) fail(502, 'source_unavailable', 'Feishu could not complete the request. Try again later.');
  const body = json('Feishu', answer);
  if (body.code !== 0 || typeof body.tenant_access_token !== 'string') accountRejected('Feishu');
  const lifetime = typeof body.expire === 'number' ? body.expire : 7200;
  if (tokens.size >= 100) tokens.delete(tokens.keys().next().value!);
  tokens.set(cacheKey, { token: body.tenant_access_token, expires: Date.now() + Math.max(0, lifetime - 300) * 1000 });
  return body.tenant_access_token;
}

/** One Feishu API call: its `data`, or null where `missing` is 'null' and Feishu refuses the item. */
async function call(secret: string, path: string, missing: 'fail' | 'null' = 'fail'): Promise<Json | null> {
  const app = JSON.parse(secret) as AppSecret;
  const answer = await upstream('Feishu', `${feishuOrigins[app.domain]}/open-apis${path}`, {
    headers: { Authorization: `Bearer ${await tenantToken(secret)}`, Accept: 'application/json' },
  });
  if (answer.status === 429) rateLimited('Feishu');
  if (answer.status >= 500) fail(502, 'source_unavailable', 'Feishu could not complete the request. Try again later.');
  const body = json('Feishu', answer);
  const code = typeof body.code === 'number' ? body.code : -1;
  if (code === 0) return body.data && typeof body.data === 'object' ? body.data as Json : {};
  // Token and app errors (999916xx), the app lacking a scope, and rate limits; everything else is an item it can't see.
  if (code === 99991400) rateLimited('Feishu');
  if (code === 99991672 || code === 99991679) fail(403, 'source_account_scope', 'The Feishu/Lark app lacks a permission it needs (drive, docx and wiki read). Add it in the developer console and publish a new version.');
  if (code >= 99991600 && code < 99991700) accountRejected('Feishu');
  return missing === 'null' ? null : notFound('Feishu', share);
}

const typeOf: Record<string, DocumentItemType> = { folder: 'folder', docx: 'document', sheet: 'spreadsheet', slides: 'presentation' };

function entryId(type: string, token: string): string {
  return type === 'folder' ? `folder:${token}` : type === 'docx' ? `docx:${token}` : `${type}:${token}`;
}

function siteUrl(app: AppSecret, item: FeishuItem): string {
  const site = app.domain === 'lark' ? 'https://www.larksuite.com' : 'https://www.feishu.cn';
  return `${site}/${item.type === 'folder' ? 'drive/folder' : item.type === 'document' ? 'docx' : 'wiki'}/${item.token}`;
}

function linkOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\/[a-z0-9.-]+\.(feishu\.cn|larksuite\.com)\//.test(value) ? value.slice(0, 2048) : undefined;
}

interface Listing { entries: SourceReadEntry[]; folders: string[]; nodes: { token: string; objToken?: string; objType?: string; hasChild?: boolean }[]; truncated: boolean }

async function folderListing(secret: string, folder: string): Promise<Listing> {
  const listing: Listing = { entries: [], folders: [], nodes: [], truncated: false };
  let pageToken: string | null = null;
  do {
    const data: Json = (await call(secret, `/drive/v1/files?folder_token=${encodeURIComponent(folder)}&page_size=200${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`))!;
    for (const raw of Array.isArray(data.files) ? data.files.filter((item: unknown): item is Json => Boolean(item) && typeof item === 'object') : []) {
      if (typeof raw.token !== 'string' || typeof raw.type !== 'string') continue;
      if (raw.type === 'folder') listing.folders.push(raw.token);
      listing.entries.push({ id: entryId(raw.type, raw.token), type: typeOf[raw.type] ?? 'file', title: clean(raw.name, sourceLimits.title) || 'Untitled',
        ...(linkOf(raw.url) ? { url: linkOf(raw.url) } : {}), ...(typeof raw.modified_time === 'string' ? { lastEdited: raw.modified_time } : {}) });
    }
    pageToken = data.has_more === true && typeof data.next_page_token === 'string' ? data.next_page_token : null;
  } while (pageToken && listing.entries.length < sourceReadLimits.entries);
  listing.truncated = Boolean(pageToken);
  return listing;
}

interface WikiNode { token: string; spaceId: string; objToken: string; objType: string; title: string; hasChild: boolean }

/** A wiki node; `space` is the space it was listed in, for list items that don't repeat their space_id. */
function wikiNode(raw: unknown, space?: string): WikiNode | null {
  const node = raw as Json | null;
  const spaceId = node && typeof node.space_id === 'string' ? node.space_id : space;
  if (!node || typeof node.node_token !== 'string' || !spaceId) return null;
  return { token: node.node_token, spaceId, objToken: typeof node.obj_token === 'string' ? node.obj_token : '', objType: typeof node.obj_type === 'string' ? node.obj_type : '',
    title: clean(node.title, sourceLimits.title) || 'Untitled', hasChild: node.has_child === true };
}

async function getNode(secret: string, token: string): Promise<WikiNode> {
  const data = (await call(secret, `/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`))!;
  return wikiNode(data.node) ?? fail(502, 'invalid_source_response', 'Feishu returned an unexpected response.');
}

async function nodeListing(secret: string, node: WikiNode): Promise<Listing> {
  const listing: Listing = { entries: [], folders: [], nodes: [], truncated: false };
  let pageToken: string | null = null;
  do {
    const data: Json = (await call(secret, `/wiki/v2/spaces/${encodeURIComponent(node.spaceId)}/nodes?parent_node_token=${encodeURIComponent(node.token)}&page_size=50${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`))!;
    for (const raw of Array.isArray(data.items) ? data.items : []) {
      const child = wikiNode(raw, node.spaceId);
      if (!child) continue;
      listing.nodes.push({ token: child.token, objToken: child.objToken, objType: child.objType, hasChild: child.hasChild });
      listing.entries.push({ id: `wiki:${child.token}`, type: 'wiki', title: child.title });
    }
    pageToken = data.has_more === true && typeof data.page_token === 'string' ? data.page_token : null;
  } while (pageToken && listing.entries.length < sourceReadLimits.entries);
  listing.truncated = Boolean(pageToken);
  return listing;
}

/**
 * Requires `target` to be the bound item or under it. Feishu doesn't name a file's parent folder, so this searches down
 * from the bound folder or wiki node, through at most `searchListings` listings.
 */
async function requireUnder(secret: string, root: FeishuItem, target: FeishuItem): Promise<void> {
  if (root.type === target.type && root.token === target.token) return;
  if (root.type === 'document') outsideSource();
  if (root.type === 'folder') {
    if (target.type === 'wiki') outsideSource();
    const queue = [root.token];
    for (let listed = 0; queue.length && listed < searchListings; listed++) {
      const listing = await folderListing(secret, queue.shift()!);
      if (listing.entries.some(entry => entry.id === entryId(target.type === 'document' ? 'docx' : 'folder', target.token))) return;
      queue.push(...listing.folders);
    }
    outsideSource();
  }
  // A wiki node: its descendants, matched by node, or by the document a node holds.
  const queue = [await getNode(secret, root.token)];
  for (let listed = 0; queue.length && listed < searchListings; listed++) {
    const node = queue.shift()!;
    if (!node.hasChild) continue;
    const listing = await nodeListing(secret, node);
    if (listing.nodes.some(child => (target.type === 'wiki' && child.token === target.token) || (target.type === 'document' && child.objType === 'docx' && child.objToken === target.token))) return;
    for (const child of listing.nodes) queue.push({ token: child.token, spaceId: node.spaceId, objToken: child.objToken ?? '', objType: child.objType ?? '', title: '', hasChild: child.hasChild ?? true });
  }
  outsideSource();
}

async function documentText(secret: string, token: string): Promise<{ content: string; truncated: boolean }> {
  const data = (await call(secret, `/docx/v1/documents/${encodeURIComponent(token)}/raw_content`))!;
  return { content: typeof data.content === 'string' ? data.content : '', truncated: false };
}

async function describe(secret: string, item: FeishuItem, link?: string): Promise<BoundItem> {
  const app = JSON.parse(secret) as AppSecret;
  const url = link ?? siteUrl(app, item);
  if (item.type === 'document') {
    const data = (await call(secret, `/docx/v1/documents/${encodeURIComponent(item.token)}`))!;
    const document = (data.document ?? {}) as Json;
    return { id: `docx:${item.token}`, type: 'document', title: clean(document.title, sourceLimits.title) || 'Untitled', url };
  }
  if (item.type === 'folder') {
    const data = (await call(secret, `/drive/explorer/v2/folder/${encodeURIComponent(item.token)}/meta`))!;
    return { id: `folder:${item.token}`, type: 'folder', title: clean(data.name, sourceLimits.title) || 'Untitled', url };
  }
  const node = await getNode(secret, item.token);
  return { id: `wiki:${item.token}`, type: 'wiki', title: node.title, url };
}

function parseBound(id: string): FeishuItem {
  return feishuItem(id) ?? fail(500, 'invalid_source', 'The bound Feishu item is malformed.');
}

export const feishuAdapter: DocumentAdapter = {
  name: 'Feishu / Lark',
  async connect(input) {
    if (Object.keys(input).some(key => !['provider', 'appId', 'appSecret', 'domain'].includes(key))) fail(400, 'invalid_input', 'Only the App ID, App Secret and domain are accepted.');
    const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
    const appSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
    const domain = (input.domain ?? 'feishu') as FeishuDomain;
    if (!/^cli_[A-Za-z0-9]{8,40}$/.test(appId) || !/^[A-Za-z0-9]{16,128}$/.test(appSecret) || !feishuDomains.includes(domain)) {
      fail(400, 'invalid_source_account', 'Paste a Feishu/Lark custom app\'s App ID (cli_…) and App Secret, and choose Feishu or Lark.');
    }
    const secret = JSON.stringify({ appId, appSecret, domain } satisfies AppSecret);
    await tenantToken(secret);
    return { secret, name: `${domain === 'lark' ? 'Lark' : 'Feishu'} app ${appId}` };
  },
  async resolve(secret, target) {
    const item = feishuItem(target);
    if (!item) fail(400, 'invalid_source', 'Paste the link of a Feishu/Lark folder, docx document or wiki page.');
    return describe(secret, item, typeof target === 'string' && /^https:\/\//.test(target.trim()) ? linkOf(target.trim()) : undefined);
  },
  async read(secret, root, raw): Promise<ItemView> {
    const bound = parseBound(root.id);
    const item = raw === null ? bound : feishuItem(raw);
    if (!item) fail(400, 'invalid_input', 'item must be a Feishu/Lark link, or an id from an earlier result (folder:…, docx:… or wiki:…).');
    await requireUnder(secret, bound, item);
    const described = raw === null ? root : await describe(secret, item);
    const base = { id: described.id, type: described.type, title: described.title, url: described.url, lastEdited: '' };
    if (item.type === 'document') return { ...base, ...await documentText(secret, item.token) };
    if (item.type === 'folder') {
      const listing = await folderListing(secret, item.token);
      return { ...base, entries: listing.entries, truncated: listing.truncated };
    }
    const node = await getNode(secret, item.token);
    const listing = node.hasChild ? await nodeListing(secret, node) : { entries: [], truncated: false };
    if (node.objType === 'docx' && node.objToken) return { ...base, ...await documentText(secret, node.objToken), entries: listing.entries, truncated: listing.truncated };
    return { ...base, entries: listing.entries, truncated: listing.truncated,
      ...(node.objType && node.objType !== 'docx' ? { note: `This wiki page holds a ${node.objType}, which can't be read as text.` } : {}) };
  },
};
