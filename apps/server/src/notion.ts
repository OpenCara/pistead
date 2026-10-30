import { notionId, notionReadLimits, sourceLimits, sourceReadLimits, type SourceReadEntry } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { accountRejected, clean, json, notFound, outsideSource, rateLimited, upstream, type BoundItem, type DocumentAdapter, type ItemView } from './document-http.js';

/** Notion's REST API with an internal integration secret, which Notion scopes to the pages shared with the integration. */
export const notionApi = 'https://api.notion.com/v1';
export const notionVersion = '2022-06-28';
const share = 'the Notion integration';

type Json = Record<string, unknown>;

/** One Notion call; `missing: 'null'` answers null for an id Notion doesn't have (or one of the other kind). */
async function call(token: string, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, missing: 'fail' | 'null' = 'fail'): Promise<Json | null> {
  const answer = await upstream('Notion', `${notionApi}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': notionVersion, Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (answer.status === 401) accountRejected('Notion');
  if (answer.status === 429) rateLimited('Notion');
  // 404 for pages the integration can't see, 400 for an id of the other kind (a database read as a page).
  if (answer.status === 404 || answer.status === 400 || answer.status === 403) return missing === 'null' ? null : notFound('Notion', share);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Notion could not complete the request. Try again later.');
  return json('Notion', answer);
}

function plain(items: unknown): string {
  return Array.isArray(items) ? items.map(item => typeof (item as Json)?.plain_text === 'string' ? (item as Json).plain_text as string : '').join('') : '';
}

function titleOf(object: Json): string {
  if (object.object === 'database') return clean(plain(object.title), sourceLimits.title) || 'Untitled';
  const properties = object.properties && typeof object.properties === 'object' ? Object.values(object.properties as Json) : [];
  const title = properties.find(property => (property as Json)?.type === 'title') as Json | undefined;
  return clean(plain(title?.title), sourceLimits.title) || 'Untitled';
}

interface NotionObject extends BoundItem { lastEdited: string; parent: Json }

function info(value: Json, type: 'page' | 'database'): NotionObject {
  if (typeof value.id !== 'string') fail(502, 'invalid_source_response', 'Notion returned an unexpected response.');
  const url = typeof value.url === 'string' && /^https:\/\/(www\.)?notion\.so\//.test(value.url) ? value.url.slice(0, 2048) : `https://www.notion.so/${value.id.replace(/-/g, '')}`;
  return { id: value.id, type, title: titleOf(value), url, lastEdited: typeof value.last_edited_time === 'string' ? value.last_edited_time : '',
    parent: value.parent && typeof value.parent === 'object' ? value.parent as Json : {} };
}

async function object(token: string, id: string): Promise<NotionObject> {
  const page = await call(token, `/pages/${id}`, {}, 'null');
  if (page) return info(page, 'page');
  const database = await call(token, `/databases/${id}`, {}, 'null');
  if (database) return info(database, 'database');
  return notFound('Notion', share);
}

/** Requires `target` to be `root` or under it, following Notion's parents (pages, databases, blocks) a bounded way up. */
async function requireUnder(token: string, root: string, target: NotionObject): Promise<void> {
  if (target.id === root) return;
  let parent = target.parent;
  for (let step = 0; step < sourceReadLimits.ancestry; step++) {
    const kind = parent.type;
    const id = typeof kind === 'string' ? parent[kind] : undefined;
    if (typeof id !== 'string' || kind === 'workspace') break;
    if (id === root) return;
    const path = kind === 'page_id' ? `/pages/${id}` : kind === 'database_id' ? `/databases/${id}` : kind === 'block_id' ? `/blocks/${id}` : null;
    if (!path) break;
    const next = await call(token, path, {}, 'null');
    if (!next?.parent || typeof next.parent !== 'object') break;
    parent = next.parent as Json;
  }
  outsideSource();
}

function richText(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return items.map(raw => {
    const item = raw as Json;
    let text = typeof item.plain_text === 'string' ? item.plain_text : '';
    if (!text) return '';
    const notes = (item.annotations && typeof item.annotations === 'object' ? item.annotations : {}) as Json;
    if (notes.code) text = `\`${text}\``;
    if (notes.bold) text = `**${text}**`;
    if (notes.italic) text = `*${text}*`;
    if (notes.strikethrough) text = `~~${text}~~`;
    const href = typeof item.href === 'string' ? item.href : null;
    return href && /^https?:\/\//.test(href) ? `[${text}](${href})` : text;
  }).join('');
}

interface Walk { lines: string[]; blocks: number; bytes: number; truncated: boolean; entries: SourceReadEntry[] }

function push(walk: Walk, line: string): boolean {
  const bytes = Buffer.byteLength(line) + 1;
  if (walk.bytes + bytes > sourceReadLimits.bytes - 8192) { walk.truncated = true; return false; }
  walk.lines.push(line); walk.bytes += bytes;
  return true;
}

/** One block as Markdown, at `indent`; null for a block with nothing to show of its own. */
function blockLine(block: Json, indent: string, number: number): string | null {
  const type = typeof block.type === 'string' ? block.type : '';
  const value = (block[type] && typeof block[type] === 'object' ? block[type] : {}) as Json;
  const text = richText(value.rich_text);
  switch (type) {
    case 'paragraph': return `${indent}${text}`;
    case 'heading_1': return `${indent}# ${text}`;
    case 'heading_2': return `${indent}## ${text}`;
    case 'heading_3': return `${indent}### ${text}`;
    case 'bulleted_list_item': case 'toggle': return `${indent}- ${text}`;
    case 'numbered_list_item': return `${indent}${number}. ${text}`;
    case 'to_do': return `${indent}- [${value.checked ? 'x' : ' '}] ${text}`;
    case 'quote': case 'callout': return `${indent}> ${text}`;
    case 'code': return `${indent}\`\`\`${typeof value.language === 'string' && value.language !== 'plain text' ? value.language : ''}\n${plain(value.rich_text)}\n${indent}\`\`\``;
    case 'equation': return `${indent}$$${typeof value.expression === 'string' ? value.expression : ''}$$`;
    case 'divider': return `${indent}---`;
    case 'bookmark': case 'embed': case 'link_preview': return typeof value.url === 'string' ? `${indent}<${value.url}>` : null;
    case 'image': case 'file': case 'pdf': case 'video': case 'audio': {
      const caption = richText(value.caption);
      // Notion-hosted files come as short-lived signed links; only external links are shown.
      const external = value.type === 'external' && value.external && typeof (value.external as Json).url === 'string' ? (value.external as Json).url as string : null;
      return `${indent}[${type}${caption ? `: ${caption}` : ''}]${external ? `(${external})` : ''}`;
    }
    case 'table_row': return `${indent}| ${(Array.isArray(value.cells) ? value.cells : []).map(cell => richText(cell).replace(/\|/g, '\\|')).join(' | ')} |`;
    case 'child_page': return `${indent}[Page: ${clean(value.title) || 'Untitled'}] (id ${String(block.id)})`;
    case 'child_database': return `${indent}[Database: ${clean(value.title) || 'Untitled'}] (id ${String(block.id)})`;
    case 'link_to_page': {
      const target = (value.page_id ?? value.database_id) as string | undefined;
      return target ? `${indent}[Link to ${value.type === 'database_id' ? 'database' : 'page'}] (id ${target})` : null;
    }
    case 'table': case 'column_list': case 'column': case 'synced_block': case 'template': return null;
    default: return `${indent}[Unsupported Notion block: ${type || 'unknown'}]`;
  }
}

async function walkChildren(token: string, id: string, depth: number, walk: Walk): Promise<void> {
  let cursor: string | null = null;
  let number = 0;
  do {
    const page: Json = (await call(token, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`))!;
    const results = Array.isArray(page.results) ? page.results.filter((item): item is Json => Boolean(item) && typeof item === 'object') : [];
    for (const block of results) {
      if (walk.truncated) return;
      if (++walk.blocks > notionReadLimits.blocks) { walk.truncated = true; return; }
      number = block.type === 'numbered_list_item' ? number + 1 : 0;
      const line = blockLine(block, '  '.repeat(depth), number);
      if (block.type === 'child_page' || block.type === 'child_database') {
        const value = (block[block.type as string] ?? {}) as Json;
        walk.entries.push({ id: String(block.id), type: block.type === 'child_page' ? 'page' : 'database', title: clean(value.title, sourceLimits.title) || 'Untitled' });
      }
      if (line !== null && !push(walk, line)) return;
      // Child pages and databases are read on their own; other blocks' children are part of this page.
      if (block.has_children === true && typeof block.id === 'string' && block.type !== 'child_page' && block.type !== 'child_database') {
        if (depth + 1 >= notionReadLimits.depth) { walk.truncated = true; continue; }
        await walkChildren(token, block.id, depth + 1, walk);
      }
    }
    cursor = page.has_more === true && typeof page.next_cursor === 'string' ? page.next_cursor : null;
  } while (cursor && !walk.truncated);
}

export const notionAdapter: DocumentAdapter = {
  name: 'Notion',
  async connect(input) {
    if (Object.keys(input).some(key => !['provider', 'token'].includes(key))) fail(400, 'invalid_input', 'Only the integration secret is accepted.');
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!/^[A-Za-z0-9_-]{20,500}$/.test(token)) fail(400, 'invalid_source_account', 'Paste a Notion internal integration secret (it starts with ntn_ or secret_).');
    const me = (await call(token, '/users/me'))!;
    const bot = me.bot && typeof me.bot === 'object' ? me.bot as Json : {};
    return { secret: token, name: clean(bot.workspace_name) || clean(me.name) || 'Notion' };
  },
  async resolve(secret, target) {
    const id = notionId(target);
    if (!id) fail(400, 'invalid_source', 'Paste the link of a Notion page or database, or its id.');
    const found = await object(secret, id);
    return { id: found.id, type: found.type, title: found.title, url: found.url };
  },
  async read(secret, root, item): Promise<ItemView> {
    const id = item === null ? root.id : notionId(item);
    if (!id) fail(400, 'invalid_input', 'item must be a Notion page or database id or link.');
    const target = await object(secret, id);
    await requireUnder(secret, root.id, target);
    const base = { id: target.id, type: target.type, title: target.title, url: target.url, lastEdited: target.lastEdited };
    if (target.type === 'page') {
      const walk: Walk = { lines: [], blocks: 0, bytes: 0, truncated: false, entries: [] };
      await walkChildren(secret, target.id, 0, walk);
      return { ...base, content: walk.lines.join('\n'), entries: walk.entries, truncated: walk.truncated };
    }
    const entries: SourceReadEntry[] = [];
    let cursor: string | null = null;
    let truncated = false;
    do {
      const page: Json = (await call(secret, `/databases/${target.id}/query`, { method: 'POST', body: {
        page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }], ...(cursor ? { start_cursor: cursor } : {}),
      } }))!;
      for (const row of Array.isArray(page.results) ? page.results.filter((value): value is Json => Boolean(value) && typeof value === 'object') : []) {
        if (entries.length >= sourceReadLimits.entries) { truncated = true; break; }
        const rowInfo = info(row, 'page');
        entries.push({ id: rowInfo.id, type: 'page', title: rowInfo.title, url: rowInfo.url, lastEdited: rowInfo.lastEdited });
      }
      cursor = !truncated && page.has_more === true && typeof page.next_cursor === 'string' ? page.next_cursor : null;
      if (page.has_more === true && entries.length >= sourceReadLimits.entries) truncated = true;
    } while (cursor);
    return { ...base, entries, truncated };
  },
};
