import { hasPermission } from '../../../packages/shared/src/policy.js';
import { webLimits, webSearchCount, webSearchProviders, webSearchQuery, type WebSearchHit, type WebSearchProvider, type WebSearchResult }
  from '../../../packages/shared/src/web.js';
import type { AppContext, Env, SessionRow } from './types.js';
import { auditStatement, sessionAccess } from './db.js';
import { fail, identifier, jsonObject, text, userIdentifier } from './http.js';
import { requireCallbackScope } from './connectors.js';
import { requireToolCall } from './approval-reviews.js';
import { boundedJson } from './github-broker.js';
import { workspaceNetworkPolicy } from './network.js';

/*
 * The agent's web_search tool: the control plane searches with the provider its operator configured (WEB_SEARCH), for
 * a tool call of a write message the requester sent within the last hour, where the session's workspace turned web
 * search on under its network access. The provider's key never leaves the server; hosts and sandboxes see only results.
 */

const SEARCH_TIMEOUT_MS = 20_000;
/** One provider answer; even 20 results with long snippets stay far below this. */
const RESPONSE_BYTES = 2 * 1024 * 1024;

export interface WebSearchBackend {
  name: WebSearchProvider;
  search: (query: string, count: number) => Promise<WebSearchHit[]>;
}

/**
 * The search provider the operator configured: WEB_SEARCH names it (`brave`, `tavily` or `searxng`; unset or `off`: none),
 * WEB_SEARCH_API_KEY holds Brave's or Tavily's key, and WEB_SEARCH_URL a SearXNG instance's origin, with its JSON output
 * on. Anything incomplete counts as none; loadConfig refuses it at start-up.
 */
export function webSearchProvider(env: Env): WebSearchBackend | undefined {
  const name = env.WEB_SEARCH?.trim().toLowerCase();
  if (!name || name === 'off' || !webSearchProviders.includes(name as WebSearchProvider)) return undefined;
  const key = env.WEB_SEARCH_API_KEY?.trim();
  switch (name as WebSearchProvider) {
    case 'brave': return key ? { name: 'brave', search: (query, count) => brave(key, query, count) } : undefined;
    case 'tavily': return key ? { name: 'tavily', search: (query, count) => tavily(key, query, count) } : undefined;
    case 'searxng': {
      const base = searxngBase(env.WEB_SEARCH_URL);
      return base ? { name: 'searxng', search: (query, count) => searxng(base, key, query, count) } : undefined;
    }
  }
}

/** The WEB_SEARCH settings' problem, for loadConfig, or undefined when they are complete (or off). */
export function webSearchConfigurationError(env: Pick<Env, 'WEB_SEARCH' | 'WEB_SEARCH_API_KEY' | 'WEB_SEARCH_URL'>): string | undefined {
  const name = env.WEB_SEARCH?.trim().toLowerCase();
  if (!name || name === 'off') return undefined;
  if (!webSearchProviders.includes(name as WebSearchProvider)) return 'WEB_SEARCH must be "off", "brave", "tavily" or "searxng".';
  if (name === 'searxng') return searxngBase(env.WEB_SEARCH_URL) ? undefined : 'WEB_SEARCH=searxng needs WEB_SEARCH_URL, the origin of a SearXNG instance such as https://search.example.com.';
  return env.WEB_SEARCH_API_KEY?.trim() ? undefined : `WEB_SEARCH=${name} needs WEB_SEARCH_API_KEY, the provider's API key.`;
}

function searxngBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.replace(/\/+$/, '');
  } catch { return undefined; }
}

/** Plain text of a provider's snippet or title: markup and entities out, whitespace collapsed, within `limit`. */
function plain(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  // Cut down first, and a tag never runs past the next `<`: a provider's field costs time in proportion to the limit.
  const textValue = value.slice(0, limit * 4).replace(/<[^<>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[lower] ?? '';
  }).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return textValue.length > limit ? `${textValue.slice(0, limit - 1)}…` : textValue;
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
}

/** A result's URL, only when it is http(s) and within the limit; anything else drops the result. */
function resultUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > webLimits.urlLength) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

