import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import type { RunnerBinding } from "../../../packages/shared/src/types.js";
import { assertId, RunnerError, stableJson, validateBinding, validateOperation } from "./protocol.js";
import { Sandbox } from "./sandbox.js";

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 10_000;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MARKER = ".restore.json";

export interface RestoreConfig {
  dataDir: string;
  /** Trusted transport must enforce the size bound while downloading from its fixed control-plane endpoint. */
  readBackup?: (descriptor: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
}

export interface RestoreManifest {
  binding: RunnerBinding;
  branches: { id: number; mode: "write" | "ask"; actorId?: string }[];
  runs: Record<string, unknown>;
  approvals: Record<string, unknown>;
  toolActors: Record<string, unknown>;
  usedTickets?: Record<string, number>;
  [key: string]: unknown;
}

/** Open only the staged SQLite with the supported pi API, paused; verify idle tasks,
 * rebind app metadata, reset authority, and checkpoint/close before returning. */
export type PrepareRestore = (stage: string, manifest: RestoreManifest) => Promise<void>;

type SnapshotFile = { path: string; bytes: Buffer; mode: number };
type Snapshot = { manifest: RestoreManifest; sqlite: Buffer; files: SnapshotFile[] };
type PublicationFence = { publish(stage: string, dev: string, ino: string): Promise<void>; close(): Promise<void> };

function invalid(message: string): never { throw new RunnerError(400, message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("base64url"); }

function descriptorCopy(value: RestoreDescriptor): RestoreDescriptor {
  if (!record(value) || Object.keys(value).sort().join(",") !== "backupId,downloadToken,id,sha256,size,sourceSessionId") invalid("Invalid restore descriptor");
  for (const key of ["id", "sourceSessionId", "backupId"] as const) {
    if (typeof value[key] !== "string") invalid("Invalid restore identifier");
    assertId(value[key]);
  }
  if (typeof value.sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.sha256)
    || Buffer.from(value.sha256, "base64url").toString("base64url") !== value.sha256
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_BYTES
    || typeof value.downloadToken !== "string" || !value.downloadToken || value.downloadToken.length > 4096
    || /[\x00-\x20\x7f]/.test(value.downloadToken)) invalid("Invalid restore checksum, size, or capability");
  return { ...value };
}

function checkedBinding(value: unknown, id: string): RunnerBinding {
  if (!record(value)) invalid("Invalid backup binding");
  const raw = JSON.parse(JSON.stringify(value));
  const binding = validateBinding(raw, assertId(id), typeof raw?.session?.connectorId === "string");
  if (typeof binding.session.workspaceId !== "string" || !binding.session.workspaceId
    || binding.model.workspaceId !== binding.session.workspaceId
    || (binding.agent.workspaceId !== null && binding.agent.workspaceId !== binding.session.workspaceId)
    || binding.session.connectorId !== binding.model.connectorId
    || binding.session.connectorOwnerId !== binding.model.connectorOwnerId
    || Boolean(binding.session.connectorId) !== Boolean(binding.session.connectorOwnerId)) invalid("Inconsistent backup workspace or connector binding");
  return binding;
}

function base64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > MAX_BYTES || value.length % 4 !== 0
    || /[^A-Za-z0-9+/=]/.test(value)) invalid("Invalid snapshot base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) invalid("Noncanonical snapshot base64");
  return bytes;
}

