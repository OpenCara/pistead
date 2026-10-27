import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRemote, parseGitProgress } from "../apps/runner/src/git-remote.js";
import { setTimeout as delay } from "node:timers/promises";
import { RepositoryCache, mirrorPath, type MirrorRepository, type MirrorTarget, type RepositoryCacheProgress } from "../apps/runner/src/repo-cache.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const gitAvailable = { skip: spawnSync("git", ["--version"]).status !== 0 };
const AUTH = "Basic cGlzdGVhZDp0b2tlbg==";
const repository: MirrorRepository = { provider: "github", host: "github.com", repositoryId: "101", fullName: "acme/alpha" };

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
  const open = (scope: "host" | "owner" = "host") => new RepositoryCache({ root: cacheRoot, scope, progressIntervalMs: 0 });
  const target = (sessionId: string, ownerId = "test:alice", authorization = AUTH, signal?: AbortSignal): MirrorTarget => ({
    repository, ownerId, sessionId, remote: new GitRemote({ url: server.url("upstream.git"), authorization, signal }),
  });
  const keeps = (directory: string) => git(root, [`--git-dir=${directory}`, "for-each-ref", "--format=%(refname)", "refs/pistead/sessions/"]).split("\n").filter(Boolean);
  return { root, upstream, work, commits, feature, cacheRoot, open, target, keeps, url: server.url("upstream.git") };
}

/** What a pack download that broke off leaves in a mirror. */
async function temporary(directory: string): Promise<string[]> {
  return (await readdir(join(directory, "objects", "pack"))).filter(name => name.startsWith("tmp_") || name.startsWith(".tmp-"));
}

/** Whether a Git request body asks for a pack (a v2 fetch command, or v0's wants), unlike a ref listing. */
async function wantsPack(init: RequestInit | undefined): Promise<{ wants: boolean; init: RequestInit | undefined }> {
  if (!init?.body) return { wants: false, init };
  const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
  return { wants: new TextDecoder().decode(body).includes("want "), init: { ...init, body } };
}

for (const protocolV2 of [true, false]) {
  const label = protocolV2 ? "v2" : "v0";

  test(`(${label}) a refresh fetches full history with blobs, mirrors branches and tags, and records the session's keep ref`, gitAvailable, async (t) => {
    const f = await fixture(t, { protocolV2 });
    const cache = f.open();
    const events: RepositoryCacheProgress[] = [];
    const result = await cache.refresh(f.target("session-1"), { onProgress: event => events.push(event) });
    assert.equal(result.fetched, true);
    const directory = cache.mirrorDirectory(repository, "test:alice");
    assert.equal(result.directory, directory);
    for (const id of [...f.commits, f.feature]) assert.ok(has(directory, id), `history must include ${id}`);
    assert.ok(has(directory, git(f.work, ["rev-parse", `${f.commits[0]}:one.txt`])));
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-list", "--count", "refs/upstream/heads/main"]), "3");
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-parse", "refs/upstream/heads/feature"]), f.feature);
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-parse", "refs/upstream/tags/v1^{commit}"]), f.commits[1]);
    assert.equal(f.keeps(directory).length, 1);
    assert.ok(events.every(event => event.path === "acme/alpha"));
    assert.equal(events.at(-1)?.phase, "done");
    assert.ok(events.some(event => event.phase === "receiving" && event.bytes > 0), "pack bytes must be reported");
    assert.ok(events.some(event => event.phase === "verifying"));
    // Progress carries numbers only.
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["bytes", "done", "path", "percent", "phase", "total"]);
  });

  test(`(${label}) an up-to-date mirror fetches nothing; a new commit fetches incrementally`, gitAvailable, async (t) => {
    const f = await fixture(t, { protocolV2 });
    const cache = f.open();
    await cache.refresh(f.target("session-1"));
    const directory = cache.mirrorDirectory(repository, "test:alice");
    assert.equal((await cache.refresh(f.target("session-2", "test:bob"))).fetched, false);
    assert.equal(f.keeps(directory).length, 2);
    const packs = (await readdir(join(directory, "objects", "pack"))).filter(name => name.endsWith(".pack")).length;
    const next = await commit(f.work, "four.txt", "4\n");
    git(f.work, ["push", "-q", f.upstream, "main"]);
    assert.equal((await cache.refresh(f.target("session-3"))).fetched, true);
    assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-list", "--count", next]), "4");
    assert.equal((await readdir(join(directory, "objects", "pack"))).filter(name => name.endsWith(".pack")).length, packs + 1);
  });
}

