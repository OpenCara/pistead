import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { repositoryLimits, type GitProvider, type SessionRepository } from "../../../packages/shared/src/repositories.js";
import { hostGitAuthorization } from "./git-credentials.js";
import { GitRemote, ProgressLines, parseGitProgress, type GitProgressPhase } from "./git-remote.js";
import { RunnerError } from "./protocol.js";

/**
 * Host repository cache (docs/design/repository-cache.md). One bare repository per provider repository
 * identity, holding full history with every blob, so sessions that borrow its objects through
 * `objects/info/alternates` never need the remote or a credential.
 *
 * Only the runner writes here, outside any sandbox. Fetches use the HOST's own Git credentials
 * (`hostGitAuthorization`); the control plane never sends a read credential. Whether a session's owner may
 * use a cached repository is decided by the server for every session, before `ensure` is called.
 */

export type RepositoryCacheScope = "host" | "owner";

export type RepositoryCachePhase = "waiting" | "connecting" | GitProgressPhase | "verifying" | "done";

/** Progress of one repository; only structured numbers, never remote text. */
export interface RepositoryCacheProgress {
  path: string;
  phase: RepositoryCachePhase;
  percent: number | null;
  done: number | null;
  total: number | null;
  /** Pack bytes received so far by this fetch. */
  bytes: number;
}

export interface RepositoryCacheTarget {
  pin: SessionRepository;
  ownerId: string;
  sessionId: string;
  /** Non-secret https clone URL of the pinned repository, supplied by the control plane. */
  remote: string;
}

export interface RepositoryCacheOptions {
  /** Absolute, runner-owned, private directory. */
  root: string;
  scope?: RepositoryCacheScope;
  /** Host credential lookup; defaults to the host user's Git credential helpers. */
  authorization?: (remote: string, signal?: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  /** Minimum interval between progress callbacks of the same phase. */
  progressIntervalMs?: number;
}

/** A workspace repository a clone session's mirror is kept for: the provider identity, never a pin. */
export interface MirrorRepository { provider: GitProvider; host: string; repositoryId: string; fullName: string }
export interface MirrorTarget {
  repository: MirrorRepository; ownerId: string; sessionId: string;
  /** Reaches the repository with the session owner's access, through the control plane's relay. */
  remote: GitRemote;
}
/** One cached repository as `pistead cache list` shows it. */
export interface CachedRepository { directory: string; bytes: number; sessions: number; pins: number }

export class RepositoryCacheError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryCacheError"; }
}

/**
 * The control plane's answer to a repository cache authorization (`repositoryAuthorize` on the server): the pin it
 * re-checked and its credential-free remote. Never a credential, never content.
 */
export interface RepositoryAuthorization { bindingId: string; commit: string; remote: string }

export function repositoryAuthorization(value: unknown): RepositoryAuthorization {
  const outer = value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join() === "repository" ? (value as { repository: unknown }).repository : undefined;
  if (!outer || typeof outer !== "object" || Array.isArray(outer) || Object.keys(outer).sort().join() !== "bindingId,commit,remote") throw new RunnerError(502, "Invalid repository authorization");
  const { bindingId, commit, remote } = outer as Record<string, unknown>;
  if (typeof bindingId !== "string" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || typeof remote !== "string" || remote.length > 2048) {
    throw new RunnerError(502, "Invalid repository authorization");
  }
  return { bindingId, commit, remote };
}

/** What checking out one pinned tree writes; `inspect` subtracts it from the session's remaining budget. */
export interface PinnedTreeSummary { entries: number; bytes: number; symlinks: number; submodules: number }
export interface CheckoutBudget { entries: number; bytes: number }

export function checkoutBudget(): CheckoutBudget {
  return { entries: repositoryLimits.checkoutEntries, bytes: repositoryLimits.checkoutBytes };
}

const OID = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 60 * 1000;
const LOCK_POLL_MS = 250;
const LOCK_NAME = "pistead.lock";
const PIN_PREFIX = "refs/pistead/pins/";
/** A clone session's keep ref: a commit whose parents are the branch tips it saw, so its borrowed objects stay. */
const SESSION_PREFIX = "refs/pistead/sessions/";
const UPSTREAM_PREFIX = "refs/upstream/";
const CAPTURE_BYTES = 64 * 1024 * 1024;

type Listener = (progress: RepositoryCacheProgress) => void;

