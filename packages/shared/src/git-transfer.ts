import { validGitHost } from "./repositories.js";
import type { LfsBatchResult, LfsObject } from "./network.js";

/**
 * Git smart HTTP and Git LFS downloads against a forge, as both the control plane's relay and a host's egress proxy
 * make them: the relay with credentials that never leave the control plane, the proxy with a direct credential the
 * control plane gave it for one repository (see GitDirectGrant). Errors are fixed, credential-free GitTransferErrors.
 */

export class GitTransferError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type GitSmartService = "info-refs" | "upload-pack" | "receive-refs" | "receive-pack";
export const gitServiceTypes: Record<GitSmartService, string> = {
  "info-refs": "application/x-git-upload-pack-advertisement",
  "upload-pack": "application/x-git-upload-pack-result",
  "receive-refs": "application/x-git-receive-pack-advertisement",
  "receive-pack": "application/x-git-receive-pack-result",
};

/** Upstream answers start within this; a pack or an LFS object may stream for as long as the session's command runs. */
export const GIT_TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;

export function gitServiceUrl(remote: string, service: GitSmartService): string {
  switch (service) {
    case "info-refs": return `${remote}/info/refs?service=git-upload-pack`;
    case "upload-pack": return `${remote}/git-upload-pack`;
    case "receive-refs": return `${remote}/info/refs?service=git-receive-pack`;
    case "receive-pack": return `${remote}/git-receive-pack`;
  }
}

/**
 * The headers a Git request is sent upstream with, from what the client sent: its user agent and protocol only when
 * they look like Git's, and the request's type, which must be the service's own. Throws a 415 on anything else.
 */
export function gitUpstreamHeaders(service: GitSmartService, input: { userAgent?: string | null; gitProtocol?: string | null;
  contentType?: string | null; contentEncoding?: string | null }): Record<string, string> {
  const agent = input.userAgent;
  const protocol = input.gitProtocol;
  const headers: Record<string, string> = {
    "User-Agent": agent && /^git\/[\x21-\x7e]{1,120}$/.test(agent) ? agent : "git/2 (pistead)",
    ...(protocol && /^[A-Za-z0-9=:._-]{1,256}$/.test(protocol) && (service === "info-refs" || service === "upload-pack") ? { "Git-Protocol": protocol } : {}),
  };
  if (service === "upload-pack") {
    if (input.contentType !== "application/x-git-upload-pack-request") throw new GitTransferError(415, "unsupported_media_type", "Expected a Git upload-pack request.");
    if (input.contentEncoding && input.contentEncoding !== "gzip") throw new GitTransferError(415, "unsupported_media_type", "Unsupported Git request encoding.");
    headers["Content-Type"] = "application/x-git-upload-pack-request";
    headers.Accept = gitServiceTypes["upload-pack"];
    if (input.contentEncoding) headers["Content-Encoding"] = input.contentEncoding;
  } else if (service === "receive-pack") {
    if (input.contentType?.toLowerCase() !== "application/x-git-receive-pack-request") throw new GitTransferError(415, "unsupported_media_type", "Expected a Git receive-pack request.");
    if (input.contentEncoding) throw new GitTransferError(415, "unsupported_media_type", "Unsupported Git request encoding.");
    headers["Content-Type"] = "application/x-git-receive-pack-request";
    headers.Accept = gitServiceTypes["receive-pack"];
  }
  return headers;
}

export interface GitUpstreamRequest {
  remote: string; service: GitSmartService;
  /** The full Authorization header, or null for a public repository read without credentials. */
  authorization: string | null;
  headers: Record<string, string>;
  body?: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  /** The provider's display name and the repository, for messages. */
  provider: string; fullName: string;
  /** Who the credential is, for the refusal's message: the session owner (reads) or the workspace's push identity. */
  identity: "owner" | "push";
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** One Git request at the forge; resolves with its streaming answer, of the service's own type. */
export async function fetchGit(request: GitUpstreamRequest): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const { service, provider } = request;
  const push = service === "receive-refs" || service === "receive-pack";
  let upstream: Response;
  try {
    upstream = await (request.fetch ?? fetch)(gitServiceUrl(request.remote, service), {
      method: request.body ? "POST" : "GET", redirect: "manual",
      headers: { ...request.headers, ...(request.authorization ? { Authorization: request.authorization } : {}) },
      body: request.body, ...(request.body instanceof ReadableStream ? { duplex: "half" } : {}),
      signal: request.signal ?? AbortSignal.timeout(GIT_TRANSFER_TIMEOUT_MS),
    } as RequestInit);
  } catch {
    throw new GitTransferError(502, "git_unavailable", `${provider} could not be reached.`);
  }
  const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (upstream.status !== 200 || type !== gitServiceTypes[service] || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    const denied = [401, 403, 404].includes(upstream.status);
    if (!denied) throw new GitTransferError(502, "git_unavailable", `${provider} could not complete the ${push ? "push" : "Git request"}.`);
    throw push
      ? new GitTransferError(403, "push_identity_denied", `${provider} did not let the workspace's push identity push to ${request.fullName}.`)
      : new GitTransferError(403, "repository_unavailable", request.authorization
        ? `${provider} did not let the session owner's account read ${request.fullName}.`
        : `${provider} did not serve ${request.fullName} without credentials.`);
  }
  return { body: upstream.body, contentType: gitServiceTypes[service] };
}