test("a clone borrowing the mirror through alternates sees history without any remote", gitAvailable, async (t) => {
  const f = await fixture(t);
  const { directory } = await f.open().refresh(f.target("session-1"));
  const session = join(f.root, "session");
  git(f.root, ["init", "-q", "-b", "main", session]);
  await writeFile(join(session, ".git", "objects", "info", "alternates"), `${join(directory, "objects")}\n`);
  assert.equal(git(session, ["show", `${f.commits[2]}:one.txt`]), "1");
  assert.equal(git(session, ["log", "--format=%s", f.commits[2]!]).split("\n").length, 3);
  // The session repository stores no copy of the mirror's objects.
  assert.deepEqual((await readdir(join(session, ".git", "objects", "pack"))), []);
});

test("host scope shares one mirror across owners; owner scope separates them", gitAvailable, async (t) => {
  const f = await fixture(t);
  const host = f.open("host");
  assert.equal(host.mirrorDirectory(repository, "test:alice"), host.mirrorDirectory(repository, "test:bob"));
  const owner = f.open("owner");
  assert.notEqual(owner.mirrorDirectory(repository, "test:alice"), owner.mirrorDirectory(repository, "test:bob"));
  await owner.refresh(f.target("s1"));
  assert.equal((await owner.refresh(f.target("s2", "test:bob"))).fetched, true, "an owner-scoped cache never reuses another owner's objects");
  assert.throws(() => new RepositoryCache({ root: f.cacheRoot, scope: "shared" as "host" }));
});

test("cache directories are private and named only from validated repository fields", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  await cache.refresh(f.target("s1"));
  assert.equal((await stat(f.cacheRoot)).mode & 0o077, 0);
  assert.equal(cache.mirrorDirectory(repository, "test:alice"), join(f.cacheRoot, "github", "github.com", "101.git"));
  assert.throws(() => mirrorPath({ ...repository, repositoryId: "../x" }));
  assert.throws(() => mirrorPath({ ...repository, provider: "gitlab", host: "../evil" }));
  await rm(f.cacheRoot, { recursive: true, force: true });
  await mkdir(f.cacheRoot);
  // Explicitly, since the umask decides mkdir's mode.
  await chmod(f.cacheRoot, 0o755);
  await assert.rejects(cache.refresh(f.target("s1")), /private directory/);
});

test("a refused credential fails without recording a keep ref, and leaves no lock behind", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  await assert.rejects(cache.refresh(f.target("s1", "test:alice", "Basic d3Jvbmc=")), /401/);
  assert.deepEqual(f.keeps(cache.mirrorDirectory(repository, "test:alice")), []);
  assert.equal((await cache.refresh(f.target("s1"))).fetched, true);
});

test("concurrent sessions fetch once; the waiting session sees the running fetch's progress", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const waiting: RepositoryCacheProgress[] = [];
  const [first, second] = await Promise.all([
    cache.refresh(f.target("s1")),
    cache.refresh(f.target("s2", "test:bob"), { onProgress: event => waiting.push(event) }),
  ]);
  assert.equal(first.fetched, true);
  assert.equal(second.fetched, false);
  assert.equal(waiting[0]?.phase, "waiting");
  assert.ok(waiting.some(event => event.phase === "receiving" || event.phase === "verifying"), "the waiter must see the other session's fetch");
  assert.equal(waiting.at(-1)?.phase, "done");
});

test("a ref listing or fetch that breaks off is tried again, and what a broken-off fetch left is removed", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = new RepositoryCache({ root: f.cacheRoot, progressIntervalMs: 0, retryDelaysMs: [0, 0] });
  const directory = await cache.prepare(repository, "test:alice");
  // Left by a fetch that broke off in a runner that died.
  await mkdir(join(directory, "objects", "pack"), { recursive: true });
  await writeFile(join(directory, "objects", "pack", "tmp_pack_left"), "partial");
  let listings = 0, packs = 0;
  const flaky: typeof fetch = async (input, init) => {
    // The remote is busy once...
    if (String(input).includes("/info/refs") && listings++ === 0) return new Response("busy", { status: 503 });
    const request = await wantsPack(init);
    const response = await fetch(input, request.init);
    if (!request.wants || packs++ > 0) return response;
    // ...and the first pack breaks off halfway, the way fetch reports a dropped connection.
    const first = (await response.body!.getReader().read()).value!;
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new TypeError("terminated"));
        else { sent = true; controller.enqueue(first.subarray(0, Math.max(1, first.length >> 1))); }
      },
    }), { status: response.status, headers: response.headers });
  };
  const result = await cache.refresh({ ...f.target("s1"), remote: new GitRemote({ url: f.url, authorization: AUTH, fetch: flaky }) });
  assert.equal(result.fetched, true);
  assert.equal(packs, 2, "the fetch that broke off was tried again");
  for (const id of [...f.commits, f.feature]) assert.ok(has(directory, id));
  assert.deepEqual(await temporary(directory), []);
  // A refusal is final: one attempt.
  let refused = 0;
  const refusing: typeof fetch = async () => { refused++; return new Response(null, { status: 403 }); };
  await assert.rejects(cache.refresh({ ...f.target("s2"), remote: new GitRemote({ url: f.url, authorization: AUTH, fetch: refusing }) }), /403/);
  assert.equal(refused, 1);
});

