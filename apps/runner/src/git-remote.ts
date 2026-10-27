// Git smart-HTTP client that pushes session commits to the forge and fills the host's repository cache from it. The
// credential lives only in this object.
export const ZERO_OID = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;
const MAX_PKT = 65520;
const MAX_ADVERTISEMENT = 8 * 1024 * 1024;
const MAX_REPORT = 1024 * 1024;
/** Bounds for one full-history cache fetch; the request body stays well under typical forge limits. */
const MAX_WANTS = 50_000;
const MAX_HAVES = 4096;

/** Structured progress, parsed from Git's own progress lines; raw remote text is never forwarded. */
export type GitProgressPhase = "enumerating" | "counting" | "compressing" | "receiving" | "resolving";
export interface GitProgress { phase: GitProgressPhase; percent: number | null; done: number | null; total: number | null }

const PROGRESS = /^(?:remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving) (?:objects|deltas):\s+(?:(\d{1,3})% \((\d{1,12})\/(\d{1,12})\)|(\d{1,12}))/;

/** Parses one Git progress line ("Counting objects:  45% (450/1000)" or "Enumerating objects: 1000, done."). */
export function parseGitProgress(line: string): GitProgress | null {
  const match = PROGRESS.exec(line);
  if (!match) return null;
  const phase = match[1]!.toLowerCase() as GitProgressPhase;
  if (match[5] !== undefined) return { phase, percent: null, done: Number(match[5]), total: null };
  return { phase, percent: Math.min(100, Number(match[2])), done: Number(match[3]), total: Number(match[4]) };
}

/** Splits a byte stream of progress output into lines at CR or LF, bounding any single line. */
export class ProgressLines {
  private pending = "";
  private readonly onLine: (line: string) => void;
  constructor(onLine: (line: string) => void) { this.onLine = onLine; }
  push(chunk: Uint8Array): void {
    const parts = (this.pending + new TextDecoder("latin1").decode(chunk)).split(/[\r\n]/);
    this.pending = parts.pop()!.slice(-1024);
    for (const part of parts) if (part) this.onLine(part.slice(0, 1024));
  }
  end(): void { if (this.pending) this.onLine(this.pending); this.pending = ""; }
}

