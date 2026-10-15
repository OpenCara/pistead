import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitProgress } from "../apps/runner/src/git-remote.js";
import { RepositoryCache, type RepositoryCacheProgress } from "../apps/runner/src/repo-cache.js";
import type { GitHubSessionRepository } from "../packages/shared/src/repositories.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const gitAvailable = { skip: spawnSync("git", ["--version"]).status !== 0 };
const AUTH = "Basic cGlzdGVhZDp0b2tlbg==";

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: cwd } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function has(directory: string, object: string): boolean {
  return spawnSync("git", [`--git-dir=${directory}`, "cat-file", "-e", object]).status === 0;
}

async function commit(work: string, name: string, content: string): Promise<string> {
  await writeFile(join(work, name), content);
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", `add ${name}`]);
  return git(work, ["rev-parse", "HEAD"]);
}

async function fixture(t: TestContext, options: { protocolV2?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pistead-repo-cache-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream.git"), work = join(root, "work");
  git(root, ["init", "-q", "--bare", "-b", "main", upstream]);
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(root, ["init", "-q", "-b", "main", work]);
  const commits = [await commit(work, "one.txt", "1\n"), await commit(work, "two.txt", "2\n"), await commit(work, "three.txt", "3\n")];
  git(work, ["tag", "-a", "v1", "-m", "release", commits[1]!]);
  git(work, ["checkout", "-q", "-b", "feature", commits[0]!]);
  const feature = await commit(work, "feature.txt", "f\n");
  git(work, ["checkout", "-q", "main"]);
  git(work, ["push", "-q", upstream, "main", "feature", "v1"]);
  const server = await startGitHttpServer(root, { ...options, authorization: AUTH });
  t.after(() => server.close());
  const cacheRoot = join(root, "cache");
  let credentialLookups = 0;
  const open = (scope: "host" | "owner" = "host", authorization = AUTH) => new RepositoryCache({
    root: cacheRoot, scope, progressIntervalMs: 0, authorization: async () => { credentialLookups++; return authorization; },
  });
  const pin = (id: string): GitHubSessionRepository => ({ bindingId: "binding-alpha", repositoryId: 101, fullName: "acme/alpha", path: "acme/alpha", ref: "main", commit: id });
  return { root, upstream, work, commits, feature, cacheRoot, open, pin, remote: server.url("upstream.git"), lookups: () => credentialLookups };
}

for (const protocolV2 of [true, false]) {
  const label = protocolV2 ? "v2" : "v0";

  test(`(${label}) a non-tip pin fetches full history with blobs, mirrors branches and tags, and records the session pin`, gitAvailable, async (t) => {
    const f = await fixture(t, { protocolV2 });
    const cache = f.open();
    const events: RepositoryCacheProgress[] = [];
    const result = await cache.ensure({ pin: f.pin(f.commits[1]!), ownerId: "test:alice", sessionId: "session-1", remote: f.remote }, { onProgress: event => events.push(event) });
    assert.equal(result.fetched, true);
    const directory = cache.directory(f.pin(f.commits[1]!), "test:alice");
    assert.equal(result.objects, join(directory, "objects"));
    for (const id of [...f.commits, f.feature]) assert.ok(has(directory, id), `history must include ${id}`);
    // Full history includes every blob, not just the pinned tree.
    assert.ok(has(directory, git(f.work, ["rev-parse", `${f.commits[0]}:one.txt`])));
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-list", "--count", "refs/upstream/heads/main"]), "3");
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-parse", "refs/upstream/heads/main"]), f.commits[2]);
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-parse", "refs/upstream/heads/feature"]), f.feature);
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-parse", "refs/upstream/tags/v1^{commit}"]), f.commits[1]);
    const pins = git(f.root, [`--git-dir=${directory}`, "for-each-ref", "--format=%(objectname)", "refs/pistead/pins/"]);
    assert.equal(pins, f.commits[1]);
    assert.equal(f.lookups(), 1);
    assert.ok(events.every(event => event.path === "acme/alpha"));
    assert.equal(events.at(-1)?.phase, "done");
    assert.ok(events.some(event => event.phase === "receiving" && event.bytes > 0), "pack bytes must be reported");
    assert.ok(events.some(event => event.phase === "verifying"));
    // Progress carries numbers only.
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["bytes", "done", "path", "percent", "phase", "total"]);
  });

  test(`(${label}) a cached pin needs no credential or fetch; a new commit fetches incrementally`, gitAvailable, async (t) => {
    const f = await fixture(t, { protocolV2 });
    const cache = f.open();
    await cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "session-1", remote: f.remote });
    const directory = cache.directory(f.pin(f.commits[2]!), "test:alice");
    const again = await cache.ensure({ pin: f.pin(f.commits[0]!), ownerId: "test:bob", sessionId: "session-2", remote: f.remote });
    assert.equal(again.fetched, false);
    assert.equal(f.lookups(), 1, "a cache hit must not read the host credential");
    assert.equal(git(f.root, [`--git-dir=${directory}`, "for-each-ref", "--format=%(objectname)", "refs/pistead/pins/"]).split("\n").length, 2);
    const packs = (await readdir(join(directory, "objects", "pack"))).filter(name => name.endsWith(".pack")).length;
    git(f.work, ["checkout", "-q", "main"]);
    const next = await commit(f.work, "four.txt", "4\n");
    git(f.work, ["push", "-q", f.upstream, "main"]);
    const fetched = await cache.ensure({ pin: f.pin(next), ownerId: "test:alice", sessionId: "session-3", remote: f.remote });
    assert.equal(fetched.fetched, true);
    assert.ok(has(directory, next));
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-list", "--count", next]), "4");
    assert.equal((await readdir(join(directory, "objects", "pack"))).filter(name => name.endsWith(".pack")).length, packs + 1);
  });
}