/* Git LFS downloads. */

const LFS_TYPE = "application/vnd.git-lfs+json";
/** A batch answer for 100 objects, each with a signed download URL and its headers. */
const LFS_BATCH_RESPONSE_BYTES = 4 * 1024 * 1024;
const LFS_BATCH_TIMEOUT_MS = 60 * 1000;
const LFS_MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Headers a download action may not set: the request's framing and target are the downloader's own. */
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization", "cookie"]);

export interface LfsDownloadAction { href: string; header: Record<string, string> }
export interface LfsProviderObject { size: number; download?: LfsDownloadAction; error?: { code: number; message: string } }
export interface LfsTarget {
  /** The repository's Git remote (bindingRemote) and the provider's display name and repository, for messages. */
  remote: string; provider: string; fullName: string;
  /** The full Authorization header for the provider's own origin, or null for a public repository. */
  authorization: string | null;
  fetch?: typeof fetch;
}

/** git-lfs's default endpoint for a remote: `<remote>/info/lfs` when it ends in `.git`, else `<remote>.git/info/lfs`. */
export function lfsEndpoint(remote: string): string {
  return remote.endsWith(".git") ? `${remote}/info/lfs` : `${remote}.git/info/lfs`;
}

/** Provider text shown to the agent: printable ASCII, bounded; anything else becomes a fixed reason. */
function providerMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[\x20-\x7e]{1,200}$/.test(value) ? value : fallback;
}

/** An https URL on a public DNS name, without credentials: where an object may be downloaded from. */
function downloadUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || !validGitHost(url.host)) return undefined;
  return url;
}

function actionHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || typeof text !== "string" || !/^[\x20-\x7e]{0,8192}$/.test(text)) return undefined;
    headers[name] = text;
  }
  return headers;
}

/** The provider's answer to a download batch, by object id; objects it left out are absent. */
export function parseLfsProviderBatch(value: unknown, provider: string): Map<string, LfsProviderObject> {
  const invalid = (): never => { throw new GitTransferError(502, "invalid_lfs_response", `${provider} returned an invalid Git LFS answer.`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  // No transfer means basic; it is the only adapter offered.
  if (body.transfer !== undefined && body.transfer !== "basic") invalid();
  if (!Array.isArray(body.objects)) invalid();
  const objects = new Map<string, LfsProviderObject>();
  for (const item of body.objects as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid();
    const object = item as Record<string, unknown>;
    if (typeof object.oid !== "string" || !Number.isSafeInteger(object.size) || (object.size as number) < 0) invalid();
    const entry: LfsProviderObject = { size: object.size as number };
    if (object.error !== undefined) {
      const error = object.error as Record<string, unknown> | null;
      const code = Number.isInteger(error?.code) && (error!.code as number) >= 400 && (error!.code as number) <= 599 ? error!.code as number : 502;
      entry.error = { code, message: providerMessage(error?.message, "The object is not available") };
    } else {
      const actions = object.actions as Record<string, unknown> | undefined;
      const download = actions && typeof actions === "object" ? actions.download as Record<string, unknown> | undefined : undefined;
      if (download && typeof download === "object") {
        const header = actionHeaders(download.header);
        if (typeof download.href !== "string" || !header) invalid();
        entry.download = { href: download.href as string, header: header! };
      }
    }
    objects.set(object.oid as string, entry);
  }
  return objects;
}

/** Reads a whole small body within `limit` bytes and `timeout`. */
async function boundedText(response: Response, limit: number, provider: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  const invalid = () => new GitTransferError(502, "invalid_lfs_response", `${provider} returned an invalid Git LFS answer.`);
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => {}); throw invalid(); }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw invalid();
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof GitTransferError ? error : invalid();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw invalid(); }
}

