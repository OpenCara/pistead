import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EgressProxy, relayFetch, type RelayRequest } from "../apps/runner/src/egress.js";
import { GitRemote } from "../apps/runner/src/git-remote.js";
import { RepositoryCache } from "../apps/runner/src/repo-cache.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import type { EgressGrant } from "../packages/shared/src/network.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
/** The Git credential the host's own credential helper would give: only the host's direct reads carry it. */
const HOST_AUTH = "Basic aG9zdDpjcmVkZW50aWFs";
const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * An upstream repository served by git http-backend twice: as the control plane's relay reaches it with the session
 * owner's account (`relay`, recording every request), and as the host reaches it directly with its own Git credential
 * (`cacheRemote`, which only accepts that credential, recording what it is asked).
 */
async function upstream(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "mirrors-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = join(directory, "projects");
  await mkdir(join(projects, "acme"), { recursive: true });
  const work = join(directory, "work");
  await mkdir(work);
  git(["init", "-q", "-b", "main"], work);
  await writeFile(join(work, "README.md"), "from upstream\n");
  git(["add", "README.md"], work);
  git(["commit", "-q", "-m", "initial"], work);
  const bare = join(projects, "acme", "app.git");
  git(["clone", "-q", "--bare", work, bare], directory);
  const server = await startGitHttpServer(projects);
  t.after(() => server.close());
  const relayed: RelayRequest[] = [];
  const relay = async (request: RelayRequest) => {
    relayed.push(request);
    return fetch(request.service === "info-refs" ? `${server.url("acme/app.git")}/info/refs?service=git-upload-pack` : `${server.url("acme/app.git")}/git-upload-pack`, {
      method: request.body ? "POST" : "GET", body: request.body,
      headers: { ...(request.contentType ? { "content-type": request.contentType } : {}), ...(request.gitProtocol ? { "git-protocol": request.gitProtocol } : {}) },
    });
  };
  const remote = () => new GitRemote({ url: "https://github.com/acme/app.git", authorization: "Bearer relay", fetch: relayFetch(repository.bindingId, relay) });
  const hosted = await startGitHttpServer(projects, { authorization: HOST_AUTH });
  t.after(() => hosted.close());
  const fetched: string[] = [];
  let delay = 0;
  const cacheRemote = async () => new GitRemote({ url: hosted.url("acme/app.git"), authorization: HOST_AUTH, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    fetched.push(path);
    // A slow download, for a clone that must wait for the fill.
    if (delay && path.endsWith("/git-upload-pack")) await new Promise(resolve => setTimeout(resolve, delay));
    return fetch(input, init);
  }) as typeof fetch });
  /** Whether a pack ever went through the relay: an upload-pack request that wants something. */
  const relayedPack = () => relayed.some(request => request.service === "upload-pack" && request.body instanceof Uint8Array
    && new TextDecoder().decode(request.body).includes("want "));
  return { directory, work, bare, relay, relayed, remote, cacheRemote, fetched, relayedPack, slow: (ms: number) => { delay = ms; } };
}

