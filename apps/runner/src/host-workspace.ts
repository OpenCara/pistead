import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { repositoryLimits, type SessionRepository } from "../../../packages/shared/src/repositories.js";
import type { Operation, RunnerBinding } from "../../../packages/shared/src/types.js";
import {
  MAX_FILE_BYTES, MAX_OUTPUT_BYTES, SandboxProcessError, TIMEOUT_MS, ownerGitConfig, pinOwnerConfig, repositoryPins, sessionEnvironment, text,
  type SandboxAuthorize, type SandboxExecutionOptions, type SandboxIdentity, type SnapshotFile,
} from "./sandbox.js";

const MAX_ENTRIES = 10_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const CACHE_MARKER = "repository-cache.json";
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const queues = new Map<string, Promise<void>>();

type Captured = { code: number | null; stdout: string; stderr: string };
type ArchiveNode = "file" | "directory";
type ArchiveFile = { path: string[]; body: Buffer; mode: number };

/**
 * Owner-consented host mode for macOS or Linux without bubblewrap. It runs as the
 * connector user with network access and no resource limits. File tools apply the
 * sandbox helper's path rules in-process; bash and commits still require exact
 * per-command approval. Operations are serialized per session, so the only actor
 * that could race these checks is an approved command, which already has full user
 * authority on the host.
 */
export class HostWorkspace {
  readonly #root: string;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #testProvider: boolean;
  readonly #repositories: readonly SessionRepository[];
  #initialization: Promise<void> | undefined;
  #ready = false;
  #closed = false;
  #cancelActive: (() => void) | undefined;