test("a refresh given the owner's ref listing mirrors only those tips, fetching their history through its own remote", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const directory = cache.mirrorDirectory(repository, "test:alice");
  // As the relay listed it a moment before: main one commit behind, and neither the feature branch nor the tag.
  assert.equal((await cache.refresh({ ...f.target("s1"), refs: new Map([["refs/heads/main", f.commits[1]!]]) })).fetched, true);
  assert.equal(git(f.root, [`--git-dir=${directory}`, "for-each-ref", "--format=%(refname) %(objectname)", "refs/upstream/"]), `refs/upstream/heads/main ${f.commits[1]}`);
  assert.ok(has(directory, f.commits[0]!));
  assert.equal(has(directory, f.commits[2]!), false);
  assert.equal(has(directory, f.feature), false);
  // A listing naming what the remote doesn't hold gets nothing from it; one naming other refs is refused.
  await assert.rejects(cache.refresh({ ...f.target("s2"), refs: new Map([["refs/heads/main", "b".repeat(40)]]) }));
  await assert.rejects(cache.refresh({ ...f.target("s3"), refs: new Map([["refs/pull/1/head", f.commits[2]!]]) }), /Invalid ref listing/);
  assert.equal(git(f.root, [`--git-dir=${directory}`, "rev-parse", "refs/upstream/heads/main"]), f.commits[1]);
});

test("a mirror's first fill is waited for; a filled mirror is answered after the wait, as it is, while its refresh goes on", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  assert.equal(await cache.filled(repository, "test:alice"), false);
  const directory = await cache.prepare(repository, "test:alice");
  assert.equal(await cache.filled(repository, "test:alice"), false, "an empty mirror is not filled");
  let hold: Promise<void> | undefined;
  let release = () => {};
  const held = () => { hold = new Promise<void>(resolve => { release = resolve; }); };
  const slow = (sessionId: string): MirrorTarget => ({ ...f.target(sessionId), remote: new GitRemote({ url: f.url, authorization: AUTH, fetch: (async (input, init) => {
    if (hold && String(input).endsWith("/git-upload-pack")) await hold;
    return fetch(input, init);
  }) as typeof fetch }) });
  // The first fill is waited for, however long it takes.
  held();
  let answered = false;
  const first = cache.ready(slow("s1"), { wait: 10 }).then(result => { answered = true; return result; });
  await delay(300);
  assert.equal(answered, false, "a mirror never filled is waited for");
  release();
  assert.deepEqual(await first, { directory, fresh: true });
  assert.equal(await cache.filled(repository, "test:alice"), true);
  // A filled one is answered as it is once the wait is over; its refresh goes on.
  const next = await commit(f.work, "four.txt", "4\n");
  git(f.work, ["push", "-q", f.upstream, "main"]);
  held();
  const started = Date.now();
  assert.deepEqual(await cache.ready(slow("s2"), { wait: 50 }), { directory, fresh: false });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(has(directory, next), false);
  release();
  // The next refresh waits for that one, which fetched the new commit.
  assert.equal((await cache.refresh(f.target("s3"))).fetched, false);
  assert.equal(has(directory, next), true);
  hold = undefined;
  assert.deepEqual(await cache.ready(f.target("s4"), { wait: 5_000 }), { directory, fresh: true });
  // A filled mirror whose refresh fails is answered as it is; one never filled fails with it.
  assert.deepEqual(await cache.ready(f.target("s5", "test:alice", "Basic d3Jvbmc="), { wait: 5_000 }), { directory, fresh: false });
  await assert.rejects(f.open("owner").ready(f.target("s6", "test:bob", "Basic d3Jvbmc=")), /401/);
});

test("a prune removes what a fetch that broke off left behind", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const { directory } = await cache.refresh(f.target("s1"));
  await writeFile(join(directory, "objects", "pack", "tmp_pack_left"), "partial");
  await cache.prune(24 * 60 * 60 * 1000);
  assert.deepEqual(await temporary(directory), []);
  assert.equal((await cache.refresh(f.target("s2"))).fetched, false, "the mirror itself is intact");
});

test("a stale lock left by a dead process is taken over", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const directory = cache.mirrorDirectory(repository, "test:alice");
  await mkdir(join(directory, ".."), { recursive: true, mode: 0o700 });
  await writeFile(`${directory}.pistead.lock`, "2147483646\n", { mode: 0o600 });
  assert.equal((await cache.refresh(f.target("s1"))).fetched, true);
});