test("a mirror is filled with the host's own credential, keeps each session's branch tips, and prune drops idle sessions", async t => {
  const u = await upstream(t);
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  const first = await cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-1", remote: await u.cacheRemote() });
  assert.equal(first.fetched, true);
  assert.equal(first.directory, cache.mirrorDirectory(repository, "test:alice"));
  const head = git(["rev-parse", "main"], u.work);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", "refs/upstream/heads/main"], u.directory), head);
  assert.ok(u.fetched.some(path => path.endsWith("/info/refs")) && u.fetched.some(path => path.endsWith("/git-upload-pack")));
  assert.deepEqual(u.relayed, [], "nothing of the fill goes through the relay");
  const keep = git(["--git-dir", first.directory, "for-each-ref", "--format=%(refname)", "refs/pistead/sessions/"], u.directory).split("\n");
  assert.equal(keep.length, 1);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^1`], u.directory), head);
  // A later refresh keeps what the session saw before: the new keep commit's first parent is the previous one.
  const before = git(["--git-dir", first.directory, "rev-parse", keep[0]!], u.directory);
  await writeFile(join(u.work, "NEXT.md"), "next\n");
  git(["add", "NEXT.md"], u.work);
  git(["commit", "-q", "-m", "next"], u.work);
  git(["push", "-q", "--force", u.bare, "main"], u.work);
  assert.equal((await cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-1", remote: await u.cacheRemote() })).fetched, true);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^1`], u.directory), before);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^2`], u.directory), git(["rev-parse", "main"], u.work));
  // Touching moves the keep ref on without fetching.
  await cache.touch(repository, "test:alice", "session-1");
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^1^1`], u.directory), before);
  // Nothing new upstream: nothing is fetched again.
  assert.equal((await cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-2", remote: await u.cacheRemote() })).fetched, false);
  const listed = await cache.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.sessions, 2);
  assert.ok(listed[0]!.bytes > 0);
  // A refusal fails the refresh.
  const refused = new GitRemote({ url: "https://github.com/acme/app.git", authorization: "Bearer relay", fetch: relayFetch(repository.bindingId, async () => {
    const { RunnerError } = await import("../apps/runner/src/protocol.js");
    throw new RunnerError(403, "The session owner lost access.");
  }) });
  await assert.rejects(cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-3", remote: refused }), /403/);
  // Keep refs younger than the age stay; older ones go.
  assert.deepEqual(await cache.prune(24 * 60 * 60 * 1000), { repositories: 1, sessions: 0 });
  assert.deepEqual(await cache.prune(0), { repositories: 1, sessions: 2 });
  assert.equal((await cache.list())[0]!.sessions, 0);
  // Owner-scoped caches keep owners apart.
  const owned = new RepositoryCache({ root: join(u.directory, "owned"), scope: "owner" });
  assert.notEqual(owned.mirrorDirectory(repository, "test:alice"), owned.mirrorDirectory(repository, "test:bob"));
});

test("the proxy's mirror endpoint serves only workspace repositories, and only where the host keeps a cache", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mirrors-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const mirrored: string[] = [];
  const start = async (name: string, mirror?: (value: typeof repository) => Promise<string>) => {
    const proxy = new EgressProxy({ socketPath: join(directory, `${name}.sock`), grant: async () => grant, relay: async () => assert.fail("no relay"),
      ...(mirror ? { mirror: async value => mirror(value as typeof repository) } : {}) });
    await proxy.start();
    t.after(() => proxy.close());
    return proxy;
  };
  const get = (socketPath: string, remote: string) => new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest({ socketPath, path: `/__pistead/mirror?remote=${encodeURIComponent(remote)}` }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, type: response.headers["content-type"], body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end();
  });
  const lines = (body: string) => body.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const cached = await start("cached", async value => { mirrored.push(value.bindingId); return "/repository-mirrors/github/github.com/1701.git"; });
  const ok = await get(cached.socketPath, "git@github.com:acme/app.git");
  assert.equal(ok.status, 200);
  assert.equal(ok.type, "application/x-ndjson");
  assert.deepEqual(lines(ok.body), [{ path: "/repository-mirrors/github/github.com/1701.git" }]);
  assert.deepEqual(mirrored, ["binding-app"]);
  assert.equal((await get(cached.socketPath, "https://github.com/acme/other.git")).status, 404);
  const uncached = await start("uncached");
  assert.equal((await get(uncached.socketPath, "https://github.com/acme/app.git")).status, 404);
  // Why it couldn't be filled is the last line; the wait itself streams the fill's progress, Git's numbers only.
  const failing = await start("failing", async () => { throw new Error("Git remote returned HTTP 403"); });
  const failed = await get(failing.socketPath, "https://github.com/acme/app.git");
  assert.equal(failed.status, 200);
  assert.match(String(lines(failed.body).at(-1)?.error), /403/);
  assert.equal(lines(failed.body).at(-1)?.retry, undefined, "final: the clone goes ahead without the cache");
  // A failure another attempt may get past says so: the clone asks again.
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  const busy = await start("busy", async () => { throw new RunnerError(503, "Pistead could not confirm right now that this session's owner can read acme/app"); });
  assert.deepEqual(lines((await get(busy.socketPath, "https://github.com/acme/app.git")).body).at(-1),
    { error: "Pistead could not confirm right now that this session's owner can read acme/app", retry: true });
  const filling = new EgressProxy({ socketPath: join(directory, "filling.sock"), grant: async () => grant, relay: async () => assert.fail("no relay"),
    mirror: async (_value, onProgress) => {
      onProgress({ phase: "connecting", percent: null, done: null, total: null, bytes: 0 });
      onProgress({ phase: "receiving", percent: 40, done: 4, total: 10, bytes: 2048, path: "acme/app" } as never);
      await new Promise(resolve => setTimeout(resolve, 50));
      return "/repository-mirrors/github/github.com/1701.git";
    } });
  await filling.start();
  t.after(() => filling.close());
  assert.deepEqual(lines((await get(filling.socketPath, "https://github.com/acme/app.git")).body), [
    { progress: { phase: "connecting", percent: null, done: null, total: null, bytes: 0 } },
    { progress: { phase: "receiving", percent: 40, done: 4, total: 10, bytes: 2048 } },
    { path: "/repository-mirrors/github/github.com/1701.git" },
  ]);
});

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Mirror test", policyVersion: 1,
      status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner",
      gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:template-author", workspaceId: "workspace", version: 1, name: "Mirror agent",
      description: "Test", instructions: "Use tools.", tools: ["bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "mirror-faux" },
  };
}

