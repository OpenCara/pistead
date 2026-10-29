/**
 * The sandbox helper for native Windows, in JavaScript for the host's own node.exe: Windows has no Python to rely on,
 * and Python there lacks the descriptor-relative calls the Linux helper is built on. It runs inside the session's
 * process container, which the OS confines to the session's grants, so its path checks are a second line, not the
 * boundary: a link inside the worktree that points elsewhere leads only where the container may go anyway.
 *
 * It takes one JSON request line on stdin, like the Linux helper, and answers the same way: JSON on stdout, or
 * `sandbox: <reason>` on stderr with exit status 1. It reads its places from the environment: SANDBOX_WORKTREE, HOME,
 * SANDBOX_GITDIR, SANDBOX_OWNER_CONFIG, SANDBOX_GIT, SANDBOX_BASH, and SANDBOX_EGRESS_PROXY when the step has network.
 *
 * Not yet here: clone backups and restores (backups and moves of clone sessions), which the workspace refuses.
 */
export const NODE_HELPER = String.raw`
import { spawn, spawnSync } from "node:child_process";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";

const WORK = process.env.SANDBOX_WORKTREE;
const HOME = process.env.HOME;
const GITDIR = process.env.SANDBOX_GITDIR;
const OWNER_CONFIG = process.env.SANDBOX_OWNER_CONFIG;
const GIT_BINARY = process.env.SANDBOX_GIT || "git";
const BASH = process.env.SANDBOX_BASH || "bash";
// busybox-w32 (as in Git for Windows' MinGit-busybox) starts in Windows' process container, where MSYS2's bash can't. Its
// shell is ash with bash's common extensions, run as its "bash" applet, and takes none of bash's start-up options.
const SHELL_ARGS = /^busybox(64)?(\.exe)?$/i.test(basename(BASH)) ? ["bash", "-c"] : ["--noprofile", "--norc", "-c"];
// MXC's proxy-only egress overwrites the proxy variables with a URL that lacks the session's token, so the proxy would
// refuse every request (407), and empties NO_PROXY, so even loopback servers the step starts are sent to the proxy. The
// backend passes the session's own values beside them; everything the helper starts gets them.
if (process.env.SANDBOX_EGRESS_PROXY) {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) process.env[name] = process.env.SANDBOX_EGRESS_PROXY;
  if (process.env.SANDBOX_EGRESS_NO_PROXY) for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = process.env.SANDBOX_EGRESS_NO_PROXY;
}
delete process.env.SANDBOX_EGRESS_PROXY;
delete process.env.SANDBOX_EGRESS_NO_PROXY;
const MAX_FILE = 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const MAX_SNAPSHOT = 32 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const BROWSE_ENTRIES = 1000;
const BROWSE_TEXT = 256 * 1024;
const BROWSE_IMAGE = 2 * 1024 * 1024;
const OID = /^[0-9a-f]{40}$/;
// Mirrors IMAGE_SIGNATURES in images.ts, which re-checks every image returned.
const IMAGE_SIGNATURES = [
  ["image/png", [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]]],
  ["image/jpeg", [[0, [0xff, 0xd8, 0xff]]]],
  ["image/gif", [[0, [...Buffer.from("GIF87a")]]]],
  ["image/gif", [[0, [...Buffer.from("GIF89a")]]]],
  ["image/webp", [[0, [...Buffer.from("RIFF")]], [8, [...Buffer.from("WEBP")]]]],
];
const GIT_HARDENED = ["--no-pager",
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null", "-c", "core.sshCommand=/usr/bin/false",
  "-c", "credential.helper=", "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false", "-c", "protocol.allow=never",
  "-c", "core.pager=cat", "-c", "core.editor=/usr/bin/false",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false",
  "-c", "core.preloadIndex=false", "-c", "index.threads=1"];
const GIT = [...GIT_HARDENED, "-c", "core.worktree=" + WORK, "-c", "safe.directory=" + WORK,
  "-c", "user.name=" + process.env.GIT_AUTHOR_NAME, "-c", "user.email=" + process.env.GIT_AUTHOR_EMAIL];

class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };

function imageType(data) {
  for (const [type, parts] of IMAGE_SIGNATURES) {
    if (parts.every(([offset, bytes]) => bytes.every((byte, index) => data[offset + index] === byte))) return type;
  }
  return undefined;
}

// Names Windows treats specially: devices whatever their extension, alternate data streams, and trailing dots or spaces
// it silently drops, so that two spellings would name one file.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
function windowsName(part) {
  return process.platform !== "win32" || (!RESERVED.test(part) && !part.includes(":") && !/[ .]$/.test(part) && !/[<>"|?*]/.test(part));
}

function partsFor(value, writing = false) {
  if (typeof value !== "string" || !value || value.length > 1024) refuse("invalid relative path");
  if (value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) refuse("invalid relative path");
  if (value.length >= 2 && value[1] === ":") refuse("absolute paths are not allowed");
  const lexical = value === "." ? [] : value.split("/");
  if (lexical.some(part => part === "" || part === "." || part === "..")) refuse("path traversal is not allowed");
  if (!lexical.every(windowsName)) refuse("invalid Windows file name");
  if (writing && lexical.some(part => part.toLowerCase() === ".git")) refuse("Git metadata is protected");
  const work = worktreeRoot();
  let current;
  try { current = resolveReal(work, lexical); }
  catch (error) { if (!denied(error)) throw error; current = resolveBelow(work, lexical); }
  const inside = relative(work, current);
  if (inside.startsWith("..") || isAbsolute(inside)) refuse("path escapes the worktree");
  const parts = inside ? inside.split(sep) : [];
  if (writing && parts.some(part => part.toLowerCase() === ".git")) refuse("Git metadata is protected");
  return parts;
}

function resolveReal(work, lexical) {
  let current = work;
  for (const [index, part] of lexical.entries()) {
    try { current = realpathSync(join(current, part)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return join(current, ...lexical.slice(index));
    }
  }
  return current;
}

// Node's realpath lstats every folder from the drive root, and its native form asks Windows for the volume's drive letter;
// Windows' process container allows neither (EPERM). There, links are resolved from the worktree down: the worktree
// itself is the runner's, and a link may lead only to somewhere else inside it.
const denied = error => !!error && (error.code === "EPERM" || error.code === "EACCES");

function worktreeRoot() {
  try { return realpathSync(WORK); } catch (error) { if (denied(error)) return WORK; throw error; }
}

function resolveBelow(work, lexical) {
  const parts = [...lexical];
  let current = work;
  let links = 0;
  while (parts.length) {
    const part = parts.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (current === work) refuse("path escapes the worktree");
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let info;
    try { info = lstatSync(next); } catch (error) { if (error.code === "ENOENT") return join(next, ...parts); throw error; }
    if (!info.isSymbolicLink()) { current = next; continue; }
    if (++links > 32) refuse("too many links");
    // Symbolic links and junctions both; a junction's target may carry the \\?\ prefix.
    const target = readlinkSync(next).replace(/^\\\\\?\\/, "");
    if (isAbsolute(target)) {
      const inside = relative(work, target);
      if (inside.startsWith("..") || isAbsolute(inside)) refuse("path escapes the worktree");
      current = work;
      parts.unshift(...inside.split(sep));
    } else parts.unshift(...target.split(/[\\/]/));
  }
  return current;
}

function directoryAt(parts, create = false) {
  let current = worktreeRoot();
  for (const part of parts) {
    current = join(current, part);
    if (create) { try { mkdirSync(current); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) refuse("path component is not a real directory");
  }
  return current;
}

function regular(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) refuse("only regular, non-hardlinked files are supported");
}

function readAt(path, limit) {
  regular(lstatSync(path));
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    regular(before);
    if (before.size > limit) refuse("file exceeds size limit");
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      chunks.push(chunk.subarray(0, read));
      size += read;
      if (size > limit) refuse("file exceeds size limit");
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse("file changed while being read; retry the operation");
    return { data: Buffer.concat(chunks), mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
}

function readPrefix(fd, limit) {
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const chunk = Buffer.alloc(Math.min(65536, limit - size));
    const read = readSync(fd, chunk, 0, chunk.length, null);
    if (!read) break;
    chunks.push(chunk.subarray(0, read));
    size += read;
  }
  return Buffer.concat(chunks);
}

function entryType(info) {
  return info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
}

function browseDirectory(directory) {
  const names = readdirSync(directory);
  if (names.length > MAX_ENTRIES * 10) refuse("directory has too many entries");
  const entries = [];
  for (const name of names) {
    let info;
    try { info = lstatSync(join(directory, name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const type = entryType(info);
    entries.push(type === "file" ? { name, type, size: info.size } : { name, type });
  }
  entries.sort((a, b) => (a.type !== "directory") - (b.type !== "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { type: "directory", entries: entries.slice(0, BROWSE_ENTRIES), total: entries.length, truncated: entries.length > BROWSE_ENTRIES };
}

function browseFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) return { type: "file", size: 0, truncated: false, binary: true };
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = readPrefix(fd, 16);
    const image = imageType(head);
    if (image) {
      if (size > BROWSE_IMAGE) return { type: "file", size, truncated: true, binary: true };
      const data = Buffer.concat([head, readPrefix(fd, BROWSE_IMAGE + 1 - head.length)]);
      if (data.length > BROWSE_IMAGE) return { type: "file", size, truncated: true, binary: true };
      return { type: "file", size, truncated: false, image: { mimeType: image, data: data.toString("base64") } };
    }
    let data = Buffer.concat([head, readPrefix(fd, BROWSE_TEXT + 1 - head.length)]);
    const truncated = data.length > BROWSE_TEXT || size > BROWSE_TEXT;
    data = data.subarray(0, BROWSE_TEXT);
    if (data.includes(0)) return { type: "file", size, truncated, binary: true };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try { return { type: "file", size, truncated, text: decoder.decode(data) }; }
    catch {
      // A preview cut inside a multi-byte character ends before it.
      if (!truncated) return { type: "file", size, truncated, binary: true };
      for (let cut = 1; cut <= 3; cut++) {
        try { return { type: "file", size, truncated, text: new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, data.length - cut)) }; } catch {}
      }
      return { type: "file", size, truncated, binary: true };
    }
  } finally { closeSync(fd); }
}

function writeAt(parts, content) {
  if (!parts.length) refuse("a file path is required");
  const data = Buffer.from(content, "utf8");
  if (data.length > MAX_FILE) refuse("file exceeds size limit");
  const parent = directoryAt(parts.slice(0, -1), true);
  const target = join(parent, parts.at(-1));
  try { regular(lstatSync(target)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(parent, ".sandbox-write-" + randomBytes(16).toString("hex"));
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    created = false;
  } finally { if (created) { try { unlinkSync(temporary); } catch {} } }
}

function run(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: WORK, stdio: ["ignore", "inherit", "inherit"], windowsHide: true, ...options });
  if (result.error) refuse("could not start " + basename(argv[0]));
  if (result.status) process.exit(result.status);
}

function snapshot(request) {
  const files = [];
  let total = 0;
  const clones = request.clones ?? [];
  if (!Array.isArray(clones) || !clones.every(path => typeof path === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,63}$/.test(path))) refuse("invalid snapshot request");
  const skipped = new Set(clones.map(path => "worktree/" + path));
  const add = (path, archivePath) => {
    if (files.length >= MAX_ENTRIES) refuse("snapshot has too many files");
    const { data, mode } = readAt(path, MAX_SNAPSHOT - total);
    total += data.length;
    files.push({ path: archivePath, data: data.toString("base64"), mode });
  };
  const visit = (directory, prefix, skip = [], depth = 0) => {
    if (depth > 64) refuse("snapshot directory nesting limit exceeded");
    const names = readdirSync(directory).sort();
    if (names.length > MAX_ENTRIES) refuse("directory has too many entries");
    for (const name of names) {
      if (skip.includes(name)) continue;
      const path = join(directory, name);
      const archivePath = prefix + "/" + name;
      if (skipped.has(archivePath)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) refuse("snapshot refuses symlinks and special files");
      if (info.isDirectory()) visit(path, archivePath, [], depth + 1);
      else if (info.isFile()) add(path, archivePath);
      else refuse("snapshot refuses symlinks and special files");
    }
  };
  visit(HOME, "home", [".gitconfig"]);
  add(OWNER_CONFIG, "owner.gitconfig");
  visit(WORK, "worktree", [".git"]);
  visit(GITDIR, "git", ["pistead-push", "pistead-clones"]);
  return files;
}

function cloneDirectory(request) {
  const parts = partsFor(request.path);
  const directory = join(WORK, ...parts);
  let ok = false;
  try { ok = parts.length > 0 && statSync(directory).isDirectory() && !!lstatSync(join(directory, ".git")); } catch {}
  if (!ok) refuse("the clone directory is not a Git clone in the worktree");
  return directory;
}

// A clone's steps read only its objects and config. Git is given its Git directory rather than told to change into the
// clone: Windows' process container lets a step change only into folders it may write, and these steps are read-only.
const cloneGitDir = directory => ["-c", "safe.directory=" + directory, "--git-dir=" + join(directory, ".git")];

function cloneGit(directory, args, input = "") {
  const result = spawnSync(GIT_BINARY, [...GIT_HARDENED, "--literal-pathspecs", ...cloneGitDir(directory), ...args], {
    input, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.error ? 127 : result.status, output: result.stdout ?? Buffer.alloc(0) };
}

function cloneHead(request) {
  const directory = cloneDirectory(request);
  let { code, output } = cloneGit(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const commit = output.toString("ascii").trim();
  if (code || !OID.test(commit)) refuse("the clone has no commit to push");
  ({ code, output } = cloneGit(directory, ["config", "--get", "remote.origin.url"]));
  const origin = code ? null : output.toString("utf8").trim();
  return { commit, origin: origin ? origin.slice(0, 2048) : null };
}

function clonePushPrepare(request) {
  const directory = cloneDirectory(request);
  const { commit, old, tips } = request;
  if (typeof commit !== "string" || !OID.test(commit) || (old !== null && (typeof old !== "string" || !OID.test(old)))
    || !Array.isArray(tips) || tips.length > 1024 || !tips.every(tip => typeof tip === "string" && OID.test(tip))) refuse("invalid push request");
  const names = [commit, ...tips];
  const kinds = cloneGit(directory, ["cat-file", "--batch-check=%(objecttype)"], names.map(name => name + "^{commit}\n").join("")).output.toString("ascii").split(/\r?\n/).filter(Boolean);
  if (kinds.length !== names.length || kinds[0] !== "commit") refuse("the commit to push is not in the clone");
  const present = tips.filter((_, index) => kinds[index + 1] === "commit");
  const ancestor = old === null ? null : present.includes(old) && cloneGit(directory, ["merge-base", "--is-ancestor", old, commit]).code === 0;
  const revisions = commit + "\n" + present.map(tip => "^" + tip + "\n").join("");
  const total = Number(cloneGit(directory, ["rev-list", "--count", "--stdin"], revisions).output.toString().trim() || "0");
  const commits = [];
  for (const line of cloneGit(directory, ["log", "--stdin", "--max-count=100", "--format=%H%x00%s"], revisions).output.toString("utf8").split(/\r?\n/)) {
    const [source, subject = ""] = line.split("\0");
    if (OID.test(source)) commits.push({ source, subject: subject.slice(0, 200) });
  }
  return { present, ancestor, commits, total };
}

async function clonePushPack(request) {
  const directory = cloneDirectory(request);
  const { commit, exclude } = request;
  if (typeof commit !== "string" || !OID.test(commit) || !Array.isArray(exclude) || exclude.length > 1024 || !exclude.every(oid => typeof oid === "string" && OID.test(oid))) refuse("invalid push request");
  // The pack streams straight to the runner on stdout.
  const child = spawn(GIT_BINARY, [...GIT_HARDENED, "--literal-pathspecs", ...cloneGitDir(directory),
    "-c", "core.bigFileThreshold=64m", "pack-objects", "--stdout", "--revs", "--delta-base-offset", "-q"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["pipe", "inherit", "ignore"], windowsHide: true,
  });
  child.stdin.end(commit + "\n" + exclude.map(oid => "^" + oid + "\n").join(""));
  const code = await new Promise(resolve => { child.on("error", () => resolve(127)); child.on("close", resolve); });
  if (code) refuse("push pack failed");
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const end = text.indexOf("\n");
    if (end >= 0) return JSON.parse(text.slice(0, end));
    if (text.length > 4 * 1024 * 1024) refuse("request too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const request = await readRequest();
  const kind = request.kind;
  const print = value => process.stdout.write(JSON.stringify(value) + "\n");
  if (kind === "initialize") {
    let initialized = false;
    try { initialized = statSync(join(GITDIR, "HEAD")).isFile(); } catch {}
    if (!initialized) {
      run([GIT_BINARY, ...GIT, "--git-dir=" + GITDIR, "init", "--quiet", "--template=", "--initial-branch=main"]);
      run([GIT_BINARY, ...GIT, "--git-dir=" + GITDIR, "config", "core.bare", "false"]);
    }
    run([GIT_BINARY, ...GIT, "rev-parse", "--is-inside-work-tree"]);
    return;
  }
  if (kind === "bash") {
    const child = spawn(BASH, [...SHELL_ARGS, request.command], { cwd: WORK, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    const code = await new Promise(resolve => { child.on("error", () => resolve(127)); child.on("close", (status, signal) => resolve(status ?? (signal ? 128 : 1))); });
    process.exit(code);
  }
  if (kind === "snapshot") return print(snapshot(request));
  if (kind === "clone-head") return print(cloneHead(request));
  if (kind === "clone-push-prepare") return print(clonePushPrepare(request));
  if (kind === "clone-push-pack") return clonePushPack(request);
  const parts = partsFor(request.path, kind === "write");
  if (kind === "write") { writeAt(parts, request.content); return print(null); }
  if (kind === "read" || kind === "read-content") {
    if (!parts.length) refuse("a file path is required");
    const path = join(directoryAt(parts.slice(0, -1)), parts.at(-1));
    if (kind === "read") return print(readAt(path, MAX_FILE).data.toString("utf8"));
    const data = readAt(path, MAX_IMAGE).data;
    if (imageType(data)) return print({ image: data.toString("base64") });
    if (data.length > MAX_FILE) refuse("file exceeds size limit");
    return print({ text: data.toString("utf8") });
  }
  if (kind === "browse") {
    if (!parts.length) return print(browseDirectory(worktreeRoot()));
    const path = join(directoryAt(parts.slice(0, -1)), parts.at(-1));
    const info = lstatSync(path);
    return print(info.isDirectory() && !info.isSymbolicLink() ? browseDirectory(path) : browseFile(path));
  }
  if (kind === "list") {
    const names = readdirSync(directoryAt(parts));
    if (names.length > MAX_ENTRIES) refuse("directory has too many entries");
    return print(names.sort());
  }
  refuse("unsupported filesystem operation");
}

main().catch(error => {
  const reason = error instanceof Refusal ? error.message : error && error.code ? error.code + ": " + (error.syscall || "operation") + " failed" : "unexpected failure";
  process.stderr.write("sandbox: " + reason + "\n");
  process.exit(1);
});
`;

/** The request kinds the Node helper runs. */
export const NODE_HELPER_KINDS: ReadonlySet<string> = new Set(["initialize", "read", "read-content", "write", "list", "browse", "snapshot", "bash",
  "clone-head", "clone-push-prepare", "clone-push-pack"]);
