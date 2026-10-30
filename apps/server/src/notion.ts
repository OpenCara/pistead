import { notionReadLimits, sourceLimits, type NotionObject, type NotionReadView } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { boundedJson } from './github-broker.js';

/**
 * Notion's REST API as one connected account. Every refusal is a fixed, credential-free reason; requests never follow
 * redirects, carry the token only to api.notion.com, and read bounded bodies.
 */
export const notionApi = 'https://api.notion.com/v1';
export const notionVersion = '2022-06-28';
const timeout = 15_000;
const bodyBytes = 1024 * 1024;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(502, 'invalid_notion_response', 'Notion returned an unexpected response.');
  return value as Json;
}

/** One Notion API call. `missing` decides what a 404 (or an id of the wrong kind) means to the caller. */
async function notionCall(token: string, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, missing: 'fail' | 'null' = 'fail'): Promise<Json | null> {
  let response: Response;
  try {
    response = await fetch(`${notionApi}${path}`, {
      method: init.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': notionVersion, Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch { return fail(502, 'notion_unavailable', 'Notion could not be reached. Try again later.'); }
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 401) fail(403, 'notion_account_rejected', 'Notion rejected the connected account. Reconnect Notion in Settings → Profile.');
    if (response.status === 429) fail(429, 'notion_rate_limited', 'Notion is rate limiting this account. Try again shortly.');
    // Notion answers 404 for pages the integration can't see, and 400 for an id of the other kind (a database read as a page).
    if (response.status === 404 || response.status === 400 || response.status === 403) {
      if (missing === 'null') return null;
      fail(404, 'notion_not_found', 'Notion has no such page or database, or it isn\'t shared with the Notion integration.');
    }
    fail(502, 'notion_unavailable', 'Notion could not complete the request. Try again later.');
  }
  try { return record(await boundedJson(response, bodyBytes)); }
  catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    return fail(502, 'invalid_notion_response', 'Notion returned a response too large or malformed to read.');
  }
}

/** Confirms a token works; the name is the integration's Notion workspace, or the integration's own name. */
export async function verifyNotion(token: string): Promise<{ name: string }> {
  const me = (await notionCall(token, '/users/me'))!;
  const bot = me.bot && typeof me.bot === 'object' ? me.bot as Json : {};
  const name = [bot.workspace_name, me.name].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return { name: clean(name ?? 'Notion').slice(0, sourceLimits.title) || 'Notion' };
}

function clean(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}

function plain(items: unknown): string {
  return Array.isArray(items) ? items.map(item => typeof (item as Json)?.plain_text === 'string' ? (item as Json).plain_text as string : '').join('') : '';
}

/** A page's or database's title as Notion shows it. */
function titleOf(object: Json): string {
  if (object.object === 'database') return clean(plain(object.title)).slice(0, sourceLimits.title) || 'Untitled';
  const properties = object.properties && typeof object.properties === 'object' ? Object.values(object.properties as Json) : [];
  const title = properties.find(property => (property as Json)?.type === 'title') as Json | undefined;
  return clean(plain(title?.title)).slice(0, sourceLimits.title) || 'Untitled';
}

export interface NotionObjectInfo { id: string; object: NotionObject; title: string; url: string; lastEdited: string; parent: Json }

function info(value: Json, object: NotionObject): NotionObjectInfo {
  if (typeof value.id !== 'string') fail(502, 'invalid_notion_response', 'Notion returned an unexpected response.');
  const url = typeof value.url === 'string' && /^https:\/\/(www\.)?notion\.so\//.test(value.url) ? value.url.slice(0, 2048) : `https://www.notion.so/${value.id.replace(/-/g, '')}`;
  return { id: value.id, object, title: titleOf(value), url, lastEdited: typeof value.last_edited_time === 'string' ? value.last_edited_time : '',
    parent: value.parent && typeof value.parent === 'object' ? value.parent as Json : {} };
}

/** A page or a database by id: whichever Notion has under it. */
export async function notionObject(token: string, id: string): Promise<NotionObjectInfo> {
  const page = await notionCall(token, `/pages/${id}`, {}, 'null');
  if (page) return info(page, 'page');
  const database = await notionCall(token, `/databases/${id}`, {}, 'null');
  if (database) return info(database, 'database');
  return fail(404, 'notion_not_found', 'Notion has no such page or database, or it isn\'t shared with the Notion integration.');
}

/**
 * Requires `target` to be `root` or under it, following Notion's parents (pages, databases and the blocks between them)
 * at most notionReadLimits.ancestry steps up. A page outside the bound page or database is refused even when the
 * account can read it: the workspace bound only that tree.
 */