const sandboxed = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

test("a sandboxed clone borrows the host mirror's objects through the git shim", { skip: !sandboxed }, async t => {
  const u = await upstream(t);
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const target = "/repository-mirrors/github/github.com/1701.git";
  const mounts: { source: string; target: string }[] = [];
  const proxy = new EgressProxy({
    socketPath: join(u.directory, "proxy.sock"), grant: async () => grant, relay: u.relay,
    mirror: async value => {
      await cache.refresh({ repository: value as typeof repository, ownerId: "test:alice", sessionId: "mirror", remote: await u.cacheRemote() });
      return target;
    },
  });
  await proxy.start();
  t.after(() => proxy.close());
  // The mirror exists from an earlier session and this one may use it, as after a reopen.
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "earlier", remote: await u.cacheRemote() });
  mounts.push({ source: cache.mirrorDirectory(repository, "test:alice"), target });
  const sandbox = new Sandbox(binding("mirror"), join(u.directory, "session"), undefined, { egressSocket: proxy.socketPath, mirrors: async () => mounts });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  await shell("git clone -q https://github.com/acme/app.git app");
  assert.equal(await sandbox.readFile("app/README.md", authorize), "from upstream\n");
  assert.equal((await sandbox.readFile("app/.git/objects/info/alternates", authorize)).trim(), `${target}/objects`);
  // The clone holds none of the mirror's objects itself, and reads them fine; no pack went through the relay for it.
  assert.equal((await shell("cd app && git count-objects -v | grep '^count\\|^in-pack'")).trim(), "count: 0\nin-pack: 0");
  assert.equal(u.relayedPack(), false);
  assert.match(await shell("cd app && git log --oneline"), /initial/);
  // A clone that already chose how to borrow, or none of the workspace's, is left alone.
  await shell("git clone -q --dissociate https://github.com/acme/app.git plain");
  await assert.rejects(sandbox.readFile("plain/.git/objects/info/alternates", authorize));
  // Other Git commands go straight through.
  assert.match(await shell("git --version"), /^git version/);
  // A borrowing clone pushes: the push steps see the mirror too.
  await shell("cd app && git switch -q -c feature && echo change > change.txt && git add change.txt && git commit -q -m 'Add a change'");
  const head = await sandbox.cloneHead("app", authorize);
  const { performClonePush } = await import("../apps/runner/src/push.js");
  const server = await startGitHttpServer(join(u.directory, "projects"));
  t.after(() => server.close());
  const pushed = await performClonePush({ workspace: sandbox, credential: { remote: server.url("acme/app.git"), authorization: "Basic dTpw" }, authorize,
    operation: { kind: "git.push", repository: "acme/app", directory: "app", branch: "feature", commit: head.commit } });
  assert.equal(pushed.outcome, "pushed");
  assert.equal(git(["rev-parse", "refs/heads/feature"], u.bare), head.commit);
  // Pushing to an existing branch needs the mirror's objects to tell it is a fast-forward.
  await shell("cd app && echo more >> change.txt && git commit -q -am 'More'");
  const next = await sandbox.cloneHead("app", authorize);
  assert.equal((await performClonePush({ workspace: sandbox, credential: { remote: server.url("acme/app.git"), authorization: "Basic dTpw" }, authorize,
    operation: { kind: "git.push", repository: "acme/app", directory: "app", branch: "feature", commit: next.commit } })).outcome, "pushed");
});

