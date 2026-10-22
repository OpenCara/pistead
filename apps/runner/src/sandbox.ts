import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import { repositoryLimits, validCloneDirectory, type SessionRepository } from "../../../packages/shared/src/repositories.js";
import { repositoryPinIdentity } from "./protocol.js";
import { EGRESS_PORT, EGRESS_SOCKET, egressEnvironment } from "./egress.js";
import type { HostCommandOperation, Operation, RunnerBinding } from "../../../packages/shared/src/types.js";
import type { ClonePushPreparation, PushPreparation } from "./push.js";
import { resourceLaunch, validateResourceConfig, type ResourceConfig } from "./resources.js";
import { MAX_IMAGE_BYTES, imageType, type FileContent } from "./images.js";
import { runHostShell } from "./host-shell.js";
import { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";

export { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";

export const TIMEOUT_MS = 30_000;
/** Push rewrites and packs move whole repositories; only push kinds get this deadline. */
const PUSH_TIMEOUT_MS = 60 * 60 * 1000;
const PUSH_ID = /^[0-9a-f]{32}$/;
const OID = /^[0-9a-f]{40}$/;
export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_OUTPUT_BYTES = 48 * 1024 * 1024;
/** A whole image file as base64 in one JSON object, with room for its key. */
const MAX_CONTENT_OUTPUT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
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
}

export interface SandboxOptions {
  /**
   * Host paths of the repository cache's object directories, keyed by pin path (`RepositoryCache.objects`). Each is
   * mounted read-only for every sandboxed process, at `/repository-cache/<n>` in pin order, which the session's
   * `objects/info/alternates` names once its repositories are checked out of the cache.
   */
  repositoryObjects?: Readonly<Record<string, string>>;
  /**
   * Host path of the session's egress proxy socket (see EgressProxy). Shell commands get it read-only at EGRESS_SOCKET,
   * and the helper relays the sandbox's loopback EGRESS_PORT to it: their only way out of the network namespace.
   */
  egressSocket?: string;
  /**
   * The host repository cache's mirrors this session may borrow from (clone sessions on a cache host), read per shell
   * command. Each is mounted read-only at its `target` below MIRROR_ROOT, and a `git` shim first on PATH makes clones
   * of the workspace's repositories borrow from them (see GIT_SHIM).
   */
  mirrors?: () => readonly MirrorMount[];
}

export interface MirrorMount { source: string; target: string }
/** Where a clone session's shell commands see the host's mirrors; clones' `objects/info/alternates` name paths below it. */
export const MIRROR_ROOT = "/repository-mirrors";
const SHIM_DIRECTORY = "/opt/pistead/bin";

/**
 * `git` for clone sessions on a cache host: a clone of a workspace repository first asks the egress proxy to bring the
 * host's mirror up to date, then borrows its objects (--reference-if-able) instead of downloading them again. If the
 * mirror is not ready within 20 seconds, the clone goes ahead on its own. Everything else runs Git unchanged.
 */
const GIT_SHIM = String.raw`#!/usr/bin/python3 -I
import json, os, sys, urllib.parse, urllib.request

args = sys.argv[1:]
VALUED = {'-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--template', '-c', '--config', '--depth', '--shallow-since',
          '--shallow-exclude', '--separate-git-dir', '-j', '--jobs', '--filter', '--bundle-uri', '--server-option', '--ref-format'}


def mirror(url):
    query = urllib.parse.urlencode({'remote': url})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:${EGRESS_PORT}/__pistead/mirror?' + query, timeout=20) as response:
            return json.load(response).get('path')
    except Exception:
        return None


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
    if url and not borrowing:
        path = mirror(url)
        if path:
            args = args[:index + 1] + ['--reference-if-able', path] + rest
os.execv('/usr/bin/git', ['git'] + args)
`;

/** "absent": pristine storage. Otherwise how the ready baseline was made: from archives, or from the host repository cache. */
export type RepositoryCacheState = "absent" | "archive" | "cache";

export function repositoryCacheState(value: unknown): RepositoryCacheState {
  if (value === false) return "absent";
  if (value === "cache") return "cache";
  if (value === true || value === "archive") return "archive";
  throw new Error("Invalid repository cache state");
}

const CACHE_MOUNT = "/repository-cache";

/**
 * Cache object directories in pin order. Only the runner configures them; they must still be canonical absolute
 * paths outside the session's own storage, and usable as alternates entries (no newline or ":").
 */
export function repositoryObjectPaths(repositories: readonly SessionRepository[], objects: Readonly<Record<string, string>> | undefined, root: string): string[] {
  if (objects === undefined) return [];
  if (!objects || typeof objects !== "object" || Object.keys(objects).sort().join("\n") !== repositories.map(({ path }) => path).sort().join("\n")) {
    throw new Error("Repository cache paths do not match pins");
  }
  const storage = resolve(root);
  return repositories.map(({ path }) => {
    const value = objects[path];
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\n:]/.test(value) || value === sep
      || value === storage || value.startsWith(`${storage}/`) || storage.startsWith(`${value}/`)) throw new Error("Invalid repository cache path");
    return value;
  });
}

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

interface Mounts {
  root: FileHandle;
  home: FileHandle;
  worktree: FileHandle;
  git: FileHandle;
  config: FileHandle;
}

type Request =
  | { kind: "initialize" }
  | { kind: "repository-ready" }
  | { kind: "repository-materialize"; archives: string[] }
  | { kind: "repository-checkout" }
  | { kind: "read" | "read-content" | "list"; path: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "status" | "snapshot" }
  | { kind: "commit"; message: string }
  | { kind: "bash"; command: string }
  | { kind: "head" }
  | { kind: "push-prepare"; id: string; path: string; base: string; commit: string }
  | { kind: "push-pack"; id: string; tip: string; exclude: string[] }
  | { kind: "push-cleanup"; id: string }
  | { kind: "clone-head"; path: string }
  | { kind: "clone-push-prepare"; path: string; commit: string; old: string | null; tips: string[] }
  | { kind: "clone-push-pack"; path: string; commit: string; exclude: string[] };

/** Push transfers: a pack streamed after the request line, or stdout handed over uncapped. */
interface Transfer { input?: AsyncIterable<Uint8Array>; output?: (stdout: Readable, kill: () => void) => void }

/* All untrusted filesystem access happens here, after entering the namespace.
 * realpath is only a policy check: actual opens walk pinned directory descriptors
 * with O_NOFOLLOW, so swapping a checked parent for a symlink cannot win a race.
 */
