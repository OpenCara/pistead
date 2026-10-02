import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import type { Operation, RunnerBinding } from "../../../packages/shared/src/types.js";

const TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_OUTPUT_BYTES = 48 * 1024 * 1024;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sessionQueues = new Map<string, Promise<void>>();

export type SandboxAuthorize = () => Promise<void>;

export interface SnapshotFile {
  /** Relative to the constructor's sandbox root; data is base64, including binary files. */
  path: string;
  data: string;
  mode: number;
}

export interface SandboxIdentity {
  ownerId: string;
  githubLogin: string | null;
  gitName: string;
  gitEmail: string;
  home: string;
  worktree: string;
  env: Readonly<Record<string, string>>;
}

export class SandboxProcessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "SandboxProcessError";
  }
}

interface Mounts {
  root: FileHandle;
  home: FileHandle;
  worktree: FileHandle;
  git: FileHandle;
  config: FileHandle;
}

type Request =
  | { kind: "initialize" }
  | { kind: "read" | "list"; path: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "status" | "snapshot" }
  | { kind: "commit"; message: string }
  | { kind: "bash"; command: string };

/* All untrusted filesystem access happens here, after entering the namespace.
 * realpath is only a policy check: actual opens walk pinned directory descriptors
 * with O_NOFOLLOW, so swapping a checked parent for a symlink cannot win a race.
 */