test("a clone session lists every workspace repository's mirror, creating missing ones empty, and mounts each only once the relay confirms the owner's access", async t => {
  const u = await upstream(t);
  const { RunnerSession } = await import("../apps/runner/src/session.js");
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "earlier", remote: await u.cacheRemote() });
  const other = { ...repository, bindingId: "binding-other", repositoryId: "1702", fullName: "acme/other" };
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository, other] };
  const mounts = [{ source: cache.mirrorDirectory(repository, "test:alice"), target: "/repository-mirrors/github/github.com/1701.git" },
    { source: cache.mirrorDirectory(other, "test:alice"), target: "/repository-mirrors/github/github.com/1702.git" }];
  let allowed: boolean | "busy" = true;
  const open = async (name: string) => {
    const root = join(u.directory, name);
    const session = new RunnerSession(binding(name), root, { dataDir: root, controlPlaneUrl: "https://control.example.test", sharedSecret: "s".repeat(32), allowFaux: true,
      authorize: async request => ({ allowed: true, ownerId: request.ownerId, policyVersion: 1 }), repositoryCache: cache, egressGrant: async () => grant,
      gitRelay: async (_sessionId, request) => {
        if (allowed === "busy") throw new RunnerError(429, "Rate limited");
        if (!allowed) throw new RunnerError(403, "No access");
        return u.relay(request);
      },
      resolveModels: async () => { throw new Error("model boundary"); } });
    t.after(() => session.sandbox.close());
    await assert.rejects(session.open(), /model boundary/);
    return session as unknown as { mirrorMounts(): Promise<{ source: string; target: string }[]> };
  };
  // The repository the host never mirrored gets an empty mirror at the open, so the first command that clones it can
  // mount it; each only once the relay confirms the owner's access.
  const confirmed = await open("confirmed");
  assert.equal(await cache.filled(other, "test:alice"), false);
  assert.deepEqual(await confirmed.mirrorMounts(), mounts);
  assert.deepEqual(u.fetched.filter(path => path.includes("other")), [], "an empty mirror is only created, not filled");
  allowed = false;
  const refused = await open("refused");
  assert.deepEqual(await refused.mirrorMounts(), []);
  allowed = true;
  assert.deepEqual(await refused.mirrorMounts(), [], "a refusal ends borrowing for the rest of the open");
  // A rate limit or an outage only skips the step: the next one asks again.
  allowed = "busy";
  const busy = await open("busy");
  assert.deepEqual(await busy.mirrorMounts(), []);
  allowed = true;
  assert.equal((await busy.mirrorMounts()).length, 2);
  // A repository the workspace no longer binds stops being mounted at once.
  allowed = true;
  const removed = await open("removed");
  assert.equal((await removed.mirrorMounts()).length, 2);
  grant.repositories.length = 0;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.deepEqual(await removed.mirrorMounts(), []);
});

test("pistead cache lists and prunes a state directory's cache", async t => {
  const u = await upstream(t);
  const { cacheMain } = await import("../apps/runner/src/cache-cli.js");
  const state = join(u.directory, "state");
  await new RepositoryCache({ root: join(state, "repo-cache") }).refresh({ repository, ownerId: "test:alice", sessionId: "listed", remote: await u.cacheRemote() });
  const output: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => { output.push(chunk); return true; });
  await cacheMain(["list", "--state-dir", state]);
  assert.match(output.join(""), /MiB +1 sessions +0 pins +github\/github\.com\/1701\.git/);
  await cacheMain(["prune", "--older-than", "0", "--state-dir", state]);
  assert.match(output.at(-1)!, /forgot 1 clone session idle/);
  await assert.rejects(cacheMain(["prune", "--older-than", "soon", "--state-dir", state]), /whole number/);
});