function snapshot(bytes: Uint8Array, descriptor: RestoreDescriptor, target: RunnerBinding): Snapshot {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== descriptor.size || bytes.byteLength > MAX_BYTES) invalid("Backup size mismatch");
  if (digest(bytes) !== descriptor.sha256) invalid("Backup checksum mismatch");
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch { invalid("Backup is not valid UTF-8 JSON"); }
  if (text !== JSON.stringify(value)) invalid("Backup JSON is not canonical");
  if (!record(value) || value.format !== "pi-runner-backup-v1" || !Array.isArray(value.files)
    || value.files.length > MAX_FILES || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) invalid("Invalid backup format");
  const source = checkedBinding(value.binding, descriptor.sourceSessionId);
  if (source.session.id === target.session.id || source.owner.id !== target.owner.id
    || source.session.workspaceId !== target.session.workspaceId
    || source.session.agentVersionId !== target.session.agentVersionId
    || source.session.connectorId !== target.session.connectorId
    || source.session.connectorOwnerId !== target.session.connectorOwnerId
    || stableJson(source.agent) !== stableJson(target.agent)
    || stableJson(source.model) !== stableJson(target.model)) invalid("Backup source, owner, agent, model, or connector mismatch");
  const manifest = value.manifest;
  if (!record(manifest) || stableJson(manifest.binding) !== stableJson(value.binding)
    || !Array.isArray(manifest.branches) || !manifest.branches.length
    || !record(manifest.runs) || !record(manifest.approvals) || !record(manifest.toolActors)
    || (manifest.usedTickets !== undefined && (!record(manifest.usedTickets)
      || Object.values(manifest.usedTickets).some(expiry => !Number.isSafeInteger(expiry))))) invalid("Invalid backup manifest binding or state");
  const branches = new Set<number>();
  for (const branch of manifest.branches) {
    if (!record(branch) || !Number.isSafeInteger(branch.id) || (branch.id as number) < 1
      || !["write", "ask"].includes(branch.mode as string)
      || (branch.actorId !== undefined && typeof branch.actorId !== "string") || branches.has(branch.id as number)) invalid("Invalid backup branches");
    branches.add(branch.id as number);
  }
  for (const [key, run] of Object.entries(manifest.runs)) {
    if (!record(run) || !["settled", "interrupted"].includes(run.status as string)) invalid("Backup requires idle runs");
    if (run.key !== key || !/^[A-Za-z0-9_-]{43}$/.test(key) || run.ownerId !== source.owner.id
      || typeof run.initiatedBy !== "string" || !run.initiatedBy || run.initiatedBy.length > 256
      || !["write", "ask"].includes(run.mode as string) || !Number.isSafeInteger(run.conversationId)
      || !branches.has(run.conversationId as number) || typeof run.content !== "string" || !run.content.trim()
      || run.content.length > 100_000 || typeof run.contentHash !== "string" || run.contentHash !== digest(run.content)
      || !Number.isSafeInteger(run.startEntry) || (run.startEntry as number) < 0
      || (run.submissionId !== undefined && (!Number.isSafeInteger(run.submissionId) || (run.submissionId as number) < 1))
      || (run.sequence !== undefined && (!Number.isSafeInteger(run.sequence) || (run.sequence as number) < 0))
      || (run.ordinal !== undefined && (!Number.isSafeInteger(run.ordinal) || (run.ordinal as number) < 0))
      || (run.admissionId !== undefined && (run.mode !== "write" || typeof run.admissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(run.admissionId)))
      || (run.started !== undefined && typeof run.started !== "boolean")) invalid("Invalid backup run binding or receipt");
  }
  for (const [id, approval] of Object.entries(manifest.approvals)) {
    if (!record(approval) || !["pending", "denied", "executed", "interrupted"].includes(approval.status as string)) invalid("Backup requires idle approvals");
    if (approval.id !== id || !id || approval.sessionId !== source.session.id
      || typeof approval.requestedBy !== "string" || !approval.requestedBy || approval.requestedBy.length > 256
      || typeof approval.createdAt !== "string" || !Number.isFinite(Date.parse(approval.createdAt))
      || (approval.decidedBy !== undefined && (typeof approval.decidedBy !== "string" || !approval.decidedBy))
      || (approval.admissionId !== undefined && (typeof approval.admissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(approval.admissionId)))
      || (approval.result !== undefined && typeof approval.result !== "string")) invalid("Invalid backup approval binding");
    validateOperation(approval.operation);
  }
  for (const actor of Object.values(manifest.toolActors)) {
    if (!record(actor) || actor.ownerId !== source.owner.id || typeof actor.runKey !== "string"
      || !Object.hasOwn(manifest.runs, actor.runKey)) invalid("Invalid backup tool attribution");
    const run = manifest.runs[actor.runKey] as Record<string, unknown>;
    if (actor.initiatedBy !== run.initiatedBy) invalid("Invalid backup tool actor");
  }
  if (manifest.nextSequence !== undefined && (!Number.isSafeInteger(manifest.nextSequence) || (manifest.nextSequence as number) < 0)) invalid("Invalid backup queue ordinal");
  if (manifest.queue !== undefined && (!Array.isArray(manifest.queue) || manifest.queue.length)) invalid("Backup requires an empty queue");
  const sqlite = base64(value.sqlite);
  if (sqlite.length < 100 || Buffer.from(sqlite.subarray(0, 16)).toString("binary") !== "SQLite format 3\0") invalid("Invalid backup SQLite header");
  let total = sqlite.length;
  const paths = new Set<string>();
  const directories = new Set<string>();
  const files: SnapshotFile[] = [];
  for (const file of value.files) {
    if (!record(file) || Object.keys(file).sort().join(",") !== "data,mode,path"
      || typeof file.path !== "string" || !file.path || Buffer.byteLength(file.path) > 4096
      || /[\\\x00-\x1f\x7f]/.test(file.path) || !Number.isSafeInteger(file.mode)
      || (file.mode as number) < 0 || (file.mode as number) > 0o777) invalid("Invalid snapshot path or file mode");
    const parts = file.path.split("/");
    if (parts.length > 66 || parts.some(part => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)
      || (file.path !== "owner.gitconfig" && (parts.length < 2 || !["home", "worktree", "git"].includes(parts[0]!)))
      || (parts[0] === "home" && parts[1] === ".gitconfig")
      || (parts[0] === "worktree" && parts[1] === ".git")
      || (parts[0] === "home" && parts[1] === ".tmp" && parts.length === 2)
      || (parts[0] === "git" && ["objects", "refs"].includes(parts[1]!) && parts.length === 2)) invalid("Unsafe or reserved snapshot path");
    if (paths.has(file.path)) invalid("Duplicate snapshot path");
    paths.add(file.path);
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/"));
      if (paths.size + directories.size > MAX_FILES * 2) invalid("Snapshot has too many filesystem entries");
    }
    const data = base64(file.data);
    total += data.length;
    if (data.length > MAX_BYTES || total > MAX_BYTES) invalid("Decoded snapshot exceeds size limit");
    // This is generated from the NEW owner binding by Sandbox.initialize, never imported.
    if (file.path !== "owner.gitconfig") files.push({ path: file.path, bytes: data, mode: 0o600 | ((file.mode as number) & 0o100) });
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) invalid("Snapshot file is also a parent directory");
  }
  return { manifest: manifest as unknown as RestoreManifest, sqlite, files };
}