export class RepositoryCache {
  readonly #root: string;
  readonly #scope: RepositoryCacheScope;
  readonly #authorization: (remote: string, signal?: AbortSignal) => Promise<string>;
  readonly #fetch: typeof fetch | undefined;
  readonly #interval: number;
  /** Per cache repository: the tail of its serialized operations, and who is watching the current one. */
  readonly #queues = new Map<string, { tail: Promise<void>; listeners: Set<Listener>; last: RepositoryCacheProgress | undefined }>();

  constructor(options: RepositoryCacheOptions) {
    if (!isAbsolute(options.root) || resolve(options.root) === sep) throw new RepositoryCacheError("Repository cache root must be an absolute, non-root path");
    this.#root = resolve(options.root);
    this.#scope = options.scope ?? "host";
    if (this.#scope !== "host" && this.#scope !== "owner") throw new RepositoryCacheError("Repository cache scope must be host or owner");
    this.#authorization = options.authorization ?? ((remote, signal) => hostGitAuthorization(remote, { signal }));
    this.#fetch = options.fetch;
    this.#interval = options.progressIntervalMs ?? 250;
  }

  get scope(): RepositoryCacheScope { return this.#scope; }

  /** Bare repository directory of a pin; owner-scoped caches never share a directory across owners. */
  directory(pin: SessionRepository, ownerId: string): string {
    return this.#directory("provider" in pin ? pin.provider : "github", "provider" in pin ? pin.host : "github.com", String(pin.repositoryId), ownerId);
  }

  /** Bare repository directory of a clone session's mirror: the same one a pin of that repository uses. */
  mirrorDirectory(repository: MirrorRepository, ownerId: string): string {
    return this.#directory(repository.provider, repository.host, repository.repositoryId, ownerId);
  }

  #directory(provider: string, host: string, id: string, ownerId: string): string {
    if (!/^[a-z0-9-]{1,32}$/.test(provider) || !/^[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/.test(host) || !/^[A-Za-z0-9{}_-]{1,100}$/.test(id)) {
      throw new RepositoryCacheError("Repository pin cannot name a cache directory");
    }
    const base = this.#scope === "owner" ? join(this.#root, "owners", digest(ownerId)) : this.#root;
    return join(base, provider, host.replace(":", "_"), `${id}.git`);
  }

  /** Objects directory a session lists in `objects/info/alternates` once `ensure` has succeeded. */
  objects(pin: SessionRepository, ownerId: string): string {
    return join(this.directory(pin, ownerId), "objects");
  }

  /**
   * Makes the pinned commit and its full history available in the cache and records a pin ref for the session.
   * Fetches only when the commit is missing. Concurrent callers for one repository are serialized, and a caller
   * that waits sees the progress of the operation in front of it.
   */
  async ensure(target: RepositoryCacheTarget, options: { onProgress?: Listener; signal?: AbortSignal } = {}): Promise<{ objects: string; fetched: boolean }> {
    const { pin, ownerId, sessionId } = target;
    if (!OID.test(pin.commit)) throw new RepositoryCacheError("Repository pin has no commit");
    const directory = this.directory(pin, ownerId);
    const report = throttle(options.onProgress, this.#interval);
    return this.#serialized(directory, pin.path, report, options.signal, async (emit) => {
      await this.#prepare(directory);
      const git = cacheGit(directory, options.signal);
      if (await git.objectType(pin.commit) === "commit") {
        await git.run(["update-ref", "--no-deref", pinRef(sessionId), pin.commit]);
        emit({ phase: "done", percent: 100, done: null, total: null, bytes: 0 });
        return { objects: join(directory, "objects"), fetched: false };
      }
      await this.#fetchInto(git, target, emit, options.signal);
      return { objects: join(directory, "objects"), fetched: true };
    });
  }

  /**
   * Checks that the pinned tree is safe to check out, before anything is written to a session (see `inspectPinnedTree`).
   * A commit's tree never changes, so this needs no lock; the pin ref keeps the commit from being collected meanwhile.
   */
  async inspect(pin: SessionRepository, ownerId: string, budget: CheckoutBudget, signal?: AbortSignal): Promise<PinnedTreeSummary> {
    if (!OID.test(pin.commit)) throw new RepositoryCacheError("Repository pin has no commit");
    return inspectPinnedTree(cacheGit(this.directory(pin, ownerId), signal), pin, budget);
  }

  /**
   * Brings a clone session's mirror up to date with every branch and tag the remote advertises, and records the
   * session's keep ref. Fetches only what is new; serialized with every other operation on the repository.
   */
  async refresh(target: MirrorTarget, options: { onProgress?: Listener; signal?: AbortSignal } = {}): Promise<{ directory: string; fetched: boolean }> {
    const directory = this.mirrorDirectory(target.repository, target.ownerId);
    return this.#serialized(directory, target.repository.fullName, throttle(options.onProgress, this.#interval), options.signal, async (emit) => {
      await this.#prepare(directory);
      const git = cacheGit(directory, options.signal);
      emit({ phase: "connecting", percent: null, done: null, total: null, bytes: 0 });
      const advertised = await target.remote.listRefs();
      const before = await git.objectTypes([...advertised.values()]);
      const wants = [...before].filter(([, type]) => type === null).map(([id]) => id);
      const bytes = wants.length ? await this.#fetchObjects(git, target.remote, wants, emit) : 0;
      await this.#updateUpstream(git, advertised, []);
      // Its branch tips as of now: whatever a clone of this session borrowed stays until prune drops the keep ref.
      const heads = [...new Set([...advertised].filter(([ref]) => ref.startsWith("refs/heads/")).map(([, id]) => id))];
      const present = await git.objectTypes(heads);
      const parents = heads.filter(id => present.get(id) === "commit");
      const ref = `${SESSION_PREFIX}${digest(target.sessionId)}`;
      if (parents.length) {
        const tree = (await git.capture(["mktree"])).trim();
        const keep = (await git.capture(["-c", "user.name=Pistead", "-c", "user.email=pistead@localhost", "commit-tree", tree,
          ...parents.flatMap(id => ["-p", id]), "-m", "Objects a clone session borrows"])).trim();
        if (!OID.test(keep)) throw new RepositoryCacheError("The session's keep ref could not be written");
        await git.run(["update-ref", "--no-deref", ref, keep]);
      }
      emit({ phase: "done", percent: 100, done: null, total: null, bytes });
      return { directory, fetched: wants.length > 0 };
    });
  }

  /** Every cached repository, with its size and how many sessions and pins keep objects in it. */
  async list(): Promise<CachedRepository[]> {
    const repositories: CachedRepository[] = [];
    for (const directory of await cacheRepositories(this.#root)) {
      const refs = (await cacheGit(directory).capture(["for-each-ref", "--format=%(refname)", SESSION_PREFIX, PIN_PREFIX])).split("\n").filter(Boolean);
      repositories.push({ directory, bytes: await directorySize(directory), sessions: refs.filter(ref => ref.startsWith(SESSION_PREFIX)).length,
        pins: refs.filter(ref => ref.startsWith(PIN_PREFIX)).length });
    }
    return repositories;
  }

  /**
   * Drops clone sessions' keep refs older than `age` and collects what no ref reaches any more, past the same age.
   * A clone in a session idle for longer loses the objects it borrowed. Pins are never dropped.
   */
  async prune(age: number): Promise<{ repositories: number; sessions: number }> {
    if (!Number.isSafeInteger(age) || age < 0) throw new RepositoryCacheError("Invalid prune age");
    const cutoff = Math.floor((Date.now() - age) / 1000);
    let repositories = 0, sessions = 0;
    for (const directory of await cacheRepositories(this.#root)) {
      await this.#serialized(directory, basename(directory), undefined, undefined, async () => {
        const git = cacheGit(directory);
        const stale = (await git.capture(["for-each-ref", "--format=%(committerdate:unix) %(refname)", SESSION_PREFIX])).split("\n")
          .map(line => line.split(" ") as [string, string]).filter(([date, ref]) => ref && Number(date) <= cutoff).map(([, ref]) => ref);
        if (stale.length) await git.run(["update-ref", "--no-deref", "--stdin"], `${stale.map(ref => `delete ${ref}`).join("\n")}\n`);
        await git.run(["gc", "--quiet", `--prune=${cutoff}`]);
        repositories++;
        sessions += stale.length;
      });
    }
    return { repositories, sessions };
  }

  /** Drops a session's pin ref so cache gc may later reclaim objects only it reached. */
  async release(target: Omit<RepositoryCacheTarget, "remote">): Promise<void> {
    const directory = this.directory(target.pin, target.ownerId);
    try {
      if (!(await lstat(directory)).isDirectory()) return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await this.#serialized(directory, target.pin.path, undefined, undefined, async () => {
      await cacheGit(directory).run(["update-ref", "--no-deref", "-d", pinRef(target.sessionId)]);
    });
  }

  async #fetchInto(git: CacheGit, target: RepositoryCacheTarget, emit: (progress: Omit<RepositoryCacheProgress, "path">) => void, signal?: AbortSignal): Promise<void> {
    const { pin, sessionId } = target;
    emit({ phase: "connecting", percent: null, done: null, total: null, bytes: 0 });
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // The host's credential lives only in this object for this one fetch.
    const remote = new GitRemote({ url: target.remote, authorization: await this.#authorization(target.remote, deadline), fetch: this.#fetch, signal: deadline });
    const advertised = await remote.listRefs();
    const before = await git.objectTypes([pin.commit, ...advertised.values()]);
    const wants = [...before].filter(([, type]) => type === null).map(([id]) => id);
    const bytes = await this.#fetchObjects(git, remote, wants, emit);
    if (await git.objectType(pin.commit) !== "commit") throw new RepositoryCacheError("The fetched history does not contain the pinned commit");
    await this.#updateUpstream(git, advertised, [`update ${pinRef(sessionId)} ${pin.commit}`]);
    emit({ phase: "done", percent: 100, done: null, total: null, bytes });
  }

  /** Fetches `wants` and their history into the cache, checked complete like `git fetch` does; returns the pack's size. */
  async #fetchObjects(git: CacheGit, remote: GitRemote, wants: string[], emit: (progress: Omit<RepositoryCacheProgress, "path">) => void): Promise<number> {
    const haves = (await git.capture(["for-each-ref", "--format=%(objecttype) %(objectname)", "--sort=-committerdate", UPSTREAM_PREFIX]))
      .split("\n").filter(line => line.startsWith("commit ")).map(line => line.slice(7));
    let bytes = 0;
    let phase: Omit<RepositoryCacheProgress, "path"> = { phase: "connecting", percent: null, done: null, total: null, bytes };
    const update = (line: string) => {
      const parsed = parseGitProgress(line);
      if (!parsed) return;
      phase = { ...parsed, bytes };
      emit(phase);
    };
    const pack = await remote.fetchHistory({ wants, haves, onProgress: update });
    const counted = (async function* () {
      for await (const chunk of pack) {
        bytes += chunk.length;
        if (phase.phase !== "receiving") phase = { phase: "receiving", percent: null, done: null, total: null, bytes };
        emit({ ...phase, bytes });
        yield chunk;
      }
    })();
    // index-pack -v reports "Receiving objects" and "Resolving deltas" on stderr.
    await git.run(["index-pack", "--stdin", "-v", "--fix-thin"], counted, update);
    emit({ phase: "verifying", percent: null, done: null, total: null, bytes });
    // The same connectivity check `git fetch` performs: everything new must be complete in this repository.
    // "^oid" lines rather than "--not", which older Git does not accept on rev-list's stdin.
    await git.run(["rev-list", "--objects", "--quiet", "--stdin"], [...wants, ...haves.map(id => `^${id}`), ""].join("\n"));
    return bytes;
  }

  /** Mirrors the advertised branches and tags as refs/upstream/*, keeping only those whose objects are here. */
  async #updateUpstream(git: CacheGit, advertised: Map<string, string>, extra: string[]): Promise<void> {
    const after = await git.objectTypes([...advertised.values()]);
    const current = new Map((await git.capture(["for-each-ref", "--format=%(refname) %(objectname)", UPSTREAM_PREFIX]))
      .split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]));
    const updates: string[] = [];
    for (const [ref, id] of advertised) {
      const local = `${UPSTREAM_PREFIX}${ref.slice("refs/".length)}`;
      // A tip the remote refused to send (e.g. a hidden ref) is simply not mirrored.
      if (current.get(local) !== id && after.get(id)) updates.push(`update ${local} ${id}`);
      current.delete(local);
    }
    const deletes = [...current.keys()].map(ref => `delete ${ref}`);
    // Deletes commit first, on their own: a branch renamed from feature/login to feature (or back) is a file/directory
    // conflict that Git refuses inside one transaction, in either order.
    if (deletes.length) await git.run(["update-ref", "--no-deref", "--stdin"], `${deletes.join("\n")}\n`);
    updates.push(...extra);
    if (updates.length) await git.run(["update-ref", "--no-deref", "--stdin"], `${updates.join("\n")}\n`);
  }

  /** Creates the cache root privately and initializes the bare repository atomically. */
  async #prepare(directory: string): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#root);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) {
      throw new RepositoryCacheError("Repository cache root must be a private directory owned by the runner user");
    }
    const parent = resolve(directory, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(join(directory, "HEAD"));
      if (!info.isFile()) throw new RepositoryCacheError("Repository cache entry is not a Git repository");
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const staging = `${directory}.init-${randomBytes(8).toString("hex")}`;
    try {
      await runGit(staging, ["init", "--quiet", "--bare", "--template=", staging], { cwd: parent });
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // Another runner process may have won the race; its repository is as good as ours.
      if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") return;
      throw error;
    }
  }

  /**
   * Serializes operations per cache repository: in-process with a promise chain, and across runner processes
   * with an exclusive lock file holding the owner's pid (stale locks of dead processes are taken over).
   */
  async #serialized<T>(directory: string, path: string, listener: Listener | undefined, signal: AbortSignal | undefined,
    operation: (emit: (progress: Omit<RepositoryCacheProgress, "path">) => void) => Promise<T>): Promise<T> {
    let queue = this.#queues.get(directory);
    if (!queue) { queue = { tail: Promise.resolve(), listeners: new Set(), last: undefined }; this.#queues.set(directory, queue); }
    const state = queue;
    if (listener) {
      state.listeners.add(listener);
      // Someone else's fetch is running: show it rather than a blank wait.
      listener(state.last ? { ...state.last, path } : { path, phase: "waiting", percent: null, done: null, total: null, bytes: 0 });
    }
    const emit = (progress: Omit<RepositoryCacheProgress, "path">) => {
      state.last = { ...progress, path };
      for (const each of state.listeners) each({ ...progress, path });
    };
    const result = state.tail.then(async () => {
      state.last = undefined;
      signal?.throwIfAborted();
      const release = await acquireLock(directory, signal);
      try { return await operation(emit); } finally { await release(); }
    });
    const settled = result.then(() => undefined, () => undefined);
    state.tail = settled;
    try {
      return await result;
    } finally {
      if (listener) state.listeners.delete(listener);
      if (state.tail === settled && !state.listeners.size) this.#queues.delete(directory);
    }
  }
}