export async function requireUnder(token: string, root: string, target: NotionObjectInfo): Promise<void> {
  let parent = target.parent;
  if (target.id === root) return;
  for (let step = 0; step < notionReadLimits.ancestry; step++) {
    const kind = parent.type;
    const id = typeof kind === 'string' ? parent[kind] : undefined;
    if (typeof id !== 'string' || kind === 'workspace') break;
    if (id === root) return;
    const path = kind === 'page_id' ? `/pages/${id}` : kind === 'database_id' ? `/databases/${id}` : kind === 'block_id' ? `/blocks/${id}` : null;
    if (!path) break;
    const next = await notionCall(token, path, {}, 'null');
    if (!next?.parent || typeof next.parent !== 'object') break;
    parent = next.parent as Json;
  }
  fail(403, 'notion_outside_source', 'That page is not under this source, the page or database bound to the workspace.');
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

interface Walk { lines: string[]; blocks: number; bytes: number; truncated: boolean; children: { id: string; object: NotionObject; title: string }[] }

function push(walk: Walk, line: string): boolean {
  const bytes = Buffer.byteLength(line) + 1;
  if (walk.bytes + bytes > notionReadLimits.bytes - 8192) { walk.truncated = true; return false; }
  walk.lines.push(line); walk.bytes += bytes;
  return true;
}

/** One block as Markdown, at `indent`; null for a block with nothing to show. */
function blockLine(block: Json, indent: string, number: number): string | null {
  const type = typeof block.type === 'string' ? block.type : '';
  const value = (block[type] && typeof block[type] === 'object' ? block[type] : {}) as Json;
  const text = richText(value.rich_text);
  switch (type) {
    case 'paragraph': return `${indent}${text}`;
    case 'heading_1': return `${indent}# ${text}`;
    case 'heading_2': return `${indent}## ${text}`;
    case 'heading_3': return `${indent}### ${text}`;
    case 'bulleted_list_item': return `${indent}- ${text}`;
    case 'numbered_list_item': return `${indent}${number}. ${text}`;
    case 'to_do': return `${indent}- [${value.checked ? 'x' : ' '}] ${text}`;
    case 'toggle': return `${indent}- ${text}`;
    case 'quote': return `${indent}> ${text}`;
    case 'callout': return `${indent}> ${text}`;
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
    case 'child_page': return `${indent}[Page: ${clean(String(value.title ?? '')) || 'Untitled'}] (id ${String(block.id)})`;
    case 'child_database': return `${indent}[Database: ${clean(String(value.title ?? '')) || 'Untitled'}] (id ${String(block.id)})`;
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
    const page: Json = (await notionCall(token, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`))!;
    const results = Array.isArray(page.results) ? page.results.map(record) : [];
    for (const block of results) {
      if (walk.truncated) return;
      if (++walk.blocks > notionReadLimits.blocks) { walk.truncated = true; return; }
      number = block.type === 'numbered_list_item' ? number + 1 : 0;
      const line = blockLine(block, '  '.repeat(depth), number);
      if (block.type === 'child_page' || block.type === 'child_database') {
        const value = (block[block.type as string] ?? {}) as Json;
        if (walk.children.length < notionReadLimits.rows) walk.children.push({ id: String(block.id), object: block.type === 'child_page' ? 'page' : 'database',
          title: clean(String(value.title ?? '')).slice(0, sourceLimits.title) || 'Untitled' });
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

/** A page as Markdown with the pages and databases under it, or a database's rows, within notionReadLimits. */
export async function readNotion(token: string, source: string, target: NotionObjectInfo): Promise<NotionReadView> {
  const base = { source, id: target.id, object: target.object, title: target.title, url: target.url, lastEdited: target.lastEdited };
  if (target.object === 'page') {
    const walk: Walk = { lines: [], blocks: 0, bytes: 0, truncated: false, children: [] };
    await walkChildren(token, target.id, 0, walk);
    return { ...base, markdown: walk.lines.join('\n'), children: walk.children, truncated: walk.truncated };
  }
  const rows: NonNullable<NotionReadView['rows']> = [];
  let cursor: string | null = null;
  let truncated = false;
  do {
    const page: Json = (await notionCall(token, `/databases/${target.id}/query`, { method: 'POST', body: {
      page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }], ...(cursor ? { start_cursor: cursor } : {}),
    } }))!;
    for (const row of Array.isArray(page.results) ? page.results.map(record) : []) {
      if (rows.length >= notionReadLimits.rows) { truncated = true; break; }
      const item = info(row, 'page');
      rows.push({ id: item.id, title: item.title, url: item.url, lastEdited: item.lastEdited });
    }
    cursor = !truncated && page.has_more === true && typeof page.next_cursor === 'string' ? page.next_cursor : null;
    if (page.has_more === true && rows.length >= notionReadLimits.rows) truncated = true;
  } while (cursor);
  return { ...base, rows, truncated };
}