/** Branch and tag names a cache may mirror; anything Git itself would refuse to store is skipped. */
function mirrorableRef(ref: string): boolean {
  return /^refs\/(?:heads|tags)\/./.test(ref) && ref.length <= 1024 && !/[\x00-\x20\x7f~^:?*[\\]/.test(ref)
    && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith("/") && !ref.endsWith(".")
    && !ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

export class GitRemoteError extends Error {
  /**
   * Whether another attempt may get past it: the connection failed or broke off, or the remote was busy or failing (HTTP
   * 5xx, 408, 429). A refusal, or a response Git can't use, is final.
   */
  readonly retryable: boolean;
  constructor(message: string, readonly status?: number, retryable?: boolean) {
    super(message);
    this.name = "GitRemoteError";
    this.retryable = retryable ?? (status !== undefined && (status >= 500 || status === 408 || status === 429));
  }
}

export interface GitRemoteOptions {
  url: string;
  /** Sent as the Authorization header; without it, the remote is read anonymously (a public repository). */
  authorization?: string;
  fetch?: typeof fetch; signal?: AbortSignal; userAgent?: string;
}

type Pkt = { kind: "data"; data: Uint8Array } | { kind: "flush" | "delim" | "end" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pkt(line: string | Uint8Array): Uint8Array {
  const data = typeof line === "string" ? encoder.encode(line) : line;
  const size = data.length + 4;
  if (size > MAX_PKT) throw new GitRemoteError("Git pkt-line is too long");
  const out = new Uint8Array(size);
  out.set(encoder.encode(size.toString(16).padStart(4, "0")));
  out.set(data, 4);
  return out;
}
const FLUSH = encoder.encode("0000");
const DELIM = encoder.encode("0001");

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function text(packet: Pkt): string | undefined {
  if (packet.kind !== "data") return undefined;
  const line = decoder.decode(packet.data);
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function oid(value: string): string {
  if (!OID.test(value)) throw new GitRemoteError("Git remote sent an invalid object id");
  return value;
}

/** Buffered pkt-line reader over a byte stream; never holds more than one pkt (or one chunk) in memory. */
class PktReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private total = 0;
  constructor(private readonly source: AsyncIterator<Uint8Array>, private readonly limit = Infinity) {}

  private async fill(size: number): Promise<boolean> {
    while (this.buffer.length - this.offset < size) {
      const next = await this.source.next();
      if (next.done) return false;
      this.total += next.value.length;
      if (this.total > this.limit) throw new GitRemoteError("Git remote response is too large");
      const rest = this.buffer.subarray(this.offset);
      this.buffer = rest.length ? concat([rest, next.value]) : next.value;
      this.offset = 0;
    }
    return true;
  }

  private take(size: number): Uint8Array {
    const out = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return out;
  }

  /** Next pkt, or null at a clean end of stream. */
  async read(): Promise<Pkt | null> {
    if (!(await this.fill(4))) {
      if (this.buffer.length > this.offset) throw new GitRemoteError("Git remote response ended mid-packet", undefined, true);
      return null;
    }
    const header = decoder.decode(this.take(4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new GitRemoteError("Git remote sent a malformed pkt-line");
    const size = parseInt(header, 16);
    if (size === 0) return { kind: "flush" };
    if (size === 1) return { kind: "delim" };
    if (size === 2) return { kind: "end" };
    if (size < 4 || size > MAX_PKT) throw new GitRemoteError("Git remote sent a malformed pkt-line");
    if (!(await this.fill(size - 4))) throw new GitRemoteError("Git remote response ended mid-packet", undefined, true);
    const data = this.take(size - 4).slice();
    if (data.length >= 4 && decoder.decode(data.subarray(0, 4)) === "ERR ") throw new GitRemoteError("Git remote reported an error");
    return { kind: "data", data };
  }

  async expect(): Promise<Pkt> {
    const next = await this.read();
    if (!next) throw new GitRemoteError("Git remote response ended early", undefined, true);
    return next;
  }

  /** Remaining raw bytes (no pkt framing). */
  async *rest(): AsyncGenerator<Uint8Array> {
    if (this.buffer.length > this.offset) yield this.take(this.buffer.length - this.offset).slice();
    for (;;) {
      const next = await this.source.next();
      if (next.done) return;
      yield next.value;
    }
  }

  /** Side-band-64k payload of band 1 until flush; band 2 goes to `progress` (or is dropped), band 3 is fatal. */
  async *sideband(progress?: ProgressLines): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = await this.read();
      if (!next || next.kind === "flush") { progress?.end(); return; }
      if (next.kind !== "data" || next.data.length < 1) throw new GitRemoteError("Git remote sent a malformed side-band packet");
      const band = next.data[0];
      if (band === 1) yield next.data.subarray(1);
      else if (band === 3) throw new GitRemoteError("Git remote reported an error");
      else if (band === 2) progress?.push(next.data.subarray(1));
      else throw new GitRemoteError("Git remote sent a malformed side-band packet");
    }
  }

  async close(): Promise<void> { await this.source.return?.(); }
}

async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Early exits (errors, abandoned packs) release the connection instead of leaving it half-read.
    await reader.cancel().catch(() => {});
  }
}

function bodyReader(response: Response, limit?: number): PktReader {
  if (!response.body) throw new GitRemoteError("Git remote response has no body");
  return new PktReader(chunks(response.body), limit);
}

function streamOf(parts: (Uint8Array | AsyncIterable<Uint8Array>)[]): ReadableStream<Uint8Array> {
  async function* all(): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      if (part instanceof Uint8Array) yield part;
      else for await (const chunk of part) yield chunk;
    }
  }
  const iterator = all();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    async cancel() { await iterator.return(undefined); },
  });
}

interface Advertisement { version: 0 | 2; refs: Map<string, string>; capabilities: Set<string> }

export class GitRemote {
  private readonly url: URL;
  private readonly authorization: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly signal?: AbortSignal;
  private readonly agent: string;

