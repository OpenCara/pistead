import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import { validCloneDirectory } from "../../../packages/shared/src/repositories.js";
import type { HostCommandOperation, Operation, RunnerBinding } from "../../../packages/shared/src/types.js";
import { checkedBrowse, type BrowseResult } from "./file-browser.js";
import { commandLimits, type CommandLimits } from "./host-config.js";
import { runHostShell } from "./host-shell.js";
import { imageType, type FileContent } from "./images.js";
import { killTree, privateEntry } from "./platform.js";
import { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";
import type { ClonePushPreparation } from "./push.js";
import {
  CA_BUNDLE_FILE, MAX_CONTENT_OUTPUT_BYTES, MAX_FILE_BYTES, MAX_SNAPSHOT_OUTPUT_BYTES, OID, PUSH_TIMEOUT_MS, TIMEOUT_MS, ownerGitConfig, pinOwnerConfig,
  sessionEnvironment, text, type CloneBackup, type SandboxAuthorize, type SandboxExecutionOptions, type SandboxIdentity, type SandboxRequest,
  type SnapshotFile,
} from "./sandbox.js";
import { trustedCertificates } from "./trust-store.js";
import type { IsolatedWorkspace } from "./workspace.js";

/** Where a helper backend keeps one session, all below its private root, at the same paths inside the sandbox. */
export interface HelperLayout {
  root: string;
  home: string;
  worktree: string;
  /** The session's own Git directory; the worktree's `.git` is a `gitdir:` file pointing here. */
  git: string;
  /** The owner's Git config, read-only to the session (GIT_CONFIG_GLOBAL). */
  ownerConfig: string;
  /** Runner-written helper files (the helper script, shims), read-only to the session. */
  bin: string;
  /** The host's trusted certificates, read-only to the session. */
  caBundle: string;
}

/** What one helper run may do, decided by the workspace for each request. */
export interface HelperContext {
  /** The session's home and worktree are read-only. */
  readOnly: boolean;
  /** The session's Git directory is writable (Git steps of the workspace itself). */
  gitWritable: boolean;
  /** The run reaches the egress proxy (shell commands, clone restores). */
  egress: boolean;
  /** A shell command's limits, from the host's configuration. */
  limits?: CommandLimits;
  /** The run's wall-clock deadline. */
  deadlineMs: number;
  /** The session's environment, without anything backend-specific. */
  environment: Readonly<Record<string, string>>;
}

/** How a backend starts one helper process: the process, and what to do once it exists, before the request is sent. */
export interface HelperLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /**
   * Runs once the process exists, before the request line is written; its result is written first. Windows puts the
   * process in its job here and only then sends the container configuration, so nothing runs outside the job's limits.
   */
  started?: (child: ChildProcess) => Promise<string | undefined>;
  /** Releases what `started` set up, when the process has ended. */
  finished?: () => void;
}

export interface HelperBackend {
  /** Named in errors and in `identity`. */
  readonly name: string;
  /** Whether shell commands run under hard per-session limits (Windows job objects); without them only the owner can let one run. */
  readonly limitedShell: boolean;
  /** Request kinds this backend's helper runs; others are refused with `unsupported`. */
  supports(kind: SandboxRequest["kind"]): boolean;
  /** The PATH for session commands. */
  readonly path: string;
  /** Writes the backend's files below `layout` (the helper script, shims); called at every initialization. */
  prepare(layout: HelperLayout): Promise<void>;
  launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch>;
}

export interface HelperWorkspaceOptions {
  /** The session's egress proxy, when it has one; shell commands reach it through `egressEnvironment`. */
  egressEnvironment?: () => Record<string, string> | undefined;
}

const queues = new Map<string, Promise<void>>();

/**
 * A session's sandbox on a backend that runs a helper for every step (macOS Seatbelt, native Windows): the same steps,
 * checks and limits as the Linux sandbox, with the boundary drawn by the backend. All untrusted filesystem access
 * happens in the helper, inside the boundary; this class only validates requests and results.
 */