const HELPER = String.raw`
import base64, json, os, resource, secrets, stat, subprocess, sys

for fd_name in os.listdir('/proc/self/fd'):
    fd = int(fd_name)
    if fd > 2:
        try:
            os.close(fd)
        except OSError:
            pass
os.umask(0o077)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
HOME = os.environ['HOME']
WORK = os.environ['SANDBOX_WORKTREE']
MAX_FILE = 1024 * 1024
MAX_SNAPSHOT = 32 * 1024 * 1024
MAX_ENTRIES = 10000
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


def parts_for(value, writing=False):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError('invalid relative path')
    if value.startswith('/') or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('invalid relative path')
    if len(value) >= 2 and value[1] == ':':
        raise ValueError('absolute paths are not allowed')
    if value != '.' and any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('path traversal is not allowed')
    lexical = [] if value == '.' else value.split('/')
    if writing and any(p.lower() == '.git' for p in lexical):
        raise ValueError('Git metadata is protected')
    canonical = os.path.realpath(os.path.join(WORK, value))
    if os.path.commonpath((WORK, canonical)) != WORK:
        raise ValueError('path escapes the worktree')
    relative = os.path.relpath(canonical, WORK)
    parts = [] if relative == '.' else relative.split('/')
    if writing and any(p.lower() == '.git' for p in parts):
        raise ValueError('Git metadata is protected')
    return parts


def walk(root, parts, create=False):
    current = os.dup(root)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            child = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('only regular, non-hardlinked files are supported')


def read_at(parent, name, limit):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(fd)
        regular(before)
        if before.st_size > limit:
            raise ValueError('file exceeds size limit')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise ValueError('file exceeds size limit')
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('file changed while being read; retry the operation')
        return b''.join(chunks), stat.S_IMODE(before.st_mode) & 0o777
    finally:
        os.close(fd)


def write_at(root, parts, content):
    if not parts:
        raise ValueError('a file path is required')
    data = content.encode('utf-8')
    if len(data) > MAX_FILE:
        raise ValueError('file exceeds size limit')
    parent = walk(root, parts[:-1], True)
    temporary = '.sandbox-write-' + secrets.token_hex(16)
    created = False
    try:
        try:
            regular(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False))
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # renameat replaces an entry; it never follows a concurrently inserted symlink.
        os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        os.fsync(parent)
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


GIT = ['/usr/bin/git', '--no-pager',
       '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
       '-c', 'core.attributesFile=/dev/null', '-c', 'core.sshCommand=/usr/bin/false',
       '-c', 'credential.helper=', '-c', 'commit.gpgSign=false',
       '-c', 'tag.gpgSign=false', '-c', 'protocol.allow=never',
       '-c', 'core.pager=cat', '-c', 'core.editor=/usr/bin/false',
       '-c', 'core.worktree=' + WORK, '-c', 'safe.directory=' + WORK,
       '-c', 'user.name=' + os.environ['GIT_AUTHOR_NAME'],
       '-c', 'user.email=' + os.environ['GIT_AUTHOR_EMAIL']]


def run(argv, data=None):
    child = subprocess.run(argv, input=data, stdin=subprocess.DEVNULL if data is None else None,
                           cwd=WORK, close_fds=True)
    if child.returncode:
        sys.exit(child.returncode if child.returncode > 0 else 128 - child.returncode)


def snapshot():
    files, total = [], 0

    def add(parent, name, archive_path):
        nonlocal total
        if len(files) >= MAX_ENTRIES:
            raise ValueError('snapshot has too many files')
        data, mode = read_at(parent, name, MAX_SNAPSHOT - total)
        total += len(data)
        files.append({'path': archive_path, 'data': base64.b64encode(data).decode('ascii'), 'mode': mode})

    def visit(fd, prefix, skip=(), depth=0):
        if depth > 64:
            raise ValueError('snapshot directory nesting limit exceeded')
        names = os.listdir(fd)
        if len(names) > MAX_ENTRIES:
            raise ValueError('directory has too many entries')
        for name in sorted(names):
            if name in skip:
                continue
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            archive_path = prefix + '/' + name
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                try:
                    visit(child, archive_path, depth=depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                add(fd, name, archive_path)
            else:
                # Never follow symlinks or serialize devices/sockets for later restoration.
                raise ValueError('snapshot refuses symlinks and special files')

    home = os.open(HOME, DIR_FLAGS)
    work = os.open(WORK, DIR_FLAGS)
    git = os.open('.git', DIR_FLAGS, dir_fd=work)
    try:
        visit(home, 'home', ('.gitconfig',))
        add(home, '.gitconfig', 'owner.gitconfig')
        visit(work, 'worktree', ('.git',))
        visit(git, 'git')
        return files
    finally:
        os.close(git)
        os.close(work)
        os.close(home)


def main():
    request = json.load(sys.stdin)
    kind = request['kind']
    if kind == 'bash':
        run(['/usr/bin/bash', '--noprofile', '--norc', '-c', request['command']])
        return
    if kind == 'initialize':
        try:
            os.stat(os.path.join(WORK, '.git', 'HEAD'), follow_symlinks=False)
        except FileNotFoundError:
            run(GIT + ['init', '--quiet', '--template=', '--initial-branch=main', WORK])
        run(GIT + ['rev-parse', '--is-inside-work-tree'])
        return
    if kind == 'status':
        run(GIT + ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'])
        return
    if kind == 'commit':
        run(GIT + ['add', '--all', '--', '.'])
        run(GIT + ['commit', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '--file=-'], request['message'].encode('utf-8'))
        return
    if kind == 'snapshot':
        print(json.dumps(snapshot(), ensure_ascii=True))
        return
    root = os.open(WORK, DIR_FLAGS)
    try:
        parts = parts_for(request['path'], kind == 'write')
        if kind == 'write':
            write_at(root, parts, request['content'])
            result = None
        elif kind == 'read':
            if not parts:
                raise ValueError('a file path is required')
            parent = walk(root, parts[:-1])
            try:
                result = read_at(parent, parts[-1], MAX_FILE)[0].decode('utf-8')
            finally:
                os.close(parent)
        elif kind == 'list':
            directory = walk(root, parts)
            try:
                names = os.listdir(directory)
                if len(names) > MAX_ENTRIES:
                    raise ValueError('directory has too many entries')
                result = sorted(names)
            finally:
                os.close(directory)
        else:
            raise ValueError('unsupported filesystem operation')
        print(json.dumps(result, ensure_ascii=True))
    finally:
        os.close(root)

try:
    main()
except (OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
    print('sandbox: ' + str(error), file=sys.stderr)
    sys.exit(1)
`;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function text(value: unknown, label: string, limit: number, multiline = false): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > limit || value.includes("\0") || (!multiline && /[\r\n]/.test(value))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function fdPath(directory: FileHandle, name: string): string {
  // name is always an internal single component, never a tool-supplied path.
  return `/proc/self/fd/${directory.fd}/${name}`;
}

