// Git smart-HTTP client used to push session commits directly to the forge. The credential lives only in this object.
export const ZERO_OID = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;
const MAX_PKT = 65520;
const MAX_ADVERTISEMENT = 8 * 1024 * 1024;
const MAX_REPORT = 1024 * 1024;

export class GitRemoteError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "GitRemoteError"; }
}

export interface GitRemoteOptions { url: string; authorization: string; fetch?: typeof fetch; signal?: AbortSignal; userAgent?: string }

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
      if (this.buffer.length > this.offset) throw new GitRemoteError("Git remote response ended mid-packet");
      return null;
    }
    const header = decoder.decode(this.take(4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new GitRemoteError("Git remote sent a malformed pkt-line");
    const size = parseInt(header, 16);
    if (size === 0) return { kind: "flush" };
    if (size === 1) return { kind: "delim" };
    if (size === 2) return { kind: "end" };
    if (size < 4 || size > MAX_PKT) throw new GitRemoteError("Git remote sent a malformed pkt-line");
    if (!(await this.fill(size - 4))) throw new GitRemoteError("Git remote response ended mid-packet");
    const data = this.take(size - 4).slice();
    if (data.length >= 4 && decoder.decode(data.subarray(0, 4)) === "ERR ") throw new GitRemoteError("Git remote reported an error");
    return { kind: "data", data };
  }

  async expect(): Promise<Pkt> {
    const next = await this.read();
    if (!next) throw new GitRemoteError("Git remote response ended early");
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

  /** Side-band-64k payload of band 1 until flush; progress dropped, band 3 is fatal. */
  async *sideband(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = await this.read();
      if (!next || next.kind === "flush") return;
      if (next.kind !== "data" || next.data.length < 1) throw new GitRemoteError("Git remote sent a malformed side-band packet");
      const band = next.data[0];
      if (band === 1) yield next.data.subarray(1);
      else if (band === 3) throw new GitRemoteError("Git remote reported an error");
      else if (band !== 2) throw new GitRemoteError("Git remote sent a malformed side-band packet");
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
  private readonly authorization: string;
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
        headers: { ...init.headers, Authorization: this.authorization, "User-Agent": `git/${this.agent}` },
        body: init.body,
        redirect: "manual",
        signal: this.signal,
        ...(init.body ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (error) {
      if (error instanceof GitRemoteError) throw error;
      throw new GitRemoteError("Git remote request failed");
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

  async fetchCommit(commit: string): Promise<{ pack: AsyncIterable<Uint8Array>; shallow: string[]; filtered: boolean }> {
    oid(commit);
    const advertised = await this.advertisement("git-upload-pack", true);
    return advertised.version === 2 ? this.fetchV2(commit, advertised.capabilities) : this.fetchV0(commit, advertised);
  }

  private async fetchV2(commit: string, capabilities: Set<string>): Promise<{ pack: AsyncIterable<Uint8Array>; shallow: string[]; filtered: boolean }> {
    const fetchLine = [...capabilities].find((cap) => cap === "fetch" || cap.startsWith("fetch="));
    if (!fetchLine) throw new GitRemoteError("Git remote does not support fetch");
    const features = new Set(fetchLine.slice(6).split(" ").filter(Boolean));
    const shallow = features.has("shallow"), filtered = features.has("filter");
    const lines = [pkt("command=fetch\n"), pkt(`agent=${this.agent}\n`)];
    if ([...capabilities].includes("object-format=sha1")) lines.push(pkt("object-format=sha1\n"));
    lines.push(DELIM, pkt("no-progress\n"), pkt("ofs-delta\n"));
    if (shallow) lines.push(pkt("deepen 1\n"));
    if (filtered) lines.push(pkt("filter blob:none\n"));
    lines.push(pkt(`want ${commit}\n`), pkt("done\n"), FLUSH);
    const response = await this.request("/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Git-Protocol": "version=2" },
      body: streamOf([concat(lines)]),
    }, "application/x-git-upload-pack-result");
    const reader = bodyReader(response);
    const shallowOids: string[] = [];
    try {
      for (;;) {
        const header = text(await reader.expect());
        if (header === "packfile") break;
        if (header !== "shallow-info" && header !== "acknowledgments") throw new GitRemoteError("Git remote sent a malformed fetch response");
        for (let next = await reader.expect(); next.kind !== "delim"; next = await reader.expect()) {
          const line = text(next);
          if (line === undefined) throw new GitRemoteError("Git remote sent a malformed fetch response");
          if (header === "shallow-info" && line.startsWith("shallow ")) shallowOids.push(oid(line.slice(8)));
        }
      }
    } catch (error) {
      await reader.close();
      throw error;
    }
    return { pack: guarded(reader, reader.sideband()), shallow: shallowOids, filtered };
  }

  private async fetchV0(commit: string, advertised: Advertisement): Promise<{ pack: AsyncIterable<Uint8Array>; shallow: string[]; filtered: boolean }> {
    const caps = advertised.capabilities;
    const isTip = [...advertised.refs.values()].includes(commit);
    if (!isTip && !caps.has("allow-reachable-sha1-in-want") && !caps.has("allow-tip-sha1-in-want")) throw new GitRemoteError("Git remote does not allow fetching this commit");
    const sideband = caps.has("side-band-64k"), shallow = caps.has("shallow"), filtered = caps.has("filter");
    const wanted = ["want", commit];
    if (sideband) wanted.push("side-band-64k");
    if (caps.has("ofs-delta")) wanted.push("ofs-delta");
    if (caps.has("no-progress")) wanted.push("no-progress");
    if (shallow) wanted.push("shallow");
    if (filtered) wanted.push("filter");
    wanted.push(`agent=${this.agent}`);
    const lines = [pkt(`${wanted.join(" ")}\n`)];
    if (shallow) lines.push(pkt("deepen 1\n"));
    if (filtered) lines.push(pkt("filter blob:none\n"));
    lines.push(FLUSH, pkt("done\n"));
    const response = await this.request("/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result" },
      body: streamOf([concat(lines)]),
    }, "application/x-git-upload-pack-result");
    const reader = bodyReader(response);
    const shallowOids: string[] = [];
    try {
      if (shallow) {
        for (let next = await reader.expect(); next.kind !== "flush"; next = await reader.expect()) {
          const line = text(next);
          if (line?.startsWith("shallow ")) shallowOids.push(oid(line.slice(8)));
          else if (!line?.startsWith("unshallow ")) throw new GitRemoteError("Git remote sent a malformed fetch response");
        }
      }
      if (text(await reader.expect()) !== "NAK") throw new GitRemoteError("Git remote sent a malformed fetch response");
    } catch (error) {
      await reader.close();
      throw error;
    }
    return { pack: guarded(reader, sideband ? reader.sideband() : reader.rest()), shallow: shallowOids, filtered };
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