test("a session repository borrowing the cache through alternates sees history without any remote", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const { objects } = await cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "session-1", remote: f.remote });
  const session = join(f.root, "session");
  git(f.root, ["init", "-q", "-b", "main", session]);
  await writeFile(join(session, ".git", "objects", "info", "alternates"), `${objects}\n`);
  git(session, ["read-tree", "--prefix=acme/alpha/", `${f.commits[2]}^{tree}`]);
  git(session, ["checkout-index", "-a"]);
  assert.equal(git(session, ["show", `${f.commits[2]}:one.txt`]), "1");
  assert.equal(git(session, ["log", "--format=%s", f.commits[2]!]).split("\n").length, 3);
  assert.equal(git(session, ["blame", "--porcelain", f.commits[2]!, "--", "two.txt"]).split("\n")[0]!.slice(0, 40), f.commits[1]);
  // The session repository stores no copy of the cached objects.
  assert.deepEqual((await readdir(join(session, ".git", "objects", "pack"))), []);
});

test("host scope shares one repository across owners; owner scope separates them", gitAvailable, async (t) => {
  const f = await fixture(t);
  const pin = f.pin(f.commits[2]!);
  const host = f.open("host");
  assert.equal(host.directory(pin, "test:alice"), host.directory(pin, "test:bob"));
  const owner = f.open("owner");
  assert.notEqual(owner.directory(pin, "test:alice"), owner.directory(pin, "test:bob"));
  await owner.ensure({ pin, ownerId: "test:alice", sessionId: "s1", remote: f.remote });
  const second = await owner.ensure({ pin, ownerId: "test:bob", sessionId: "s2", remote: f.remote });
  assert.equal(second.fetched, true, "an owner-scoped cache never reuses another owner's objects");
  assert.throws(() => new RepositoryCache({ root: f.cacheRoot, scope: "shared" as "host" }));
});