async function privateDirectory(path: string): Promise<FileHandle> {
  if (await realpath(path) !== path) throw new RunnerError(403, "Restore storage must be canonical");
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new RunnerError(403, "Restore storage must be private and runner-owned");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function writePrivate(path: string, bytes: string | Uint8Array, mode = 0o600): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function readPrivate(path: string, limit: number): Promise<string> {
  const handle = await open(path, FILE_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > limit) throw new RunnerError(409, "Unsafe restore receipt or binding");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function mountIdentity(handle: FileHandle): Promise<string> {
  const fdinfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const matches = [...fdinfo.matchAll(/^mnt_id:[\t ]+([1-9][0-9]*)[\t ]*$/gm)];
  if (fdinfo.length > 8192 || matches.length !== 1) throw new RunnerError(503, "Cannot verify restore mount identity");
  return matches[0]![1]!;
}

async function syncTree(path: string, mountId: string, budget = { files: 0, bytes: 0 }, depth = 0): Promise<void> {
  if (depth > 70 || ++budget.files > MAX_FILES * 2 + 128) throw new RunnerError(400, "Prepared restore has too many entries");
  const before = await lstat(path);
  if (before.uid !== process.getuid?.() || (!before.isDirectory() && !before.isFile())) throw new RunnerError(403, "Unsafe prepared restore entry");
  const handle = await open(path, before.isDirectory() ? DIRECTORY_FLAGS : FILE_FLAGS);
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.uid !== process.getuid?.()
      || await mountIdentity(handle) !== mountId) throw new RunnerError(403, "Unsafe prepared restore entry");
    // Overlayfs can report different st_dev values within one mount. Compare mount
    // identities instead; this also rejects same-device bind mounts and submounts.
    if (info.isDirectory()) {
      if (info.mode & 0o077) throw new RunnerError(403, "Restore storage must be private and runner-owned");
      const pinned = `/proc/self/fd/${handle.fd}`;
      for (const name of await readdir(pinned)) await syncTree(join(pinned, name), mountId, budget, depth + 1);
    } else {
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o022) || (info.mode & 0o7000)) throw new RunnerError(403, "Unsafe prepared restore file");
      budget.bytes += info.size;
      if (budget.bytes > MAX_BYTES * 2) throw new RunnerError(400, "Prepared restore exceeds size limit");
    }
    await handle.sync();
  } finally { await handle.close(); }
}