function hits(items: unknown, count: number, fields: { title: string; url: string; snippet: string; published?: string }): WebSearchHit[] {
  if (!Array.isArray(items)) return [];
  const results: WebSearchHit[] = [];
  for (const item of items) {
    if (results.length >= count) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = resultUrl(record[fields.url]);
    if (!url) continue;
    const published = fields.published ? plain(record[fields.published], 100) : '';
    results.push({ title: plain(record[fields.title], webLimits.titleLength) || url, url, snippet: plain(record[fields.snippet], webLimits.snippetLength),
      ...(published ? { published } : {}) });
  }
  return results;
}

async function providerJson(provider: WebSearchProvider, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  } catch {
    fail(502, 'web_search_unavailable', `The search provider (${provider}) could not be reached. Try again later.`);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    fail(429, 'web_search_rate_limited', `The search provider (${provider}) is rate limiting searches. Try again later.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(502, 'web_search_failed', `The search provider (${provider}) refused the search (HTTP ${response.status}).`);
  }
  let value: unknown;
  try { value = await boundedJson(response, RESPONSE_BYTES); }
  catch { fail(502, 'web_search_failed', `The search provider (${provider}) sent an answer Pistead could not read.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'web_search_failed', `The search provider (${provider}) sent an answer Pistead could not read.`);
  return value as Record<string, unknown>;
}

async function brave(key: string, query: string, count: number): Promise<WebSearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`;
  const value = await providerJson('brave', url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  const web = value.web && typeof value.web === 'object' ? (value.web as Record<string, unknown>).results : undefined;
  return hits(web, count, { title: 'title', url: 'url', snippet: 'description', published: 'age' });
}

async function tavily(key: string, query: string, count: number): Promise<WebSearchHit[]> {
  const value = await providerJson('tavily', 'https://api.tavily.com/search', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
  });
  return hits(value.results, count, { title: 'title', url: 'url', snippet: 'content', published: 'published_date' });
}

async function searxng(base: string, key: string | undefined, query: string, count: number): Promise<WebSearchHit[]> {
  const value = await providerJson('searxng', `${base}/search?${new URLSearchParams({ q: query, format: 'json' })}`, {
    headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  });
  return hits(value.results, count, { title: 'title', url: 'url', snippet: 'content', published: 'publishedDate' });
}

/**
 * Searches the web for a web_search call of a write message the requester sent within the last hour, where the
 * session's workspace turned web search on. Each search is audited, with its query.
 */
export async function webSearch(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'query', 'count'].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected web search field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  let query: string; let count: number;
  try { query = webSearchQuery(input.query); count = webSearchCount(input.count); }
  catch (error) { fail(400, 'invalid_input', error instanceof Error ? error.message : 'Invalid web search.'); }
  // Every authority check, repeated after the search and before its results leave the control plane.
  const authorize = async (): Promise<SessionRow> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await c.env.DB.query<{ id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>(
      'SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'web_search_not_admitted', 'Web searches need a write message from the requester sent within the last hour.');
    }
    // A one-call grant covers only the search its owner saw: this requester, message and query.
    await requireToolCall(c.env, access.row, 'web_search', { id: callId, requestedBy: actorId, admission, target: query });
    if (!(await workspaceNetworkPolicy(c.env.DB, access.row.workspace_id)).webSearch) {
      fail(403, 'web_search_off', 'Web search is off in this workspace. Its owners and admins turn it on under Settings → Workspaces → the workspace → Network access.');
    }
    return access.row;
  };
  await authorize();
  const provider = webSearchProvider(c.env);
  if (!provider) fail(503, 'web_search_unconfigured', 'This Pistead server has no web search provider: its operator sets one with WEB_SEARCH.');
  const results = await provider.search(query, count);
  const row = await authorize();
  await auditStatement(c.env, actorId, 'web.search', row.workspace_id, sessionId, { provider: provider.name, query, results: results.length }).run();
  return c.json({ query, provider: provider.name, results } satisfies WebSearchResult, 200, { 'Cache-Control': 'private, no-store' });
}