const HELPER = String.raw`
import base64, binascii, ctypes, fcntl, json, os, re, resource, secrets, shutil, socket, stat, subprocess, sys, threading, zlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor

for fd_name in os.listdir('/proc/self/fd'):
    fd = int(fd_name)
    if fd > 2:
        try:
            os.close(fd)
        except OSError:
            pass
os.umask(0o077)
PUSH_KINDS = ('push-prepare', 'push-pack', 'clone-push-prepare', 'clone-push-pack')
# Checkouts from the host repository cache write whole repositories, like pushes read them.
LONG_KINDS = PUSH_KINDS + ('repository-checkout',)


def limits(kind):
    # These remain defense in depth for fixed helpers/test fixtures, NOT session quotas.
    # Push rewrites and packs and cache checkouts handle whole repositories, so only they get larger bounds.
    push = kind in LONG_KINDS
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (3600, 3600) if push else (25, 25))
    size = (16 if push else 1 / 16) * 1024 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_FSIZE, (int(size), int(size)))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    # Shell commands inherit these limits, so they get no address-space cap: Go and Node reserve far
    # more address space than they use, and gh and node abort at start-up under 512 MiB. Their memory
    # bound is the session cgroup's memory.max, which the resource supervisor applies and reads back
    # before bash starts; Sandbox.execute refuses bash without it unless the host's owner waived limits.
    if kind != 'bash':
        memory = (4096 if push else 512) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))


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

REPOSITORY_LIMITS = ${JSON.stringify(repositoryLimits)}
CACHE_MARKER = 'repository-cache.json'
CACHE_LOCK = 'repository-cache.lock'
RESERVED = {'.git'}


def archive_parts(value, directory=False):
    if directory and value.endswith('/'):
        value = value[:-1]
    if not value or len(value.encode('utf-8')) > 1024 or value.startswith('/') or '\\' in value:
        raise ValueError('invalid repository archive path')
    parts = value.split('/')
    if len(parts) > 64 or any(p in ('', '.', '..') or len(p.encode('utf-8')) > 255 for p in parts):
        raise ValueError('repository archive traversal or depth limit')
    if any(ord(c) < 32 or ord(c) == 127 for c in value) or any(':' in p for p in parts):
        raise ValueError('invalid repository archive path')
    if any(p.lower() in RESERVED for p in parts):
        raise ValueError('repository archive contains reserved Git or identity files')
    return parts


def expand_archive(encoded, budget):
    try:
        packed = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('invalid repository archive encoding')
    if not packed or len(packed) > REPOSITORY_LIMITS['archiveBytes']:
        raise ValueError('repository archive exceeds compressed size limit')
    # No tar parser sees a byte until the complete gzip stream (metadata included)
    # has passed the aggregate expansion bound. Concatenated streams are refused.
    inflater = zlib.decompressobj(31)
    expanded = inflater.decompress(packed, budget + 1)
    if len(expanded) > budget or inflater.unconsumed_tail:
        raise ValueError('repository archives exceed expanded size limit')
    if not inflater.eof or inflater.unused_data:
        raise ValueError('incomplete or concatenated repository gzip archive')
    return expanded


def tar_number(raw):
    value = raw.rstrip(b'\x00 ').lstrip(b' ')
    if not value:
        return 0
    if not re.fullmatch(b'[0-7]+', value):
        raise ValueError('unsupported repository tar numeric field')
    return int(value, 8)


def tar_text(raw):
    value, separator, padding = raw.partition(b'\x00')
    if separator and any(padding):
        raise ValueError('invalid repository tar name padding')
    return value.decode('utf-8')


def pax_fields(data, global_header):
    result, offset = {}, 0
    while offset < len(data):
        space = data.find(b' ', offset, min(len(data), offset + 12))
        if space < 0 or not re.fullmatch(b'[1-9][0-9]*', data[offset:space]):
            raise ValueError('invalid repository PAX length')
        length = int(data[offset:space])
        end = offset + length
        if end > len(data) or end <= space + 2 or data[end - 1:end] != b'\n':
            raise ValueError('incomplete repository PAX record')
        key, separator, value = data[space + 1:end - 1].partition(b'=')
        key, value = key.decode('utf-8'), value.decode('utf-8')
        if not separator or key in result:
            raise ValueError('duplicate or invalid repository PAX key')
        # GitHub emits a global commit comment and may use POSIX path metadata.
        # Size overrides, sparse maps, linkpaths and vendor extensions are unsafe.
        if key not in ('comment', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'path'):
            raise ValueError('unsupported repository PAX metadata')
        if key == 'path':
            if global_header:
                raise ValueError('global repository PAX path is not supported')
            archive_parts(value, True)
        result[key] = value
        offset = end
    return result


def link_target(path, link):
    # Symlinks resolve lexically inside their repository; '..' may never climb above its root.
    if not link or link.startswith('/') or '\\' in link or any(ord(c) < 32 or ord(c) == 127 for c in link):
        raise ValueError('repository symlink target must be a relative path')
    parts = list(path[:-1])
    for part in link.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            if not parts:
                raise ValueError('repository symlink escapes its repository')
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        raise ValueError('repository symlink escapes its repository')
    return tuple(parts)


def parse_archive(data, budget, destination):
    if len(data) % 512:
        raise ValueError('incomplete repository tar archive')
    offset, entries, prefix, pending, ended = 0, 0, None, None, False
    explicit, nodes, files, links = set(), {}, [], {}
    while offset < len(data):
        header = data[offset:offset + 512]
        offset += 512
        if not any(header):
            if pending is not None or offset + 512 > len(data) or any(data[offset:]):
                raise ValueError('incomplete repository tar terminator')
            ended = True
            break
        entries += 1
        if entries > budget:
            raise ValueError('repository archives have too many entries')
        if tar_number(header[148:156]) != sum(header[:148]) + 8 * 32 + sum(header[156:]):
            raise ValueError('invalid repository tar checksum')
        if header[257:263] not in (b'ustar\x00', b'ustar '):
            raise ValueError('unsupported repository tar format')
        name = tar_text(header[:100])
        if header[257:263] == b'ustar\x00':
            parent = tar_text(header[345:500])
            if parent:
                name = parent + '/' + name
        kind, size = header[156:157], tar_number(header[124:136])
        if offset + ((size + 511) // 512) * 512 > len(data):
            raise ValueError('incomplete repository tar entry')
        body = data[offset:offset + size]
        offset += ((size + 511) // 512) * 512
        archive_parts(name, kind == b'5')
        if kind in (b'x', b'g'):
            if pending is not None:
                raise ValueError('conflicting repository PAX headers')
            metadata = pax_fields(body, kind == b'g')
            if kind == b'x':
                pending = metadata
            continue
        if kind == b'2':
            # Symlinks become copies of an in-repository regular file; no link is ever created.
            if size:
                raise ValueError('repository symlink entries cannot carry data')
            link = tar_text(header[157:257])
        elif kind not in (b'0', b'\x00', b'5') or any(header[157:257]):
            raise ValueError('repository archive links and special files are forbidden')
        if pending is not None:
            name = pending.get('path', name)
            pending = None
        parts = archive_parts(name, kind == b'5')
        if prefix is None:
            prefix = parts[0]
        if parts[0] != prefix:
            raise ValueError('repository archive must have one top-level directory')
        path = tuple(parts[1:])
        if len(path) + 2 > 64 or len('/'.join([destination] + list(path)).encode('utf-8')) > 1024:
            raise ValueError('repository destination exceeds path or depth limit')
        if not path and kind != b'5':
            raise ValueError('repository archive root must be a directory')
        if path in explicit:
            raise ValueError('duplicate repository archive entry')
        explicit.add(path)
        for depth in range(1, len(path)):
            parent = path[:depth]
            if nodes.get(parent) == 'file':
                raise ValueError('conflicting repository archive paths')
            nodes[parent] = 'directory'
        if kind == b'5':
            if size or nodes.get(path) == 'file':
                raise ValueError('conflicting repository directory entry')
            nodes[path] = 'directory'
        elif kind == b'2':
            if path in nodes:
                raise ValueError('conflicting repository archive paths')
            nodes[path] = 'file'
            links[path] = link
        else:
            if size > REPOSITORY_LIMITS['fileBytes']:
                raise ValueError('repository file exceeds size limit')
            if path in nodes:
                raise ValueError('conflicting repository archive paths')
            nodes[path] = 'file'
            mode = 0o700 if tar_number(header[100:108]) & 0o111 else 0o600
            files.append((path, body, mode))
        if len(nodes) > REPOSITORY_LIMITS['entries']:
            raise ValueError('repository archive has too many filesystem entries')
    if not ended or prefix is None:
        raise ValueError('incomplete or empty repository tar archive')
    regular_files = {path: (body, mode) for path, body, mode in files}
    copied = 0
    for path, link in links.items():
        target = link_target(path, link)
        for _ in range(8):
            if target not in links:
                break
            target = link_target(target, links[target])
        if target not in regular_files:
            raise ValueError('repository symlink must point to a regular file in its repository')
        body, mode = regular_files[target]
        copied += len(body)
        files.append((path, body, mode))
    return files, nodes, max(entries, len(nodes)), copied


def git_capture(arguments, success=True):
    result = subprocess.run(GIT + arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=WORK, close_fds=True)
    if success and result.returncode:
        raise ValueError('repository Git baseline validation failed')
    return result


def read_alternates(git):
    try:
        info = walk(git, ['objects', 'info'])
    except FileNotFoundError:
        return ''
    try:
        return read_at(info, 'alternates', 65536)[0].decode('utf-8')
    except FileNotFoundError:
        return ''
    finally:
        os.close(info)


def cache_ready(work, git, repositories, alternates=()):
    # False for pristine storage; otherwise how the ready baseline was made: 'archive' (version 1 marker, or no
    # repositories) or 'cache' (version 2: checked out from the host repository cache through read-only mounts).
    try:
        raw, _ = read_at(git, CACHE_MARKER, 65536)
    except FileNotFoundError:
        if not repositories:
            return True
        if os.listdir(work) != ['.git'] or git_capture(['rev-parse', '--verify', 'HEAD'], False).returncode == 0:
            raise ValueError('repository cache is unmarked and nonempty; refusing to overwrite')
        if git_capture(['ls-files', '--stage']).stdout:
            raise ValueError('repository cache has an existing Git index')
        return False
    marker = json.loads(raw)
    if not isinstance(marker, dict) or type(marker.get('version')) is not int:
        raise ValueError('repository cache binding does not match immutable pins')
    if marker['version'] == 1:
        source = 'archive'
    elif marker['version'] == 2 and marker.get('source') == 'cache':
        source = 'cache'
    else:
        raise ValueError('repository cache binding does not match immutable pins')
    if json.dumps(marker.get('repositories'), sort_keys=True) != json.dumps(repositories, sort_keys=True):
        raise ValueError('repository cache binding does not match immutable pins')
    if source == 'cache' and not alternates:
        raise ValueError('this session needs the host repository cache; its connector must run with --repo-cache')
    expected = ''.join(path + '\n' for path in alternates) if source == 'cache' else ''
    if read_alternates(git) != expected:
        raise ValueError('repository cache mounts do not match this session')
    if marker.get('status') != 'ready':
        raise ValueError('repository cache preparation is incomplete; refusing to overwrite')
    baseline = marker.get('baseline')
    if not isinstance(baseline, str) or not re.fullmatch('[0-9a-f]{40}', baseline):
        raise ValueError('invalid repository cache baseline')
    if git_capture(['cat-file', '-t', baseline]).stdout.strip() != b'commit':
        raise ValueError('repository cache baseline is missing')
    git_capture(['merge-base', '--is-ancestor', baseline, 'HEAD'])
    return source


def cache_marker(git, repositories, status, baseline=None, source='archive'):
    value = {'version': 1, 'repositories': repositories, 'status': status}
    if source == 'cache':
        # Version 2: older runners refuse these sessions instead of using them without the cache mounts.
        value = {'version': 2, 'source': 'cache', 'repositories': repositories, 'status': status}
    if baseline is not None:
        value['baseline'] = baseline
    write_at(git, [CACHE_MARKER], json.dumps(value, ensure_ascii=True))


def rename_new(source, destination, name):
    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    renameat2.restype = ctypes.c_int
    encoded = os.fsencode(name)
    if renameat2(source, encoded, destination, encoded, 1) != 0:  # RENAME_NOREPLACE
        raise OSError(ctypes.get_errno(), 'repository destination cannot be promoted')


def sync_cache(root, entry_limit, byte_limit, links=False):
    # Only pinned descendants are flushed, never the shared host filesystem.
    # With links=True, symlinks are allowed (cache checkouts create real ones); the fsync
    # of their parent directory makes them durable, and they are never followed.
    # Bound both traversal and outstanding descriptors; concurrent fsync calls
    # let storage coalesce flushes without weakening the ready-marker barrier.
    pending = deque()
    entries, size = 0, 0

    def mount_id(fd):
        # Overlay files and directories can legitimately have different st_dev.
        # Kernel fdinfo identifies the actual mount of the pinned descriptor.
        with open('/proc/self/fdinfo/' + str(fd), 'r', encoding='ascii') as stream:
            match = re.search(r'^mnt_id:\s*([0-9]+)$', stream.read(4096), re.MULTILINE)
        if match is None:
            raise ValueError('repository durability mount identity is unavailable')
        return match.group(1)

    mount = mount_id(root)

    def persist(fd):
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    with ThreadPoolExecutor(max_workers=4) as pool:
        def enqueue(fd):
            try:
                if len(pending) >= 16:
                    pending.popleft().result()
                future = pool.submit(persist, fd)
            except BaseException:
                os.close(fd)
                raise
            pending.append(future)

        def visit(directory, depth, path_bytes):
            nonlocal entries, size
            with os.scandir(directory) as children:
                for child in children:
                    entries += 1
                    length = path_bytes + len(os.fsencode(child.name)) + (1 if depth else 0)
                    if entries > entry_limit or depth >= 64 or length > 1024:
                        raise ValueError('repository durability traversal limit exceeded')
                    before = child.stat(follow_symlinks=False)
                    if links and stat.S_ISLNK(before.st_mode):
                        continue
                    is_directory = stat.S_ISDIR(before.st_mode)
                    if not is_directory:
                        regular(before)
                    fd = os.open(child.name, DIR_FLAGS if is_directory else FILE_FLAGS, dir_fd=directory)
                    try:
                        info = os.fstat(fd)
                        if mount_id(fd) != mount or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino):
                            raise ValueError('repository durability entry changed or crosses a mount')
                        if is_directory:
                            visit(fd, depth + 1, length)
                        else:
                            regular(info)
                            size += info.st_size
                            if size > byte_limit:
                                raise ValueError('repository durability byte limit exceeded')
                            enqueue(os.dup(fd))
                    finally:
                        os.close(fd)
            enqueue(os.dup(directory))

        visit(root, 0, 0)
        while pending:
            pending.popleft().result()


def materialize_repositories(work, git, repositories, archives, alternates=()):
    if cache_ready(work, git, repositories, alternates):
        return
    if len(archives) != len(repositories):
        raise ValueError('repository archives do not match pins')
    prepared, expanded, entries = [], 0, 0
    for repository, encoded in zip(repositories, archives):
        data = expand_archive(encoded, REPOSITORY_LIMITS['expandedBytes'] - expanded)
        expanded += len(data)
        files, nodes, count, copied = parse_archive(data, REPOSITORY_LIMITS['entries'] - entries, repository['path'])
        # Symlink copies occupy disk too; they count against the same aggregate bound.
        expanded += copied
        if expanded > REPOSITORY_LIMITS['expandedBytes']:
            raise ValueError('repository archives exceed expanded size limit')
        entries += count
        if entries > REPOSITORY_LIMITS['entries']:
            raise ValueError('repository archives have too many entries')
        prepared.append((repository['path'].split('/'), files, nodes))
    # Validate every archive before the first filesystem change. Thereafter a
    # durable preparing marker makes interruption fail closed, never reset edits.
    cache_marker(git, repositories, 'preparing')
    stage_name = '.repository-stage-' + secrets.token_hex(16)
    os.mkdir(stage_name, 0o700, dir_fd=work)
    stage = os.open(stage_name, DIR_FLAGS, dir_fd=work)
    try:
        for destination, files, nodes in prepared:
            root = walk(stage, destination, True)
            try:
                directories = sorted((path for path in nodes if nodes[path] == 'directory'), key=lambda p: (len(p), p))
                for path in directories:
                    os.close(walk(root, path, True))
                for path, body, mode in files:
                    parent = walk(root, path[:-1], True)
                    try:
                        fd = os.open(path[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                     mode, dir_fd=parent)
                        with os.fdopen(fd, 'wb') as stream:
                            stream.write(body)
                    finally:
                        os.close(parent)
            finally:
                os.close(root)
        sync_cache(stage, REPOSITORY_LIMITS['entries'] + 2 * len(repositories),
                   REPOSITORY_LIMITS['expandedBytes'])
        for owner in os.listdir(stage):
            # Atomic no-replace promotion, including against concurrent insertion.
            rename_new(stage, work, owner)
        os.rmdir(stage_name, dir_fd=work)
        os.fsync(work)
        git_capture(['add', '--force', '--all', '--', '.'])
        git_capture(['commit', '--quiet', '--allow-empty', '--no-verify', '--no-gpg-sign',
                     '-m', 'Initialize pinned repository snapshots'])
        baseline = git_capture(['rev-parse', '--verify', 'HEAD']).stdout.decode('ascii').strip()
        # Loose blobs and trees add at most two objects per imported node.
        # Include bounded overhead for refs, logs, index and Git administrative
        # directories, independently of the worktree's archive quotas.
        sync_cache(git, 2 * REPOSITORY_LIMITS['entries'] + 1024,
                   4 * REPOSITORY_LIMITS['expandedBytes'] + 1024 * REPOSITORY_LIMITS['entries'])
        cache_marker(git, repositories, 'ready', baseline)
    finally:
        os.close(stage)


def cache_mounts(alternates, count):
    if not isinstance(alternates, list) or not count or len(alternates) != count:
        raise ValueError('repository cache mounts do not match pins')
    for path in alternates:
        if (not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path
                or any(character in path for character in '\0\n:')
                or os.path.commonpath((WORK, path)) == WORK or os.path.commonpath((HOME, path)) == HOME):
            raise ValueError('invalid repository cache mount')
    return alternates


def pinned_ref(path):
    # refs/remotes/<path>/pinned names each pinned commit for the agent, when <path> is also a valid ref name.
    if all(re.fullmatch('[A-Za-z0-9_-][A-Za-z0-9._-]*', part) and not part.endswith(('.', '.lock')) and '..' not in part
           for part in path.split('/')):
        return 'refs/remotes/' + path + '/pinned'
    return None


def compose_tree(node):
    # Only the directories above the pinned paths are new; each pinned tree is referenced, never rewritten, so no
    # object of the read-only cache is copied into the session (Git would duplicate any object it "writes" there).
    lines = []
    for name in sorted(node):
        value = node[name]
        lines.append('040000 tree ' + (compose_tree(value) if isinstance(value, dict) else value) + '\t' + name + '\n')
    result = subprocess.run(GIT + ['mktree'], input=''.join(lines).encode('utf-8'), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=WORK, close_fds=True)
    tree = result.stdout.decode('ascii').strip()
    if result.returncode or not re.fullmatch('[0-9a-f]{40}', tree):
        raise ValueError('repository baseline tree could not be written')
    return tree


def materialize_from_cache(work, git, repositories, alternates):
    # Checks pinned trees out of the host repository cache, which the runner validated (repo-cache.ts inspect) and
    # mounted read-only; the session's object store borrows its objects through objects/info/alternates.
    if cache_ready(work, git, repositories, alternates):
        return
    cache_mounts(alternates, len(repositories))
    env = dict(os.environ, GIT_ALTERNATE_OBJECT_DIRECTORIES=':'.join(alternates))
    root = {}
    # Nothing is written until every pinned commit is readable through the mounts.
    for repository in repositories:
        commit = repository['commit']
        if not isinstance(commit, str) or not re.fullmatch('[0-9a-f]{40}', commit):
            raise ValueError('invalid repository pin')
        kind = subprocess.run(GIT + ['cat-file', '-t', commit], env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=WORK, close_fds=True)
        tree = subprocess.run(GIT + ['rev-parse', '--verify', '--quiet', commit + '^{tree}'], env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=WORK, close_fds=True)
        if kind.returncode or kind.stdout.strip() != b'commit' or tree.returncode:
            raise ValueError('pinned commit is missing from the repository cache')
        parts, node = repository['path'].split('/'), root
        for part in parts[:-1]:
            node = node.setdefault(part, {})
            if not isinstance(node, dict):
                raise ValueError('repository paths overlap')
        if parts[-1] in node:
            raise ValueError('repository paths overlap')
        node[parts[-1]] = tree.stdout.decode('ascii').strip()
    # Thereafter a durable preparing marker makes interruption fail closed, never reset edits.
    cache_marker(git, repositories, 'preparing', source='cache')
    write_at(git, ['objects', 'info', 'alternates'], ''.join(path + '\n' for path in alternates))
    baseline_tree = compose_tree(root)
    # One tree, no prefix: read-tree primes the cache tree, so later commits rewrite only what changed.
    git_capture(['read-tree', baseline_tree])
    # The worktree holds only .git (cache_ready): checkout-index writes into empty directories, real symlinks
    # included, and records stat data so the new baseline is clean without hashing every file again.
    git_capture(['checkout-index', '--all', '--index'])
    for name in sorted(os.listdir(work)):
        if name == '.git':
            continue
        owner = os.open(name, DIR_FLAGS, dir_fd=work)
        try:
            sync_cache(owner, REPOSITORY_LIMITS['checkoutEntries'] + 1024, REPOSITORY_LIMITS['checkoutBytes'], links=True)
        finally:
            os.close(owner)
    os.fsync(work)
    baseline = git_capture(['commit-tree', baseline_tree, '-m', 'Initialize pinned repository snapshots']).stdout.decode('ascii').strip()
    git_capture(['update-ref', 'HEAD', baseline])
    for repository in repositories:
        ref = pinned_ref(repository['path'])
        if ref:
            git_capture(['update-ref', ref, repository['commit']])
    # The index grows with the checkout; objects are only the few new trees and the baseline commit.
    sync_cache(git, 4096, 256 * REPOSITORY_LIMITS['checkoutEntries'] + 64 * 1024 * 1024)
    cache_marker(git, repositories, 'ready', baseline, source='cache')


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


# Hardening shared by every Git invocation; session commands add the worktree and owner identity below.
GIT_HARDENED = ['/usr/bin/git', '--no-pager',
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
        # Push scratch repositories are transient and never belong in a backup.
        visit(git, 'git', ('pistead-push',))
        return files
    finally:
        os.close(git)
        os.close(work)
        os.close(home)


OID = re.compile('[0-9a-f]{40}')
ZERO_OID = '0' * 40


def push_directory(request):
    push_id = request['id']
    if not isinstance(push_id, str) or not re.fullmatch('[0-9a-f]{32}', push_id):
        raise ValueError('invalid push id')
    return os.path.join(WORK, '.git', 'pistead-push'), os.path.join(WORK, '.git', 'pistead-push', push_id)


def push_spawn(directory, arguments, stdout=subprocess.PIPE, extra=None):
    # Scratch repositories get a clean config and the same hardening flags; never the session config.
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
               GIT_INDEX_FILE=os.path.join(directory, 'pistead-index'))
    env.update(extra or {})
    argv = GIT_HARDENED + ['--literal-pathspecs', '-c', 'safe.directory=' + directory, '--git-dir=' + directory] + arguments
    return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=stdout, stderr=subprocess.DEVNULL,
                            cwd=directory, env=env, close_fds=True)


def push_git(directory, arguments, data=b'', extra=None, success=True):
    child = push_spawn(directory, arguments, extra=extra)
    output, _ = child.communicate(data)
    if success and child.returncode:
        raise ValueError('push rewrite failed')
    return output if success else (child.returncode, output)


def push_prepare(request, git):
    path, base, commit = request['path'], request['base'], request['commit']
    if (not any(repository['path'] == path for repository in request['expectedRepositories'])
            or not isinstance(base, str) or not OID.fullmatch(base) or not isinstance(commit, str) or not OID.fullmatch(commit)):
        raise ValueError('invalid push request')
    scratch, directory = push_directory(request)
    try:
        os.mkdir(scratch, 0o700)
    except FileExistsError:
        pass
    if not stat.S_ISDIR(os.lstat(scratch).st_mode):
        raise ValueError('push scratch directory is unsafe')
    # Pushes are serialized per session: any existing scratch repository is an orphan of an interrupted push.
    for name in os.listdir(scratch):
        if stat.S_ISDIR(os.lstat(os.path.join(scratch, name)).st_mode):
            shutil.rmtree(os.path.join(scratch, name))
    os.mkdir(directory, 0o700)
    for name in ('objects/info', 'objects/pack', 'refs/heads', 'refs/tags'):
        os.makedirs(os.path.join(directory, name), 0o700)
    for name, content in (('HEAD', 'ref: refs/heads/main\n'),
                          ('config', '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'),
                          ('objects/info/alternates', os.path.join(WORK, '.git', 'objects') + '\n')):
        with open(os.path.join(directory, name), 'x', encoding='utf-8') as stream:
            stream.write(content)
    # The upstream pack follows the request line on stdin.
    child = push_spawn(directory, ['index-pack', '--stdin', '--fix-thin'], stdout=subprocess.DEVNULL)
    try:
        while True:
            chunk = sys.stdin.buffer.read1(65536)
            if not chunk:
                break
            child.stdin.write(chunk)
        child.stdin.close()
    except BrokenPipeError:
        pass
    if child.wait():
        raise ValueError('upstream pack could not be indexed')
    if push_git(directory, ['cat-file', '-t', base], success=False)[1].strip() != b'commit':
        raise ValueError('pinned commit is missing from the upstream pack')
    with open(os.path.join(directory, 'shallow'), 'x', encoding='ascii') as stream:
        stream.write(base + '\n')
    raw, _ = read_at(git, CACHE_MARKER, 65536)
    baseline = json.loads(raw).get('baseline')
    if not isinstance(baseline, str) or not OID.fullmatch(baseline):
        raise ValueError('invalid repository cache baseline')
    if (push_git(directory, ['cat-file', '-t', commit], success=False)[1].strip() != b'commit'
            or push_git(directory, ['merge-base', '--is-ancestor', baseline, commit], success=False)[0]):
        raise ValueError('push commit is not a session commit')
    sources = push_git(directory, ['rev-list', '--reverse', '--first-parent', baseline + '..' + commit]).decode('ascii').split()
    push_git(directory, ['read-tree', base + '^{tree}'])
    previous = base
    previous_tree = push_git(directory, ['rev-parse', base + '^{tree}']).strip()
    prefix = path.encode('utf-8') + b'/'
    commits = []
    for source in sources:
        if not OID.fullmatch(source):
            raise ValueError('push rewrite failed')
        fields = push_git(directory, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--full-index',
                                      source + '^1', source, '--', path + '/']).split(b'\0')
        records, index = [], 0
        while index + 1 < len(fields) and fields[index]:
            meta, name = fields[index][1:].split(b' '), fields[index + 1]
            index += 2
            if len(meta) != 5 or not name.startswith(prefix) or name == prefix:
                raise ValueError('push rewrite failed')
            entry = b'0 ' + ZERO_OID.encode('ascii') if meta[4] == b'D' else meta[1] + b' ' + meta[3]
            records.append(entry + b'\t' + name[len(prefix):] + b'\0')
        if records:
            push_git(directory, ['update-index', '-z', '--replace', '--index-info'], b''.join(records))
        tree = push_git(directory, ['write-tree', '--missing-ok']).strip()
        if tree == previous_tree:
            continue
        header, separator, message = push_git(directory, ['cat-file', 'commit', source]).partition(b'\n\n')
        identities = {}
        for line in header.split(b'\n'):
            match = re.fullmatch(rb'(author|committer) (.*) <([^<>]*)> ([0-9]+) ([+-][0-9]{4})', line)
            if match and match.group(1) not in identities:
                identities[match.group(1)] = match
        if set(identities) != {b'author', b'committer'}:
            raise ValueError('push rewrite failed')
        extra = {}
        for kind, label in ((b'author', 'AUTHOR'), (b'committer', 'COMMITTER')):
            match = identities[kind]
            extra['GIT_' + label + '_NAME'] = os.fsdecode(match.group(2))
            extra['GIT_' + label + '_EMAIL'] = os.fsdecode(match.group(3))
            extra['GIT_' + label + '_DATE'] = '@' + match.group(4).decode('ascii') + ' ' + match.group(5).decode('ascii')
        rewritten = push_git(directory, ['commit-tree', tree.decode('ascii'), '-p', previous], message, extra).decode('ascii').strip()
        if not OID.fullmatch(rewritten):
            raise ValueError('push rewrite failed')
        commits.append({'source': source, 'rewritten': rewritten,
                        'subject': message.split(b'\n', 1)[0].decode('utf-8', 'replace')[:200]})
        previous, previous_tree = rewritten, tree
    if not commits:
        raise ValueError('session commits do not change the repository')
    return {'tip': previous, 'base': base, 'commits': commits}


def push_pack(request):
    _, directory = push_directory(request)
    tip, exclude = request['tip'], request['exclude']
    if (not isinstance(tip, str) or not OID.fullmatch(tip) or not isinstance(exclude, list) or len(exclude) > 16
            or not all(isinstance(oid, str) and OID.fullmatch(oid) for oid in exclude)):
        raise ValueError('invalid push request')
    if not stat.S_ISDIR(os.lstat(directory).st_mode):
        raise ValueError('push scratch directory is unsafe')
    sys.stdout.flush()
    # The pack streams straight to the runner on the helper's stdout.
    child = push_spawn(directory, ['-c', 'core.bigFileThreshold=64m', 'pack-objects', '--stdout', '--revs',
                                   '--delta-base-offset', '-q'], stdout=None)
    child.communicate((tip + '\n' + ''.join('^' + oid + '\n' for oid in exclude)).encode('ascii'))
    if child.returncode:
        raise ValueError('push pack failed')


def clone_directory(request):
    # A clone the agent made in the worktree: Git runs in it read-only, with its own config but the hardened flags.
    parts = parts_for(request['path'])
    directory = os.path.join(WORK, *parts)
    if not parts or not os.path.isdir(directory) or not os.path.lexists(os.path.join(directory, '.git')):
        raise ValueError('the clone directory is not a Git clone in the worktree')
    return directory


def clone_spawn(directory, arguments, stdout=subprocess.PIPE):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
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


def push_cleanup(request):
    scratch, directory = push_directory(request)
    try:
        if not stat.S_ISDIR(os.lstat(scratch).st_mode):
            raise ValueError('push scratch directory is unsafe')
    except FileNotFoundError:
        return
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        pass


def main():
    # One JSON line; push-prepare streams the upstream pack after it.
    request = json.loads(sys.stdin.buffer.readline())
    kind = request['kind']
    limits(kind)
    repositories = request['expectedRepositories']
    alternates = request.get('repositoryAlternates', [])
    if not isinstance(alternates, list) or not all(isinstance(path, str) for path in alternates):
        raise ValueError('invalid repository cache mounts')
    if kind == 'initialize':
        try:
            os.stat(os.path.join(WORK, '.git', 'HEAD'), follow_symlinks=False)
        except FileNotFoundError:
            if repositories:
                try:
                    os.stat(os.path.join(WORK, '.git', CACHE_MARKER), follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise ValueError('repository cache Git HEAD is missing; refusing to reinitialize')
            run(GIT + ['init', '--quiet', '--template=', '--initial-branch=main', WORK])
        run(GIT + ['rev-parse', '--is-inside-work-tree'])
        return
    work = os.open(WORK, DIR_FLAGS)
    git = os.open('.git', DIR_FLAGS, dir_fd=work)
    lock = None
    try:
        if kind == 'repository-materialize':
            lock = os.open(CACHE_LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                           0o600, dir_fd=git)
            regular(os.fstat(lock))
            fcntl.flock(lock, fcntl.LOCK_EX)
            materialize_repositories(work, git, repositories, request['archives'], alternates)
            return
        if kind == 'repository-checkout':
            lock = os.open(CACHE_LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                           0o600, dir_fd=git)
            regular(os.fstat(lock))
            fcntl.flock(lock, fcntl.LOCK_EX)
            materialize_from_cache(work, git, repositories, alternates)
            return
        if kind == 'repository-ready' or repositories:
            ready = cache_ready(work, git, repositories, alternates)
            if kind == 'repository-ready':
                print(json.dumps(ready))
                return
            if not ready:
                raise ValueError('repository cache is not prepared')
            if kind == 'snapshot' and ready == 'cache':
                # Its objects live in the host cache, not in the session: a backup would not restore.
                raise ValueError('backups of sessions checked out from the host repository cache are not supported yet')
        if kind == 'push-prepare':
            print(json.dumps(push_prepare(request, git), ensure_ascii=True))
            return
        if kind == 'push-pack':
            push_pack(request)
            return
        if kind == 'push-cleanup':
            push_cleanup(request)
            return
    finally:
        if lock is not None:
            os.close(lock)
        os.close(git)
        os.close(work)
    if kind == 'head':
        run(GIT + ['rev-parse', '--verify', 'HEAD'])
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
    if kind == 'bash':
        egress = request.get('egress')
        if egress is not None:
            egress_relay(egress['socket'], int(egress['port']))
        run(['/usr/bin/bash', '--noprofile', '--norc', '-c', request['command']])
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
except (OSError, ValueError, KeyError, TypeError, UnicodeError, zlib.error) as error:
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

export function repositoryPins(repositories: readonly SessionRepository[]): SessionRepository[] {
  if (!Array.isArray(repositories) || repositories.length > repositoryLimits.repositories) throw new Error("Invalid repository pin set");
  const names = new Set<string>();
  const ids = new Set<string>();
  const bindings = new Set<string>();
  return repositories.map((repository) => {
    const id = repositoryPinIdentity(repository);
    if (!id) throw new Error("Invalid repository pin");
    if (names.has(repository.path.toLowerCase()) || ids.has(id) || bindings.has(repository.bindingId)) throw new Error("Invalid or duplicate repository pin");
    names.add(repository.path.toLowerCase());
    ids.add(id);
    bindings.add(repository.bindingId);
    if ("provider" in repository) {
      const { bindingId, provider, host, repositoryId, fullName, ref, commit, path } = repository;
      return { bindingId, provider, host, repositoryId, fullName, ref, commit, path };
    }
    const { bindingId, repositoryId, fullName, ref, commit, path } = repository;
    return { bindingId, repositoryId, fullName, ref, commit, path };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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
    const created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try {
      await created.writeFile(configText, "utf8");
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const config = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await config.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o377) !== 0 || info.size !== Buffer.byteLength(configText)) {
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
export class Sandbox {
  readonly #root: string;
  readonly #identity: Readonly<SandboxIdentity>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #resources: Readonly<ResourceConfig> | undefined;
  readonly #sessionKey: string;
  readonly #testProvider: boolean;
  readonly #repositories: readonly SessionRepository[];
  readonly #cacheObjects: readonly string[];
  readonly #egressSocket: string | undefined;
  readonly #mirrors: (() => readonly MirrorMount[]) | undefined;
  /** Whether processes see the cache at all: only cache-backed sessions, after their owner's access was re-checked. */
  #cacheMounted = false;
  #initialization: Promise<void> | undefined;
  #mounts: Mounts | undefined;
  #closed = false;
  #cancelActive: (() => void) | undefined;
  readonly #pushStreams = new Map<string, () => void>();

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
    this.#repositories = repositoryPins(binding.session.repositories ?? []);
    this.#cacheObjects = Object.freeze(repositoryObjectPaths(this.#repositories, options.repositoryObjects, root));
    if (options.egressSocket !== undefined && !isAbsolute(options.egressSocket)) throw new Error("Invalid egress socket path");
    this.#egressSocket = options.egressSocket;
    this.#mirrors = options.mirrors;
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
        if (this.#mirrors) {
          await mkdir(join(this.#root, "bin"), { recursive: true, mode: 0o700 });
          await writeFile(join(this.#root, "bin", "git"), GIT_SHIM, { mode: 0o500 });
          await chmod(join(this.#root, "bin", "git"), 0o500);
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

  async #operation(request: Request, readOnly: boolean, authorize: SandboxAuthorize, gitWritable = false, requireResources = false): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      // Admission-time permission may have been revoked while this operation waited.
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      return this.#run(request, readOnly, gitWritable, requireResources);
    });
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

  gitStatus(authorize: SandboxAuthorize): Promise<string> {
    return this.#operation({ kind: "status" }, true, authorize);
  }

  async execute(operation: Operation, readOnly: boolean, authorize: SandboxAuthorize, options: SandboxExecutionOptions = {}): Promise<string> {
    switch (operation.kind) {
      case "git.commit":
        if (readOnly) throw new Error("Read-only sandbox cannot commit");
        return this.#operation({ kind: "commit", message: text(operation.message, "commit message", 16 * 1024, true) }, false, authorize, true);
      case "bash": {
        if (options.allowTestShell === true && !this.#testProvider) throw new Error("Test shell bypass is restricted to the explicit faux provider");
        const bounded = options.allowTestShell !== true && (!!this.#resources || options.unbounded !== true);
        if (bounded && !this.#resources) {
          throw new Error("Production bash unavailable: explicitly provisioned cgroup and bounded filesystem resources are required");
        }
        return this.#operation({ kind: "bash", command: text(operation.command, "shell command", 64 * 1024, true) }, readOnly, authorize, false, bounded);
      }
      case "github.comment":
      case "github.merge":
        throw new Error("GitHub operations require the control-plane credential broker, not the sandbox");
      default:
        throw new Error("Unsupported sandbox operation");
    }
  }

  async snapshot(authorize: SandboxAuthorize): Promise<SnapshotFile[]> {
    return JSON.parse(await this.#operation({ kind: "snapshot" }, true, authorize)) as SnapshotFile[];
  }

  #assertRepositories(repositories: readonly SessionRepository[]): void {
    if (JSON.stringify(repositoryPins(repositories)) !== JSON.stringify(this.#repositories)) {
      throw new Error("Repository pins do not match the immutable sandbox binding");
    }
  }

  /** False only for pristine storage; mismatched or interrupted caches fail closed. */
  async repositoryCachesReady(repositories: readonly SessionRepository[], authorize: SandboxAuthorize): Promise<boolean> {
    return (await this.repositoryCacheState(repositories, authorize)) !== "absent";
  }

  /** How the session's repositories were prepared; a cache-backed session also needs its cache mounts to match. */
  async repositoryCacheState(repositories: readonly SessionRepository[], authorize: SandboxAuthorize): Promise<RepositoryCacheState> {
    this.#assertRepositories(repositories);
    return repositoryCacheState(JSON.parse(await this.#operation({ kind: "repository-ready" }, true, authorize)));
  }

  /**
   * Checks the pinned trees out of the host repository cache, mounted read-only. The runner must already have made
   * each pinned commit available (`RepositoryCache.ensure`) and checked its tree (`RepositoryCache.inspect`). Ready
   * caches never overwrite edits.
   */
  async materializeFromCache(repositories: readonly SessionRepository[], authorize: SandboxAuthorize): Promise<void> {
    this.#assertRepositories(repositories);
    if (!this.#repositories.length || this.#cacheObjects.length !== this.#repositories.length) throw new Error("The repository cache is not configured for this session");
    if (!this.#cacheMounted) throw new Error("The repository cache is not mounted for this session");
    await this.#operation({ kind: "repository-checkout" }, false, authorize, true);
  }

  /**
   * Mounts the cache's object directories, read-only, into every later process of this sandbox. Only for a session
   * checked out (or about to be) from the cache, once the control plane has re-checked its owner's access to every
   * pinned repository: archive-backed sessions on a cache host never see the cache, which other owners' fetches fill.
   */
  enableRepositoryCache(): void {
    if (!this.#repositories.length || this.#cacheObjects.length !== this.#repositories.length) throw new Error("The repository cache is not configured for this session");
    this.#cacheMounted = true;
  }

  /** Archives correspond to the supplied pin order; ready caches never overwrite edits. */
  async materializeRepositories(
    repositories: readonly SessionRepository[],
    archives: readonly Uint8Array[],
    authorize: SandboxAuthorize,
  ): Promise<void> {
    this.#assertRepositories(repositories);
    if (!Array.isArray(archives) || archives.length !== repositories.length
      || archives.some((archive) => !(archive instanceof Uint8Array) || !archive.byteLength || archive.byteLength > repositoryLimits.archiveBytes)) {
      throw new Error("Repository archives exceed size limits or do not match pins");
    }
    const encoded = new Map(repositories.map((repository, index) => [repository.path, Buffer.from(archives[index]!).toString("base64")]));
    await this.#operation({
      kind: "repository-materialize",
      archives: this.#repositories.map((repository) => encoded.get(repository.path)!),
    }, false, authorize, true);
  }

  /** Explicit host-owner-approved execution, serialized with sandbox file/Git operations; never a fallback. */
  async executeHost(operation: HostCommandOperation, authorize: SandboxAuthorize, signal: AbortSignal): Promise<string> {
    if (typeof authorize !== "function") throw new Error("Host command authorization is required");
    await this.initialize();
    return this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      if (!JSON.parse(await this.#run({ kind: "repository-ready" }, true, false))) throw new Error("Repository cache is not prepared");
      await authorize();
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

  async head(authorize: SandboxAuthorize): Promise<string> {
    const head = (await this.#operation({ kind: "head" }, true, authorize)).trim();
    if (!OID.test(head)) throw new Error("Session HEAD is not a commit");
    return head;
  }

  /** Rewrites session commits under `path` onto the upstream `base` in a scratch repository under the session Git dir. */
  async pushPrepare(id: string, input: { path: string; base: string; commit: string }, pack: AsyncIterable<Uint8Array>, authorize: SandboxAuthorize): Promise<PushPreparation> {
    if (!PUSH_ID.test(id) || !this.#repositories.some((repository) => repository.path === input.path) || !OID.test(input.base) || !OID.test(input.commit)) {
      throw new Error("Invalid push request");
    }
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    const output = await this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      return this.#run({ kind: "push-prepare", id, path: input.path, base: input.base, commit: input.commit }, false, true, false, { input: pack });
    });
    const value = JSON.parse(output) as PushPreparation;
    if (!value || value.base !== input.base || !OID.test(value.tip) || !Array.isArray(value.commits) || !value.commits.length
      || value.commits.some((commit) => !OID.test(commit.source) || !OID.test(commit.rewritten) || typeof commit.subject !== "string")
      || value.commits.at(-1)!.rewritten !== value.tip) throw new Error("Invalid push preparation");
    return { tip: value.tip, base: value.base, commits: value.commits.map(({ source, rewritten, subject }) => ({ source, rewritten, subject })) };
  }

  /** Streams the pack of `tip` minus `exclude`; the session queue is held until the stream ends. */
  async pushPack(id: string, input: { tip: string; exclude: string[] }, authorize: SandboxAuthorize): Promise<AsyncIterable<Uint8Array>> {
    if (!PUSH_ID.test(id) || !OID.test(input.tip) || !Array.isArray(input.exclude) || input.exclude.length > 16 || !input.exclude.every((oid) => OID.test(oid))) {
      throw new Error("Invalid push request");
    }
    if (typeof authorize !== "function") throw new Error("Sandbox authorization callback is required");
    await this.initialize();
    const started = Promise.withResolvers<{ stdout: Readable; kill: () => void }>();
    const finished = this.#exclusive(async () => {
      if (this.#closed) throw new Error("Sandbox is closed");
      await authorize();
      if (this.#closed) throw new Error("Sandbox is closed");
      try {
        await this.#run({ kind: "push-pack", id, tip: input.tip, exclude: [...input.exclude] }, true, false, false, {
          output: (stdout, kill) => { this.#pushStreams.set(id, kill); started.resolve({ stdout, kill }); },
        });
      } finally { this.#pushStreams.delete(id); }
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

  /** The checked-out commit of a clone the agent made in the worktree, and its origin remote (clone sessions). */
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
      await this.#run({ kind: "clone-push-pack", path, commit: input.commit, exclude: [...input.exclude] }, true, false, false, {
        output: (stdout, kill) => started.resolve({ stdout, kill }),
      });
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

  async pushCleanup(id: string): Promise<void> {
    if (!PUSH_ID.test(id)) throw new Error("Invalid push id");
    this.#pushStreams.get(id)?.();
    if (!this.#mounts) await this.initialize();
    await this.#exclusive(async () => {
      await this.#run({ kind: "push-cleanup", id }, false, true);
    });
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

  #run(request: Request, readOnly: boolean, gitWritable: boolean, requireResources = false, transfer: Transfer = {}): Promise<string> {
    const mounts = this.#mounts;
    if (!mounts) return Promise.reject(new Error("Sandbox is not initialized"));
    if (readOnly && gitWritable) return Promise.reject(new Error("Invalid read-only mount request"));
    if (requireResources && !this.#resources) return Promise.reject(new Error("Production bash resources are unavailable"));
    const mount = readOnly ? "--ro-bind-fd" : "--bind-fd";
    const egress = request.kind === "bash" ? this.#egressSocket : undefined;
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
      // By path, not descriptor: the resource supervisor passes only fds 3-6 to bwrap. Only the runner writes below
      // the private cache root, so nothing a session controls can redirect these. A missing directory is skipped;
      // Git then reports the missing objects instead of reading anything else.
      ...(this.#cacheMounted ? this.#cacheObjects.flatMap((source, index) => ["--ro-bind-try", source, `${CACHE_MOUNT}/${index}`]) : []),
      // Only shell commands reach the network, and only through the session's proxy. A missing socket (the session is
      // not open) is skipped; requests then fail to connect.
      ...(egress ? ["--ro-bind-try", egress, EGRESS_SOCKET] : []),
      ...(egress && this.#mirrors ? ["--ro-bind-try", join(this.#root, "bin"), SHIM_DIRECTORY,
        ...this.#mirrors().filter(mirrorMount).flatMap(({ source, target }) => ["--ro-bind-try", source, target])] : []),
      "--remount-ro", "/proc", "--remount-ro", "/dev", "--remount-ro", "/",
      "--chdir", this.worktree, "--clearenv",
    ];
    for (const [name, value] of Object.entries(this.#environment)) args.push("--setenv", name, value);
    if (egress) for (const [name, value] of Object.entries(egressEnvironment())) args.push("--setenv", name, value);
    if (egress && this.#mirrors) args.push("--setenv", "PATH", `${SHIM_DIRECTORY}:${this.#environment.PATH}`);
    args.push("--", "/usr/bin/python3", "-I", "-c", HELPER);
    const limit = request.kind === "snapshot" ? MAX_SNAPSHOT_OUTPUT_BYTES : request.kind === "read-content" ? MAX_CONTENT_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    const launch = requireResources
      ? resourceLaunch(this.#resources!, this.#sessionKey, args)
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
      const deadline = ["push-prepare", "push-pack", "repository-checkout", "clone-push-prepare", "clone-push-pack"].includes(request.kind) ? PUSH_TIMEOUT_MS : TIMEOUT_MS;
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
          resolveResult(request.kind === "bash" || request.kind === "commit" || request.kind === "status" ? out + err : out);
        }
      });
      const line = JSON.stringify({ ...request, expectedRepositories: this.#repositories,
        repositoryAlternates: this.#cacheObjects.map((_, index) => `${CACHE_MOUNT}/${index}`),
        ...(egress ? { egress: { socket: EGRESS_SOCKET, port: EGRESS_PORT } } : {}) });
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
