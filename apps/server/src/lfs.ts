import { bindingRemote, gitProviderNames, validGitHost } from '../../../packages/shared/src/repositories.js';
import { parseLfsBatchRequest, parseLfsObject, type LfsBatchResult, type LfsObject } from '../../../packages/shared/src/network.js';
import type { AppContext, RepositoryRow } from './types.js';
import type { Database } from './db/types.js';
import { fail } from './http.js';
import { boundedRepositoryBody, recheckAccess, verifyRepository, type RepositoryAccess } from './repositories.js';
import { ownerGitAuthorization } from './push/targets.js';

/**
 * Git LFS downloads for a session's egress proxy, for repositories whose workspace turned LFS on.
 *
 * The proxy turns git-lfs's batch API into two relay requests: `lfs-batch` (which of these objects can be downloaded)
 * and `lfs-object` (one object's content). The control plane makes the provider's batch request itself, with the session
 * owner's own credential, and downloads the objects itself, so the provider's download URLs and the headers that
 * authorize them (often short-lived tokens) never reach the host or the sandbox; the host sees object ids and content.
 * Uploads are not relayed: sessions run Git without hooks, so git-lfs never tries one, and the proxy refuses them.
 */

const lfsType = 'application/vnd.git-lfs+json';
/** A batch request names at most lfsLimits.batchObjects objects; this leaves room for long refs. */
export const lfsRequestBytes = 64 * 1024;
/** A batch answer for 100 objects, each with a signed download URL and its headers. */
const batchResponseBytes = 4 * 1024 * 1024;
const batchTimeout = 60 * 1000;
/** An object streams for as long as a session's command runs, like a pack. */
const downloadTimeout = 60 * 60 * 1000;
const maxRedirects = 3;
const redirects = new Set([301, 302, 303, 307, 308]);
/** Headers a download action may not set: the request's framing and target are the relay's own. */
const reservedHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'cookie']);

interface DownloadAction { href: string; header: Record<string, string> }
interface ProviderObject { size: number; download?: DownloadAction; error?: { code: number; message: string } }

export async function lfsEnabled(db: Database, binding: RepositoryRow): Promise<boolean> {
  const row = await db.query<{ enabled: number }>('SELECT enabled FROM repository_lfs_settings WHERE binding_id = ? AND workspace_id = ?')
    .bind(binding.id, binding.workspace_id).first();
  return row?.enabled === 1;
}

/** git-lfs's default endpoint for a remote: `<remote>/info/lfs` when it ends in `.git`, else `<remote>.git/info/lfs`. */
export function lfsEndpoint(remote: string): string {
  return remote.endsWith('.git') ? `${remote}/info/lfs` : `${remote}.git/info/lfs`;
}

/** Provider text shown to the agent: printable ASCII, bounded; anything else becomes a fixed reason. */
function providerMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[\x20-\x7e]{1,200}$/.test(value) ? value : fallback;
}

/** An https URL on a public DNS name, without credentials: where the relay may download an object from. */
function downloadUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || !validGitHost(url.host)) return undefined;
  return url;
}

function actionHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || reservedHeaders.has(name.toLowerCase()) || typeof text !== 'string' || !/^[\x20-\x7e]{0,8192}$/.test(text)) return undefined;
    headers[name] = text;
  }
  return headers;
}

/** The provider's answer to a download batch, by object id; objects it left out are absent. */
function parseBatch(value: unknown, provider: string): Map<string, ProviderObject> {
  const invalid: () => never = () => fail(502, 'invalid_lfs_response', `${provider} returned an invalid Git LFS answer.`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  // No transfer means basic; it is the only adapter the relay offers.
  if (body.transfer !== undefined && body.transfer !== 'basic') invalid();
  if (!Array.isArray(body.objects)) invalid();
  const objects = new Map<string, ProviderObject>();
  for (const item of body.objects as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const object = item as Record<string, unknown>;
    if (typeof object.oid !== 'string' || !Number.isSafeInteger(object.size) || (object.size as number) < 0) invalid();
    const entry: ProviderObject = { size: object.size as number };
    if (object.error !== undefined) {
      const error = object.error as Record<string, unknown> | null;
      const code = Number.isInteger(error?.code) && (error!.code as number) >= 400 && (error!.code as number) <= 599 ? error!.code as number : 502;
      entry.error = { code, message: providerMessage(error?.message, 'The object is not available') };
    } else {
      const actions = object.actions as Record<string, unknown> | undefined;
      const download = actions && typeof actions === 'object' ? actions.download as Record<string, unknown> | undefined : undefined;
      if (download && typeof download === 'object') {
        const header = actionHeaders(download.header);
        if (typeof download.href !== 'string' || !header) invalid();
        entry.download = { href: download.href as string, header: header! };
      }
    }
    objects.set(object.oid, entry);
  }
  return objects;
}

/** One download batch at the provider, with the session owner's credential. */
async function providerBatch(binding: RepositoryRow, access: RepositoryAccess, objects: LfsObject[], ref?: string): Promise<Map<string, ProviderObject>> {
  const provider = gitProviderNames[binding.provider];
  const endpoint = lfsEndpoint(bindingRemote({ provider: binding.provider, host: binding.host, fullName: binding.full_name }));
  let response: Response;
  try {
    response = await fetch(`${endpoint}/objects/batch`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(batchTimeout),
      headers: { Authorization: ownerGitAuthorization(access), Accept: lfsType, 'Content-Type': lfsType, 'User-Agent': 'git-lfs/3 (pistead)' },
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects, ...(ref ? { ref: { name: ref } } : {}), hash_algo: 'sha256' }),
    });
  } catch {
    return fail(502, 'lfs_unavailable', `${provider} could not be reached for Git LFS.`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    if ([401, 403, 404].includes(response.status)) {
      fail(403, 'repository_unavailable', `${provider} did not let the session owner's account read Git LFS objects of ${binding.full_name}.`);
    }
    fail(502, 'lfs_unavailable', `${provider} could not complete the Git LFS request.`);
  }
  const bytes = await boundedRepositoryBody(response, batchResponseBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail(502, 'invalid_lfs_response', `${provider} returned an invalid Git LFS answer.`); }
  return parseBatch(parsed, provider);
}

