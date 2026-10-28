import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, open, realpath, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import { validCloneDirectory } from "../../../packages/shared/src/repositories.js";
import { EGRESS_PORT, EGRESS_SOCKET, egressEnvironment } from "./egress.js";
import type { HostCommandOperation, Operation, RunnerBinding } from "../../../packages/shared/src/types.js";
import type { ClonePushPreparation } from "./push.js";
import { resourceLaunch, validateResourceConfig, type ResourceConfig } from "./resources.js";
import { MAX_IMAGE_BYTES, imageType, type FileContent } from "./images.js";
import { CA_BUNDLE, trustedCertificates } from "./trust-store.js";
import { runHostShell } from "./host-shell.js";
import { checkedBrowse, type BrowseResult } from "./file-browser.js";
import { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";
import { commandLimits, gpuMounts, type CommandLimits } from "./host-config.js";
import type { IsolatedWorkspace } from "./workspace.js";
import { CREATE_FILE, OPEN_FILE, privateEntry } from "./platform.js";

export { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";

export const TIMEOUT_MS = 30_000;
/** Push rewrites and packs move whole repositories; only push kinds get this deadline. */
export const PUSH_TIMEOUT_MS = 60 * 60 * 1000;
export const OID = /^[0-9a-f]{40}$/;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_OUTPUT_BYTES = 48 * 1024 * 1024;
/** A whole image file as base64 in one JSON object, with room for its key. */
export const MAX_CONTENT_OUTPUT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sessionQueues = new Map<string, Promise<void>>();

export type SandboxAuthorize = () => Promise<void>;

export interface SandboxExecutionOptions {
  /** Trusted harness only: caller must separately require faux + allowTestShell. */
  allowTestShell?: boolean;
  /**
   * The host's owner allowed this command to run without the resource limits this host lacks. It still runs inside
   * the sandbox's namespaces; provisioned limits are always used when present.
   */
  unbounded?: boolean;
  /** The command's time limit and per-process limits, from the host's configuration; a 30-second command's without them. */
  limits?: CommandLimits;
  /** Lend the command the host's GPU render device, where it has one (HostConfig.gpu; see gpuMounts). */
  gpu?: boolean;
  /** Stops the command, as closing the sandbox does: a stopped message or a closing session ends a long one at once. */
  signal?: AbortSignal;
}

/** How one shell command runs, besides what every sandboxed step gets. */
interface CommandOptions { limits?: CommandLimits; gpu?: boolean; signal?: AbortSignal }

export interface SandboxOptions {
  /**
   * Host path of the session's egress proxy socket (see EgressProxy). Shell commands get it read-only at EGRESS_SOCKET,
   * and the helper relays the sandbox's loopback EGRESS_PORT to it: their only way out of the network namespace.
   */
  egressSocket?: string;
  /** The branch a clone session's shell commands may push through the proxy, given to them as PISTEAD_SESSION_BRANCH. */
  sessionBranch?: string;
  /**
   * The host repository cache's mirrors this session may borrow from (clone sessions on a cache host), asked for before
   * each shell command and each step that runs Git in a clone (a borrowing clone can't read its objects without them).
   * Each is mounted read-only at its `target` below MIRROR_ROOT, and for shell commands a `git` shim first on PATH makes
   * clones of the workspace's repositories borrow from them (see GIT_SHIM).
   */
  mirrors?: () => Promise<readonly MirrorMount[]>;
  /** Where the host's / is when shell commands look for its GPU (see gpuMounts): the host's own, unless a test gives a stand-in. */
  gpuRoot?: string;
}

export interface MirrorMount { source: string; target: string }
/** Where a clone session's shell commands see the host's mirrors; clones' `objects/info/alternates` name paths below it. */
export const MIRROR_ROOT = "/repository-mirrors";
const SHIM_DIRECTORY = "/opt/pistead/bin";
/** The host's trusted certificates in the session's private root, mounted read-only at CA_BUNDLE for shell commands. */
export const CA_BUNDLE_FILE = "ca-certificates.crt";
/** The steps that may run Git in an agent's clone, and so need the mirrors a clone borrows from. */
const MIRROR_KINDS: ReadonlySet<Request["kind"]> = new Set(["bash", "clone-head", "clone-push-prepare", "clone-push-pack", "clone-backup", "clone-restore"]);

/**
 * Where sandboxes find git-lfs: the host's own, as /usr is mounted read-only in every sandbox. Package managers install
 * it in /usr/bin; /usr/local/bin is not on sandboxed commands' PATH, so it is always named by its full path.
 */
const GIT_LFS_PATHS = ["/usr/bin/git-lfs", "/usr/local/bin/git-lfs"] as const;
/** The host's git-lfs, which sandboxed sessions can run, if it has one. */
export function hostGitLfs(): string | undefined {
  return GIT_LFS_PATHS.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

/**
 * `git` for clone sessions on a host with a repository cache or git-lfs. A clone of a workspace repository:
 * - on a cache host, first asks the egress proxy for the host's mirror and borrows its objects (--reference-if-able)
 *   instead of downloading them again. It waits for the mirror however long that takes: a mirror's first fill downloads
 *   the whole repository once, with the host's own Git credentials, and the clone never downloads it a second time
 *   beside it. The wait is told on stderr, and the fill goes on if the command stops. A dropped connection or a failure
 *   that may pass is asked again; only a mirror the host can't fill at all lets the clone go ahead without it. A mirror
 *   that stays unavailable, or that the command can't see yet (mounts are fixed when a command starts), fails the
 *   clone, to be run again;
 * - where the workspace turned Git LFS on for the repository and git-lfs is installed, configures the clone's LFS
 *   filters (in its own .git/config), so its checkout downloads LFS files' content through the proxy. Elsewhere clones
 *   keep LFS pointer files, as plain Git does.
 * Everything else runs Git unchanged.
 */
const GIT_SHIM = String.raw`#!/usr/bin/python3 -I
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

args = sys.argv[1:]
VALUED = {'-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--template', '-c', '--config', '--depth', '--shallow-since',
          '--shallow-exclude', '--separate-git-dir', '-j', '--jobs', '--filter', '--bundle-uri', '--server-option', '--ref-format',
          '--reference', '--reference-if-able', '--revision'}


LFS = next((path for path in ${JSON.stringify(GIT_LFS_PATHS)} if os.access(path, os.X_OK)), None)


def endpoint(name, url, timeout):
    query = urllib.parse.urlencode({'remote': url})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open('http://127.0.0.1:${EGRESS_PORT}/__pistead/' + name + '?' + query, timeout=timeout)


def ask(name, url, timeout):
    try:
        with endpoint(name, url, timeout) as response:
            answer = json.load(response)
            return answer if isinstance(answer, dict) else {}
    except Exception:
        return {}


def note(text):
    try:
        sys.stderr.write('pistead: ' + text + '\n')
        sys.stderr.flush()
    except Exception:
        pass


def described(progress):
    phase = progress.get('phase')
    text = phase if isinstance(phase, str) and phase.isalpha() else 'filling'
    percent = progress.get('percent')
    if type(percent) is int:
        text += ' %d%%' % percent
    count = progress.get('bytes')
    if type(count) is int and count > 0:
        size, unit = float(count), 'bytes'
        for bigger in ('KiB', 'MiB', 'GiB'):
            if size < 1024:
                break
            size, unit = size / 1024, bigger
        text += ', %s received' % ('%d bytes' % count if unit == 'bytes' else '%.1f %s' % (size, unit))
    return text


def mirror(url):
    # The host's mirror of a workspace repository once it is ready to borrow from, however long its fill takes; None where
    # the host keeps no mirror of the repository, or can't fill it at all. The proxy streams one JSON object per line, with
    # a heartbeat. A connection that drops while the fill goes on is asked again, which joins it; a failure that may pass,
    # or a proxy that doesn't answer, is asked again twice more. Then the clone stops, to be run again, rather than
    # downloading the repository without the cache.
    started, shown, failures, reason = time.monotonic(), None, 0, 'it did not answer'
    while True:
        progressed = transient = False
        try:
            with endpoint('mirror', url, 120) as response:
                for line in response:
                    try:
                        answer = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(answer, dict):
                        continue
                    path = answer.get('path')
                    if isinstance(path, str) and path:
                        if shown is not None:
                            note('the repository cache is ready; cloning from it')
                        return path
                    if 'error' in answer:
                        reason = str(answer['error'])[:300]
                        if answer.get('retry') is not True:
                            note('the host cannot fill its repository cache (%s); cloning without it' % reason)
                            return None
                        transient = True
                        break
                    progressed = True
                    progress, now = answer.get('progress'), time.monotonic()
                    if isinstance(progress, dict) and now - started >= 3 and (shown is None or now - shown >= 30):
                        if shown is None:
                            note('waiting for the host to fill its repository cache of ' + url + ': it downloads the repository once,'
                                 ' then every clone borrows from it, and it goes on if this command stops')
                        note('repository cache: ' + described(progress))
                        shown = now
        except urllib.error.HTTPError:
            # No repository cache on this host, or not one of the workspace's repositories: a clone as any other.
            return None
        except Exception:
            reason = 'it did not answer'
        failures = failures + 1 if transient or not progressed else 0
        if failures >= 3:
            note('the repository cache of ' + url + ' is not available right now (%s); run the clone again' % reason)
            sys.exit(128)
        time.sleep(failures or 1)


index = 0
while index < len(args) and args[index].startswith('-'):
    index += 2 if args[index] in ('-C', '-c') else 1
if index < len(args) and args[index] == 'clone':
    rest = args[index + 1:]
    position, url = 0, None
    while position < len(rest):
        argument = rest[position]
        if argument == '--':
            url = rest[position + 1] if position + 1 < len(rest) else None
            break
        if argument.startswith('-'):
            position += 2 if argument in VALUED else 1
            continue
        url = argument
        break
    borrowing = any(argument.startswith('--reference') or argument in ('-s', '--shared', '--dissociate') for argument in rest)
    extra = []
    if url and not borrowing:
        path = mirror(url)
        if path and not os.path.isdir(path):
            # Mounted from the next command on: cloning without it would download the whole repository again.
            note('the repository cache of ' + url + ' is ready, but this command started before it could see it; run the clone again')
            sys.exit(128)
        if path:
            extra += ['--reference-if-able', path]
    if url and LFS and ask('lfs', url, 10).get('lfs') is True:
        extra += ['-c', 'filter.lfs.process=' + LFS + ' filter-process', '-c', 'filter.lfs.smudge=' + LFS + ' smudge -- %f',
                  '-c', 'filter.lfs.clean=' + LFS + ' clean -- %f', '-c', 'filter.lfs.required=true']
    args = args[:index + 1] + extra + rest
os.execv('/usr/bin/git', ['git'] + args)
`;

export interface SnapshotFile {
  /** Relative to the constructor's sandbox root; data is base64, including binary files. */
  path: string;
  data: string;
  mode: number;
}

/**
 * One clone of a clone session as a backup keeps it (see Sandbox.cloneBackup). `worktree` commits its working tree,
 * untracked files included and ignored ones not, on top of `head`; `bundle` (base64) holds what `origin` doesn't have:
 * `worktree` and the local branches, as `refs/pistead/backup` and `refs/heads/*`.
 */
export interface CloneBackup {
  path: string; origin: string | null; branch: string | null; head: string | null; worktree: string;
  branches: [string, string][]; bundle: string | null;
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

interface Mounts {
  root: FileHandle;
  home: FileHandle;
  worktree: FileHandle;
  git: FileHandle;
  config: FileHandle;
}

export type SandboxRequest = Request;
type Request =
  | { kind: "initialize" }
  | { kind: "read" | "read-content" | "list" | "browse"; path: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "snapshot"; clones?: string[] }
  | { kind: "bash"; command: string }
  | { kind: "clone-head"; path: string }
  | { kind: "clone-push-prepare"; path: string; commit: string; old: string | null; tips: string[] }
  | { kind: "clone-push-pack"; path: string; commit: string; exclude: string[] }
  | { kind: "clone-backup" | "clone-pending" }
  | { kind: "clone-restore"; path: string; url: string; reference: string | null };

/** Push transfers: a pack streamed after the request line, or stdout handed over uncapped. */
interface Transfer { input?: AsyncIterable<Uint8Array>; output?: (stdout: Readable, kill: () => void) => void }

/* All untrusted filesystem access happens here, after entering the namespace.
 * realpath is only a policy check: actual opens walk pinned directory descriptors
 * with O_NOFOLLOW, so swapping a checked parent for a symlink cannot win a race.
 */
export const HELPER = String.raw`
import base64, json, os, re, resource, secrets, shutil, socket, stat, subprocess, sys, threading

# Linux lists a process's descriptors in /proc; macOS (the Seatbelt backend) in /dev/fd.
for fd_name in os.listdir('/proc/self/fd' if os.path.isdir('/proc/self/fd') else '/dev/fd'):
    fd = int(fd_name)
    if fd > 2:
        try:
            os.close(fd)
        except OSError:
            pass
os.umask(0o077)
PUSH_KINDS = ('clone-push-prepare', 'clone-push-pack')
# Checkouts from the host repository cache write whole repositories, like pushes read them.
LONG_KINDS = PUSH_KINDS + ('clone-backup', 'clone-restore')


def bounded(which, value):
    # An unprivileged process can't raise a hard limit: never ask for more than the runner itself has.
    hard = resource.getrlimit(which)[1]
    value = value if hard == resource.RLIM_INFINITY else min(value, hard)
    resource.setrlimit(which, (value, value))


def limits(request):
    # These remain defense in depth for fixed helpers/test fixtures, NOT session quotas.
    # Push rewrites and packs and cache checkouts handle whole repositories, so only they get larger bounds. A shell
    # command gets the ones the runner chose for the host's command time limit (commandLimits in host-config.ts).
    kind = request['kind']
    push = kind in LONG_KINDS
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    cpu, size, files = (3600, 16 * 1024 * 1024 * 1024, 256) if push else (25, 64 * 1024 * 1024, 256)
    given = request.get('limits') if kind == 'bash' else None
    if given is not None:
        values = [given.get(key) for key in ('cpu', 'size', 'files')] if isinstance(given, dict) and len(given) == 3 else []
        if len(values) != 3 or not all(type(value) is int and 0 < value <= 2 ** 62 for value in values):
            raise ValueError('invalid command limits')
        cpu, size, files = values
    bounded(resource.RLIMIT_CPU, cpu)
    bounded(resource.RLIMIT_FSIZE, size)
    bounded(resource.RLIMIT_NOFILE, files)
    # Shell commands inherit these limits, so they get no address-space cap: Go and Node reserve far
    # more address space than they use, and gh and node abort at start-up under 512 MiB. Their memory
    # bound is the session cgroup's memory.max, which the resource supervisor applies and reads back
    # before bash starts; Sandbox.execute refuses bash without it unless the host's owner waived limits.
    if kind != 'bash':
        memory = (4096 if push else 512) * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        except (ValueError, OSError):
            # macOS doesn't let a process lower its address-space limit; Linux always does.
            if sys.platform != 'darwin':
                raise


HOME = os.environ['HOME']
WORK = os.environ['SANDBOX_WORKTREE']
MAX_FILE = 1024 * 1024
MAX_IMAGE = 16 * 1024 * 1024
# Mirrors MAX_IMAGE_BYTES and IMAGE_SIGNATURES in images.ts, which re-checks the signature of every image returned.
IMAGE_SIGNATURES = (
    ((0, b'\x89PNG\r\n\x1a\n'),),
    ((0, b'\xff\xd8\xff'),),
    ((0, b'GIF87a'),),
    ((0, b'GIF89a'),),
    ((0, b'RIFF'), (8, b'WEBP')),
)
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


# Mirror fileBrowserLimits in packages/shared/src/types.ts.
BROWSE_ENTRIES = 1000
BROWSE_TEXT = 256 * 1024
BROWSE_IMAGE = 2 * 1024 * 1024
IMAGE_TYPES = ('image/png', 'image/jpeg', 'image/gif', 'image/gif', 'image/webp')


def entry_type(mode):
    if stat.S_ISDIR(mode):
        return 'directory'
    if stat.S_ISREG(mode):
        return 'file'
    if stat.S_ISLNK(mode):
        return 'symlink'
    return 'other'


def browse_directory(directory):
    # Entries are lstat-ed, never followed: a symlink is listed as one, and opening it resolves it again under parts_for.
    names = os.listdir(directory)
    if len(names) > MAX_ENTRIES * 10:
        raise ValueError('directory has too many entries')
    entries = []
    for name in names:
        try:
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        kind = entry_type(info.st_mode)
        entry = {'name': name, 'type': kind}
        if kind == 'file':
            entry['size'] = info.st_size
        entries.append(entry)
    entries.sort(key=lambda entry: (entry['type'] != 'directory', entry['name']))
    return {'type': 'directory', 'entries': entries[:BROWSE_ENTRIES], 'total': len(entries), 'truncated': len(entries) > BROWSE_ENTRIES}


def read_prefix(fd, limit):
    chunks, size = [], 0
    while size < limit:
        chunk = os.read(fd, min(65536, limit - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b''.join(chunks)


def browse_file(parent, name):
    # O_NONBLOCK keeps a FIFO from blocking the open; only regular files are read.
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return {'type': 'file', 'size': 0, 'truncated': False, 'binary': True}
        size = info.st_size
        head = read_prefix(fd, 16)
        image = next((IMAGE_TYPES[index] for index, signature in enumerate(IMAGE_SIGNATURES)
                      if all(head[offset:offset + len(part)] == part for offset, part in signature)), None)
        if image is not None:
            if size > BROWSE_IMAGE:
                return {'type': 'file', 'size': size, 'truncated': True, 'binary': True}
            data = head + read_prefix(fd, BROWSE_IMAGE + 1 - len(head))
            if len(data) > BROWSE_IMAGE:
                return {'type': 'file', 'size': size, 'truncated': True, 'binary': True}
            return {'type': 'file', 'size': size, 'truncated': False, 'image': {'mimeType': image, 'data': base64.b64encode(data).decode('ascii')}}
        data = head + read_prefix(fd, BROWSE_TEXT + 1 - len(head))
        truncated = len(data) > BROWSE_TEXT or size > BROWSE_TEXT
        data = data[:BROWSE_TEXT]
        if b'\0' in data:
            return {'type': 'file', 'size': size, 'truncated': truncated, 'binary': True}
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError as error:
            # A preview cut inside a multi-byte character ends before it.
            if not truncated or error.start < len(data) - 3 or error.reason != 'unexpected end of data':
                return {'type': 'file', 'size': size, 'truncated': truncated, 'binary': True}
            content = data[:error.start].decode('utf-8')
        return {'type': 'file', 'size': size, 'truncated': truncated, 'text': content}
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


# Hardening shared by every Git invocation; session commands add the worktree and owner identity below.
# Backends without bind mounts (macOS Seatbelt) see the session's Git directory where it is on the host, with a
# gitdir: file at WORK/.git, and name their own Git and Bash; bubblewrap mounts it at WORK/.git and uses /usr/bin.
GITDIR = os.environ.get('SANDBOX_GITDIR') or None
GIT_BINARY = os.environ.get('SANDBOX_GIT') or '/usr/bin/git'
BASH = os.environ.get('SANDBOX_BASH') or '/usr/bin/bash'


def open_gitdir(work):
    return os.open('.git', DIR_FLAGS, dir_fd=work) if GITDIR is None else os.open(GITDIR, DIR_FLAGS)


GIT_HARDENED = [GIT_BINARY, '--no-pager',
                '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                '-c', 'core.attributesFile=/dev/null', '-c', 'core.sshCommand=/usr/bin/false',
                '-c', 'credential.helper=', '-c', 'commit.gpgSign=false',
                '-c', 'tag.gpgSign=false', '-c', 'protocol.allow=never',
                '-c', 'core.pager=cat', '-c', 'core.editor=/usr/bin/false',
                '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
                '-c', 'core.preloadIndex=false', '-c', 'index.threads=1']
GIT = GIT_HARDENED + ['-c', 'core.worktree=' + WORK, '-c', 'safe.directory=' + WORK,
                      '-c', 'user.name=' + os.environ['GIT_AUTHOR_NAME'],
                      '-c', 'user.email=' + os.environ['GIT_AUTHOR_EMAIL']]


def egress_relay(path, port):
    # The sandbox has its own network namespace with only loopback. Each connection to the loopback port is relayed,
    # byte for byte, to the session's egress proxy socket, which decides what may leave.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', port))
    listener.listen(64)

    def pump(source, target):
        try:
            while True:
                data = source.recv(65536)
                if not data:
                    break
                target.sendall(data)
        except OSError:
            pass
        finally:
            try:
                target.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def serve(client):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(path)
        except OSError:
            upstream.close()
            client.close()
            return
        back = threading.Thread(target=pump, args=(upstream, client), daemon=True)
        back.start()
        pump(client, upstream)
        back.join()
        client.close()
        upstream.close()

    def accept():
        while True:
            try:
                client, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=serve, args=(client,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()


def run(argv, data=None):
    child = subprocess.run(argv, input=data, stdin=subprocess.DEVNULL if data is None else None,
                           cwd=WORK, close_fds=True)
    if child.returncode:
        sys.exit(child.returncode if child.returncode > 0 else 128 - child.returncode)


def snapshot(request):
    files, total = [], 0
    # Clones are backed up as bundles (clone-backup), never as files.
    clones = request.get('clones', [])
    if not isinstance(clones, list) or not all(clone_path(path) for path in clones):
        raise ValueError('invalid snapshot request')
    skipped = {'worktree/' + path for path in clones}

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
            if archive_path in skipped:
                continue
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
    git = open_gitdir(work)
    try:
        visit(home, 'home', ('.gitconfig',))
        owner = os.environ.get('SANDBOX_OWNER_CONFIG')
        if owner is None:
            add(home, '.gitconfig', 'owner.gitconfig')
        else:
            # Not mounted into the home: read where the runner keeps it.
            parent = os.open(os.path.dirname(owner), DIR_FLAGS)
            try:
                add(parent, os.path.basename(owner), 'owner.gitconfig')
            finally:
                os.close(parent)
        visit(work, 'worktree', ('.git',))
        # Push scratch repositories are transient and never belong in a backup; pending clone restorations go with the
        # clones' bundles.
        visit(git, 'git', ('pistead-push', CLONE_STATE))
        return files
    finally:
        os.close(git)
        os.close(work)
        os.close(home)


OID = re.compile('[0-9a-f]{40}')


def clone_directory(request):
    # A clone the agent made in the worktree: Git runs in it read-only, with its own config but the hardened flags.
    parts = parts_for(request['path'])
    directory = os.path.join(WORK, *parts)
    if not parts or not os.path.isdir(directory) or not os.path.lexists(os.path.join(directory, '.git')):
        raise ValueError('the clone directory is not a Git clone in the worktree')
    return directory


def clone_spawn(directory, arguments, stdout=subprocess.PIPE, extra=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', **(extra or {}))
    argv = GIT_HARDENED + ['--literal-pathspecs', '-c', 'safe.directory=' + directory, '-C', directory] + arguments
    return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=stdout, stderr=subprocess.DEVNULL, cwd=directory, env=env, close_fds=True)


def clone_git(directory, arguments, data=b''):
    child = clone_spawn(directory, arguments)
    output, _ = child.communicate(data)
    return child.returncode, output


def clone_head(request):
    directory = clone_directory(request)
    code, output = clone_git(directory, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    commit = output.decode('ascii', 'replace').strip()
    if code or not OID.fullmatch(commit):
        raise ValueError('the clone has no commit to push')
    code, output = clone_git(directory, ['config', '--get', 'remote.origin.url'])
    origin = output.decode('utf-8', 'replace').strip() if not code else None
    return {'commit': commit, 'origin': origin[:2048] if origin else None}


def clone_push_prepare(request):
    directory = clone_directory(request)
    commit, old, tips = request['commit'], request['old'], request['tips']
    if (not isinstance(commit, str) or not OID.fullmatch(commit) or (old is not None and (not isinstance(old, str) or not OID.fullmatch(old)))
            or not isinstance(tips, list) or len(tips) > 1024 or not all(isinstance(tip, str) and OID.fullmatch(tip) for tip in tips)):
        raise ValueError('invalid push request')
    names = [commit] + tips
    _, output = clone_git(directory, ['cat-file', '--batch-check=%(objecttype)'], ''.join(name + '^{commit}\n' for name in names).encode('ascii'))
    kinds = output.decode('ascii', 'replace').splitlines()
    if len(kinds) != len(names) or kinds[0] != 'commit':
        raise ValueError('the commit to push is not in the clone')
    present = [tip for tip, kind in zip(tips, kinds[1:]) if kind == 'commit']
    ancestor = None
    if old is not None:
        ancestor = old in present and clone_git(directory, ['merge-base', '--is-ancestor', old, commit])[0] == 0
    revisions = (commit + '\n' + ''.join('^' + tip + '\n' for tip in present)).encode('ascii')
    _, output = clone_git(directory, ['rev-list', '--count', '--stdin'], revisions)
    total = int(output.strip() or b'0')
    _, output = clone_git(directory, ['log', '--stdin', '--max-count=100', '--format=%H%x00%s'], revisions)
    commits = []
    for line in output.decode('utf-8', 'replace').splitlines():
        source, _, subject = line.partition('\0')
        if OID.fullmatch(source):
            commits.append({'source': source, 'subject': subject[:200]})
    return {'present': present, 'ancestor': ancestor, 'commits': commits, 'total': total}


def clone_push_pack(request):
    directory = clone_directory(request)
    commit, exclude = request['commit'], request['exclude']
    if (not isinstance(commit, str) or not OID.fullmatch(commit) or not isinstance(exclude, list) or len(exclude) > 1024
            or not all(isinstance(oid, str) and OID.fullmatch(oid) for oid in exclude)):
        raise ValueError('invalid push request')
    sys.stdout.flush()
    # The pack streams straight to the runner on the helper's stdout.
    child = clone_spawn(directory, ['-c', 'core.bigFileThreshold=64m', 'pack-objects', '--stdout', '--revs',
                                    '--delta-base-offset', '-q'], stdout=None)
    child.communicate((commit + '\n' + ''.join('^' + oid + '\n' for oid in exclude)).encode('ascii'))
    if child.returncode:
        raise ValueError('push pack failed')


# Clone sessions keep their clones' local work in backups as Git bundles, not as files: what the clone's origin already
# has is cloned again on restore. Pending restorations live in the worktree's .git, which shell commands see read-only.
CLONE_STATE = 'pistead-clones'
CLONE_PATH = re.compile(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){0,63}')
MAX_CLONES = 50
MAX_CLONE_BRANCHES = 200
MAX_CLONE_BUNDLES = 16 * 1024 * 1024
MAX_CLONE_SEARCH = 20000
BACKUP_IDENTITY = {'GIT_AUTHOR_NAME': 'Pistead', 'GIT_AUTHOR_EMAIL': 'backup@pistead.invalid',
                   'GIT_COMMITTER_NAME': 'Pistead', 'GIT_COMMITTER_EMAIL': 'backup@pistead.invalid'}
RESTORED_MARKER = 'pistead-restored'


def clone_path(value):
    return (isinstance(value, str) and len(value) <= 512 and CLONE_PATH.fullmatch(value) is not None
            and not any(part.lower() in ('.', '..', '.git') for part in value.split('/')))


def branch_name(value):
    # Mirrors validPushBranch in packages/shared/src/repositories.ts: Git's own rules for a branch name.
    return (isinstance(value, str) and 1 <= len(value) <= 200 and value not in ('HEAD', '@') and not value.startswith(('-', 'refs/'))
            and not re.search(r'[\s\x00-\x1f\x7f\\~^:?*[]', value) and not re.search('[\ud800-\udfff]', value)
            and '..' not in value and '@{' not in value and not value.endswith(('.', '/'))
            and not any(not part or part.startswith('.') or part.endswith('.lock') for part in value.split('/')))


def find_clones():
    # Directories of the worktree, up to four levels down, holding a .git directory: what git clone makes. Clones inside
    # clones count too. Dependency trees are not searched, and the search is bounded: a clone it misses is kept as files.
    found, visited = [], 0

    def visit(fd, parts):
        nonlocal visited
        for name in sorted(os.listdir(fd)):
            if name in ('.git', 'node_modules') or visited >= MAX_CLONE_SEARCH:
                continue
            if not stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                continue
            visited += 1
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                try:
                    marker = os.stat('.git', dir_fd=child, follow_symlinks=False)
                except FileNotFoundError:
                    marker = None
                path = '/'.join(parts + [name])
                if marker is not None and stat.S_ISDIR(marker.st_mode) and clone_path(path):
                    if len(found) >= MAX_CLONES:
                        raise ValueError('the worktree has too many clones to back up')
                    found.append(path)
                if len(parts) < 3:
                    visit(child, parts + [name])
            finally:
                os.close(child)

    work = os.open(WORK, DIR_FLAGS)
    try:
        visit(work, [])
    finally:
        os.close(work)
    return found


def clone_state(git):
    # The restorations still pending from the last restore of this session, without their bundles.
    try:
        state = os.open(CLONE_STATE, DIR_FLAGS, dir_fd=git)
    except FileNotFoundError:
        return None, []
    try:
        data, _ = read_at(state, 'manifest.json', MAX_FILE)
    except FileNotFoundError:
        return state, []
    clones = json.loads(data).get('clones')
    if not isinstance(clones, list):
        raise ValueError('invalid pending clone restorations')
    return state, clones


def save_clone_state(state, clones):
    text = json.dumps({'version': 1, 'clones': clones}, ensure_ascii=True).encode('ascii')
    fd = os.open('manifest.json.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=state)
    try:
        os.write(fd, text)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename('manifest.json.tmp', 'manifest.json', src_dir_fd=state, dst_dir_fd=state)


def clone_git_checked(directory, arguments, data=b'', extra=None, reason='the clone could not be backed up'):
    child = clone_spawn(directory, arguments, extra=extra)
    output, _ = child.communicate(data)
    if child.returncode:
        raise ValueError(reason)
    return output.decode('utf-8', 'replace').strip()


def clone_backup_one(path, nested, budget):
    directory = os.path.join(WORK, *path.split('/'))
    reason = 'the clone ' + path + ' could not be backed up'
    code, output = clone_git(directory, ['config', '--get', 'remote.origin.url'])
    origin = output.decode('utf-8', 'replace').strip()[:2048] if not code else None
    code, output = clone_git(directory, ['symbolic-ref', '-q', 'HEAD'])
    ref = output.decode('utf-8', 'replace').strip() if not code else ''
    branch = None
    if ref.startswith('refs/heads/'):
        branch = ref[len('refs/heads/'):]
        if not branch_name(branch):
            raise ValueError('the clone ' + path + ' is on a branch whose name can\'t be backed up')
    code, output = clone_git(directory, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    head = output.decode('ascii', 'replace').strip() if not code else None
    if head is None and os.path.exists(os.path.join(directory, '.git', 'objects', 'info', 'alternates')):
        # A clone borrowing from the host's mirror reads nothing without it, and the mirror is mounted only while this
        # session may read its repository.
        raise ValueError('the clone ' + path + ' borrows objects from the host cache that this session can\'t read now')
    if head is not None and not OID.fullmatch(head):
        raise ValueError(reason)
    branches = []
    for line in clone_git_checked(directory, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'], reason=reason).splitlines():
        name, _, oid = line.partition('\0')
        if not name.startswith('refs/heads/') or not branch_name(name[len('refs/heads/'):]) or not OID.fullmatch(oid):
            raise ValueError('the clone ' + path + ' has a branch whose name can\'t be backed up')
        branches.append([name[len('refs/heads/'):], oid])
    if len(branches) > MAX_CLONE_BRANCHES:
        raise ValueError('the clone ' + path + ' has too many branches to back up')
    # The working tree, untracked files included and ignored ones not, as a commit on top of HEAD. A copy of the clone's
    # own index is the starting point, so sparse checkouts stay as they are and unchanged files aren't read again; the
    # clone's index and HEAD are left alone. Clones inside this one are backed up on their own.
    index = os.path.join(directory, '.git', 'pistead-backup-index')
    extra = dict(BACKUP_IDENTITY, GIT_INDEX_FILE=index)
    try:
        try:
            shutil.copyfile(os.path.join(directory, '.git', 'index'), index, follow_symlinks=False)
        except FileNotFoundError:
            clone_git_checked(directory, ['read-tree', head] if head else ['read-tree', '--empty'], extra=extra, reason=reason)
        # Without the clone's LFS filters: git-lfs's clean filter would store a changed LFS file as a pointer to an object
        # in .git/lfs, which the bundle doesn't carry and sessions can't upload, so the change would be lost. Its content
        # goes into the bundle instead (within the budget below); unchanged files keep their pointers from the index.
        clone_git_checked(directory, ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false',
                                      'add', '-A'], extra=extra, reason=reason)
        if nested:
            clone_git_checked(directory, ['update-index', '--force-remove', '--'] + nested, extra=extra, reason=reason)
        tree = clone_git_checked(directory, ['write-tree'], extra=extra, reason=reason)
    finally:
        try:
            os.unlink(index)
        except FileNotFoundError:
            pass
    if not OID.fullmatch(tree):
        raise ValueError(reason)
    # A clean working tree is HEAD itself.
    if head is not None and clone_git_checked(directory, ['rev-parse', head + '^{tree}'], reason=reason) == tree:
        worktree = head
    else:
        worktree = clone_git_checked(directory, ['commit-tree', tree] + (['-p', head] if head else []),
                                     b'Pistead backup of the working tree\n', extra=BACKUP_IDENTITY, reason=reason)
    if not OID.fullmatch(worktree):
        raise ValueError(reason)
    # Only what the clone's origin has is left out; a restore fetches by commit whatever its origin no longer lists.
    bundle = None
    new = ['refs/pistead/backup', '--branches', '--not', '--remotes=origin']
    clone_git_checked(directory, ['update-ref', 'refs/pistead/backup', worktree], reason=reason)
    target = os.path.join(directory, '.git', 'pistead-backup.bundle')
    try:
        if int(clone_git_checked(directory, ['rev-list', '--count'] + new, reason=reason) or '0'):
            clone_git_checked(directory, ['bundle', 'create', target] + new, reason=reason)
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                if os.fstat(fd).st_size > budget:
                    raise ValueError('the clones\' local work exceeds the backup size limit')
                with os.fdopen(os.dup(fd), 'rb') as handle:
                    bundle = handle.read(budget + 1)
            finally:
                os.close(fd)
            if len(bundle) > budget:
                raise ValueError('the clones\' local work exceeds the backup size limit')
    finally:
        clone_git(directory, ['update-ref', '-d', 'refs/pistead/backup'])
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
    return {'path': path, 'origin': origin, 'branch': branch, 'head': head, 'worktree': worktree, 'branches': branches,
            'bundle': base64.b64encode(bundle).decode('ascii') if bundle is not None else None}


def clone_backup():
    paths = find_clones()
    budget = MAX_CLONE_BUNDLES
    clones = []
    for path in paths:
        nested = [other[len(path) + 1:] for other in paths if other.startswith(path + '/')]
        clone = clone_backup_one(path, nested, budget)
        if clone['bundle'] is not None:
            budget -= len(clone['bundle']) * 3 // 4
        clones.append(clone)
    # Restorations still pending stay in the backup as they were restored, whatever is at their paths now: a restore
    # never clones over something, so they stay pending there too.
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    state = None
    try:
        state, pending = clone_state(git)
        for entry in pending:
            if not isinstance(entry, dict) or not clone_path(entry.get('path')) or entry['path'] in paths:
                continue
            item = dict(entry)
            name = entry.get('bundle')
            item['bundle'] = None
            if name is not None:
                if not isinstance(name, str) or not re.fullmatch(r'[0-9]{1,2}\.bundle', name):
                    raise ValueError('invalid pending clone restorations')
                data, _ = read_at(state, name, budget)
                budget -= len(data)
                item['bundle'] = base64.b64encode(data).decode('ascii')
            clones.append(item)
            if len(clones) > MAX_CLONES:
                raise ValueError('the worktree has too many clones to back up')
    finally:
        if state is not None:
            os.close(state)
        os.close(git)
        os.close(work)
    # The snapshot leaves out the clones found, not the pending ones: whatever is at their paths is kept as files.
    return {'clones': clones, 'found': paths}


def clone_pending():
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    try:
        state, clones = clone_state(git)
        if state is not None:
            os.close(state)
        return [{'path': entry.get('path'), 'origin': entry.get('origin'), 'bundle': entry.get('bundle')}
                for entry in clones if isinstance(entry, dict)]
    finally:
        os.close(git)
        os.close(work)


def bundle_prerequisites(path):
    # The commits a bundle builds on: the "-<oid>" lines of its header, which ends at the first empty line.
    with open(path, 'rb') as handle:
        header = handle.read(4 * 1024 * 1024).split(b'\n\n', 1)[0]
    found = []
    for line in header.split(b'\n')[1:]:
        if line.startswith(b'-'):
            oid = line[1:41].decode('ascii', 'replace')
            if OID.fullmatch(oid):
                found.append(oid)
    return found


def clone_restore(request):
    # Clones one pending clone again through the egress proxy, then puts its local work back from its bundle: its
    # branches, HEAD, and the working tree as uncommitted changes. Its entry goes once that is done.
    path, url, reference = request['path'], request['url'], request.get('reference')
    if (not clone_path(path) or not isinstance(url, str) or not re.fullmatch(r'https://[\x21-\x7e]{1,2040}', url)
            or (reference is not None and (not isinstance(reference, str) or not reference.startswith('${MIRROR_ROOT}/')))):
        raise ValueError('invalid clone restoration')
    work = os.open(WORK, DIR_FLAGS)
    git = open_gitdir(work)
    state = None
    try:
        state, clones = clone_state(git)
        entry = next((item for item in clones if isinstance(item, dict) and item.get('path') == path), None)
        if state is None or entry is None:
            raise ValueError('no restoration is pending for this clone')
        origin, branch, head, worktree, branches, bundle = (entry.get(key) for key in ('origin', 'branch', 'head', 'worktree', 'branches', 'bundle'))
        if (not isinstance(origin, str) or not re.fullmatch(r'[\x21-\x7e]{1,2048}', origin) or (branch is not None and not branch_name(branch))
                or (head is not None and not OID.fullmatch(str(head))) or not OID.fullmatch(str(worktree)) or not isinstance(branches, list)
                or not all(isinstance(item, list) and len(item) == 2 and branch_name(item[0]) and OID.fullmatch(str(item[1])) for item in branches)
                or (bundle is not None and (not isinstance(bundle, str) or not re.fullmatch(r'[0-9]{1,2}\.bundle', bundle)))):
            raise ValueError('invalid clone restoration')
        remaining = [item for item in clones if not (isinstance(item, dict) and item.get('path') == path)]
        parts = path.split('/')
        directory = os.path.join(WORK, *parts)
        marker = os.path.join(directory, '.git', RESTORED_MARKER)
        if os.path.lexists(directory):
            # Restored before, but the list kept it (the runner stopped in between): only the list is left to update.
            try:
                with open(marker, 'rb') as handle:
                    done = handle.read(64).decode('ascii', 'replace').strip() == worktree
            except OSError:
                done = False
            if not done or os.path.islink(directory):
                raise ValueError('something else is already at the clone\'s path')
            save_clone_state(state, remaining)
            os.unlink(marker)
            return
        parent = WORK
        for part in parts[:-1]:
            parent = os.path.join(parent, part)
            try:
                os.mkdir(parent, 0o700)
            except FileExistsError:
                if not stat.S_ISDIR(os.lstat(parent).st_mode):
                    raise ValueError('something else is already at the clone\'s path')
        # Built beside its path and moved there whole, so an interrupted restoration leaves nothing in the way of the next.
        staging = os.path.join(parent, '.' + parts[-1] + '.pistead-restore')
        if os.path.lexists(staging):
            if os.path.islink(staging) or not os.path.isdir(staging):
                raise ValueError('something else is already at the clone\'s path')
            shutil.rmtree(staging)
        env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
        # Through the proxy: https remotes are rewritten to its loopback address (see egressEnvironment).
        argv = GIT_HARDENED + ['-c', 'protocol.http.allow=always', 'clone', '--quiet', '--no-checkout']
        if reference is not None:
            argv += ['--reference-if-able', reference]
        child = subprocess.run(argv + ['--', url, staging], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, cwd=parent, env=env, close_fds=True)
        if child.returncode:
            shutil.rmtree(staging, ignore_errors=True)
            raise ValueError('the clone could not be cloned again from its origin')
        reason = 'the clone\'s local work could not be put back'
        try:
            def present(oid):
                return clone_git(staging, ['cat-file', '-e', oid + '^{commit}'])[0] == 0

            # Commits the origin had at backup time but no longer lists (a branch merged and deleted, say) are fetched
            # by commit, which forges allow for what their pull requests still reach.
            def fetch_missing(oids):
                wanted = list(dict.fromkeys(oid for oid in oids if not present(oid)))
                if len(wanted) > 256:
                    raise ValueError('commits the backup builds on are no longer on the clone\'s origin')
                if wanted:
                    clone_git_checked(staging, ['-c', 'protocol.http.allow=always', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', url]
                                      + wanted, reason='commits the backup builds on are no longer on the clone\'s origin')

            if bundle is not None:
                source = os.path.join(GITDIR or os.path.join(WORK, '.git'), CLONE_STATE, bundle)
                fetch_missing(bundle_prerequisites(source))
                clone_git_checked(staging, ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', source,
                                            'refs/*:refs/pistead/restore/*'], reason=reason)
            fetch_missing([oid for _, oid in branches] + ([head] if head else []) + [worktree])
            # The origin as the clone named it (an SSH remote, say), not the form it was cloned again from.
            if origin != url:
                clone_git_checked(staging, ['remote', 'set-url', 'origin', origin], reason=reason)
            for name, oid in branches:
                clone_git_checked(staging, ['update-ref', 'refs/heads/' + name, oid], reason=reason)
            listed = {name for name, _ in branches}
            for line in clone_git_checked(staging, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/pistead'], reason=reason).splitlines():
                if line.startswith('refs/pistead/') or line[len('refs/heads/'):] not in listed:
                    clone_git_checked(staging, ['update-ref', '-d', line], reason=reason)
            if branch is not None:
                clone_git_checked(staging, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch], reason=reason)
            elif head is not None:
                clone_git_checked(staging, ['update-ref', '--no-deref', 'HEAD', head], reason=reason)
            clone_git_checked(staging, ['read-tree', '--reset', '-u', worktree], reason=reason)
            # The index goes back to HEAD, so the backed-up changes show as uncommitted again.
            clone_git_checked(staging, ['read-tree', head] if head else ['read-tree', '--empty'], reason=reason)
            with open(os.path.join(staging, '.git', RESTORED_MARKER), 'w') as handle:
                handle.write(worktree + '\n')
            if os.path.lexists(directory):
                raise ValueError('something else is already at the clone\'s path')
            os.rename(staging, directory)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        save_clone_state(state, remaining)
        os.unlink(marker)
        if bundle is not None:
            try:
                os.unlink(bundle, dir_fd=state)
            except FileNotFoundError:
                pass
    finally:
        if state is not None:
            os.close(state)
        os.close(git)
        os.close(work)


def main():
    # One JSON line.
    request = json.loads(sys.stdin.buffer.readline())
    kind = request['kind']
    limits(request)
    if kind == 'initialize':
        try:
            os.stat(os.path.join(GITDIR or os.path.join(WORK, '.git'), 'HEAD'), follow_symlinks=False)
        except FileNotFoundError:
            if GITDIR is None:
                run(GIT + ['init', '--quiet', '--template=', '--initial-branch=main', WORK])
            else:
                # The runner wrote WORK/.git, which the session can't change, pointing here.
                run(GIT + ['--git-dir=' + GITDIR, 'init', '--quiet', '--template=', '--initial-branch=main'])
                run(GIT + ['--git-dir=' + GITDIR, 'config', 'core.bare', 'false'])
        run(GIT + ['rev-parse', '--is-inside-work-tree'])
        return
    if kind == 'clone-head':
        print(json.dumps(clone_head(request), ensure_ascii=True))
        return
    if kind == 'clone-push-prepare':
        print(json.dumps(clone_push_prepare(request), ensure_ascii=True))
        return
    if kind == 'clone-push-pack':
        clone_push_pack(request)
        return
    if kind == 'clone-backup':
        print(json.dumps(clone_backup(), ensure_ascii=True))
        return
    if kind == 'clone-pending':
        print(json.dumps(clone_pending(), ensure_ascii=True))
        return
    if kind == 'clone-restore':
        egress = request.get('egress')
        if egress is not None:
            egress_relay(egress['socket'], int(egress['port']))
        clone_restore(request)
        return
    if kind == 'bash':
        egress = request.get('egress')
        if egress is not None:
            egress_relay(egress['socket'], int(egress['port']))
        run([BASH, '--noprofile', '--norc', '-c', request['command']])
        return
    if kind == 'snapshot':
        print(json.dumps(snapshot(request), ensure_ascii=True))
        return
    root = os.open(WORK, DIR_FLAGS)
    try:
        parts = parts_for(request['path'], kind == 'write')
        if kind == 'write':
            write_at(root, parts, request['content'])
            result = None
        elif kind == 'read' or kind == 'read-content':
            if not parts:
                raise ValueError('a file path is required')
            parent = walk(root, parts[:-1])
            try:
                if kind == 'read':
                    result = read_at(parent, parts[-1], MAX_FILE)[0].decode('utf-8')
                else:
                    data = read_at(parent, parts[-1], MAX_IMAGE)[0]
                    if any(all(data[offset:offset + len(part)] == part for offset, part in signature)
                           for signature in IMAGE_SIGNATURES):
                        result = {'image': base64.b64encode(data).decode('ascii')}
                    elif len(data) > MAX_FILE:
                        raise ValueError('file exceeds size limit')
                    else:
                        result = {'text': data.decode('utf-8')}
            finally:
                os.close(parent)
        elif kind == 'browse':
            if not parts:
                result = browse_directory(root)
            else:
                parent = walk(root, parts[:-1])
                try:
                    info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        directory = os.open(parts[-1], DIR_FLAGS, dir_fd=parent)
                        try:
                            result = browse_directory(directory)
                        finally:
                            os.close(directory)
                    else:
                        result = browse_file(parent, parts[-1])
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

/** Waits for a writable to drain or close, removing whichever listener did not fire so long streams never accumulate listeners. */
export function drained(stream: Writable): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (stream.destroyed) { resolve(); return promise; }
  const done = () => { stream.off("drain", done); stream.off("close", done); resolve(); };
  stream.on("drain", done);
  stream.on("close", done);
  return promise;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function text(value: unknown, label: string, limit: number, multiline = false): string {
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

export function quoteGitConfig(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

/** Immutable per-session owner Git config, shared with the unsandboxed host workspace. */
export function ownerGitConfig(identity: Readonly<SandboxIdentity>): string {
  const { ownerId, githubLogin, gitName, gitEmail, home, worktree } = identity;
  return `# Immutable session owner: ${JSON.stringify({ ownerId, githubLogin, gitName, gitEmail, home, worktree })}\n[user]\n\tname = ${quoteGitConfig(gitName)}\n\temail = ${quoteGitConfig(gitEmail)}\n[core]\n\thooksPath = /dev/null\n\tfsmonitor = false\n[commit]\n\tgpgSign = false\n[credential]\n\thelper =\n`;
}

/** The complete process environment for session tools; nothing is inherited from the runner. */
export function sessionEnvironment(identity: Readonly<SandboxIdentity>, tools: { path: string; gitConfig: string }): Readonly<Record<string, string>> {
  return Object.freeze({
    ...identity.env,
    PATH: tools.path,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    HOME: identity.home,
    PWD: identity.worktree,
    TMPDIR: `${identity.home}/.tmp`,
    XDG_CONFIG_HOME: `${identity.home}/.config`,
    XDG_CACHE_HOME: `${identity.home}/.cache`,
    SANDBOX_WORKTREE: identity.worktree,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: tools.gitConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_EDITOR: "/usr/bin/false",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: identity.gitName,
    GIT_AUTHOR_EMAIL: identity.gitEmail,
    GIT_COMMITTER_NAME: identity.gitName,
    GIT_COMMITTER_EMAIL: identity.gitEmail,
  });
}

/** Only runner-owned cache directories, at their fixed place below MIRROR_ROOT. */
function mirrorMount(mount: MirrorMount): boolean {
  return isAbsolute(mount.source) && !mount.source.split(sep).includes("..")
    && /^\/repository-mirrors\/[a-z0-9-]{1,32}\/[a-z0-9._-]{1,253}\/[A-Za-z0-9{}_-]{1,100}\.git$/.test(mount.target);
}

/** Creates the read-only owner Git config once, then verifies it is the unchanged private original. */
export async function pinOwnerConfig(path: string, configText: string): Promise<FileHandle> {
  try {
    const created = await open(path, CREATE_FILE, 0o400);
    try {
      await created.writeFile(configText, "utf8");
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const config = await open(path, OPEN_FILE);
  try {
    const info = await config.stat();
    if (!info.isFile() || info.nlink !== 1 || !privateEntry(info, 0o377) || info.size !== Buffer.byteLength(configText)) {
      throw new Error("Unsafe or changed session owner configuration");
    }
    if (await config.readFile("utf8") !== configText) throw new Error("Session owner identity is immutable");
    return config;
  } catch (error) {
    await config.close();
    throw error;
  }
}

/**
 * Linux-only execution boundary. The caller supplies a trusted live-authorization
 * callback, which is awaited after queueing, immediately before execution.
 * execute() takes the exact approved Operation, never a reconstructed shell command.
 * No host-shell, host-Git, or host-filesystem-tool fallback exists.
 */
export class Sandbox implements IsolatedWorkspace {
  readonly isolated = true;
  readonly #root: string;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #resources: Readonly<ResourceConfig> | undefined;
  readonly #sessionKey: string;
  readonly #testProvider: boolean;
  readonly #egressSocket: string | undefined;
  readonly #sessionBranch: string | undefined;
  readonly #mirrors: (() => Promise<readonly MirrorMount[]>) | undefined;
  readonly #gpuRoot: string;
  /** Whether shell commands get the `git` shim: on a cache host, or where git-lfs is installed, in sessions with a proxy. */
  readonly #shim: boolean;
  #initialization: Promise<void> | undefined;
  #mounts: Mounts | undefined;
  #closed = false;
  #cancelActive: (() => void) | undefined;

  constructor(binding: RunnerBinding, root: string, resources?: ResourceConfig, options: SandboxOptions = {}) {
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
    this.#sessionKey = key;
    this.#resources = resources ? validateResourceConfig(resources) : undefined;
    this.#testProvider = binding.model.provider === "faux";
    if (options.egressSocket !== undefined && !isAbsolute(options.egressSocket)) throw new Error("Invalid egress socket path");
    this.#egressSocket = options.egressSocket;
    this.#sessionBranch = options.sessionBranch;
    this.#mirrors = options.mirrors;
    this.#gpuRoot = options.gpuRoot ?? "/";
    this.#shim = options.egressSocket !== undefined && (options.mirrors !== undefined || hostGitLfs() !== undefined);
    const base = `/sessions/${key}`;
    this.#root = resolve(root);
    this.#identity = Object.freeze({ ownerId, githubLogin, gitName, gitEmail, home: `${base}/home`, worktree: `${base}/worktree`, env });
    this.#environment = sessionEnvironment(this.#identity, { path: "/usr/bin:/bin", gitConfig: `${this.home}/.gitconfig` });
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
        const config = await pinOwnerConfig(fdPath(root, "owner.gitconfig"), ownerGitConfig(this.#identity));
        // The shim lives beside the session's mounts, where nothing in the sandbox can change it.
        if (this.#shim) {
          const shim = join(this.#root, "bin", "git");
          await mkdir(join(this.#root, "bin"), { recursive: true, mode: 0o700 });
          // Written afresh at every open: the previous one is read-only, and may be an older version.
          await rm(shim, { force: true });
          await writeFile(shim, GIT_SHIM, { mode: 0o500 });
          await chmod(shim, 0o500);
        }
        // Beside the shim, out of the sandbox's reach; written at every open, so the host's current store applies.
        if (this.#egressSocket !== undefined) {
          // Replaced in one step, so no command ever finds the file missing or half written.
          const bundle = join(this.#root, CA_BUNDLE_FILE);
          const staged = `${bundle}.new`;
          await rm(staged, { force: true });
          await writeFile(staged, trustedCertificates(), { mode: 0o400 });
          await chmod(staged, 0o400);
          await rename(staged, bundle);
        }
        opened.push(config);
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

  async #operation(request: Request, readOnly: boolean, authorize: SandboxAuthorize, gitWritable = false, requireResources = false, command: CommandOptions = {}): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      // Admission-time permission may have been revoked while this operation waited.
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      // A command stopped while it waited for the sandbox never starts.
      if (command.signal?.aborted) throw new SandboxProcessError("Command stopped before it started", null, null, "", "");
      return this.#run(request, readOnly, gitWritable, requireResources, {}, await this.#mirrorMounts(request), command);
    });
  }

  /** The mirrors to mount for `request`: asked for only for steps that may run Git in a clone. */
  async #mirrorMounts(request: Request): Promise<readonly MirrorMount[]> {
    return this.#mirrors && MIRROR_KINDS.has(request.kind) ? (await this.#mirrors()).filter(mirrorMount) : [];
  }

  async readFile(path: string, authorize: SandboxAuthorize): Promise<string> {
    const output = await this.#operation({ kind: "read", path: text(path, "path", 1024) }, true, authorize);
    return JSON.parse(output) as string;
  }

  /** Like `readFile`, but an image (by signature, up to `MAX_IMAGE_BYTES`) comes back as its bytes. */
  async readContent(path: string, authorize: SandboxAuthorize): Promise<FileContent> {
    const output = JSON.parse(await this.#operation({ kind: "read-content", path: text(path, "path", 1024) }, true, authorize)) as { text: string } | { image: string };
    if ("text" in output) return { text: output.text };
    const image = Buffer.from(output.image, "base64");
    const mimeType = imageType(image);
    if (!mimeType) throw new Error("Invalid sandbox image response");
    return { image, mimeType };
  }

  async writeFile(path: string, content: string, authorize: SandboxAuthorize): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.#operation({ kind: "write", path: text(path, "path", 1024), content }, false, authorize);
  }

  async listFiles(path: string | undefined, authorize: SandboxAuthorize): Promise<string[]> {
    const output = await this.#operation({ kind: "list", path: text(path ?? ".", "path", 1024) }, true, authorize);
    return JSON.parse(output) as string[];
  }

  /** The file browser's read-only look at one worktree path: a directory's entries or a file's preview. */
  async browse(path: string, authorize: SandboxAuthorize): Promise<BrowseResult> {
    return checkedBrowse(JSON.parse(await this.#operation({ kind: "browse", path: text(path, "path", 1024) }, true, authorize)));
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "bash": {
        if (options.allowTestShell === true && !this.#testProvider) throw new Error("Test shell bypass is restricted to the explicit faux provider");
        const bounded = options.allowTestShell !== true && (!!this.#resources || options.unbounded !== true);
        if (bounded && !this.#resources) {
          throw new Error("Production bash unavailable: explicitly provisioned cgroup and bounded filesystem resources are required");
        }
        return this.#operation({ kind: "bash", command: text(operation.command, "shell command", 64 * 1024, true) }, readOnly, authorize, false, bounded,
          { limits: options.limits, gpu: options.gpu, signal: options.signal });
      }
      case "github.comment":
      case "github.merge":
      case "github.issue":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  /** The session's files, leaving out `clones` (worktree paths), which a backup keeps as bundles (cloneBackup). */
  async snapshot(authorize: SandboxAuthorize, clones: readonly string[] = []): Promise<SnapshotFile[]> {
    return JSON.parse(await this.#operation({ kind: "snapshot", ...(clones.length ? { clones: [...clones] } : {}) }, true, authorize)) as SnapshotFile[];
  }

  /**
   * A clone session's clones as a backup keeps them: for each, its origin, branches and HEAD, a commit of its working
   * tree, and a bundle of what its origin doesn't have. Restorations still pending are carried over as they are.
   * `found` are the clones in the worktree, which the snapshot leaves out.
   */
  async cloneBackup(authorize: SandboxAuthorize): Promise<{ clones: CloneBackup[]; found: string[] }> {
    const value = JSON.parse(await this.#operation({ kind: "clone-backup" }, false, authorize)) as { clones: CloneBackup[]; found: string[] };
    if (!Array.isArray(value?.clones) || !Array.isArray(value.found) || !value.found.every(path => validCloneDirectory(path))) throw new Error("Invalid sandbox clone response");
    return value;
  }

  /** The clones a restore left to clone again, by worktree path. */
  async clonePending(authorize: SandboxAuthorize): Promise<{ path: string; origin: string | null }[]> {
    const value = JSON.parse(await this.#operation({ kind: "clone-pending" }, true, authorize)) as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid sandbox clone response");
    return value.filter((entry): entry is { path: string; origin: string | null } => !!entry && typeof entry === "object"
      && validCloneDirectory((entry as { path?: unknown }).path) && ((entry as { origin?: unknown }).origin === null || typeof (entry as { origin?: unknown }).origin === "string"))
      .map(entry => ({ path: entry.path, origin: entry.origin }));
  }

  /**
   * Clones one pending clone again from `url` (its workspace repository's https remote) through the egress proxy,
   * borrowing from `reference` (a mounted mirror) when given, and puts its backed-up work back; its origin stays as the
   * clone named it. Its pending entry goes once that is done.
   */
  async cloneRestore(path: string, url: string, reference: string | null, authorize: SandboxAuthorize): Promise<void> {
    if (!validCloneDirectory(path) || !/^https:\/\/[\x21-\x7e]{1,2040}$/.test(url) || (reference !== null && !reference.startsWith(`${MIRROR_ROOT}/`)))
      throw new Error("Invalid clone restoration");
    await this.#operation({ kind: "clone-restore", path, url, reference }, false, authorize, true);
  }

  /** Explicit host-owner-approved execution, serialized with sandbox file/Git operations; never a fallback. */
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
          worktree: resolve(this.#root, "worktree"), git: resolve(this.#root, "git"), gitConfig: resolve(this.#root, "owner.gitconfig"),
          gitName: this.#identity.gitName, gitEmail: this.#identity.gitEmail,
          signal: AbortSignal.any([signal, controller.signal]),
        });
      } finally { if (this.#cancelActive === cancel) this.#cancelActive = undefined; }
    });
  }
  async cloneHead(path: string, authorize: SandboxAuthorize): Promise<{ commit: string; origin: string | null }> {
    if (!validCloneDirectory(path)) throw new Error("Invalid clone directory");
    const value = JSON.parse(await this.#operation({ kind: "clone-head", path }, true, authorize)) as { commit: unknown; origin: unknown };
    if (typeof value.commit !== "string" || !OID.test(value.commit) || (value.origin !== null && typeof value.origin !== "string")) throw new Error("Invalid clone head");
    return { commit: value.commit, origin: value.origin };
  }

  /** Which advertised tips the clone has, whether the branch's tip is an ancestor of `commit`, and the commits to push. */
  async clonePushPrepare(path: string, input: { commit: string; old: string | null; tips: string[] }, authorize: SandboxAuthorize): Promise<ClonePushPreparation> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || (input.old !== null && !OID.test(input.old))
      || input.tips.length > 1024 || !input.tips.every((tip) => OID.test(tip))) throw new Error("Invalid push request");
    const value = JSON.parse(await this.#operation({ kind: "clone-push-prepare", path, commit: input.commit, old: input.old, tips: [...input.tips] }, true, authorize)) as ClonePushPreparation;
    if (!Array.isArray(value.present) || !value.present.every((tip) => input.tips.includes(tip)) || (value.ancestor !== null && typeof value.ancestor !== "boolean")
      || !Array.isArray(value.commits) || value.commits.some((commit) => !OID.test(commit.source) || typeof commit.subject !== "string")
      || !Number.isSafeInteger(value.total) || value.total < value.commits.length) throw new Error("Invalid push preparation");
    return { present: value.present, ancestor: value.ancestor, commits: value.commits.map(({ source, subject }) => ({ source, subject })), total: value.total };
  }

  /** Streams the clone's pack of `commit` minus `exclude`; the session queue is held until the stream ends. */
  async clonePushPack(path: string, input: { commit: string; exclude: string[] }, authorize: SandboxAuthorize): Promise<AsyncIterable<Uint8Array>> {
    if (!validCloneDirectory(path) || !OID.test(input.commit) || input.exclude.length > 1024 || !input.exclude.every((oid) => OID.test(oid))) throw new Error("Invalid push request");
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    const started = Promise.withResolvers<{ stdout: Readable; kill: () => void }>();
    const finished = this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      const request: Request = { kind: "clone-push-pack", path, commit: input.commit, exclude: [...input.exclude] };
      await this.#run(request, true, false, false, { output: (stdout, kill) => started.resolve({ stdout, kill }) }, await this.#mirrorMounts(request));
    });
    finished.catch((error) => started.reject(error));
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

  /** Release pinned descriptors when the owning runner session closes. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelActive?.();
    await this.#initialization?.catch(() => undefined);
    await this.#exclusive(async () => {
      const mounts = this.#mounts;
      this.#mounts = undefined;
      if (mounts) await Promise.allSettled(Object.values(mounts).map((handle) => handle.close()));
    });
  }

  #run(request: Request, readOnly: boolean, gitWritable: boolean, requireResources = false, transfer: Transfer = {}, mirrors: readonly MirrorMount[] = [],
    command: CommandOptions = {}): Promise<string> {
    const mounts = this.#mounts;
    if (!mounts) return Promise.reject(new Error("Sandbox is not initialized"));
    if (readOnly && gitWritable) return Promise.reject(new Error("Invalid read-only mount request"));
    if (requireResources && !this.#resources) return Promise.reject(new Error("Production bash resources are unavailable"));
    const mount = readOnly ? "--ro-bind-fd" : "--bind-fd";
    const egress = request.kind === "bash" || request.kind === "clone-restore" ? this.#egressSocket : undefined;
    // Only shell commands get the GPU, and only its render device; it is looked up again for each one.
    const gpu = request.kind === "bash" && command.gpu ? gpuMounts(this.#gpuRoot) : undefined;
    const limits = request.kind === "bash" ? command.limits : undefined;
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
      // Only shell commands reach the network, and only through the session's proxy. A missing socket (the session is
      // not open) is skipped; requests then fail to connect.
      // The certificates are written whenever there is a proxy, so a missing file is an error, not a skipped mount.
      ...(egress ? ["--ro-bind-try", egress, EGRESS_SOCKET, "--ro-bind", join(this.#root, CA_BUNDLE_FILE), CA_BUNDLE] : []),
      ...(egress && this.#shim ? ["--ro-bind-try", join(this.#root, "bin"), SHIM_DIRECTORY] : []),
      ...mirrors.flatMap(({ source, target }) => ["--ro-bind-try", source, target]),
      ...(gpu?.args ?? []),
      "--remount-ro", "/proc", "--remount-ro", "/dev", "--remount-ro", "/",
      "--chdir", this.worktree, "--clearenv",
    ];
    for (const [name, value] of Object.entries(this.#environment)) args.push("--setenv", name, value);
    if (egress) for (const [name, value] of Object.entries(egressEnvironment(this.#sessionBranch))) args.push("--setenv", name, value);
    if (egress && this.#shim) args.push("--setenv", "PATH", `${SHIM_DIRECTORY}:${this.#environment.PATH}`);
    for (const [name, value] of Object.entries(gpu?.env ?? {})) args.push("--setenv", name, value);
    args.push("--", "/usr/bin/python3", "-I", "-c", HELPER);
    const limit = request.kind === "snapshot" || request.kind === "clone-backup" ? MAX_SNAPSHOT_OUTPUT_BYTES : request.kind === "read-content" ? MAX_CONTENT_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    const deadline = ["clone-push-prepare", "clone-push-pack", "clone-backup", "clone-restore"].includes(request.kind)
      ? PUSH_TIMEOUT_MS : (limits ?? commandLimits(TIMEOUT_MS / 1000)).seconds * 1000;
    const launch = requireResources
      ? resourceLaunch(this.#resources!, this.#sessionKey, args, deadline / 1000)
      : { command: "/usr/bin/bwrap", args };
    return new Promise<string>((resolveResult, reject) => {
      // Resource supervisor alone receives root fd 8 and liveness pipe 7. It closes
      // both before bwrap exec; neither is exposed to the untrusted namespace.
      const child = spawn(launch.command, launch.args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        detached: true,
        stdio: requireResources
          ? ["pipe", "pipe", "pipe", mounts.home.fd, mounts.worktree.fd, mounts.git.fd, mounts.config.fd, "pipe", mounts.root.fd]
          : ["pipe", "pipe", "pipe", mounts.home.fd, mounts.worktree.fd, mounts.git.fd, mounts.config.fd],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      let spawnFailure: Error | undefined;
      const kill = () => {
        if (!child.pid) return;
        if (requireResources) {
          // Never SIGKILL the supervisor: it must retain its lock until the entire
          // cgroup is killed and empty. It also watches parent EOF + its own deadline.
          child.kill("SIGTERM");
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (errorCode(error) !== "ESRCH") child.kill("SIGKILL");
        }
      };
      const cancel = () => {
        failure ??= "Sandbox closed";
        kill();
      };
      this.#cancelActive = cancel;
      const stop = () => {
        failure ??= "Command stopped";
        kill();
      };
      command.signal?.addEventListener("abort", stop, { once: true });
      if (command.signal?.aborted) stop();
      const timer = setTimeout(() => {
        failure ??= `Sandbox exceeded ${deadline}ms time limit`;
        kill();
      }, deadline);
      const capture = (target: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, limit - bytes);
        if (remaining) target.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > limit) {
          failure ??= `Sandbox exceeded ${limit} byte output limit`;
          kill();
        }
      };
      // Push packs stream to the forge uncapped; stderr stays bounded.
      if (transfer.output) transfer.output(child.stdout!, cancel);
      else child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk));
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.on("error", () => {
          failure ??= "Could not read sandbox output";
          kill();
        });
      }
      child.once("error", (error) => {
        spawnFailure = error;
        failure ??= "Sandbox launcher is unavailable; refusing unsandboxed execution";
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
        command.signal?.removeEventListener("abort", stop);
        if (this.#cancelActive === cancel) this.#cancelActive = undefined;
        child.stdio.at(7)?.destroy();
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
          resolveResult(request.kind === "bash" ? out + err : out);
        }
      });
      const line = JSON.stringify({ ...request, ...(egress ? { egress: { socket: EGRESS_SOCKET, port: EGRESS_PORT } } : {}),
        ...(limits ? { limits: { cpu: limits.cpuSeconds, size: limits.fileBytes, files: limits.openFiles } } : {}) });
      const input = transfer.input;
      if (!input) child.stdin!.end(line);
      else {
        // One request line, then the upstream pack with backpressure.
        void (async () => {
          const stdin = child.stdin!;
          stdin.write(`${line}\n`);
          for await (const chunk of input) {
            if (stdin.destroyed) break;
            if (!stdin.write(chunk)) await drained(stdin);
          }
          stdin.end();
        })().catch(() => {
          failure ??= "Could not stream the upstream pack";
          kill();
        });
      }
    });
  }
}