test("an aborted refresh fails before Git starts or the lock is taken, and a later refresh succeeds", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cache.refresh(f.target("s1"), { signal: controller.signal }));
  assert.equal((await cache.refresh(f.target("s1"))).fetched, true);
});

test("progress parsing keeps Git's numbers and drops any other remote text", () => {
  assert.deepEqual(parseGitProgress("Counting objects:  45% (450/1000)"), { phase: "counting", percent: 45, done: 450, total: 1000 });
  assert.deepEqual(parseGitProgress("Receiving objects: 100% (3/3), 1.20 KiB | 1.2 MiB/s, done."), { phase: "receiving", percent: 100, done: 3, total: 3 });
  assert.deepEqual(parseGitProgress("Enumerating objects: 1234, done."), { phase: "enumerating", percent: null, done: 1234, total: null });
  assert.equal(parseGitProgress("Visit https://evil.example to continue"), null);
  assert.equal(parseGitProgress("Counting objects: \u001b[31m"), null);
});

test("branches renamed into or out of a directory on the remote update the mirror in either direction", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const directory = cache.mirrorDirectory(repository, "test:alice");
  await cache.refresh(f.target("s1"));
  const upstreamRefs = () => git(f.root, [`--git-dir=${directory}`, "for-each-ref", "--format=%(refname)", "refs/upstream/heads/"]).split("\n");
  for (const [from, to, step] of [["feature", "feature/login", 1], ["feature/login", "feature", 2]] as const) {
    const next = git(f.work, ["commit-tree", `${f.commits[2]}^{tree}`, "-p", f.commits[2]!, "-m", `rename ${step}`]);
    git(f.work, ["push", "-q", f.upstream, `:refs/heads/${from}`]);
    git(f.work, ["push", "-q", f.upstream, `${next}:refs/heads/${to}`]);
    await cache.refresh(f.target(`s${step + 1}`));
    assert.ok(upstreamRefs().includes(`refs/upstream/heads/${to}`), to);
    assert.ok(!upstreamRefs().includes(`refs/upstream/heads/${from}`), from);
  }
});

test("a live holder's lock is waited for, and a lock without a pid is replaced only after it stays that way", gitAvailable, async (t) => {
  const f = await fixture(t);
  const cache = f.open();
  const directory = cache.mirrorDirectory(repository, "test:alice");
  await mkdir(join(directory, ".."), { recursive: true, mode: 0o700 });
  const lock = `${directory}.pistead.lock`;
  // The test runner's parent process is alive and is not this process.
  await writeFile(lock, `${process.ppid}\n`, { mode: 0o600 });
  let finished = false;
  const pending = cache.refresh(f.target("s1")).finally(() => { finished = true; });
  await delay(600);
  assert.equal(finished, false, "a live holder's lock is respected");
  await rm(lock);
  assert.equal((await pending).fetched, true);
  await writeFile(lock, "", { mode: 0o600 });
  const started = Date.now();
  await cache.refresh(f.target("s2"));
  assert.ok(Date.now() - started >= 250, "an empty lock gets one poll interval to receive its pid");
});

function pkt(body: string | Buffer): Buffer {
  const bytes = Buffer.from(body);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

test("a corrupt pack fails the fetch and closes the download instead of leaving it streaming", gitAvailable, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pistead-repo-cache-corrupt-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "a".repeat(40);
  let cancelled = false;
  let posts = 0;
  const result = (body: BodyInit) => new Response(body, { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes("/info/refs")) {
      return new Response(Buffer.concat([pkt("# service=git-upload-pack\n"), Buffer.from("0000"), pkt("version 2\n"), pkt("ls-refs\n"), pkt("fetch\n"), Buffer.from("0000")]),
        { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } });
    }
    if (++posts === 1) return result(Buffer.concat([pkt(`${id} refs/heads/main\n`), Buffer.from("0000")]));
    // A pack section whose side-band data is not a pack, without end.
    const garbage = pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(60_000, 0x41)]));
    let first = true;
    return result(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(first ? Buffer.concat([pkt("packfile\n"), garbage]) : garbage); first = false; },
      cancel() { cancelled = true; },
    }));
  };
  const cache = new RepositoryCache({ root: join(root, "cache") });
  const remote = new GitRemote({ url: "https://github.com/acme/alpha.git", authorization: "Basic eDp5", fetch: fakeFetch });
  await assert.rejects(cache.refresh({ repository, ownerId: "test:alice", sessionId: "s1", remote }), /index-pack failed/);
  for (let attempt = 0; attempt < 50 && !cancelled; attempt++) await delay(20);
  assert.equal(cancelled, true, "the download is closed once Git gives up on the pack");
  // Git refusing the pack is final, and what index-pack started is removed.
  assert.equal(posts, 2, "no second attempt at a pack Git refused");
  assert.deepEqual(await temporary(cache.mirrorDirectory(repository, "test:alice")), []);
});