/** The bare repositories below a cache root: `<provider>/<host>/<id>.git`, also under `owners/<owner>/`. */
async function cacheRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const children = async (directory: string): Promise<string[]> => {
    try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name)); }
    catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
  };
  const visit = async (base: string) => {
    for (const provider of await children(base)) {
      if (basename(provider) === "owners") continue;
      for (const host of await children(provider)) {
        for (const repository of await children(host)) if (/^[A-Za-z0-9{}_-]{1,100}\.git$/.test(basename(repository))) found.push(repository);
      }
    }
  };
  await visit(root);
  for (const owner of await children(join(root, "owners"))) await visit(owner);
  return found.sort();
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await lstat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

function pinRef(sessionId: string): string {
  if (typeof sessionId !== "string" || !sessionId) throw new RepositoryCacheError("Invalid session id");
  return `${PIN_PREFIX}${digest(sessionId)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Forwards every phase change and "done" at once, otherwise at most one update per interval. */
function throttle(listener: Listener | undefined, interval: number): Listener | undefined {
  if (!listener) return undefined;
  let last = 0;
  let phase: RepositoryCachePhase | undefined;
  return (progress) => {
    const now = Date.now();
    if (progress.phase !== phase || progress.phase === "done" || now - last >= interval) {
      last = now;
      phase = progress.phase;
      listener(progress);
    }
  };
}

/**
 * One lock file per cache repository holding its owner's pid. The connector's lease already keeps a second runner off
 * the same state directory, so this guards custom roots and tests. The lock appears atomically with its pid (written to
 * a private file, then hard-linked into place), so it is never seen empty. A dead or own pid is stale; content that is
 * not a pid is stale only if the very same file still holds it one poll later.
 */
async function acquireLock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const parent = resolve(directory, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const name = `${basename(directory)}.${LOCK_NAME}`;
  const path = join(parent, name);
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let suspect: { ino: number; content: string } | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const claim = join(parent, `.${name}.${randomBytes(8).toString("hex")}`);
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(claim, path);
      return async () => { await unlink(path).catch(() => undefined); };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      await unlink(claim).catch(() => undefined);
    }
    let held: { ino: number; content: string };
    try {
      const info = await lstat(path);
      held = { ino: info.ino, content: await readFile(path, "utf8") };
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const holder = /^[1-9][0-9]{0,9}\n$/.test(held.content) ? Number(held.content) : 0;
    // In-process callers are already serialized, so our own pid here can only be a lock left by a crash.
    const stale = holder ? holder === process.pid || !alive(holder) : suspect?.ino === held.ino && suspect.content === held.content;
    if (stale) {
      await unlink(path).catch(() => undefined);
      suspect = undefined;
      continue;
    }
    suspect = holder ? undefined : held;
    if (Date.now() > deadline) throw new RepositoryCacheError("Timed out waiting for another process to finish fetching this repository");
    await new Promise(resolveWait => setTimeout(resolveWait, LOCK_POLL_MS));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; }
}

interface CacheGit {
  run(args: string[], input?: string | AsyncIterable<Uint8Array>, onProgress?: (line: string) => void): Promise<void>;
  capture(args: string[]): Promise<string>;
  /** Stdout goes to `onStdout` instead of memory; if it throws, Git is killed and the call fails with that error. */
  stream(args: string[], onStdout: (chunk: Buffer) => void): Promise<void>;
  /** Raw stdout for binary output such as `cat-file --batch`. */
  batch(args: string[], input: string): Promise<Buffer>;
  objectType(id: string): Promise<string | null>;
  /** Types of many objects in one process; null for a missing object. */
  objectTypes(ids: readonly string[]): Promise<Map<string, string | null>>;
}

function cacheGit(directory: string, signal?: AbortSignal): CacheGit {
  return {
    run: async (args, input, onProgress) => { await runGit(directory, args, { input, onProgress, signal }); },
    capture: async (args) => (await runGit(directory, args, { signal })).stdout.toString("utf8"),
    stream: async (args, onStdout) => { await runGit(directory, args, { signal, onStdout }); },
    batch: async (args, input) => (await runGit(directory, args, { signal, input })).stdout,
    objectType: async (id) => {
      if (!OID.test(id)) return null;
      const result = await runGit(directory, ["cat-file", "-t", id], { signal, allowFailure: true });
      return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    },
    objectTypes: async (ids) => {
      const unique = [...new Set(ids)];
      if (unique.some(id => !OID.test(id))) throw new RepositoryCacheError("Invalid object id");
      const types = new Map<string, string | null>(unique.map(id => [id, null]));
      if (!unique.length) return types;
      const output = (await runGit(directory, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { signal, input: `${unique.join("\n")}\n` })).stdout.toString("utf8");
      for (const line of output.split("\n")) {
        const [id, type] = line.split(" ");
        if (id && type && type !== "missing" && types.has(id)) types.set(id, type);
      }
      return types;
    },
  };
}

/**
 * Git against one cache repository with the same hardening as push scratch repositories: no global or system
 * config, no hooks, no credential helpers, no protocols (all network traffic goes through GitRemote).
 */
function runGit(directory: string, args: string[], options: {
  input?: string | AsyncIterable<Uint8Array>; onProgress?: (line: string) => void; onStdout?: (chunk: Buffer) => void;
  signal?: AbortSignal; allowFailure?: boolean; cwd?: string;
}): Promise<{ code: number | null; stdout: Buffer }> {
  // A signal can be aborted before it is ever listened to; then Git must not start at all.
  if (options.signal?.aborted) return Promise.reject(new RepositoryCacheError("Repository cache operation was cancelled"));
  const child = spawn("git", ["--no-pager",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null", "-c", "core.sshCommand=/usr/bin/false",
    "-c", "credential.helper=", "-c", "protocol.allow=never",
    "-c", "core.pager=cat", "-c", "core.editor=/usr/bin/false",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.fsckObjects=false",
    "-c", "transfer.fsckObjects=false", "-c", "core.bigFileThreshold=64m",
    "-c", `safe.directory=${directory}`,
    ...(args[0] === "init" ? [] : [`--git-dir=${directory}`]), ...args], {
    cwd: options.cwd ?? directory, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const { promise, resolve: done, reject } = Promise.withResolvers<{ code: number | null; stdout: Buffer }>();
  const stdout: Buffer[] = [];
  let size = 0;
  let failure: Error | undefined;
  const kill = (reason: Error) => {
    failure ??= reason;
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => kill(new RepositoryCacheError("Git exceeded its time limit in the repository cache")), GIT_TIMEOUT_MS);
  const abort = () => kill(new RepositoryCacheError("Repository cache operation was cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    if (options.onStdout) {
      try { options.onStdout(chunk); } catch (error) { kill(error instanceof Error ? error : new RepositoryCacheError("Git output could not be processed")); }
      return;
    }
    size += chunk.length;
    if (size > CAPTURE_BYTES) kill(new RepositoryCacheError("Git output exceeds its limit in the repository cache"));
    else stdout.push(chunk);
  });
  const progress = options.onProgress ? new ProgressLines(options.onProgress) : undefined;
  child.stderr.on("data", (chunk: Buffer) => progress?.push(chunk));
  child.stdin.on("error", () => { /* Early exit closes stdin; the exit status is authoritative. */ });
  child.once("error", () => { clearTimeout(timer); reject(new RepositoryCacheError("Git could not be started on this host")); });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    progress?.end();
    if (failure) reject(failure);
    else if (signal || (code !== 0 && !options.allowFailure)) reject(new RepositoryCacheError(`Git ${args[0]} failed in the repository cache`));
    else done({ code, stdout: Buffer.concat(stdout) });
  });
  if (options.input === undefined || typeof options.input === "string") child.stdin.end(options.input ?? "");
  else {
    const input = options.input;
    let exited = false;
    child.once("close", () => { exited = true; });
    // Resolves on drain, or when Git exits or its stdin closes or fails: a full pipe to a dead process never drains.
    const writable = () => new Promise<void>(resolveWritable => {
      const settle = () => {
        child.stdin.off("drain", settle).off("close", settle).off("error", settle);
        child.off("close", settle);
        resolveWritable();
      };
      child.stdin.once("drain", settle).once("close", settle).once("error", settle);
      child.once("close", settle);
    });
    void (async () => {
      // Leaving the loop early returns the source, which closes the download behind it.
      for await (const chunk of input) {
        if (exited || child.stdin.destroyed) break;
        if (!child.stdin.write(chunk)) await writable();
        if (exited || child.stdin.destroyed) break;
      }
      if (!child.stdin.destroyed) child.stdin.end();
    })().catch(error => kill(error instanceof Error ? error : new RepositoryCacheError("Repository fetch failed")));
  }
  return promise;
}

const REGULAR_MODES = new Set(["100644", "100755", "100664"]);
const MAX_TREE_RECORD = 8192;

/**
 * Checks one pinned tree in the cache before any of it is checked out into a session, with the archive parser's path
 * rules: no traversal, empty or dot components, control characters, backslashes or ":" in paths, no ".git" component
 * (or its NTFS short and trailing-dot spellings), bounded depth and length, and UTF-8 names. Entries must be regular
 * files, symlinks or submodules; submodules check out as empty directories, as archives left them. Symlinks are
 * checked out for real, so each target must be relative and resolve lexically inside its own repository.
 */
async function inspectPinnedTree(git: CacheGit, pin: SessionRepository, budget: CheckoutBudget): Promise<PinnedTreeSummary> {
  const summary: PinnedTreeSummary = { entries: 0, bytes: 0, symlinks: 0, submodules: 0 };
  const destination = pin.path.split("/");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const links: { oid: string; parts: string[]; size: number }[] = [];
  const malformed = () => new RepositoryCacheError("Repository tree listing is malformed");
  const entry = (raw: Buffer) => {
    const tab = raw.indexOf(9);
    const meta = tab < 0 ? [] : raw.subarray(0, tab).toString("latin1").split(/ +/);
    if (meta.length !== 4) throw malformed();
    const [mode, type, oid, size] = meta as [string, string, string, string];
    let name: string;
    try { name = decoder.decode(raw.subarray(tab + 1)); } catch { throw new RepositoryCacheError("Repository tree contains a path that is not UTF-8"); }
    const parts = checkoutParts(name);
    if (destination.length + parts.length > 64 || Buffer.byteLength(`${pin.path}/${name}`) > 1024) {
      throw new RepositoryCacheError("Repository tree path exceeds the path or depth limit");
    }
    if (!OID.test(oid)) throw malformed();
    if (++summary.entries > budget.entries) throw new RepositoryCacheError("Repository checkout has too many entries");
    if (mode === "160000" && type === "commit") { summary.submodules += 1; return; }
    if (type !== "blob" || !/^[0-9]{1,15}$/.test(size)) throw new RepositoryCacheError("Repository tree contains an unsupported entry");
    const bytes = Number(size);
    if (REGULAR_MODES.has(mode)) {
      if (bytes > repositoryLimits.checkoutFileBytes) throw new RepositoryCacheError("Repository file exceeds the checkout size limit");
    } else if (mode === "120000") {
      if (bytes < 1 || bytes > 1024) throw new RepositoryCacheError("Repository symlink target is empty or too long");
      summary.symlinks += 1;
      links.push({ oid, parts, size: bytes });
    } else {
      throw new RepositoryCacheError("Repository tree contains an unsupported entry");
    }
    summary.bytes += bytes;
    if (summary.bytes > budget.bytes) throw new RepositoryCacheError("Repository checkout exceeds its size limit");
  };
  let pending: Buffer = Buffer.alloc(0);
  await git.stream(["ls-tree", "-r", "-z", "-l", "--full-tree", pin.commit], chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(0); end >= 0; end = pending.indexOf(0, start)) {
      entry(pending.subarray(start, end));
      start = end + 1;
    }
    pending = Buffer.from(pending.subarray(start));
    if (pending.length > MAX_TREE_RECORD) throw new RepositoryCacheError("Repository tree path exceeds the path or depth limit");
  });
  if (pending.length) throw malformed();
  if (links.length) {
    const output = await git.batch(["cat-file", "--batch"], links.map(link => `${link.oid}\n`).join(""));
    let offset = 0;
    for (const link of links) {
      const newline = output.indexOf(10, offset);
      const body = newline < 0 ? Buffer.alloc(0) : output.subarray(newline + 1, newline + 1 + link.size);
      if (newline < 0 || output.subarray(offset, newline).toString("latin1") !== `${link.oid} blob ${link.size}`
        || body.length !== link.size || output[newline + 1 + link.size] !== 10) {
        throw new RepositoryCacheError("Repository symlink could not be read");
      }
      offset = newline + 2 + link.size;
      let target: string;
      try { target = decoder.decode(body); } catch { throw new RepositoryCacheError("Repository symlink target is not UTF-8"); }
      symlinkTarget(link.parts, target);
    }
  }
  return summary;
}

/** ".git" in any spelling Git itself treats as the repository directory on some filesystem. */
function reservedGitName(part: string): boolean {
  const name = part.toLowerCase().replace(/[. ]+$/, "");
  return name === ".git" || name === "git~1";
}

function checkoutParts(value: string): string[] {
  if (!value || Buffer.byteLength(value) > 1024 || value.startsWith("/") || value.includes("\\")) {
    throw new RepositoryCacheError("Repository tree contains an invalid path");
  }
  const parts = value.split("/");
  if (parts.length > 64 || parts.some(part => part === "" || part === "." || part === ".." || Buffer.byteLength(part) > 255)) {
    throw new RepositoryCacheError("Repository tree path traversal or depth limit");
  }
  if (/[\x00-\x1f\x7f]/.test(value) || parts.some(part => part.includes(":"))) throw new RepositoryCacheError("Repository tree contains an invalid path");
  if (parts.some(reservedGitName)) throw new RepositoryCacheError("Repository tree contains reserved Git metadata");
  return parts;
}

/** A symlink resolves lexically inside its repository: ".." may never climb above the repository root. */
function symlinkTarget(path: readonly string[], link: string): string[] {
  if (!link || link.startsWith("/") || link.includes("\\") || /[\x00-\x1f\x7f]/.test(link)) {
    throw new RepositoryCacheError("Repository symlink target must be a relative path");
  }
  const parts = path.slice(0, -1);
  for (const part of link.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new RepositoryCacheError("Repository symlink escapes its repository");
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw new RepositoryCacheError("Repository symlink escapes its repository");
  if (parts.some(reservedGitName)) throw new RepositoryCacheError("Repository symlink points into Git metadata");
  return parts;
}