  constructor(options: GitRemoteOptions) {
    let url: URL;
    try { url = new URL(options.url); } catch { throw new GitRemoteError("Git remote URL is invalid"); }
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new GitRemoteError("Git remote URL must use https");
    if (url.username || url.password || url.search || url.hash) throw new GitRemoteError("Git remote URL is invalid");
    url.pathname = url.pathname.replace(/\/+$/, "");
    this.url = url;
    this.authorization = options.authorization;
    this.fetcher = options.fetch ?? fetch;
    this.signal = options.signal;
    this.agent = (options.userAgent ?? "pistead").replace(/[^\x21-\x7e]/g, "");
  }

  private async request(path: string, init: { method: string; headers: Record<string, string>; body?: ReadableStream<Uint8Array> }, contentType: string): Promise<Response> {
    const target = new URL(this.url.href + path);
    if (target.origin !== this.url.origin) throw new GitRemoteError("Git remote URL is invalid");
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method: init.method,
        headers: { ...init.headers, ...(this.authorization ? { Authorization: this.authorization } : {}), "User-Agent": `git/${this.agent}` },
        body: init.body,
        redirect: "manual",
        signal: this.signal,
        ...(init.body ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (error) {
      if (error instanceof GitRemoteError) throw error;
      // Aborted by the caller's own signal: final. Otherwise the connection failed, which another attempt may get past.
      throw new GitRemoteError("Git remote request failed", undefined, !this.signal?.aborted);
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new GitRemoteError("Git remote redirected the request", response.status || undefined);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitRemoteError(`Git remote returned HTTP ${response.status}`, response.status);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== contentType) {
      await response.body?.cancel();
      throw new GitRemoteError("Git remote returned an unexpected content type", response.status);
    }
    return response;
  }

  private async advertisement(service: "git-receive-pack" | "git-upload-pack", v2: boolean): Promise<Advertisement> {
    const headers: Record<string, string> = { Accept: `application/x-${service}-advertisement` };
    if (v2) headers["Git-Protocol"] = "version=2";
    const response = await this.request(`/info/refs?service=${service}`, { method: "GET", headers }, `application/x-${service}-advertisement`);
    const reader = bodyReader(response, MAX_ADVERTISEMENT);
    try {
      let first = await reader.expect();
      if (text(first) === `# service=${service}`) {
        if ((await reader.expect()).kind !== "flush") throw new GitRemoteError("Git remote sent a malformed advertisement");
        first = await reader.expect();
      }
      const refs = new Map<string, string>();
      const capabilities = new Set<string>();
      if (text(first) === "version 2") {
        for (let next = await reader.expect(); next.kind !== "flush"; next = await reader.expect()) {
          const line = text(next);
          if (line === undefined) throw new GitRemoteError("Git remote sent a malformed advertisement");
          capabilities.add(line);
        }
        checkFormat(capabilities);
        return { version: 2, refs, capabilities };
      }
      for (let next: Pkt = first; next.kind !== "flush"; next = await reader.expect()) {
        let line = text(next);
        if (line === undefined) throw new GitRemoteError("Git remote sent a malformed advertisement");
        const nul = line.indexOf("\0");
        if (nul >= 0) {
          for (const cap of line.slice(nul + 1).split(" ")) if (cap) capabilities.add(cap);
          line = line.slice(0, nul);
        }
        const space = line.indexOf(" ");
        const id = oid(line.slice(0, space)), ref = line.slice(space + 1);
        if (space !== 40 || !ref) throw new GitRemoteError("Git remote sent a malformed advertisement");
        if (ref === "capabilities^{}") continue;
        if (!ref.endsWith("^{}")) refs.set(ref, id);
      }
      checkFormat(capabilities);
      return { version: 0, refs, capabilities };
    } finally {
      await reader.close();
    }
  }

  async receivePackAdvertisement(): Promise<{ refs: Map<string, string>; capabilities: Set<string> }> {
    const { refs, capabilities } = await this.advertisement("git-receive-pack", false);
    return { refs, capabilities };
  }

  /** Branch and tag tips (unpeeled) the remote advertises for upload-pack; names Git could not store are skipped. */
  async listRefs(): Promise<Map<string, string>> {
    const advertised = await this.advertisement("git-upload-pack", true);
    const refs = new Map<string, string>();
    if (advertised.version === 0) {
      for (const [ref, id] of advertised.refs) if (mirrorableRef(ref)) refs.set(ref, id);
      return refs;
    }
    if (![...advertised.capabilities].some(cap => cap === "ls-refs" || cap.startsWith("ls-refs="))) throw new GitRemoteError("Git remote does not support ls-refs");
    const lines = [pkt("command=ls-refs\n"), pkt(`agent=${this.agent}\n`)];
    if (advertised.capabilities.has("object-format=sha1")) lines.push(pkt("object-format=sha1\n"));
    lines.push(DELIM, pkt("ref-prefix refs/heads/\n"), pkt("ref-prefix refs/tags/\n"), FLUSH);
    const response = await this.request("/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Git-Protocol": "version=2" },
      body: streamOf([concat(lines)]),
    }, "application/x-git-upload-pack-result");
    const reader = bodyReader(response, MAX_ADVERTISEMENT);
    try {
      for (let next = await reader.expect(); next.kind !== "flush"; next = await reader.expect()) {
        const line = text(next);
        if (line === undefined) throw new GitRemoteError("Git remote sent a malformed ref listing");
        const [id, ref] = line.split(" ");
        if (id === undefined || ref === undefined) throw new GitRemoteError("Git remote sent a malformed ref listing");
        if (mirrorableRef(ref)) refs.set(ref, oid(id));
      }
    } finally {
      await reader.close();
    }
    return refs;
  }

  /**
   * Full-history pack of `wants` minus what `haves` already reach: no depth, no filter, no thin pack, so a
   * repository that holds the haves can index it with no further remote access. Band 2 progress lines go to
   * `onProgress`; the remote must allow wanting non-tip commits when a want is not an advertised tip.
   */
  async fetchHistory(input: { wants: readonly string[]; haves: readonly string[]; onProgress?: (line: string) => void }): Promise<AsyncIterable<Uint8Array>> {
    const wants = [...new Set(input.wants.map(oid))];
    const haves = [...new Set(input.haves.map(oid))].slice(0, MAX_HAVES);
    if (!wants.length || wants.length > MAX_WANTS) throw new GitRemoteError("Git fetch needs between one and 50000 wanted commits");
    const progress = input.onProgress ? new ProgressLines(input.onProgress) : undefined;
    const advertised = await this.advertisement("git-upload-pack", true);
    if (advertised.version === 2) {
      const fetchLine = [...advertised.capabilities].find((cap) => cap === "fetch" || cap.startsWith("fetch="));
      if (!fetchLine) throw new GitRemoteError("Git remote does not support fetch");
      const lines = [pkt("command=fetch\n"), pkt(`agent=${this.agent}\n`)];
      if (advertised.capabilities.has("object-format=sha1")) lines.push(pkt("object-format=sha1\n"));
      lines.push(DELIM, pkt("ofs-delta\n"), ...(progress ? [] : [pkt("no-progress\n")]));
      for (const id of wants) lines.push(pkt(`want ${id}\n`));
      for (const id of haves) lines.push(pkt(`have ${id}\n`));
      lines.push(pkt("done\n"), FLUSH);
      const response = await this.request("/git-upload-pack", {
        method: "POST",
        headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Git-Protocol": "version=2" },
        body: streamOf([concat(lines)]),
      }, "application/x-git-upload-pack-result");
      const reader = bodyReader(response);
      try {
        for (;;) {
          const header = text(await reader.expect());
          if (header === "packfile") break;
          if (header !== "acknowledgments" && header !== "shallow-info") throw new GitRemoteError("Git remote sent a malformed fetch response");
          for (let next = await reader.expect(); next.kind !== "delim"; next = await reader.expect()) {
            if (text(next) === undefined) throw new GitRemoteError("Git remote sent a malformed fetch response");
          }
        }
      } catch (error) {
        await reader.close();
        throw error;
      }
      return guarded(reader, reader.sideband(progress));
    }
    const caps = advertised.capabilities;
    const tips = new Set(advertised.refs.values());
    if (wants.some(id => !tips.has(id)) && !caps.has("allow-reachable-sha1-in-want") && !caps.has("allow-tip-sha1-in-want")) {
      throw new GitRemoteError("Git remote does not allow fetching this commit");
    }
    const sideband = caps.has("side-band-64k");
    const first = ["want", wants[0]!];
    if (sideband) first.push("side-band-64k");
    if (caps.has("ofs-delta")) first.push("ofs-delta");
    if (caps.has("no-progress") && !progress) first.push("no-progress");
    first.push(`agent=${this.agent}`);
    const lines = [pkt(`${first.join(" ")}\n`), ...wants.slice(1).map(id => pkt(`want ${id}\n`)), FLUSH];
    for (const id of haves) lines.push(pkt(`have ${id}\n`));
    lines.push(pkt("done\n"));
    const response = await this.request("/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result" },
      body: streamOf([concat(lines)]),
    }, "application/x-git-upload-pack-result");
    const reader = bodyReader(response);
    try {
      // Without multi_ack the server answers with one ACK for the first common object, or NAK if there is none.
      const answer = text(await reader.expect());
      if (answer !== "NAK" && !(answer?.startsWith("ACK ") && OID.test(answer.slice(4, 44)))) throw new GitRemoteError("Git remote sent a malformed fetch response");
    } catch (error) {
      await reader.close();
      throw error;
    }
    return guarded(reader, sideband ? reader.sideband(progress) : reader.rest());
  }

  async push(update: { ref: string; old: string; new: string }, pack: AsyncIterable<Uint8Array>, capabilities: Set<string>): Promise<{ unpack: string; status: "ok" | "ng"; reason?: string }> {
    oid(update.old); oid(update.new);
    if (!update.ref.startsWith("refs/") || /[\0\s]/.test(update.ref)) throw new GitRemoteError("Git ref name is invalid");
    checkFormat(capabilities);
    if (!capabilities.has("report-status")) throw new GitRemoteError("Git remote does not support report-status");
    const sideband = capabilities.has("side-band-64k");
    const caps = ["report-status", ...(sideband ? ["side-band-64k"] : []), ...(capabilities.has("quiet") ? ["quiet"] : []), `agent=${this.agent}`];
    const head = concat([pkt(`${update.old} ${update.new} ${update.ref}\0${caps.join(" ")}\n`), FLUSH]);
    const response = await this.request("/git-receive-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-receive-pack-request", Accept: "application/x-git-receive-pack-result" },
      body: streamOf(update.new === ZERO_OID ? [head] : [head, pack]),
    }, "application/x-git-receive-pack-result");
    let reader = bodyReader(response, MAX_REPORT);
    try {
      if (sideband) {
        const parts: Uint8Array[] = [];
        for await (const chunk of reader.sideband()) parts.push(chunk);
        await reader.close();
        reader = new PktReader((async function* () { yield concat(parts); })());
      }
      const unpackLine = text(await reader.expect());
      if (!unpackLine?.startsWith("unpack ")) throw new GitRemoteError("Git remote sent a malformed push report");
      const unpack = unpackLine.slice(7);
      let result: { status: "ok" | "ng"; reason?: string } | undefined;
      for (let next = await reader.expect(); next.kind !== "flush"; next = await reader.expect()) {
        const line = text(next) ?? "";
        if (line === `ok ${update.ref}`) result = { status: "ok" };
        else if (line.startsWith(`ng ${update.ref} `)) result = { status: "ng", reason: line.slice(update.ref.length + 4) };
      }
      if (!result) {
        if (unpack !== "ok") return { unpack, status: "ng", reason: `unpack ${unpack}` };
        throw new GitRemoteError("Git remote sent a malformed push report");
      }
      if (unpack !== "ok" && result.status === "ok") return { unpack, status: "ng", reason: `unpack ${unpack}` };
      return { unpack, ...result };
    } finally {
      await reader.close();
    }
  }
}

function checkFormat(capabilities: Set<string>): void {
  for (const cap of capabilities) if (cap.startsWith("object-format=") && cap !== "object-format=sha1") throw new GitRemoteError("Git remote uses an unsupported object format");
}

async function* guarded(reader: PktReader, source: AsyncGenerator<Uint8Array>): AsyncGenerator<Uint8Array> {
  try { yield* source; } finally { await reader.close(); }
}