test("a clone session's backup and restore carry its clones' local work, cloned again through the relay from the mirror", { skip: !sandboxed }, async t => {
  const u = await upstream(t);
  const { RunnerService } = await import("../apps/runner/src/server.js");
  const { sha256 } = await import("../packages/shared/src/crypto.js");
  const { randomUUID } = await import("node:crypto");
  const allow = async () => {};
  const ticket = async (sessionId: string, action: "create" | "backup" | "restore") => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: "runner" as const, sessionId, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1,
      iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
  };
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const config = (name: string, extra: Record<string, unknown> = {}) => ({ dataDir: join(u.directory, name), controlPlaneUrl: "https://control.example.test",
    sharedSecret: "s".repeat(32), allowFaux: true, authorize: async (request: { ownerId: string }) => ({ allowed: true, ownerId: request.ownerId, policyVersion: 1 }),
    repositoryCache: cache, cacheRemote: u.cacheRemote, egressGrant: async () => grant, gitRelay: async (_sessionId: string, request: RelayRequest) => u.relay(request), ...extra });
  const sourceService = new RunnerService(config("source"));
  t.after(() => sourceService.close());
  await sourceService.initialize();
  const source = await sourceService.provision(binding("move-source"), await ticket("move-source", "create"));
  const shell = (session: typeof source, command: string) => session.sandbox.execute({ kind: "bash", command }, false, allow, { allowTestShell: true });
  await shell(source, "git clone -q https://github.com/acme/app.git app && cd app && git switch -q -c feature && echo one > one.txt && git add one.txt"
    + " && git commit -q -m 'Local commit' && echo draft > draft.txt && echo notes > ../notes.txt");
  const backup = await source.backup(await ticket("move-source", "backup")) as { clones?: { path: string; branch: string }[]; files: { path: string }[] };
  assert.deepEqual(backup.clones?.map(clone => [clone.path, clone.branch]), [["app", "feature"]]);
  assert.ok(backup.files.some(file => file.path === "worktree/notes.txt"));
  assert.ok(!backup.files.some(file => file.path.startsWith("worktree/app/")));

  const text = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(text);
  const descriptor = { id: "clone-restore", sourceSessionId: "move-source", backupId: "clone-backup", sha256: await sha256(text), size: bytes.byteLength,
    downloadToken: "scoped-backup-capability" };
  const targetService = new RunnerService(config("target", { readBackup: async () => bytes }));
  t.after(() => targetService.close());
  await targetService.initialize();
  await targetService.restore({ binding: binding("move-target"), restore: descriptor }, await ticket("move-target", "restore"));
  const restored = await targetService.get("move-target");
  // The clone is cloned again in the background; the session's work waits for it.
  for (let attempt = 0; (await restored.view()).repositories && attempt < 300; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await restored.view()).repositories, undefined);
  assert.equal(await restored.sandbox.readFile("notes.txt", allow), "notes\n");
  assert.equal(await restored.sandbox.readFile("app/draft.txt", allow), "draft\n");
  assert.match(await shell(restored, "cd app && git rev-parse --abbrev-ref HEAD && git log --format=%s -1 && git status --porcelain"),
    /^feature\nLocal commit\n\?\? draft\.txt\n$/);
  // It borrowed from the host's mirror, which the host filled with its own credential: no pack ever went through the relay.
  assert.match(await restored.sandbox.readFile("app/.git/objects/info/alternates", allow), /^\/repository-mirrors\/github\/github\.com\/1701\.git\/objects\n$/);
  assert.deepEqual(await (restored.sandbox as Sandbox).clonePending(allow), []);
  assert.equal(u.relayedPack(), false);
});