/** One download batch at the provider. */
export async function lfsProviderBatch(target: LfsTarget, objects: LfsObject[], ref?: string): Promise<Map<string, LfsProviderObject>> {
  const { provider } = target;
  let response: Response;
  try {
    response = await (target.fetch ?? fetch)(`${lfsEndpoint(target.remote)}/objects/batch`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(LFS_BATCH_TIMEOUT_MS),
      headers: { ...(target.authorization ? { Authorization: target.authorization } : {}), Accept: LFS_TYPE, "Content-Type": LFS_TYPE, "User-Agent": "git-lfs/3 (pistead)" },
      body: JSON.stringify({ operation: "download", transfers: ["basic"], objects, ...(ref ? { ref: { name: ref } } : {}), hash_algo: "sha256" }),
    });
  } catch {
    throw new GitTransferError(502, "lfs_unavailable", `${provider} could not be reached for Git LFS.`);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403, 404].includes(response.status)) {
      throw new GitTransferError(403, "repository_unavailable", `${provider} did not let the session owner's account read Git LFS objects of ${target.fullName}.`);
    }
    throw new GitTransferError(502, "lfs_unavailable", `${provider} could not complete the Git LFS request.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await boundedText(response, LFS_BATCH_RESPONSE_BYTES, provider)); }
  catch (error) { throw error instanceof GitTransferError ? error : new GitTransferError(502, "invalid_lfs_response", `${provider} returned an invalid Git LFS answer.`); }
  return parseLfsProviderBatch(parsed, provider);
}

/** Which of the requested objects can be downloaded, from the provider's answer; where they are stored is left out. */
export function lfsBatchResult(objects: LfsObject[], answer: Map<string, LfsProviderObject>): LfsBatchResult {
  return {
    objects: objects.map(object => {
      const entry = answer.get(object.oid);
      if (entry?.error) return { ...object, download: false, error: entry.error };
      if (!entry?.download) return { ...object, download: false, error: { code: 404, message: "Object does not exist on the server" } };
      if (entry.size !== object.size) return { ...object, download: false, error: { code: 422, message: "The object's size does not match its pointer" } };
      return { ...object, download: true };
    }),
  };
}

/**
 * Fetches where the provider's action points, following a few redirects. The credential is added only for the
 * provider's own origin, and only when the action brings no authorization of its own; an action's headers never follow
 * a redirect to another origin.
 */
async function download(target: LfsTarget, action: LfsDownloadAction): Promise<Response> {
  const { provider } = target;
  let url = downloadUrl(action.href);
  if (!url) throw new GitTransferError(502, "invalid_lfs_response", `${provider} pointed a Git LFS download somewhere Pistead does not fetch from.`);
  let headers: Record<string, string> = { ...action.header };
  if (target.authorization && !Object.keys(headers).some(name => name.toLowerCase() === "authorization") && url.origin === new URL(target.remote).origin) {
    headers.Authorization = target.authorization;
  }
  for (let hop = 0; ; hop++) {
    let response: Response;
    try { response = await (target.fetch ?? fetch)(url, { headers, redirect: "manual", signal: AbortSignal.timeout(GIT_TRANSFER_TIMEOUT_MS) }); }
    catch { throw new GitTransferError(502, "lfs_unavailable", `${provider} could not be reached for a Git LFS object.`); }
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    let next: URL | undefined;
    try { next = location && hop < LFS_MAX_REDIRECTS ? downloadUrl(new URL(location, url).href) : undefined; } catch { next = undefined; }
    if (!next) throw new GitTransferError(502, "lfs_unavailable", `${provider} redirected a Git LFS download somewhere Pistead does not fetch from.`);
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
      if (seen > size) controller.error(new Error("The Git LFS object is larger than its pointer says"));
      else controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== size) controller.error(new Error("The Git LFS object ended early"));
    },
  }));
}

/** One object's content: a one-object batch at the provider, then its download, cut off unless exactly its size. */
export async function lfsDownload(target: LfsTarget, object: LfsObject): Promise<ReadableStream<Uint8Array>> {
  const { provider } = target;
  const entry = (await lfsProviderBatch(target, [object])).get(object.oid);
  if (!entry?.download || entry.error) {
    throw new GitTransferError(404, "lfs_object_unavailable", entry?.error ? `${provider}: ${entry.error.message}` : `${provider} has no Git LFS object ${object.oid}.`);
  }
  if (entry.size !== object.size) throw new GitTransferError(422, "lfs_object_unavailable", `${provider} reports another size for Git LFS object ${object.oid}.`);
  const upstream = await download(target, entry.download);
  const length = upstream.headers.get("content-length");
  if (upstream.status !== 200 || !upstream.body || (length !== null && length !== String(object.size))) {
    await upstream.body?.cancel().catch(() => {});
    throw new GitTransferError(upstream.status === 404 ? 404 : 502, "lfs_object_unavailable", `${provider} could not serve Git LFS object ${object.oid}.`);
  }
  return exactly(upstream.body, object.size);
}