export class HelperWorkspace implements IsolatedWorkspace {
  readonly isolated = true;
  readonly #backend: HelperBackend;
  readonly #layout: HelperLayout;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #testProvider: boolean;
  readonly #options: HelperWorkspaceOptions;
  #initialization: Promise<void> | undefined;
  #closed = false;
  #cancelActive: (() => void) | undefined;

  constructor(binding: RunnerBinding, root: string, backend: HelperBackend, options: HelperWorkspaceOptions = {}) {
    if (!isAbsolute(root) || resolve(root) === sep || resolve(root) === resolve(root, "..")) throw new Error("Sandbox requires an absolute, non-root private storage path");
    const ownerId = text(binding.owner.id, "owner id", 256);
    if (binding.session.ownerId !== ownerId) throw new Error("Session owner does not match its binding");
    text(binding.session.id, "session id", 256);
    const gitName = text(binding.owner.gitName, "Git name", 256);
    const gitEmail = text(binding.owner.gitEmail, "Git email", 320);
    if (/[<>\x00-\x1f\x7f]/.test(gitName + gitEmail)) throw new Error("Invalid Git identity");
    const githubLogin = binding.owner.githubLogin === null ? null : text(binding.owner.githubLogin, "GitHub login", 256);
    const env = Object.freeze({ ...validateUserEnv(binding.owner.env) });
    const base = resolve(root);
    this.#backend = backend;
    this.#options = options;
    this.#testProvider = binding.model.provider === "faux";
    this.#layout = Object.freeze({
      root: base, home: join(base, "home"), worktree: join(base, "worktree"), git: join(base, "git"),
      ownerConfig: join(base, "owner.gitconfig"), bin: join(base, "bin"), caBundle: join(base, CA_BUNDLE_FILE),
    });
    this.#identity = Object.freeze({ ownerId, githubLogin, gitName, gitEmail, home: this.#layout.home, worktree: this.#layout.worktree, env });
    this.#environment = sessionEnvironment(this.#identity, { path: backend.path, gitConfig: this.#layout.ownerConfig });
  }

  get home(): string { return this.#identity.home; }
  get worktree(): string { return this.#identity.worktree; }
  /** Where the session's files are; the backends' tests and the session's own steps use it. */
  get layout(): Readonly<HelperLayout> { return this.#layout; }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.#layout.root) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    queues.set(this.#layout.root, barrier);
    try { return await result; }
    finally { if (queues.get(this.#layout.root) === barrier) queues.delete(this.#layout.root); }
  }

  async identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      return this.#identity;
    });
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
    this.#initialization ??= this.#exclusive(async () => {
      const { root, home, worktree, git, bin } = this.#layout;
      // The root and everything the runner keeps there are private to the connector's user; the session writes only
      // below home and worktree (and git, for the workspace's own Git steps).
      for (const directory of [root, home, worktree, git, bin, join(home, ".tmp")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || !privateEntry(info)) throw new Error("Sandbox storage must be private and owned by the runner user");
      }
      await (await pinOwnerConfig(this.#layout.ownerConfig, ownerGitConfig(this.#identity))).close();
      // The worktree's .git names the session's Git directory; sandboxed steps may never change it.
      const pointer = join(worktree, ".git");
      const expected = `gitdir: ${git.replaceAll("\\", "/")}\n`;
      const current = await readFile(pointer, "utf8").catch(() => undefined);
      if (current !== expected) {
        const info = await lstat(pointer).catch(() => undefined);
        if (info && !info.isFile()) throw new Error("The worktree's .git is not the runner's pointer to the session's Git directory");
        await rm(pointer, { force: true });
        await writeFile(pointer, expected, { mode: 0o400, flag: "wx" });
      }
      // Replaced in one step, so no command finds it missing or half written; the host's current store applies.
      const staged = `${this.#layout.caBundle}.new`;
      await rm(staged, { force: true });
      await writeFile(staged, trustedCertificates(), { mode: 0o400 });
      await chmod(staged, 0o400);
      await rename(staged, this.#layout.caBundle);
      await this.#backend.prepare(this.#layout);
      await this.#run({ kind: "initialize" }, { readOnly: false, gitWritable: true, egress: false });
    });
    return this.#initialization;
  }

  async #operation(request: SandboxRequest, context: { readOnly: boolean; gitWritable?: boolean; egress?: boolean; limits?: CommandLimits },
    authorize: SandboxAuthorize, signal?: AbortSignal): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    if (!this.#backend.supports(request.kind)) throw new Error(`The ${this.#backend.name} sandbox can't do this yet (${request.kind})`);
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      if (signal?.aborted) throw new SandboxProcessError("Command stopped before it started", null, null, "", "");
      return this.#run(request, { gitWritable: false, egress: false, ...context }, signal);
    });
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    return JSON.parse(await this.#operation({ kind: "read", path: text(path, "path", 1024) }, { readOnly: true }, authorize)) as string;
  }

  async readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent> {
    const output = JSON.parse(await this.#operation({ kind: "read-content", path: text(path, "path", 1024) }, { readOnly: true }, authorize)) as { text: string } | { image: string };
    if ("text" in output) return { text: output.text };
    const image = Buffer.from(output.image, "base64");
    const mimeType = imageType(image);
    if (!mimeType) throw new Error("Invalid sandbox image response");
    return { image, mimeType };
  }

  async writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.#operation({ kind: "write", path: text(path, "path", 1024), content }, { readOnly: false }, authorize);
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    return JSON.parse(await this.#operation({ kind: "list", path: text(path ?? ".", "path", 1024) }, { readOnly: true }, authorize)) as string[];
  }

  async browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult> {
    return checkedBrowse(JSON.parse(await this.#operation({ kind: "browse", path: text(path, "path", 1024) }, { readOnly: true }, authorize)));
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "bash": {
        if (options.allowTestShell === true && !this.#testProvider) throw new Error("Test shell bypass is restricted to the explicit faux provider");
        // As on a Linux host without --resources: a command without hard limits runs only where the host's owner allowed it.
        if (!this.#backend.limitedShell && options.allowTestShell !== true && options.unbounded !== true) {
          throw new Error(`Production bash unavailable: the ${this.#backend.name} sandbox has no hard per-session resource limits, so only the host's owner can let commands run`);
        }
        return this.#operation({ kind: "bash", command: text(operation.command, "shell command", 64 * 1024, true) },
          { readOnly, egress: true, limits: options.limits }, authorize, options.signal);
      }
      case "github.comment":
      case "github.merge":
      case "github.issue":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  async snapshot(authorize: SandboxAuthorize, clones: readonly string[] = []): Promise<SnapshotFile[]> {
    return JSON.parse(await this.#operation({ kind: "snapshot", ...(clones.length ? { clones: [...clones] } : {}) }, { readOnly: true }, authorize)) as SnapshotFile[];
  }

  async cloneBackup(authorize: SandboxAuthorize): Promise<{ clones: CloneBackup[]; found: string[] }> {
    const value = JSON.parse(await this.#operation({ kind: "clone-backup" }, { readOnly: false }, authorize)) as { clones: CloneBackup[]; found: string[] };
    if (!Array.isArray(value?.clones) || !Array.isArray(value.found) || !value.found.every(path => validCloneDirectory(path))) throw new Error("Invalid sandbox clone response");
    return value;
  }

  async clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]> {
    const value = JSON.parse(await this.#operation({ kind: "clone-pending" }, { readOnly: true }, authorize)) as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid sandbox clone response");
    return value.filter((entry): entry is { path: string; origin: string | null } => !!entry && typeof entry === "object"
      && validCloneDirectory((entry as { path?: unknown }).path) && ((entry as { origin?: unknown }).origin === null || typeof (entry as { origin?: unknown }).origin === "string"))
      .map(entry => ({ path: entry.path, origin: entry.origin }));
  }

  async cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void> {
    // These backends have no host repository cache to borrow from.
    if (!validCloneDirectory(path) || !/^https:\/\/[\x21-\x7e]{1,2040}$/.test(url) || reference !== null) throw new Error("Invalid clone restoration");
    await this.#operation({ kind: "clone-restore", path, url, reference }, { readOnly: false, gitWritable: true, egress: true }, authorize);
  }

  async cloneHead(path: string, authorize: SandboxAuthorize): Promise<{ commit: string; origin: string | null }> {
    if (!validCloneDirectory(path)) throw new Error("Invalid clone directory");
    const value = JSON.parse(await this.#operation({ kind: "clone-head", path }, { readOnly: true }, authorize)) as { commit: unknown; origin: unknown };
    if (typeof value.commit !== "string" || !OID.test(value.commit) || (value.origin !== null && typeof value.origin !== "string")) throw new Error("Invalid clone head");
    return { commit: value.commit, origin: value.origin };
  }

  async clonePushPrepare(path: string, input: { commit: string; old: string | null; tips: string[] }, authorize: SandboxAuthorize): Promise<ClonePushPreparation> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || (input.old !== null && !OID.test(input.old))
      || input.tips.length > 1024 || !input.tips.every(tip => OID.test(tip))) throw new Error("Invalid push request");
    const value = JSON.parse(await this.#operation({ kind: "clone-push-prepare", path, commit: input.commit, old: input.old, tips: [...input.tips] }, { readOnly: true }, authorize)) as ClonePushPreparation;
    if (!Array.isArray(value.present) || !value.present.every(tip => input.tips.includes(tip)) || (value.ancestor !== null && typeof value.ancestor !== "boolean")
      || !Array.isArray(value.commits) || value.commits.some(commit => !OID.test(commit.source) || typeof commit.subject !== "string")
      || !Number.isSafeInteger(value.total) || value.total < value.commits.length) throw new Error("Invalid push preparation");
    return { present: value.present, ancestor: value.ancestor, commits: value.commits.map(({ source, subject }) => ({ source, subject })), total: value.total };
  }

  /** Streams the clone's pack of `commit` minus `exclude`; the session queue is held until the stream ends. */
  async clonePushPack(path: string, input: { commit: string; exclude: string[] }, authorize: SandboxAuthorize): Promise<AsyncIterable<Uint8Array>> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || input.exclude.length > 1024 || !input.exclude.every(oid => OID.test(oid))) throw new Error("Invalid push request");
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    if (!this.#backend.supports("clone-push-pack")) throw new Error(`The ${this.#backend.name} sandbox can't push yet`);
    await this.initialize();
    const started = Promise.withResolvers<{ stdout: Readable; kill: () => void }>();
    const finished = this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      await this.#run({ kind: "clone-push-pack", path, commit: input.commit, exclude: [...input.exclude] }, { readOnly: true, gitWritable: false, egress: false },
        undefined, (stdout, kill) => started.resolve({ stdout, kill }));
    });
    finished.catch(error => started.reject(error));
    const pack = await started.promise;
    return (async function* () {
      let complete = false;
      try {
        for await (const chunk of pack.stdout) yield chunk as Uint8Array;
        await finished;
        complete = true;
      } finally {
        if (!complete) { pack.kill(); await finished.catch(() => undefined); }
      }
    })();
  }

  /** Explicit host-owner-approved execution, serialized with the sandbox's steps; never a fallback. */
  async executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Host command authorization is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.#cancelActive = cancel;
      try {
        return await runHostShell(operation, {
          worktree: this.#layout.worktree, git: this.#layout.git, gitConfig: this.#layout.ownerConfig,
          gitName: this.#identity.gitName, gitEmail: this.#identity.gitEmail, signal: AbortSignal.any([signal, controller.signal]),
        });
      } finally { if (this.#cancelActive === cancel) this.#cancelActive = undefined; }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelActive?.();
    await this.#initialization?.catch(() => undefined);
    await this.#exclusive(async () => {});
  }

  async #run(request: SandboxRequest, context: { readOnly: boolean; gitWritable: boolean; egress: boolean; limits?: CommandLimits }, signal?: AbortSignal,
    output?: (stdout: Readable, kill: () => void) => void): Promise<string> {
    if (context.readOnly && context.gitWritable) throw new Error("Invalid read-only mount request");
    const long = ["clone-push-prepare", "clone-push-pack", "clone-backup", "clone-restore"].includes(request.kind);
    const limits = request.kind === "bash" ? context.limits : undefined;
    const deadlineMs = long ? PUSH_TIMEOUT_MS : (limits ?? commandLimits(TIMEOUT_MS / 1000)).seconds * 1000;
    const egress = context.egress ? this.#options.egressEnvironment?.() : undefined;
    const environment = Object.freeze({ ...this.#environment, ...(egress ?? {}) });
    const launch = await this.#backend.launch(request, { ...context, egress: egress !== undefined, deadlineMs, environment }, this.#layout);
    const limit = request.kind === "snapshot" || request.kind === "clone-backup" ? MAX_SNAPSHOT_OUTPUT_BYTES
      : request.kind === "read-content" ? MAX_CONTENT_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    return new Promise<string>((resolveResult, reject) => {
      const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      let spawnFailure: Error | undefined;
      const kill = () => killTree(child);
      const cancel = () => { failure ??= "Sandbox closed"; kill(); };
      this.#cancelActive = cancel;
      const stop = () => { failure ??= "Command stopped"; kill(); };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      const timer = setTimeout(() => { failure ??= `Sandbox exceeded ${deadlineMs}ms time limit`; kill(); }, deadlineMs);
      const capture = (target: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, limit - bytes);
        if (remaining) target.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > limit) { failure ??= `Sandbox exceeded ${limit} byte output limit`; kill(); }
      };
      if (output) output(child.stdout, cancel);
      else child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      for (const stream of [child.stdout, child.stderr]) stream.on("error", () => { failure ??= "Could not read sandbox output"; kill(); });
      child.once("error", error => { spawnFailure = error; failure ??= `The ${this.#backend.name} sandbox is unavailable; refusing unsandboxed execution`; kill(); });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") { failure ??= "Could not send sandbox request"; kill(); }
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (this.#cancelActive === cancel) this.#cancelActive = undefined;
        launch.finished?.();
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (failure || code !== 0 || exitSignal) {
          const detail = failure ?? `Sandbox process failed (${exitSignal ?? `exit ${code}`})`;
          const error = new SandboxProcessError(`${detail}${err ? `: ${err.slice(0, 4096).trim()}` : ""}`, code, exitSignal, out, err);
          if (spawnFailure) error.cause = spawnFailure;
          reject(error);
        } else resolveResult(request.kind === "bash" ? out + err : out);
      });
      const line = JSON.stringify({ ...request, ...(limits ? { limits: { cpu: limits.cpuSeconds, size: limits.fileBytes, files: limits.openFiles } } : {}) });
      void (async () => {
        // Nothing reaches the helper before the backend has set up its boundary around the process.
        const first = launch.started ? await launch.started(child) : undefined;
        if (first !== undefined) child.stdin.write(`${first}\n`);
        child.stdin.end(line);
      })().catch(error => {
        failure ??= `The ${this.#backend.name} sandbox could not be set up: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`;
        kill();
      });
    });
  }
}

/** A stable short key for a session's resources (Seatbelt temp names, Windows container ids). */
export function sessionKey(binding: RunnerBinding): string {
  return createHash("sha256").update(JSON.stringify([binding.owner.id, binding.session.id])).digest("hex").slice(0, 32);
}
