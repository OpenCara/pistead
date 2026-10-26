/**
 * The branch a clone session pushes to without approval, through its host's egress proxy: the one named when it was
 * created (see sessionBranchName), or `pistead/<session-id>` for a session from before that or on an older connector.
 */
export function sessionBranch(session: { id: string; branch?: string | null }): string {
  return session.branch || `pistead/${session.id}`;
}

/** How many characters of the title a session branch keeps, before its short id. */
export const SESSION_BRANCH_SLUG_LIMIT = 48;
const SESSION_BRANCH = /^pistead\/(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[0-9a-f]{8}$/;

/**
 * A new session's branch, named for what it works on: `pistead/<title-slug>-<first 8 hex of its id>`, for example
 * `pistead/add-dark-mode-toggle-1a2b3c4d`. The short id keeps branches of sessions with the same title apart. A title
 * with nothing to slug (or the default "Untitled session") gives `pistead/session-<short id>`. Fixed at creation:
 * renaming the session doesn't move its branch.
 */
export function sessionBranchName(title: string, sessionId: string): string {
  const short = sessionId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase().padEnd(8, "0");
  let slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > SESSION_BRANCH_SLUG_LIMIT) {
    const cut = slug.slice(0, SESSION_BRANCH_SLUG_LIMIT + 1);
    // Cut at a word boundary when one is near enough, so the name doesn't end mid-word.
    const boundary = cut.lastIndexOf("-");
    slug = (boundary >= SESSION_BRANCH_SLUG_LIMIT / 2 ? cut.slice(0, boundary) : cut.slice(0, SESSION_BRANCH_SLUG_LIMIT)).replace(/-+$/, "");
  }
  if (!slug || slug === "untitled-session") slug = "session";
  return `pistead/${slug}-${short}`;
}

/** Whether `branch` is a branch sessionBranchName could have named, for the session with this id. */
export function validSessionBranch(branch: unknown, sessionId: string): branch is string {
  return typeof branch === "string" && branch.length <= 8 + SESSION_BRANCH_SLUG_LIMIT + 9 && SESSION_BRANCH.test(branch)
    && branch.endsWith(`-${sessionId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase().padEnd(8, "0")}`);
}

/** One ref update of a Git push. A zero `new` deletes the ref; a zero `old` creates it. */
export interface PushCommand { old: string; new: string; ref: string }

/** A push request's command section is a few lines; a pack follows it. */
export const PUSH_COMMANDS_BYTES = 64 * 1024;
/** Forges refuse pushes far below this; it bounds what one push can make the proxy and the control plane stream. */
export const PUSH_REQUEST_BYTES = 2 * 1024 * 1024 * 1024;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ZERO_OBJECT = /^0+$/;

/** Thrown for a request that isn't a well-formed push, or one this parser declines (signed pushes). */
export class PushRequestError extends Error {
  constructor(message: string) { super(message); this.name = "PushRequestError"; }
}

/**
 * The ref updates at the start of a `git-receive-pack` request body: pkt-lines up to the first flush, with the
 * capabilities after the first command's NUL and any `shallow` lines skipped. Undefined while `bytes` doesn't hold the
 * whole section yet. A body of just a flush (Git's probe before a chunked upload) has no commands.
 */