// A kernel lock outlives JS exceptions but not process death. Publication uses the
// pinned parent and Linux RENAME_NOREPLACE; unsupported kernels/libcs fail closed.
const PUBLICATION = String.raw`
import ctypes, errno, fcntl, json, os, stat, sys
parent, path, target, lockname = 3, sys.argv[1], sys.argv[2], sys.argv[3]
try:
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    lock = os.open(lockname, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        raise ValueError('unsafe publication fence')
    fcntl.flock(lock, fcntl.LOCK_EX)
    print('ready', flush=True)
    command = sys.stdin.readline()
    if not command:
        sys.exit(0)
    request = json.loads(command)
    stage = request['stage']
    if not stage.startswith('.restore-') or '/' in stage or '\\' in stage:
        raise ValueError('invalid staging name')
    pinned, current = os.fstat(parent), os.stat(path, follow_symlinks=False)
    if (pinned.st_dev, pinned.st_ino) != (current.st_dev, current.st_ino) or os.path.realpath(path) != path:
        raise ValueError('publication parent changed')
    staged = os.stat(stage, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(staged.st_mode) or staged.st_uid != os.getuid() or staged.st_mode & 0o077 or (str(staged.st_dev), str(staged.st_ino)) != (request['dev'], request['ino']):
        raise ValueError('staging fence changed')
    if rename(parent, os.fsencode(stage), parent, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    os.fsync(parent)
    print('published', flush=True)
except OSError as error:
    print('restore publication unavailable: ' + str(error), file=sys.stderr)
    sys.exit(17 if error.errno == errno.EEXIST else 1)
except Exception:
    print('restore publication fence unavailable', file=sys.stderr)
    sys.exit(1)
`;

async function publicationFence(parent: FileHandle, path: string, target: string) {
  const child = spawn("/usr/bin/python3", ["-I", "-c", PUBLICATION, path, target, `.restore-lock-${digest(target)}`], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe", parent.fd],
  });
  let ready = false;
  let stdout = "";
  let stderr = "";
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolveResult, reject) => { resolveReady = resolveResult; rejectReady = reject; });
  const finished = new Promise<void>((resolveResult, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(0, 128);
      if (!ready && stdout === "ready\n") { ready = true; resolveReady(); }
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 2048); });
    child.stdin!.on("error", () => { /* Process exit below determines publication success. */ });
    child.once("error", () => { const error = new RunnerError(503, "Linux restore publication helper unavailable"); rejectReady(error); reject(error); });
    child.once("close", (exit, signal) => {
      if (exit === 0 && !signal && ready) resolveResult();
      else {
        const error = new RunnerError(exit === 17 ? 409 : 503, exit === 17 ? "Restore target already exists" : `Restore publication failed${stderr ? `: ${stderr.trim()}` : ""}`);
        rejectReady(error); reject(error);
      }
    });
  });
  void finished.catch(() => undefined);
  await started;
  return {
    async publish(stage: string, dev: string, ino: string) {
      child.stdin!.end(`${JSON.stringify({ stage, dev, ino })}\n`);
      await finished;
      if (stdout !== "ready\npublished\n") throw new RunnerError(503, "Restore publication was not acknowledged");
    },
    async close() { if (!child.stdin!.writableEnded) child.stdin!.end(); await finished.catch(() => undefined); },
  };
}