test("cache directories are private and named only from validated pin fields", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  await cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote });
  assert.equal((await stat(f.cacheRoot)).mode & 0o077, 0);
  assert.equal(cache.directory(f.pin(f.commits[2]!), "test:alice"), join(f.cacheRoot, "github", "github.com", "101.git"));
  assert.throws(() => cache.directory({ ...f.pin(f.commits[2]!), repositoryId: "../x" as unknown as number }, "test:alice"));
  assert.throws(() => cache.directory({ bindingId: "b", provider: "gitlab", host: "../evil", repositoryId: "1", fullName: "a/b", ref: "main", commit: f.commits[2]!, path: "x/a/b" }, "test:alice"));
  await rm(f.cacheRoot, { recursive: true, force: true });
  await mkdir(f.cacheRoot);
  // Explicitly, since the umask decides mkdir's mode.
  await chmod(f.cacheRoot, 0o755);
  await assert.rejects(cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote }), /private directory/);
});

test("a commit the remote does not have, or a refused credential, fails without recording a pin", gitAvailable, async (t) => {
  const f = await fixture(t);
  const missing = f.pin("e".repeat(40));
  await assert.rejects(f.open().ensure({ pin: missing, ownerId: "test:alice", sessionId: "s1", remote: f.remote }));
  const denied = f.open("host", "Basic d3Jvbmc=");
  await assert.rejects(denied.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote }), /401/);
  const directory = f.open().directory(f.pin(f.commits[2]!), "test:alice");
  assert.equal(git(f.root, [`--git-dir=${directory}`, "for-each-ref", "refs/pistead/pins/"]), "");
  // A later, valid request still succeeds: failures leave no lock behind.
  assert.equal((await f.open().ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote })).fetched, true);
});

test("concurrent sessions fetch once; the waiting session sees the running fetch's progress", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const waiting: RepositoryCacheProgress[] = [];
  const [first, second] = await Promise.all([
    cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote }),
    cache.ensure({ pin: f.pin(f.commits[1]!), ownerId: "test:bob", sessionId: "s2", remote: f.remote }, { onProgress: event => waiting.push(event) }),
  ]);
  assert.equal(first.fetched, true);
  assert.equal(second.fetched, false);
  assert.equal(f.lookups(), 1);
  assert.equal(waiting[0]?.phase, "waiting");
  assert.ok(waiting.some(event => event.phase === "receiving" || event.phase === "verifying"), "the waiter must see the other session's fetch");
  assert.equal(waiting.at(-1)?.phase, "done");
});

test("a stale lock left by a dead process is taken over; release drops only that session's pin", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const directory = cache.directory(f.pin(f.commits[2]!), "test:alice");
  await mkdir(join(directory, ".."), { recursive: true, mode: 0o700 });
  await writeFile(`${directory}.pistead.lock`, "2147483646\n", { mode: 0o600 });
  await cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote });
  await cache.ensure({ pin: f.pin(f.commits[1]!), ownerId: "test:alice", sessionId: "s2", remote: f.remote });
  await cache.release({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1" });
  assert.equal(git(f.root, [`--git-dir=${directory}`, "for-each-ref", "--format=%(objectname)", "refs/pistead/pins/"]), f.commits[1]);
  await cache.release({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "never-pinned" });
});

test("an aborted ensure fails without taking the lock, and a later ensure succeeds", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote }, { signal: controller.signal }));
  assert.equal((await cache.ensure({ pin: f.pin(f.commits[2]!), ownerId: "test:alice", sessionId: "s1", remote: f.remote })).fetched, true);
});

test("progress parsing keeps Git's numbers and drops any other remote text", () => {
  assert.deepEqual(parseGitProgress("Counting objects:  45% (450/1000)"), { phase: "counting", percent: 45, done: 450, total: 1000 });
  assert.deepEqual(parseGitProgress("Receiving objects: 100% (3/3), 1.20 KiB | 1.2 MiB/s, done."), { phase: "receiving", percent: 100, done: 3, total: 3 });
  assert.deepEqual(parseGitProgress("Enumerating objects: 1234, done."), { phase: "enumerating", percent: null, done: 1234, total: null });
  assert.equal(parseGitProgress("Visit https://evil.example to continue"), null);
  assert.equal(parseGitProgress("Counting objects: \u001b[31m"), null);
});