/**
 * Downloads one object from where the provider's action points, following a few redirects. The owner's credential is
 * added only for the provider's own origin, and only when the action brings no authorization of its own; an action's
 * headers never follow a redirect to another origin.
 */
async function download(action: DownloadAction, remote: string, access: RepositoryAccess, provider: string): Promise<Response> {
  let url = downloadUrl(action.href);
  if (!url) fail(502, 'invalid_lfs_response', `${provider} pointed a Git LFS download somewhere the relay does not fetch from.`);
  const origin = url.origin;
  let headers: Record<string, string> = { ...action.header };
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'authorization') && origin === new URL(remote).origin) {
    headers.Authorization = ownerGitAuthorization(access);
  }
  for (let hop = 0; ; hop++) {
    let response: Response;
    try { response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(downloadTimeout) }); }
    catch { return fail(502, 'lfs_unavailable', `${provider} could not be reached for a Git LFS object.`); }
    if (!redirects.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    let next: URL | undefined;
    try { next = location && hop < maxRedirects ? downloadUrl(new URL(location, url).href) : undefined; } catch { next = undefined; }
    if (!next) fail(502, 'lfs_unavailable', `${provider} redirected a Git LFS download somewhere the relay does not fetch from.`);
    if (next.origin !== url.origin) headers = {};
    url = next;
  }
}

/** Passes exactly `size` bytes on: more is an error, and so is the stream ending early. */
function exactly(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > size) controller.error(new Error('The Git LFS object is larger than its pointer says'));
      else controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== size) controller.error(new Error('The Git LFS object ended early'));
    },
  }));
}

function lfsInput<T>(body: Uint8Array, parse: (value: unknown) => T): T {
  try { return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); }
  catch (error) { return fail(400, 'invalid_lfs_request', error instanceof Error && /^[\x20-\x7e]{1,200}$/.test(error.message) ? error.message : 'Invalid Git LFS request.'); }
}

/**
 * One Git LFS relay request (`lfs-batch` or `lfs-object`) for a session already authorized for `binding`. The setting is
 * read on every request, so turning LFS off stops downloads at once, whatever the host's grant says.
 */
export async function lfsRelay(c: AppContext, options: {
  binding: RepositoryRow; access: RepositoryAccess; service: 'lfs-batch' | 'lfs-object'; body: Uint8Array; authorize: () => Promise<void>;
}): Promise<Response> {
  const { binding, access, service, body, authorize } = options;
  const provider = gitProviderNames[binding.provider];
  if (!await lfsEnabled(c.env.DB, binding)) {
    fail(403, 'lfs_disabled', `Git LFS is off for ${binding.full_name} in this workspace; a workspace owner or admin can turn it on in the workspace's repository settings.`);
  }
  if (service === 'lfs-batch') {
    const request = lfsInput(body, parseLfsBatchRequest);
    // Renames and transfers fail closed, as for every Git read. Objects are content-addressed and the owner's own access
    // is checked by the provider on each download, so the downloads below don't verify again.
    await verifyRepository(access, { repositoryId: binding.repository_id, fullName: binding.full_name });
    await recheckAccess(c.env, access);
    await authorize();
    const answer = await providerBatch(binding, access, request.objects, request.ref);
    const result: LfsBatchResult = {
      objects: request.objects.map(object => {
        const entry = answer.get(object.oid);
        if (entry?.error) return { ...object, download: false, error: entry.error };
        if (!entry?.download) return { ...object, download: false, error: { code: 404, message: 'Object does not exist on the server' } };
        if (entry.size !== object.size) return { ...object, download: false, error: { code: 422, message: 'The object\'s size does not match its pointer' } };
        return { ...object, download: true };
      }),
    };
    return c.json(result, 200, { 'Cache-Control': 'private, no-store' });
  }
  const object = lfsInput(body, parseLfsObject);
  await recheckAccess(c.env, access);
  await authorize();
  const entry = (await providerBatch(binding, access, [object])).get(object.oid);
  if (!entry?.download || entry.error) {
    fail(404, 'lfs_object_unavailable', entry?.error ? `${provider}: ${entry.error.message}` : `${provider} has no Git LFS object ${object.oid}.`);
  }
  if (entry.size !== object.size) fail(422, 'lfs_object_unavailable', `${provider} reports another size for Git LFS object ${object.oid}.`);
  const remote = bindingRemote({ provider: binding.provider, host: binding.host, fullName: binding.full_name });
  const upstream = await download(entry.download, remote, access, provider);
  const length = upstream.headers.get('content-length');
  if (upstream.status !== 200 || !upstream.body || (length !== null && length !== String(object.size))) {
    await upstream.body?.cancel();
    fail(upstream.status === 404 ? 404 : 502, 'lfs_object_unavailable', `${provider} could not serve Git LFS object ${object.oid}.`);
  }
  return new Response(exactly(upstream.body, object.size), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
}