export async function restoreSession(config: RestoreConfig, input: RunnerBinding, requested: RestoreDescriptor, prepare: PrepareRestore): Promise<void> {
  if (process.platform !== "linux") throw new RunnerError(503, "Restore requires Linux no-replace directory publication");
  if (typeof config.readBackup !== "function") throw new RunnerError(503, "Trusted backup reader is not configured");
  if (typeof prepare !== "function") throw new RunnerError(503, "Paused restore preparation is required");
  const descriptor = descriptorCopy(requested);
  if (!input?.session || typeof input.session.id !== "string") invalid("Invalid restore target binding");
  const binding = checkedBinding(input, input.session.id);
  if (binding.session.id === descriptor.sourceSessionId) invalid("Restore requires a new target session");
  const dataDir = resolve(config.dataDir);
  const root = await privateDirectory(dataDir);
  const sessions = join(dataDir, "sessions");
  let parent: FileHandle | undefined;
  let fence: PublicationFence | undefined;
  let stage: string | undefined;
  try {
    await mkdir(sessions, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await root.sync();
    parent = await privateDirectory(sessions);
    fence = await publicationFence(parent, sessions, binding.session.id);
    const target = join(sessions, binding.session.id);
    const receipt = { format: "pi-runner-restore-v1", restoreId: descriptor.id, sha256: descriptor.sha256,
      sourceSessionId: descriptor.sourceSessionId, backupId: descriptor.backupId, size: descriptor.size, bindingHash: digest(stableJson(binding)) };
    let exists = false;
    try { await lstat(target); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (exists) {
      let targetHandle: FileHandle | undefined;
      try {
        targetHandle = await privateDirectory(target);
        if (stableJson(JSON.parse(await readPrivate(join(target, MARKER), 4096))) !== stableJson(receipt)
          || stableJson(JSON.parse(await readPrivate(join(target, "binding.json"), MAX_BYTES))) !== stableJson(binding)) throw new Error("mismatch");
        await targetHandle.sync();
        await parent.sync();
        return;
      } catch { throw new RunnerError(409, "Restore target conflicts with the durable restore receipt or binding"); }
      finally { await targetHandle?.close(); }
    }
    const downloaded = await config.readBackup({ ...descriptor }, binding.session.id);
    const backup = snapshot(downloaded, descriptor, binding);
    const stageName = `.restore-${randomUUID()}`;
    const stagePath = join(sessions, stageName);
    await mkdir(stagePath, { mode: 0o700 });
    stage = stagePath;
    const staged = await lstat(stage, { bigint: true });
    await writePrivate(join(stage, "binding.json"), JSON.stringify(binding));
    await writePrivate(join(stage, "session.sqlite"), backup.sqlite);
    for (const name of ["home", "worktree", "git"]) await mkdir(join(stage, "sandbox", name), { recursive: true, mode: 0o700 });
    for (const file of backup.files) {
      const path = join(stage, "sandbox", file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writePrivate(path, file.bytes, file.mode);
    }
    await prepare(stage, backup.manifest);
    if (stableJson(JSON.parse(await readPrivate(join(stage, "binding.json"), MAX_BYTES))) !== stableJson(binding)) throw new RunnerError(409, "Preparation changed the target binding");
    const sandbox = new Sandbox(binding, join(stage, "sandbox"));
    try { await sandbox.initialize(); } finally { await sandbox.close(); }
    await writePrivate(join(stage, MARKER), JSON.stringify(receipt));
    await syncTree(stage, await mountIdentity(parent));
    await parent.sync();
    await fence.publish(stageName, String(staged.dev), String(staged.ino));
    stage = undefined;
  } finally {
    try { if (stage) { await rm(stage, { recursive: true, force: true }); await parent?.sync(); } }
    finally { await fence?.close(); await parent?.close(); await root.close(); }
  }
}