  constructor(binding: RunnerBinding, root: string) {
    if (!["linux", "darwin"].includes(process.platform) || !isAbsolute(root) || resolve(root) === sep) {
      throw new Error("Host workspace requires Linux or macOS and an absolute, non-root private storage path");
    }
    const ownerId = text(binding.owner.id, "owner id", 256);
    if (binding.session.ownerId !== ownerId) throw new Error("Session owner does not match its binding");
    text(binding.session.id, "session id", 256);
    const gitName = text(binding.owner.gitName, "Git name", 256);
    const gitEmail = text(binding.owner.gitEmail, "Git email", 320);
    if (/[<>\x00-\x1f\x7f]/.test(gitName + gitEmail)) throw new Error("Invalid Git identity");
    const githubLogin = binding.owner.githubLogin === null ? null : text(binding.owner.githubLogin, "GitHub login", 256);
    this.#root = resolve(root);
    this.#testProvider = binding.model.provider === "faux";
    this.#repositories = repositoryPins(binding.session.repositories ?? []);
    this.#identity = Object.freeze({
      ownerId, githubLogin, gitName, gitEmail, home: join(this.#root, "home"), worktree: join(this.#root, "worktree"),
      env: Object.freeze({ ...binding.owner.env }),
    });
    // Approved commands need the owner's own tools; runner secrets are still never inherited.
    this.#environment = sessionEnvironment(this.#identity, {
      path: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", gitConfig: join(this.#root, "owner.gitconfig"),
    });
  }

  get home(): string { return this.#identity.home; }
  get worktree(): string { return this.#identity.worktree; }

  identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>> {
    return this.#operation(authorize, async () => this.#identity);
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
    this.#initialization ??= this.#exclusive(async () => {
      for (const directory of [this.#root, this.home, this.worktree, join(this.home, ".tmp")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
          throw new Error("Sandbox storage must be private and owned by the runner user");
        }
      }
      await (await pinOwnerConfig(join(this.#root, "owner.gitconfig"), ownerGitConfig(this.#identity))).close();
      if (!await exists(join(this.worktree, ".git", "HEAD"))) {
        if (this.#repositories.length && await exists(join(this.worktree, ".git", CACHE_MARKER))) {
          throw hostError("repository cache Git HEAD is missing; refusing to reinitialize");
        }
        await this.#git(["init", "--quiet", "--template=", "--initial-branch=main", this.worktree]);
      }
      await this.#git(["rev-parse", "--is-inside-work-tree"]);
      this.#ready = true;
    });
    return this.#initialization;
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    const value = text(path, "path", 1024);
    return this.#operation(authorize, async () => {
      await this.#requireCache();
      const parts = await this.#parts(value, false);
      if (!parts.length) throw hostError("a file path is required");
      const parent = await directoryAt(this.worktree, parts.slice(0, -1));
      return new TextDecoder().decode((await readAt(parent, parts.at(-1)!, MAX_FILE_BYTES)).data);
    });
  }

  async writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    const value = text(path, "path", 1024);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.#operation(authorize, async () => {
      await this.#requireCache();
      await writeAt(this.worktree, await this.#parts(value, true), content);
    });
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const value = text(path ?? ".", "path", 1024);
    return this.#operation(authorize, async () => {
      await this.#requireCache();
      const names = await readdir(await directoryAt(this.worktree, await this.#parts(value, false)));
      if (names.length > MAX_ENTRIES) throw hostError("directory has too many entries");
      return names.sort();
    });
  }

  gitStatus(authorize: SandboxAuthorize): Promise<string> {
    return this.#operation(authorize, async () => {
      await this.#requireCache();
      return output(await this.#git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]));
    });
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "git.commit": {
        if (readOnly) throw new Error("Read-only sandbox cannot commit");
        const message = text(operation.message, "commit message", 16 * 1024, true);
        return this.#operation(authorize, async () => {
          await this.#requireCache();
          const added = await this.#git(["add", "--all", "--", "."]);
          return output(added) + output(await this.#git(["commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "--file=-"], message));
        });
      }
      case "bash": {
        if (options.allowTestShell === true && !this.#testProvider) throw new Error("Test shell bypass is restricted to the explicit faux provider");
        // Nothing can be mounted read-only on the host, so only writable approved commands run.
        if (readOnly) throw new Error("Unsandboxed hosts cannot run read-only shell commands");
        const command = text(operation.command, "shell command", 64 * 1024, true);
        return this.#operation(authorize, async () => {
          await this.#requireCache();
          return output(checked(await this.#spawn("/bin/bash", ["--noprofile", "--norc", "-c", command])));
        });
      }
      case "github.comment":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  snapshot(authorize: SandboxAuthorize): Promise<SnapshotFile[]> {
    return this.#operation(authorize, async () => {
      await this.#requireCache();
      const files: SnapshotFile[] = [];
      let total = 0;
      const add = async (parent: string, name: string, archivePath: string) => {
        if (files.length >= MAX_ENTRIES) throw hostError("snapshot has too many files");
        const { data, mode } = await readAt(parent, name, MAX_SNAPSHOT_BYTES - total);
        total += data.length;
        files.push({ path: archivePath, data: Buffer.from(data).toString("base64"), mode });
      };
      const visit = async (directory: string, prefix: string, skip: readonly string[] = [], depth = 0): Promise<void> => {
        if (depth > 64) throw hostError("snapshot directory nesting limit exceeded");
        const names = await readdir(directory);
        if (names.length > MAX_ENTRIES) throw hostError("directory has too many entries");
        for (const name of names.sort()) {
          if (skip.includes(name)) continue;
          const info = await lstat(join(directory, name));
          if (info.isDirectory()) await visit(join(directory, name), `${prefix}/${name}`, [], depth + 1);
          else if (info.isFile()) await add(directory, name, `${prefix}/${name}`);
          // Never follow symlinks or serialize devices/sockets for later restoration.
          else throw hostError("snapshot refuses symlinks and special files");
        }
      };
      await visit(this.home, "home");
      await add(this.#root, "owner.gitconfig", "owner.gitconfig");
      await visit(this.worktree, "worktree", [".git"]);
      await visit(join(this.worktree, ".git"), "git");
      return files;
    });
  }

  /** False only for pristine storage; mismatched or interrupted caches fail closed. */
  async repositoryCachesReady(repositories: readonly SessionRepository[], authorize: SandboxAuthorize): Promise<boolean> {
    this.#assertRepositories(repositories);
    return this.#operation(authorize, () => this.#cacheReady());
  }

  /** Archives correspond to the supplied pin order; ready caches never overwrite edits. */
  async materializeRepositories(repositories: readonly SessionRepository[], archives: readonly Uint8Array[], authorize: SandboxAuthorize): Promise<void> {
    this.#assertRepositories(repositories);
    if (!Array.isArray(archives) || archives.length !== repositories.length
      || archives.some((archive) => !(archive instanceof Uint8Array) || !archive.byteLength || archive.byteLength > repositoryLimits.archiveBytes)) {
      throw new Error("Repository archives exceed size limits or do not match pins");
    }
    const byPath = new Map(repositories.map((repository, index) => [repository.path, Buffer.from(archives[index]!)]));
    await this.#operation(authorize, () => this.#materialize(this.#repositories.map((repository) => byPath.get(repository.path)!)));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelActive?.();
    await this.#initialization?.catch(() => undefined);
    await this.#exclusive(async () => { this.#ready = false; });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.#root) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    queues.set(this.#root, barrier);
    try {
      return await result;
    } finally {
      if (queues.get(this.#root) === barrier) queues.delete(this.#root);
    }
  }

  async #operation<T>(authorize: SandboxAuthorize, operation: () => Promise<T>): Promise<T> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed || !this.#ready) throw new Error("Sandbox is closed");
      // Admission-time permission may have been revoked while this operation waited.
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      try {
        return await operation();
      } catch (error) {
        throw error instanceof SandboxProcessError ? error : hostError(describe(error));
      }
    });
  }

  #assertRepositories(repositories: readonly SessionRepository[]): void {
    if (JSON.stringify(repositoryPins(repositories)) !== JSON.stringify(this.#repositories)) {
      throw new Error("Repository pins do not match the immutable sandbox binding");
    }
  }

  async #requireCache(): Promise<void> {
    if (this.#repositories.length && !await this.#cacheReady()) throw hostError("repository cache is not prepared");
  }

  /** Lexical checks, then symlink resolution: the resolved path must stay inside the worktree. */
  async #parts(value: string, writing: boolean): Promise<string[]> {
    if (value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) throw hostError("invalid relative path");
    if (value.length >= 2 && value[1] === ":") throw hostError("absolute paths are not allowed");
    const lexical = value === "." ? [] : value.split("/");
    if (lexical.some((part) => ["", ".", ".."].includes(part))) throw hostError("path traversal is not allowed");
    if (writing && lexical.some((part) => part.toLowerCase() === ".git")) throw hostError("Git metadata is protected");
    const work = await realpath(this.worktree);
    let current = work;
    for (const [index, part] of lexical.entries()) {
      try {
        current = await realpath(join(current, part));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        current = join(current, ...lexical.slice(index));
        break;
      }
    }
    const inside = relative(work, current);
    if (inside.startsWith("..") || isAbsolute(inside)) throw hostError("path escapes the worktree");
    const parts = inside ? inside.split(sep) : [];
    if (writing && parts.some((part) => part.toLowerCase() === ".git")) throw hostError("Git metadata is protected");
    return parts;
  }

  async #cacheReady(): Promise<boolean> {
    const git = join(this.worktree, ".git");
    let raw: Buffer;
    try {
      raw = (await readAt(git, CACHE_MARKER, 65536)).data;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (!this.#repositories.length) return true;
      const names = await readdir(this.worktree);
      if (names.length !== 1 || names[0] !== ".git" || (await this.#capture(["rev-parse", "--verify", "HEAD"])).code === 0) {
        throw hostError("repository cache is unmarked and nonempty; refusing to overwrite");
      }
      if ((await this.#git(["ls-files", "--stage"])).stdout) throw hostError("repository cache has an existing Git index");
      return false;
    }
    const marker: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!marker || typeof marker !== "object" || !("version" in marker) || marker.version !== 1 || !("repositories" in marker)
      || canonicalJson(marker.repositories) !== canonicalJson(this.#repositories)) {
      throw hostError("repository cache binding does not match immutable pins");
    }
    if (!("status" in marker) || marker.status !== "ready") throw hostError("repository cache preparation is incomplete; refusing to overwrite");
    const baseline = "baseline" in marker ? marker.baseline : undefined;
    if (typeof baseline !== "string" || !/^[0-9a-f]{40}$/.test(baseline)) throw hostError("invalid repository cache baseline");
    if ((await this.#git(["cat-file", "-t", baseline])).stdout.trim() !== "commit") throw hostError("repository cache baseline is missing");
    await this.#git(["merge-base", "--is-ancestor", baseline, "HEAD"]);
    return true;
  }

  async #marker(status: "preparing" | "ready", baseline?: string): Promise<void> {
    const value = { version: 1, repositories: this.#repositories, status, ...(baseline ? { baseline } : {}) };
    await writeAt(join(this.worktree, ".git"), [CACHE_MARKER], JSON.stringify(value));
  }

  async #materialize(archives: readonly Buffer[]): Promise<void> {
    if (await this.#cacheReady()) return;
    const prepared: { destination: string[]; files: ArchiveFile[]; nodes: Map<string, ArchiveNode> }[] = [];
    let expanded = 0;
    let entries = 0;
    for (const [index, repository] of this.#repositories.entries()) {
      const data = expandArchive(archives[index]!, repositoryLimits.expandedBytes - expanded);
      expanded += data.length;
      const parsed = parseArchive(data, repositoryLimits.entries - entries, repository.path);
      // Symlink copies occupy disk too; they count against the same aggregate bound.
      expanded += parsed.copied;
      if (expanded > repositoryLimits.expandedBytes) throw hostError("repository archives exceed expanded size limit");
      entries += parsed.count;
      if (entries > repositoryLimits.entries) throw hostError("repository archives have too many entries");
      prepared.push({ destination: repository.path.split("/"), files: parsed.files, nodes: parsed.nodes });
    }
    // Validate every archive before the first filesystem change. Thereafter a
    // durable preparing marker makes interruption fail closed, never reset edits.
    await this.#marker("preparing");
    const stage = join(this.worktree, `.repository-stage-${randomUUID().replaceAll("-", "")}`);
    await mkdir(stage, { mode: 0o700 });
    for (const { destination, files, nodes } of prepared) {
      const root = await directoryAt(stage, destination, true);
      const directories = [...nodes].filter(([, kind]) => kind === "directory").map(([key]) => key.split("/"))
        .sort((a, b) => a.length - b.length || a.join("/").localeCompare(b.join("/")));
      for (const path of directories) await directoryAt(root, path, true);
      for (const file of files) {
        const parent = await directoryAt(root, file.path.slice(0, -1), true);
        const handle = await open(join(parent, file.path.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
        try { await handle.writeFile(file.body); } finally { await handle.close(); }
      }
    }
    await syncTree(stage, repositoryLimits.entries + 2 * this.#repositories.length, repositoryLimits.expandedBytes);
    for (const owner of await readdir(stage)) {
      // Serialized operations make this check-then-rename a no-replace promotion.
      if (await exists(join(this.worktree, owner))) throw hostError("repository destination cannot be promoted");
      await rename(join(stage, owner), join(this.worktree, owner));
    }
    await rmdir(stage);
    await syncPath(this.worktree);
    await this.#git(["add", "--force", "--all", "--", "."]);
    await this.#git(["commit", "--quiet", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Initialize pinned repository snapshots"]);
    const baseline = (await this.#git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    // Loose blobs and trees add at most two objects per imported node, plus Git bookkeeping.
    await syncTree(join(this.worktree, ".git"), 2 * repositoryLimits.entries + 1024,
      4 * repositoryLimits.expandedBytes + 1024 * repositoryLimits.entries);
    await this.#marker("ready", baseline);
  }

  #gitArgs(args: string[]): string[] {
    return ["--no-pager",
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=/dev/null", "-c", "core.sshCommand=/usr/bin/false",
      "-c", "credential.helper=", "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false", "-c", "protocol.allow=never",
      "-c", "core.pager=cat", "-c", "core.editor=/usr/bin/false",
      "-c", "gc.auto=0", "-c", "maintenance.auto=false",
      "-c", "core.preloadIndex=false", "-c", "index.threads=1",
      "-c", `core.worktree=${this.worktree}`, "-c", `safe.directory=${this.worktree}`,
      "-c", `user.name=${this.#identity.gitName}`, "-c", `user.email=${this.#identity.gitEmail}`,
      ...args];
  }

  #capture(args: string[], input?: string): Promise<Captured> {
    // Host mode uses the owner's Git from PATH (Xcode tools or Homebrew on macOS).
    return this.#spawn("git", this.#gitArgs(args), input);
  }

  async #git(args: string[], input?: string): Promise<Captured> {
    return checked(await this.#capture(args, input));
  }

  #spawn(command: string, args: string[], input?: string): Promise<Captured> {
    const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Captured>();
    const child = spawn(command, args, { cwd: this.worktree, env: { ...this.#environment }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (errorCode(error) !== "ESRCH") child.kill("SIGKILL"); }
    };
    const cancel = () => { failure ??= "Sandbox closed"; kill(); };
    this.#cancelActive = cancel;
    const timer = setTimeout(() => { failure ??= `Command exceeded ${TIMEOUT_MS}ms time limit`; kill(); }, TIMEOUT_MS);
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { failure ??= `Command exceeded ${MAX_OUTPUT_BYTES} byte output limit`; kill(); }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on("error", () => { /* Early exit closes stdin; the exit status is authoritative. */ });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new SandboxProcessError(`Cannot start ${command}: ${errorCode(error) ?? "launch failed"}`, null, null, "", ""));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (this.#cancelActive === cancel) this.#cancelActive = undefined;
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (failure || signal) reject(new SandboxProcessError(`${failure ?? `Command killed by ${signal}`}${err ? `: ${err.slice(0, 4096).trim()}` : ""}`, code, signal, out, err));
      else resolveResult({ code, stdout: out, stderr: err });
    });
    child.stdin.end(input ?? "");
    return promise;
  }
}

function checked(result: Captured): Captured {
  if (result.code !== 0) {
    throw new SandboxProcessError(`Command failed (exit ${result.code})${result.stderr ? `: ${result.stderr.slice(0, 4096).trim()}` : ""}`, result.code, null, result.stdout, result.stderr);
  }
  return result;
}

function output(result: Captured): string {
  return result.stdout + result.stderr;
}

function hostError(message: string): Error {
  return new Error(`sandbox: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Filesystem errors would otherwise disclose absolute host paths in the transcript. */
function describe(error: unknown): string {
  const known: Record<string, string> = {
    ENOENT: "no such file or directory", ELOOP: "symlinks are not followed", ENOTDIR: "not a directory",
    EISDIR: "is a directory", EEXIST: "file exists", EACCES: "permission denied", EPERM: "operation not permitted",
  };
  const code = errorCode(error);
  if (code && known[code]) return known[code];
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("sandbox: ") ? message.slice(9) : message;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sorted(entry)]))
    : item;
  return JSON.stringify(sorted(value));
}

/** Walks real directories only: a symlinked or non-directory component is refused. */
async function directoryAt(root: string, parts: readonly string[], create = false): Promise<string> {
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    if (create) {
      try { await mkdir(next, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    }
    if (!(await lstat(next)).isDirectory()) throw hostError("path component is not a real directory");
    current = next;
  }
  return current;
}

function regular(info: Stats | BigIntStats): void {
  if (!info.isFile() || Number(info.nlink) !== 1) throw hostError("only regular, non-hardlinked files are supported");
}

async function readAt(parent: string, name: string, limit: number): Promise<{ data: Buffer; mode: number }> {
  const handle = await open(join(parent, name), FILE_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    regular(before);
    if (before.size > BigInt(limit)) throw hostError("file exceeds size limit");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
      if (size > limit) throw hostError("file exceeds size limit");
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw hostError("file changed while being read; retry the operation");
    }
    return { data: Buffer.concat(chunks), mode: Number(before.mode) & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writeAt(root: string, parts: readonly string[], content: string): Promise<void> {
  if (!parts.length) throw hostError("a file path is required");
  const data = Buffer.from(content, "utf8");
  if (data.length > MAX_FILE_BYTES) throw hostError("file exceeds size limit");
  const parent = await directoryAt(root, parts.slice(0, -1), true);
  const target = join(parent, parts.at(-1)!);
  try { regular(await lstat(target)); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const temporary = join(parent, `.sandbox-write-${randomUUID().replaceAll("-", "")}`);
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // rename replaces the directory entry; it never follows a symlink at the target.
    await rename(temporary, target);
    created = false;
    await syncPath(parent);
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, DIRECTORY_FLAGS);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Flushes every regular file and directory beneath root, refusing links and filesystem crossings. */
async function syncTree(root: string, entryLimit: number, byteLimit: number): Promise<void> {
  const device = (await lstat(root)).dev;
  let entries = 0;
  let size = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    for (const name of await readdir(directory)) {
      entries += 1;
      if (entries > entryLimit || depth >= 64) throw hostError("repository durability traversal limit exceeded");
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.dev !== device) throw hostError("repository durability entry crosses a filesystem");
      if (info.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      regular(info);
      size += info.size;
      if (size > byteLimit) throw hostError("repository durability byte limit exceeded");
      const handle = await open(path, FILE_FLAGS);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await syncPath(directory);
  };
  await visit(root, 0);
}

/** Exactly one gzip member, bounded before any tar parsing; trailing or concatenated data is refused. */
function expandArchive(packed: Buffer, budget: number): Buffer {
  if (!packed.length || packed.length > repositoryLimits.archiveBytes) throw hostError("repository archive exceeds compressed size limit");
  if (packed.length < 18 || packed[0] !== 0x1f || packed[1] !== 0x8b || packed[2] !== 8 || (packed[3]! & 0xe0)) {
    throw hostError("invalid repository gzip archive");
  }
  const flags = packed[3]!;
  let offset = 10;
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  if (flags & 4) offset += 2 + view.getUint16(offset, true);
  for (const flag of [8, 16]) {
    if (!(flags & flag)) continue;
    const end = packed.indexOf(0, offset);
    if (end < 0) throw hostError("invalid repository gzip archive");
    offset = end + 1;
  }
  if (flags & 2) offset += 2;
  if (offset > packed.length - 8) throw hostError("invalid repository gzip archive");
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    // Node returns { buffer, engine } when info is set; its typings only describe the Buffer form.
    const result: unknown = inflateRawSync(packed.subarray(offset), { maxOutputLength: Math.max(1, budget + 1), info: true });
    inflated = result as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (error) {
    throw hostError(errorCode(error) === "ERR_BUFFER_TOO_LARGE" ? "repository archives exceed expanded size limit" : "incomplete or corrupt repository gzip archive");
  }
  const data = inflated.buffer;
  if (data.length > budget) throw hostError("repository archives exceed expanded size limit");
  const trailer = packed.subarray(offset + inflated.engine.bytesWritten);
  if (trailer.length !== 8 || view.getUint32(packed.length - 8, true) !== crc32(data) || view.getUint32(packed.length - 4, true) !== data.length % 2 ** 32) {
    throw hostError("incomplete or concatenated repository gzip archive");
  }
  return data;
}

function archiveParts(value: string, directory = false): string[] {
  const trimmed = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (!trimmed || Buffer.byteLength(trimmed) > 1024 || trimmed.startsWith("/") || trimmed.includes("\\")) throw hostError("invalid repository archive path");
  const parts = trimmed.split("/");
  if (parts.length > 64 || parts.some((part) => ["", ".", ".."].includes(part) || Buffer.byteLength(part) > 255)) {
    throw hostError("repository archive traversal or depth limit");
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed) || parts.some((part) => part.includes(":"))) throw hostError("invalid repository archive path");
  if (parts.some((part) => part.toLowerCase() === ".git")) throw hostError("repository archive contains reserved Git or identity files");
  return parts;
}

function tarNumber(raw: Buffer): number {
  const value = new TextDecoder("latin1").decode(raw).replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw hostError("unsupported repository tar numeric field");
  return parseInt(value, 8);
}

function tarText(raw: Buffer): string {
  const end = raw.indexOf(0);
  if (end >= 0 && raw.subarray(end).some((byte) => byte !== 0)) throw hostError("invalid repository tar name padding");
  return new TextDecoder("utf-8", { fatal: true }).decode(end >= 0 ? raw.subarray(0, end) : raw);
}

function paxFields(data: Buffer, global: boolean): Map<string, string> {
  const result = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  while (offset < data.length) {
    const space = data.subarray(offset, Math.min(data.length, offset + 12)).indexOf(0x20);
    const length = space < 0 ? "" : new TextDecoder("latin1").decode(data.subarray(offset, offset + space));
    if (space < 0 || !/^[1-9][0-9]*$/.test(length)) throw hostError("invalid repository PAX length");
    const end = offset + Number(length);
    const valueStart = offset + space + 1;
    if (end > data.length || end <= valueStart + 1 || data[end - 1] !== 0x0a) throw hostError("incomplete repository PAX record");
    const record = data.subarray(valueStart, end - 1);
    const equals = record.indexOf(0x3d);
    const key = equals < 0 ? "" : decoder.decode(record.subarray(0, equals));
    if (equals < 0 || result.has(key)) throw hostError("duplicate or invalid repository PAX key");
    const value = decoder.decode(record.subarray(equals + 1));
    // GitHub emits a global commit comment and may use POSIX path metadata.
    // Size overrides, sparse maps, linkpaths and vendor extensions are unsafe.
    if (!["comment", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "path"].includes(key)) throw hostError("unsupported repository PAX metadata");
    if (key === "path") {
      if (global) throw hostError("global repository PAX path is not supported");
      archiveParts(value, true);
    }
    result.set(key, value);
    offset = end;
  }
  return result;
}

/** Symlinks resolve lexically inside their repository; ".." may never climb above its root. */
function linkTarget(path: readonly string[], link: string): string[] {
  if (!link || link.startsWith("/") || link.includes("\\") || /[\x00-\x1f\x7f]/.test(link)) throw hostError("repository symlink target must be a relative path");
  const parts = path.slice(0, -1);
  for (const part of link.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw hostError("repository symlink escapes its repository");
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw hostError("repository symlink escapes its repository");
  return parts;
}

function parseArchive(data: Buffer, budget: number, destination: string): { files: ArchiveFile[]; nodes: Map<string, ArchiveNode>; count: number; copied: number } {
  if (data.length % 512) throw hostError("incomplete repository tar archive");
  let offset = 0;
  let entries = 0;
  let prefix: string | undefined;
  let pending: Map<string, string> | undefined;
  let ended = false;
  const explicit = new Set<string>();
  const nodes = new Map<string, ArchiveNode>();
  const files: ArchiveFile[] = [];
  const links = new Map<string, { path: string[]; link: string }>();
  while (offset < data.length) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (pending || offset + 512 > data.length || data.subarray(offset).some((byte) => byte !== 0)) throw hostError("incomplete repository tar terminator");
      ended = true;
      break;
    }
    entries += 1;
    if (entries > budget) throw hostError("repository archives have too many entries");
    const sum = header.subarray(0, 148).reduce((total, byte) => total + byte, 0) + 8 * 32 + header.subarray(156).reduce((total, byte) => total + byte, 0);
    if (tarNumber(header.subarray(148, 156)) !== sum) throw hostError("invalid repository tar checksum");
    const magic = new TextDecoder("latin1").decode(header.subarray(257, 263));
    if (magic !== "ustar\0" && magic !== "ustar ") throw hostError("unsupported repository tar format");
    let name = tarText(header.subarray(0, 100));
    if (magic === "ustar\0") {
      const parent = tarText(header.subarray(345, 500));
      if (parent) name = `${parent}/${name}`;
    }
    const kind = String.fromCharCode(header[156]!);
    const size = tarNumber(header.subarray(124, 136));
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > data.length) throw hostError("incomplete repository tar entry");
    const body = data.subarray(offset, offset + size);
    offset += padded;
    archiveParts(name, kind === "5");
    if (kind === "x" || kind === "g") {
      if (pending) throw hostError("conflicting repository PAX headers");
      const metadata = paxFields(body, kind === "g");
      if (kind === "x") pending = metadata;
      continue;
    }
    let link = "";
    if (kind === "2") {
      // Symlinks become copies of an in-repository regular file; no link is ever created.
      if (size) throw hostError("repository symlink entries cannot carry data");
      link = tarText(header.subarray(157, 257));
    } else if (!["0", "\0", "5"].includes(kind) || header.subarray(157, 257).some((byte) => byte !== 0)) {
      throw hostError("repository archive links and special files are forbidden");
    }
    if (pending) {
      name = pending.get("path") ?? name;
      pending = undefined;
    }
    const parts = archiveParts(name, kind === "5");
    prefix ??= parts[0];
    if (parts[0] !== prefix) throw hostError("repository archive must have one top-level directory");
    const path = parts.slice(1);
    if (path.length + 2 > 64 || Buffer.byteLength([destination, ...path].join("/")) > 1024) throw hostError("repository destination exceeds path or depth limit");
    if (!path.length && kind !== "5") throw hostError("repository archive root must be a directory");
    const key = path.join("/");
    if (explicit.has(key)) throw hostError("duplicate repository archive entry");
    explicit.add(key);
    for (let depth = 1; depth < path.length; depth++) {
      const parent = path.slice(0, depth).join("/");
      if (nodes.get(parent) === "file") throw hostError("conflicting repository archive paths");
      nodes.set(parent, "directory");
    }
    if (kind === "5") {
      if (size || nodes.get(key) === "file") throw hostError("conflicting repository directory entry");
      if (path.length) nodes.set(key, "directory");
    } else if (kind === "2") {
      if (nodes.has(key)) throw hostError("conflicting repository archive paths");
      nodes.set(key, "file");
      links.set(key, { path, link });
    } else {
      if (size > repositoryLimits.fileBytes) throw hostError("repository file exceeds size limit");
      if (nodes.has(key)) throw hostError("conflicting repository archive paths");
      nodes.set(key, "file");
      files.push({ path, body, mode: tarNumber(header.subarray(100, 108)) & 0o111 ? 0o700 : 0o600 });
    }
    if (nodes.size > repositoryLimits.entries) throw hostError("repository archive has too many filesystem entries");
  }
  if (!ended || prefix === undefined) throw hostError("incomplete or empty repository tar archive");
  const regular = new Map(files.map((file) => [file.path.join("/"), file]));
  let copied = 0;
  for (const { path, link } of links.values()) {
    let target = linkTarget(path, link);
    for (let hop = 0; hop < 8 && links.has(target.join("/")); hop++) {
      const next = links.get(target.join("/"))!;
      target = linkTarget(next.path, next.link);
    }
    const file = regular.get(target.join("/"));
    if (!file) throw hostError("repository symlink must point to a regular file in its repository");
    copied += file.body.length;
    files.push({ path, body: file.body, mode: file.mode });
  }
  return { files, nodes, count: Math.max(entries, nodes.size), copied };
}