async function privateDirectory(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
  const path = fdPath(parent, name);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error("Sandbox storage must be private and owned by the runner user");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openRoot(path: string): Promise<FileHandle> {
  // Pin every ancestor rather than checking lstat/realpath and subsequently opening
  // the original pathname. Even a renamed ancestor cannot redirect these operations.
  let current = await open(sep, DIRECTORY_FLAGS);
  try {
    const components = path.split(sep).filter(Boolean);
    for (let index = 0; index < components.length; index++) {
      const component = components[index]!;
      const childPath = fdPath(current, component);
      try {
        await mkdir(childPath, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const next = index === components.length - 1
        ? await privateDirectory(current, component, false)
        : await open(childPath, DIRECTORY_FLAGS);
      await current.close();
      current = next;
    }
    if (await realpath(`/proc/self/fd/${current.fd}`) !== path) {
      throw new Error("Sandbox root changed during initialization");
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function placeholder(parent: FileHandle, name: string): Promise<void> {
  const handle = await open(fdPath(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) {
      throw new Error("Unsafe sandbox mount point");
    }
  } finally {
    await handle.close();
  }
}

function quoteGitConfig(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

/**
 * Linux-only execution boundary. The caller supplies a trusted live-authorization
 * callback, which is awaited after queueing, immediately before execution.
 * execute() takes the exact approved Operation, never a reconstructed shell command.
 * No host-shell, host-Git, or host-filesystem-tool fallback exists.
 */
export class Sandbox {
  readonly #root: string;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  #initialization: Promise<void> | undefined;
  #mounts: Mounts | undefined;
  #closed = false;

  constructor(binding: RunnerBinding, root: string) {
    if (process.platform !== "linux" || !isAbsolute(root) || resolve(root) === sep) {
      throw new Error("Sandbox requires Linux and an absolute, non-root private storage path");
    }
    if (["/usr", "/lib", "/lib64"].some((runtime) => resolve(root) === runtime || resolve(root).startsWith(`${runtime}/`))) {
      throw new Error("Session storage cannot be located in a shared runtime mount");
    }
    const ownerId = text(binding.owner.id, "owner id", 256);
    if (binding.session.ownerId !== ownerId) throw new Error("Session owner does not match its binding");
    const sessionId = text(binding.session.id, "session id", 256);
    const gitName = text(binding.owner.gitName, "Git name", 256);
    const gitEmail = text(binding.owner.gitEmail, "Git email", 320);
    if (/[<>\x00-\x1f\x7f]/.test(gitName + gitEmail)) throw new Error("Invalid Git identity");
    const githubLogin = binding.owner.githubLogin === null ? null : text(binding.owner.githubLogin, "GitHub login", 256);
    const env = Object.freeze({ ...validateUserEnv(binding.owner.env) });
    const key = createHash("sha256").update(JSON.stringify([ownerId, sessionId])).digest("hex");
    const base = `/sessions/${key}`;
    this.#root = resolve(root);
    this.#identity = Object.freeze({ ownerId, githubLogin, gitName, gitEmail, home: `${base}/home`, worktree: `${base}/worktree`, env });
    this.#environment = Object.freeze({
      ...env,
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      TERM: "dumb",
      HOME: this.home,
      PWD: this.worktree,
      TMPDIR: `${this.home}/.tmp`,
      XDG_CONFIG_HOME: `${this.home}/.config`,
      XDG_CACHE_HOME: `${this.home}/.cache`,
      SANDBOX_WORKTREE: this.worktree,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: `${this.home}/.gitconfig`,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
      GIT_PAGER: "cat",
      GIT_EDITOR: "/usr/bin/false",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: gitName,
      GIT_AUTHOR_EMAIL: gitEmail,
      GIT_COMMITTER_NAME: gitName,
      GIT_COMMITTER_EMAIL: gitEmail,
    });
  }

  get home(): string { return this.#identity.home; }
  get worktree(): string { return this.#identity.worktree; }

  async identity(authorize: SandboxAuthorize): Promise<Readonly<SandboxIdentity>> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      return this.#identity;
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = sessionQueues.get(this.#root) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    sessionQueues.set(this.#root, barrier);
    try {
      return await result;
    } finally {
      if (sessionQueues.get(this.#root) === barrier) sessionQueues.delete(this.#root);
    }
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Sandbox is closed"));
    this.#initialization ??= this.#exclusive(async () => {
      const opened: FileHandle[] = [];
      try {
        const root = await openRoot(this.#root);
        opened.push(root);
        const home = await privateDirectory(root, "home", true);
        opened.push(home);
        const worktree = await privateDirectory(root, "worktree", true);
        opened.push(worktree);
        const git = await privateDirectory(root, "git", true);
        opened.push(git);
        // File-only backups omit empty Git directories, including those in an unborn repository.
        for (const name of ["objects", "refs"]) {
          const directory = await privateDirectory(git, name, true);
          await directory.close();
        }
        const gitPoint = await privateDirectory(worktree, ".git", true);
        await gitPoint.close();
        const temporary = await privateDirectory(home, ".tmp", true);
        await temporary.close();
        await placeholder(home, ".gitconfig");
        const { ownerId, githubLogin, gitName, gitEmail } = this.#identity;
        const configText = `# Immutable session owner: ${JSON.stringify({ ownerId, githubLogin, gitName, gitEmail, home: this.home, worktree: this.worktree })}\n[user]\n\tname = ${quoteGitConfig(gitName)}\n\temail = ${quoteGitConfig(gitEmail)}\n[core]\n\thooksPath = /dev/null\n\tfsmonitor = false\n[commit]\n\tgpgSign = false\n[credential]\n\thelper =\n`;
        const configPath = fdPath(root, "owner.gitconfig");
        try {
          const created = await open(configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
          try {
            await created.writeFile(configText, "utf8");
            await created.sync();
          } finally {
            await created.close();
          }
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        const config = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        opened.push(config);
        const info = await config.stat();
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o377) !== 0 || info.size !== Buffer.byteLength(configText)) {
          throw new Error("Unsafe or changed session owner configuration");
        }
        if (await config.readFile("utf8") !== configText) throw new Error("Session owner identity is immutable");
        this.#mounts = { root, home, worktree, git, config };
        await this.#run({ kind: "initialize" }, false, true);
      } catch (error) {
        this.#mounts = undefined;
        await Promise.allSettled(opened.map((handle) => handle.close()));
        throw error;
      }
    });
    return this.#initialization;
  }

  async #operation(request: Request, readOnly: boolean, authorize: SandboxAuthorize, gitWritable = false): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      // Admission-time permission may have been revoked while this operation waited.
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      return this.#run(request, readOnly, gitWritable);
    });
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    const output = await this.#operation({ kind: "read", path: text(path, "path", 1024) }, true, authorize);
    return JSON.parse(output) as string;
  }

  async writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.#operation({ kind: "write", path: text(path, "path", 1024), content }, false, authorize);
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const output = await this.#operation({ kind: "list", path: text(path ?? ".", "path", 1024) }, true, authorize);
    return JSON.parse(output) as string[];
  }

  gitStatus(authorize: SandboxAuthorize): Promise<string> {
    return this.#operation({ kind: "status" }, true, authorize);
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize): Promise<string> {
    switch (operation.kind) {
      case "git.commit":
        if (readOnly) throw new Error("Read-only sandbox cannot commit");
        return this.#operation({ kind: "commit", message: text(operation.message, "commit message", 16 * 1024, true) }, false, authorize, true);
      case "bash":
        return this.#operation({ kind: "bash", command: text(operation.command, "shell command", 64 * 1024, true) }, readOnly, authorize);
      case "github.comment":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  async snapshot(authorize: SandboxAuthorize): Promise<SnapshotFile[]> {
    return JSON.parse(await this.#operation({ kind: "snapshot" }, true, authorize)) as SnapshotFile[];
  }

  /** Release pinned descriptors when the owning runner session closes. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#initialization?.catch(() => undefined);
    await this.#exclusive(async () => {
      const mounts = this.#mounts;
      this.#mounts = undefined;
      if (mounts) await Promise.allSettled(Object.values(mounts).map((handle) => handle.close()));
    });
  }

  #run(request: Request, readOnly: boolean, gitWritable: boolean): Promise<string> {
    const mounts = this.#mounts;
    if (!mounts) return Promise.reject(new Error("Sandbox is not initialized"));
    if (readOnly && gitWritable) return Promise.reject(new Error("Invalid read-only mount request"));
    const mount = readOnly ? "--ro-bind-fd" : "--bind-fd";
    const args = [
      "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--symlink", "usr/bin", "/bin",
      "--proc", "/proc", "--dev", "/dev",
      mount, "3", this.home,
      mount, "4", this.worktree,
      gitWritable ? "--bind-fd" : "--ro-bind-fd", "5", `${this.worktree}/.git`,
      "--ro-bind-fd", "6", `${this.home}/.gitconfig`,
      "--remount-ro", "/proc", "--remount-ro", "/",
      "--chdir", this.worktree, "--clearenv",
    ];
    for (const [name, value] of Object.entries(this.#environment)) args.push("--setenv", name, value);
    args.push("--", "/usr/bin/python3", "-I", "-c", HELPER);
    const limit = request.kind === "snapshot" ? MAX_SNAPSHOT_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    return new Promise<string>((resolveResult, reject) => {
      // Only these session descriptors are inherited, never the trusted root or
      // SQLite/binding files. Bubblewrap consumes them before executing the helper.
      const child = spawn("/usr/bin/bwrap", args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        detached: true,
        stdio: ["pipe", "pipe", "pipe", mounts.home.fd, mounts.worktree.fd, mounts.git.fd, mounts.config.fd],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      let spawnFailure: Error | undefined;
      const kill = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (errorCode(error) !== "ESRCH") child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        failure ??= `Sandbox exceeded ${TIMEOUT_MS}ms time limit`;
        kill();
      }, TIMEOUT_MS);
      const capture = (target: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, limit - bytes);
        if (remaining) target.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > limit) {
          failure ??= `Sandbox exceeded ${limit} byte output limit`;
          kill();
        }
      };
      child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk));
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.on("error", () => {
          failure ??= "Could not read sandbox output";
          kill();
        });
      }
      child.once("error", (error) => {
        spawnFailure = error;
        failure ??= "Bubblewrap is unavailable; refusing unsandboxed execution";
        kill();
      });
      child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        // Early process exit commonly closes stdin; the exit status is authoritative.
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
          failure ??= "Could not send sandbox request";
          kill();
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (failure || code !== 0 || signal) {
          const detail = failure ?? `Sandbox process failed (${signal ?? `exit ${code}`})`;
          const error = new SandboxProcessError(`${detail}${err ? `: ${err.slice(0, 4096).trim()}` : ""}`, code, signal, out, err);
          if (spawnFailure) error.cause = spawnFailure;
          reject(error);
        } else {
          // Structured filesystem responses use stdout only; shell/Git diagnostics
          // remain visible without corrupting their exit status or JSON tool output.
          resolveResult(request.kind === "bash" || request.kind === "commit" || request.kind === "status" ? out + err : out);
        }
      });
      child.stdin!.end(JSON.stringify(request));
    });
  }
}
