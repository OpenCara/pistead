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
const environment = { ...process.env, GIT_AUTHOR_NAME: "U", GIT_AUTHOR_EMAIL: "u@example.test", GIT_COMMITTER_NAME: "U", GIT_COMMITTER_EMAIL: "u@example.test" };

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** An upstream repository served by git http-backend, standing in for the control plane's relay to GitHub. */
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
  return { directory, work, bare, relay, relayed, remote };
}

test("a mirror is filled through the relay, keeps each session's branch tips, and prune drops idle sessions", async t => {
  const u = await upstream(t);
  const cache = new RepositoryCache({ root: join(u.directory, "cache"), authorization: async () => assert.fail("mirrors never use host credentials") });
  const first = await cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-1", remote: u.remote() });
  assert.equal(first.fetched, true);
  assert.equal(first.directory, cache.mirrorDirectory(repository, "test:alice"));
  const head = git(["rev-parse", "main"], u.work);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", "refs/upstream/heads/main"], u.directory), head);
  assert.ok(u.relayed.some(request => request.service === "info-refs") && u.relayed.some(request => request.service === "upload-pack"));
  assert.ok(u.relayed.every(request => request.bindingId === "binding-app"));
  const keep = git(["--git-dir", first.directory, "for-each-ref", "--format=%(refname)", "refs/pistead/sessions/"], u.directory).split("\n");
  assert.equal(keep.length, 1);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^1`], u.directory), head);
  // A later refresh keeps what the session saw before: the new keep commit's first parent is the previous one.
  const before = git(["--git-dir", first.directory, "rev-parse", keep[0]!], u.directory);
  await writeFile(join(u.work, "NEXT.md"), "next\n");
  git(["add", "NEXT.md"], u.work);
  git(["commit", "-q", "-m", "next"], u.work);
  git(["push", "-q", "--force", u.bare, "main"], u.work);
  assert.equal((await cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-1", remote: u.remote() })).fetched, true);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^1`], u.directory), before);
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^2`], u.directory), git(["rev-parse", "main"], u.work));
  // Touching moves the keep ref on without fetching.
  await cache.touch(repository, "test:alice", "session-1");
  assert.equal(git(["--git-dir", first.directory, "rev-parse", `${keep[0]}^1^1`], u.directory), before);
  // Nothing new upstream: nothing is fetched again.
  u.relayed.length = 0;
  assert.equal((await cache.refresh({ repository, ownerId: "test:alice", sessionId: "session-2", remote: u.remote() })).fetched, false);
  const listed = await cache.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.sessions, 2);
  assert.ok(listed[0]!.bytes > 0);
  // A relay refusal fails the refresh.
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
  const get = (socketPath: string, remote: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ socketPath, path: `/__pistead/mirror?remote=${encodeURIComponent(remote)}` }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end();
  });
  const cached = await start("cached", async value => { mirrored.push(value.bindingId); return "/repository-mirrors/github/github.com/1701.git"; });
  const ok = await get(cached.socketPath, "git@github.com:acme/app.git");
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { path: "/repository-mirrors/github/github.com/1701.git" });
  assert.deepEqual(mirrored, ["binding-app"]);
  assert.equal((await get(cached.socketPath, "https://github.com/acme/other.git")).status, 404);
  const uncached = await start("uncached");
  assert.equal((await get(uncached.socketPath, "https://github.com/acme/app.git")).status, 404);
  const failing = await start("failing", async () => { throw new Error("Git remote returned HTTP 403"); });
  const failed = await get(failing.socketPath, "https://github.com/acme/app.git");
  assert.equal(failed.status, 502);
  assert.match(failed.body, /403/);
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
      await cache.refresh({ repository: value as typeof repository, ownerId: "test:alice", sessionId: "mirror", remote: u.remote() });
      return target;
    },
  });
  await proxy.start();
  t.after(() => proxy.close());
  // The mirror exists from an earlier session and this one may use it, as after a reopen.
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "earlier", remote: u.remote() });
  mounts.push({ source: cache.mirrorDirectory(repository, "test:alice"), target });
  const sandbox = new Sandbox(binding("mirror"), join(u.directory, "session"), undefined, { egressSocket: proxy.socketPath, mirrors: async () => mounts });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const authorize = async () => {};
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize, { allowTestShell: true });
  await shell("git clone -q https://github.com/acme/app.git app");
  assert.equal(await sandbox.readFile("app/README.md", authorize), "from upstream\n");
  assert.equal((await sandbox.readFile("app/.git/objects/info/alternates", authorize)).trim(), `${target}/objects`);
  // The clone holds none of the mirror's objects itself, and reads them fine.
  assert.equal((await shell("cd app && git count-objects -v | grep '^count\\|^in-pack'")).trim(), "count: 0\nin-pack: 0");
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

test("a reopened clone session mounts an existing mirror only once the relay confirms the owner's access", async t => {
  const u = await upstream(t);
  const { RunnerSession } = await import("../apps/runner/src/session.js");
  const { RunnerError } = await import("../apps/runner/src/protocol.js");
  const cache = new RepositoryCache({ root: join(u.directory, "cache") });
  await cache.refresh({ repository, ownerId: "test:alice", sessionId: "earlier", remote: u.remote() });
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository, { ...repository, bindingId: "binding-other", repositoryId: "1702", fullName: "acme/other" }] };
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
  // Only the repository whose mirror exists, and only once the relay confirms the owner's access.
  const confirmed = await open("confirmed");
  assert.deepEqual(await confirmed.mirrorMounts(), [{ source: cache.mirrorDirectory(repository, "test:alice"), target: "/repository-mirrors/github/github.com/1701.git" }]);
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
  assert.equal((await busy.mirrorMounts()).length, 1);
  // A repository the workspace no longer binds stops being mounted at once.
  allowed = true;
  const removed = await open("removed");
  assert.equal((await removed.mirrorMounts()).length, 1);
  grant.repositories.length = 0;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.deepEqual(await removed.mirrorMounts(), []);
});

test("pistead cache lists and prunes a state directory's cache", async t => {
  const u = await upstream(t);
  const { cacheMain } = await import("../apps/runner/src/cache-cli.js");
  const state = join(u.directory, "state");
  await new RepositoryCache({ root: join(state, "repo-cache") }).refresh({ repository, ownerId: "test:alice", sessionId: "listed", remote: u.remote() });
  const output: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => { output.push(chunk); return true; });
  await cacheMain(["list", "--state-dir", state]);
  assert.match(output.join(""), /MiB +1 sessions +0 pins +github\/github\.com\/1701\.git/);
  await cacheMain(["prune", "--older-than", "0", "--state-dir", state]);
  assert.match(output.at(-1)!, /forgot 1 clone session idle/);
  await assert.rejects(cacheMain(["prune", "--older-than", "soon", "--state-dir", state]), /whole number/);
});