test("a session's first clone waits for the host to fill its mirror, with the host's own credential, and nothing of it comes through the relay", { skip: !sandboxed }, async t => {
  const u = await upstream(t);
  const { RunnerService } = await import("../apps/runner/src/server.js");
  const { GitRemoteError } = await import("../apps/runner/src/git-remote.js");
  const allow = async () => {};
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const service = (name: string, cacheRemote: () => Promise<GitRemote>) => new RunnerService({ dataDir: join(u.directory, name),
    controlPlaneUrl: "https://control.example.test", sharedSecret: "s".repeat(32), allowFaux: true,
    authorize: async (request: { ownerId: string }) => ({ allowed: true, ownerId: request.ownerId, policyVersion: 1 }),
    repositoryCache: cache, cacheRemote, egressGrant: async () => grant, gitRelay: async (_sessionId: string, request: RelayRequest) => u.relay(request) });
  const provision = async (runner: InstanceType<typeof RunnerService>, id: string) => {
    const { sha256 } = await import("../packages/shared/src/crypto.js");
    const { randomUUID } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    return runner.provision(binding(id), { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action: "create", policyVersion: 1,
      iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") });
  };
  const shell = (session: Awaited<ReturnType<typeof provision>>, command: string) =>
    session.sandbox.execute({ kind: "bash", command }, false, allow, { allowTestShell: true });

  // A host that can't read the repository: the clone says why and goes ahead without the cache, through the relay.
  const refusing = service("refusing", async () => new GitRemote({ url: "https://github.com/acme/app.git", fetch: (async () => {
    throw new GitRemoteError("Git remote returned HTTP 404", 404);
  }) as typeof fetch }));
  t.after(() => refusing.close());
  await refusing.initialize();
  const alone = await provision(refusing, "uncached-clone");
  const output = await shell(alone, "git clone -q https://github.com/acme/app.git app");
  assert.match(output, /cannot fill its repository cache \(This host's Git credentials can't read acme\/app; its owner can set one up for github\.com/);
  assert.equal(await alone.sandbox.readFile("app/README.md", allow), "from upstream\n");
  await assert.rejects(alone.sandbox.readFile("app/.git/objects/info/alternates", allow));
  assert.equal(await cache.filled(repository, "test:alice"), false);

  // The first clone waits while the host fills the mirror (slowly here), and says so; then it borrows everything.
  u.relayed.length = 0;
  u.slow(3_500);
  const runner = service("cached", u.cacheRemote);
  t.after(() => runner.close());
  await runner.initialize();
  const session = await provision(runner, "first-clone");
  const waited = await shell(session, "git clone -q https://github.com/acme/app.git app");
  assert.match(waited, /waiting for the host to fill its repository cache of https:\/\/github\.com\/acme\/app\.git/);
  assert.match(waited, /repository cache: \w+/);
  assert.match(waited, /the repository cache is ready; cloning from it/);
  assert.equal(await cache.filled(repository, "test:alice"), true);
  assert.equal((await session.sandbox.readFile("app/.git/objects/info/alternates", allow)).trim(), "/repository-mirrors/github/github.com/1701.git/objects");
  assert.equal((await shell(session, "cd app && git count-objects -v | grep '^count\\|^in-pack'")).trim(), "count: 0\nin-pack: 0");
  assert.ok(u.fetched.some(path => path.endsWith("/git-upload-pack")), "the host fetched the repository itself");
  assert.equal(u.relayedPack(), false, "no pack went through the relay");
  // A filled mirror is borrowed straight away: no wait to tell of.
  u.slow(0);
  const again = await shell(session, "git clone -q https://github.com/acme/app.git copy");
  assert.doesNotMatch(again, /pistead:/);
  assert.equal((await session.sandbox.readFile("copy/.git/objects/info/alternates", allow)).trim(), "/repository-mirrors/github/github.com/1701.git/objects");
});

test("a clone asks again after a failure that may pass, and stops to be run again rather than downloading the repository without the cache", { skip: !sandboxed }, async t => {
  const u = await upstream(t);
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "earlier", remote: await u.cacheRemote() });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const target = "/repository-mirrors/github/github.com/1701.git";
  let unavailable = 1, asked = 0;
  const proxy = new EgressProxy({ socketPath: join(u.directory, "proxy.sock"), grant: async () => grant, relay: u.relay,
    mirror: async () => {
      asked++;
      if (unavailable-- > 0) throw new RunnerError(503, "Pistead could not confirm right now that this session's owner can read acme/app");
      return target;
    } });
  await proxy.start();
  t.after(() => proxy.close());
  const sandbox = new Sandbox(binding("transient"), join(u.directory, "session"), undefined, { egressSocket: proxy.socketPath,
    mirrors: async () => [{ source: cache.mirrorDirectory(repository, "test:alice"), target }] });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  // Unavailable once: asked again, then borrowed.
  await shell("git clone -q https://github.com/acme/app.git app");
  assert.equal(asked, 2);
  assert.equal((await sandbox.readFile("app/.git/objects/info/alternates", authorize)).trim(), `${target}/objects`);
  // Unavailable for good: after three tries the clone stops, to be run again, having downloaded nothing.
  unavailable = Infinity;
  u.relayed.length = 0;
  await assert.rejects(shell("git clone -q https://github.com/acme/app.git again"), (error: { stderr?: string }) =>
    /is not available right now \(Pistead could not confirm right now that this session's owner can read acme\/app\); run the clone again/.test(error.stderr ?? ""));
  assert.equal(asked, 5);
  assert.deepEqual(u.relayed, []);
  await assert.rejects(sandbox.readFile("again/README.md", authorize));
});

test("a session asks the relay again for its owner's refs after a failure that may pass; a refusal is final", async t => {
  const u = await upstream(t);
  const { RunnerSession } = await import("../apps/runner/src/session.js");
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  let hiccups = 0, refusing = false;
  const root = join(u.directory, "listing");
  const session = new RunnerSession(binding("listing"), root, { dataDir: root, controlPlaneUrl: "https://control.example.test", sharedSecret: "s".repeat(32),
    allowFaux: true, authorize: async request => ({ allowed: true, ownerId: request.ownerId, policyVersion: 1 }), repositoryCache: cache,
    cacheRemote: u.cacheRemote, egressGrant: async () => grant,
    gitRelay: async (_sessionId, request) => {
      if (refusing) throw new RunnerError(403, "No access");
      if (hiccups > 0) { hiccups--; throw new RunnerError(502, "The provider could not be reached"); }
      return u.relay(request);
    },
    resolveModels: async () => { throw new Error("model boundary"); } });
  t.after(() => session.sandbox.close());
  await assert.rejects(session.open(), /model boundary/);
  const mirror = (value: typeof repository) => (session as unknown as { mirror(value: typeof repository): Promise<string> }).mirror(value);
  // Two hiccups: the listing is asked again each time, then the mirror fills.
  hiccups = 2;
  assert.equal(await mirror(repository), "/repository-mirrors/github/github.com/1701.git");
  assert.equal(await cache.filled(repository, "test:alice"), true);
  // Still failing after its own attempts: the clone is told to ask again (503).
  hiccups = Infinity;
  await assert.rejects(mirror(repository), (error: unknown) => error instanceof RunnerError && error.status === 503 && /right now/.test(error.message));
  // A refusal is final (403): the clone goes ahead without the cache, and the relay refuses that too.
  hiccups = 0;
  refusing = true;
  await assert.rejects(mirror(repository), (error: unknown) => error instanceof RunnerError && error.status === 403);
});

test("a clone whose mirror its command can't see yet fails, to be run again, rather than downloading the repository", { skip: !sandboxed }, async t => {
  const u = await upstream(t);
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] };
  const proxy = new EgressProxy({ socketPath: join(u.directory, "proxy.sock"), grant: async () => grant, relay: u.relay,
    mirror: async () => "/repository-mirrors/github/github.com/1701.git" });
  await proxy.start();
  t.after(() => proxy.close());
  // Mounts are fixed when a command starts; this one's had none.
  const sandbox = new Sandbox(binding("unmounted"), join(u.directory, "session"), undefined, { egressSocket: proxy.socketPath, mirrors: async () => [] });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  await assert.rejects(sandbox.execute({ kind: "bash", command: "git clone -q https://github.com/acme/app.git app" }, false, authorize, { allowTestShell: true }),
    (error: { stderr?: string }) => /is ready, but this command started before it could see it; run the clone again/.test(error.stderr ?? ""));
  await assert.rejects(sandbox.readFile("app/README.md", authorize));
  assert.deepEqual(u.relayed, [], "nothing was downloaded");
});
