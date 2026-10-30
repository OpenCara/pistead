import type { DocumentItemType, SourceReadEntry, SourceReadView } from '../../../packages/shared/src/sources.js';
import { sourceReadLimits } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';

/**
 * Calls to document providers (Notion, Google, Feishu/Lark) as one connected account. Requests never follow redirects
 * and read bounded bodies; adapters send credentials only to their provider's fixed API origin and turn every refusal
 * into a fixed, credential-free reason.
 */
export interface Upstream { status: number; headers: Headers; bytes: Uint8Array }

const timeout = 15_000;

export async function upstream(provider: string, url: string, init: RequestInit = {}, limit = 1024 * 1024): Promise<Upstream> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) }); }
  catch { return fail(502, 'source_unavailable', `${provider} could not be reached. Try again later.`); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.byteLength > limit) {
        chunks.push(part.value.subarray(0, limit - size)); size = limit; cut = true;
        await reader.cancel().catch(() => {});
        break;
      }
      size += part.value.byteLength;
      chunks.push(part.value);
    }
  } catch { return fail(502, 'source_unavailable', `${provider} could not complete the request. Try again later.`); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(response.headers);
  if (cut) headers.set('x-pistead-truncated', '1');
  return { status: response.status, headers, bytes };
}

/** A successful JSON answer as an object; an oversized or malformed one is a fixed refusal. */
export function json(provider: string, answer: Upstream): Record<string, unknown> {
  if (answer.headers.get('x-pistead-truncated')) fail(502, 'invalid_source_response', `${provider} returned a response too large to read.`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.bytes)); }
  catch { return fail(502, 'invalid_source_response', `${provider} returned a malformed response.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'invalid_source_response', `${provider} returned an unexpected response.`);
  return value as Record<string, unknown>;
}

/** A text body, decoded leniently, and whether it was cut at the read limit. */
export function textBody(answer: Upstream): { text: string; truncated: boolean } {
  return { text: new TextDecoder('utf-8').decode(answer.bytes), truncated: answer.headers.get('x-pistead-truncated') === '1' };
}

export function clean(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max) : '';
}

export function notFound(provider: string, shareWith: string): never {
  return fail(404, 'source_item_not_found', `${provider} has no such item, or it isn't shared with ${shareWith}.`);
}
export function accountRejected(provider: string): never {
  return fail(403, 'source_account_rejected', `${provider} rejected the connected account. Reconnect it in Settings → Profile → Connected accounts.`);
}
export function rateLimited(provider: string): never {
  return fail(429, 'source_rate_limited', `${provider} is rate limiting this account. Try again shortly.`);
}
export function outsideSource(): never {
  return fail(403, 'source_outside', 'That item is not under this source, the page, folder or document bound to the workspace.');
}

/** The item a document source binds, as an adapter resolves it. */
export interface BoundItem { id: string; type: DocumentItemType; title: string; url: string }
/** What an adapter reads; the broker adds the source and kind. */
export type ItemView = Omit<SourceReadView, 'source' | 'kind'>;

/**
 * One document provider. `connect` verifies what the user pasted and returns the secret to store (encrypted) and the
 * account's name; `resolve` names the item an admin binds; `read` reads the bound item or one under it (`item`, raw
 * as the agent passed it), refusing anything that isn't under it.
 */
export interface DocumentAdapter {
  name: string;
  connect(input: Record<string, unknown>): Promise<{ secret: string; name: string }>;
  resolve(secret: string, target: unknown): Promise<BoundItem>;
  read(secret: string, root: BoundItem, item: string | null): Promise<ItemView>;
}

/** Cuts a view to fit sourceReadLimits.bytes of JSON: entries first, then content. */
export function fit<T extends { entries?: SourceReadEntry[]; content?: string; truncated: boolean }>(view: T): T {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (view.entries && view.entries.length > sourceReadLimits.entries) { view.entries = view.entries.slice(0, sourceReadLimits.entries); view.truncated = true; }
  while (size(view) > sourceReadLimits.bytes && view.entries?.length) { view.entries.pop(); view.truncated = true; }
  if (size(view) > sourceReadLimits.bytes && view.content) {
    let content = view.content;
    while (content && size({ ...view, content }) > sourceReadLimits.bytes) content = content.slice(0, Math.floor(content.length * 0.9));
    view.content = content;
    view.truncated = true;
  }
  return view;
}