export function parsePushCommands(bytes: Uint8Array): { commands: PushCommand[]; capabilities: string[]; end: number } | undefined {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let position = 0;
  for (;;) {
    if (bytes.length < position + 4) return undefined;
    const header = String.fromCharCode(...bytes.subarray(position, position + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new PushRequestError("Invalid Git push request");
    const length = parseInt(header, 16);
    if (length === 0) return { commands, capabilities, end: position + 4 };
    if (length < 5) throw new PushRequestError("Invalid Git push request");
    if (bytes.length < position + length) return undefined;
    let line = new TextDecoder("latin1").decode(bytes.subarray(position + 4, position + length));
    position += length;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (!commands.length) capabilities = line.slice(nul + 1).split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) throw new PushRequestError("Signed pushes are not supported");
    const [old, next, ref, ...rest] = line.split(" ");
    if (rest.length || !OID.test(old ?? "") || !OID.test(next ?? "") || !ref) throw new PushRequestError("Invalid Git push request");
    commands.push({ old: old!, new: next!, ref });
  }
}

/**
 * Reads a push request's command section from `body` (at most PUSH_COMMANDS_BYTES) and returns its commands, with the
 * request rebuilt as a stream: the bytes already read, then the rest of `body`, unchanged.
 */
export async function readPushCommands(body: ReadableStream<Uint8Array>): Promise<{ commands: PushCommand[]; capabilities: string[]; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  let parsed: ReturnType<typeof parsePushCommands>;
  try {
    while (!(parsed = parsePushCommands(head))) {
      if (head.length > PUSH_COMMANDS_BYTES) throw new PushRequestError("The Git push request is invalid or too large");
      const part = await reader.read();
      if (part.done) throw new PushRequestError("The Git push request ended early");
      const next = new Uint8Array(head.length + part.value.length);
      next.set(head);
      next.set(part.value, head.length);
      head = next;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  let first = true;
  return {
    commands: parsed.commands,
    capabilities: parsed.capabilities,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) { first = false; controller.enqueue(head); return; }
        const part = await reader.read();
        if (part.done) controller.close();
        else controller.enqueue(part.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }),
  };
}

/**
 * Reads `body` to its end, discarding it, and returns false if it holds more than `limit` bytes. An HTTP server answers
 * a request it refuses only once the request is read: cancelling the request's stream would close the connection
 * before the client reads the answer.
 */
export async function drainStream(body: ReadableStream<Uint8Array>, limit: number): Promise<boolean> {
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return true;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return false; }
    }
  } catch { return false; }
}

/** `body`, failing once more than `limit` bytes have passed. */
export function boundedStream(body: ReadableStream<Uint8Array>, limit: number, message: string): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) controller.error(new PushRequestError(message));
      else controller.enqueue(chunk);
    },
  }));
}

/**
 * Why a push may not go through the proxy without approval, or undefined when it only creates or moves `branch`:
 * exactly one command, to refs/heads/<branch>, not deleting it.
 */
export function sessionBranchRefusal(commands: readonly PushCommand[], branch: string): string | undefined {
  const ref = `refs/heads/${branch}`;
  const other = commands.find(command => command.ref !== ref);
  if (other?.ref.startsWith("refs/tags/")) {
    return `Tags can't be pushed without approval, not ${other.ref.slice("refs/tags/".length, 200)}; use the git_push tool with a tag for a commit already on its branch`;
  }
  if (other) return `Only this session's branch ${branch} can be pushed without approval, not ${other.ref.replace(/^refs\/heads\//, "").slice(0, 200)}; use the git_push tool for other branches`;
  if (commands.length > 1) return `Push ${branch} once per push`;
  if (commands.some(command => ZERO_OBJECT.test(command.new))) return `The session branch ${branch} can't be deleted`;
  return undefined;
}

function pktLine(payload: Uint8Array): Uint8Array {
  const line = new Uint8Array(payload.length + 4);
  line.set(new TextEncoder().encode((payload.length + 4).toString(16).padStart(4, "0")));
  line.set(payload, 4);
  return line;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/**
 * A receive-pack result that rejects every command with `reason`, as a forge does: Git shows each as
 * "! [remote rejected] … (reason)". Undefined when the client asked for no status report, which can't carry a reason.
 */
export function pushRejection(commands: readonly PushCommand[], capabilities: readonly string[], reason: string): Uint8Array | undefined {
  if (!capabilities.includes("report-status") && !capabilities.includes("report-status-v2")) return undefined;
  const text = reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 400);
  const encoder = new TextEncoder();
  const flush = encoder.encode("0000");
  const report = concat([pktLine(encoder.encode("unpack ok\n")),
    ...commands.map(command => pktLine(encoder.encode(`ng ${command.ref} ${text}\n`))), flush]);
  if (!capabilities.includes("side-band-64k") && !capabilities.includes("side-band")) return report;
  // The report travels on band 1, in packets of at most 1000 bytes (side-band) or 65520 (side-band-64k).
  const size = capabilities.includes("side-band-64k") ? 65515 : 995;
  const packets: Uint8Array[] = [];
  for (let offset = 0; offset < report.length; offset += size) packets.push(pktLine(concat([new Uint8Array([1]), report.subarray(offset, offset + size)])));
  return concat([...packets, flush]);
}
