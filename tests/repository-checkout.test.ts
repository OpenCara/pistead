import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { RepositoryCache, checkoutBudget } from "../apps/runner/src/repo-cache.js";
import { Sandbox, repositoryObjectPaths, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import { repositoryLimits, type GitHubSessionRepository, type SessionRepository } from "../packages/shared/src/repositories.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
// Like repository-cache.test.ts: needs bwrap with user namespaces, Python and Git.
const linux = { skip: process.platform !== "linux" };
const authorize: SandboxAuthorize = async () => {};
const OWNER = "test:alice";
const ENV = { ...process.env, GIT_AUTHOR_NAME: "Upstream", GIT_AUTHOR_EMAIL: "upstream@example.test", GIT_COMMITTER_NAME: "Upstream",
  GIT_COMMITTER_EMAIL: "upstream@example.test", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const README = "hello\n";
const TOOL = "#!/bin/sh\necho tool\n";
const GUIDE = "guide\n";

function git(cwd: string, args: string[], input?: string | Buffer): string {
  const result = spawnSync("git", args, { cwd, input, env: ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function pinFor(commit: string, path = "acme/alpha"): GitHubSessionRepository {
  return { bindingId: `binding-${path.replace(/\W/g, "-")}`, repositoryId: 101, fullName: path, path, ref: "main", commit };
}

function binding(id: string, repositories: SessionRepository[], provider = "openai"): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: OWNER, agentVersionId: "version-1", title: "Cache checkout", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories },
    owner: { id: OWNER, githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: OWNER, workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "git_commit", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider, modelId: "local" },
  };
}

/** An upstream repository with history, an executable, in-repository symlinks and a submodule, cloned into a cache. */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pistead-checkout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "upstream");
  git(root, ["init", "-q", "-b", "main", work]);
  await writeFile(join(work, "README.md"), README);
  await mkdir(join(work, "bin"));
  await writeFile(join(work, "bin", "tool.sh"), TOOL);
  await chmod(join(work, "bin", "tool.sh"), 0o755);
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "first"]);
  const first = git(work, ["rev-parse", "HEAD"]);
  await mkdir(join(work, "docs"));
  await writeFile(join(work, "docs", "guide.md"), GUIDE);
  await symlink("README.md", join(work, "link"));
  await symlink("../README.md", join(work, "docs", "up"));
  git(work, ["add", "."]);
  git(work, ["update-index", "--add", "--cacheinfo", `160000,${first},vendor/lib`]);
  git(work, ["commit", "-q", "-m", "second"]);
  const commits = [first, git(work, ["rev-parse", "HEAD"])];
  const cache = new RepositoryCache({ root: join(root, "cache") });
  const pin = pinFor(commits[1]!);
  const directory = cache.directory(pin, OWNER);
  await mkdir(dirname(directory), { recursive: true });
  git(root, ["clone", "-q", "--bare", "--no-local", work, directory]);
  return { root, work, commits, cache, pin, directory, objects: cache.objects(pin, OWNER) };
}

/** Writes objects Git itself would refuse to create, straight into the cache repository. */
function object(directory: string, type: "blob" | "tree" | "commit", body: Buffer | string): string {
  const result = spawnSync("git", [`--git-dir=${directory}`, "hash-object", "-t", type, "--literally", "-w", "--stdin"], { input: body, env: ENV });
  if (result.status !== 0) throw new Error(`hash-object failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function tree(directory: string, entries: { mode: string; name: string | Buffer; oid: string }[]): string {
  return object(directory, "tree", Buffer.concat(entries.map(entry => Buffer.concat([
    Buffer.from(`${entry.mode} `), Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name), Buffer.from([0]), Buffer.from(entry.oid, "hex"),
  ]))));
}
function commitOf(directory: string, root: string): string {
  return git(directory, [`--git-dir=${directory}`, "commit-tree", root, "-m", "crafted"]);
}

test("inspection accepts a real tree and counts what its checkout writes against the session budget", hostMode, async t => {
  const f = await fixture(t);
  const summary = await f.cache.inspect(f.pin, OWNER, checkoutBudget());
  const bytes = [README, TOOL, GUIDE, "README.md", "../README.md"].reduce((total, text) => total + Buffer.byteLength(text), 0);
  assert.deepEqual(summary, { entries: 6, bytes, symlinks: 2, submodules: 1 });
  await assert.rejects(f.cache.inspect(f.pin, OWNER, { entries: 5, bytes }), /too many entries/);
  await assert.rejects(f.cache.inspect(f.pin, OWNER, { entries: 6, bytes: bytes - 1 }), /exceeds its size limit/);
  await assert.rejects(f.cache.inspect(pinFor("e".repeat(40)), OWNER, checkoutBudget()), /ls-tree failed/);
});

test("inspection refuses Git metadata, unsafe names and symlinks that leave their repository", hostMode, async t => {
  const f = await fixture(t);
  const blob = object(f.directory, "blob", "content\n");
  const config = tree(f.directory, [{ mode: "100644", name: "config", oid: blob }]);
  const link = (target: string) => object(f.directory, "blob", target);
  let deep = tree(f.directory, [{ mode: "100644", name: "file", oid: blob }]);
  for (let depth = 0; depth < 64; depth++) deep = tree(f.directory, [{ mode: "40000", name: "d", oid: deep }]);
  const cases: [string, { mode: string; name: string | Buffer; oid: string }[], RegExp][] = [
    [".git directory", [{ mode: "40000", name: ".git", oid: config }], /reserved Git metadata/],
    ["upper-case .GIT file", [{ mode: "100644", name: ".GIT", oid: blob }], /reserved Git metadata/],
    ["NTFS short name", [{ mode: "40000", name: "GIT~1", oid: config }], /reserved Git metadata/],
    ["trailing-dot .git", [{ mode: "40000", name: ".git.", oid: config }], /reserved Git metadata/],
    ["colon", [{ mode: "100644", name: "a:b", oid: blob }], /invalid path/],
    ["backslash", [{ mode: "100644", name: "a\\b", oid: blob }], /invalid path/],
    ["control character", [{ mode: "100644", name: "bad\nname", oid: blob }], /invalid path/],
    ["not UTF-8", [{ mode: "100644", name: Buffer.from([0x66, 0xff]), oid: blob }], /not UTF-8/],
    ["long component", [{ mode: "100644", name: "x".repeat(256), oid: blob }], /traversal or depth limit/],
    ["deep path", [{ mode: "40000", name: "d", oid: deep }], /path or depth limit|traversal or depth limit/],
    ["escaping symlink", [{ mode: "120000", name: "escape", oid: link("../outside") }], /escapes its repository/],
    ["symlink to the repository root", [{ mode: "120000", name: "self", oid: link(".") }], /escapes its repository/],
    ["absolute symlink", [{ mode: "120000", name: "passwd", oid: link("/etc/passwd") }], /must be a relative path/],
    ["symlink into Git metadata", [{ mode: "120000", name: "meta", oid: link(".git/config") }], /points into Git metadata/],
  ];
  for (const [name, entries, reason] of cases) {
    await t.test(name, async () => {
      const commit = commitOf(f.directory, tree(f.directory, entries));
      await assert.rejects(f.cache.inspect(pinFor(commit), OWNER, checkoutBudget()), reason);
    });
  }
  // A symlink to a directory inside its repository is fine: file tools resolve it and stay in the worktree.
  const ok = commitOf(f.directory, tree(f.directory, [{ mode: "40000", name: "dir", oid: config }, { mode: "120000", name: "to-dir", oid: link("dir") }]));
  assert.equal((await f.cache.inspect(pinFor(ok), OWNER, checkoutBudget())).symlinks, 1);
});

test("cache object paths must match the pins and stay outside the session's storage", () => {
  const alpha = pinFor("a".repeat(40), "acme/alpha"), beta = pinFor("b".repeat(40), "acme/beta");
  const storage = "/data/sessions/one";
  assert.deepEqual(repositoryObjectPaths([alpha, beta], undefined, storage), []);
  assert.deepEqual(repositoryObjectPaths([alpha, beta], { "acme/beta": "/cache/b/objects", "acme/alpha": "/cache/a/objects" }, storage),
    ["/cache/a/objects", "/cache/b/objects"]);
  // Annotated: inferred from these literals, the missing keys would become optional undefined, which no Record accepts.
  const invalid: Readonly<Record<string, string>>[] = [
    { "acme/alpha": "/cache/a/objects" },
    { "acme/alpha": "/cache/a/objects", "acme/beta": "/cache/b/objects", "acme/gamma": "/cache/c/objects" },
    { "acme/alpha": "cache/a/objects", "acme/beta": "/cache/b/objects" },
    { "acme/alpha": "/cache/../a/objects", "acme/beta": "/cache/b/objects" },
    { "acme/alpha": "/cache/a\n/objects", "acme/beta": "/cache/b/objects" },
    { "acme/alpha": "/cache/a:b/objects", "acme/beta": "/cache/b/objects" },
    { "acme/alpha": `${storage}/worktree`, "acme/beta": "/cache/b/objects" },
    { "acme/alpha": "/data/sessions", "acme/beta": "/cache/b/objects" },
    { "acme/alpha": "/", "acme/beta": "/cache/b/objects" },
  ];
  for (const objects of invalid) assert.throws(() => repositoryObjectPaths([alpha, beta], objects, storage), JSON.stringify(objects));
});

test("host mode checks pinned trees out of the cache with real symlinks and full history, copying no cached object", hostMode, async t => {
  const f = await fixture(t);
  await f.cache.inspect(f.pin, OWNER, checkoutBudget());
  const root = join(f.root, "session");
  const workspace = new HostWorkspace(binding("cache-session", [f.pin]), root, { repositoryObjects: { [f.pin.path]: f.objects } });
  t.after(() => workspace.close());
  await workspace.initialize();
  assert.equal(await workspace.repositoryCacheState([f.pin], authorize), "absent");
  await assert.rejects(workspace.materializeFromCache([f.pin], authorize), /not mounted/, "the cache is used only once the session enables it");
  workspace.enableRepositoryCache();
  await workspace.materializeFromCache([f.pin], authorize);
  assert.equal(await workspace.repositoryCacheState([f.pin], authorize), "cache");
  assert.equal(await workspace.gitStatus(authorize), "");
  const work = join(root, "worktree");
  const repository = join(work, "acme", "alpha");
  assert.equal(await workspace.readFile("acme/alpha/README.md", authorize), README);
  assert.equal(await readlink(join(repository, "link")), "README.md");
  assert.equal(await readlink(join(repository, "docs", "up")), "../README.md");
  assert.equal(await workspace.readFile("acme/alpha/docs/up", authorize), README, "file tools follow in-repository symlinks");
  assert.ok((await lstat(join(repository, "bin", "tool.sh"))).mode & 0o100);
  assert.deepEqual(await readdir(join(repository, "vendor", "lib")), [], "submodules check out as empty directories");
  assert.equal(await readFile(join(work, ".git", "objects", "info", "alternates"), "utf8"), `${f.objects}\n`);
  const marker = JSON.parse(await readFile(join(work, ".git", "repository-cache.json"), "utf8"));
  assert.deepEqual({ ...marker, baseline: undefined }, { version: 2, source: "cache", repositories: [f.pin], status: "ready", baseline: undefined });
  const shell = async (command: string) => (await workspace.execute({ kind: "bash", command }, false, authorize)).trim();
  assert.equal(await shell("git rev-parse HEAD"), marker.baseline);
  assert.equal(await shell("git rev-list --count HEAD"), "1");
  assert.equal(await shell("git log -1 --format='%an|%ae'"), "Alice Owner|alice@example.test");
  // The pinned commit and its whole history come from the cache, named by refs/remotes/<path>/pinned.
  assert.equal(await shell("git rev-parse acme/alpha/pinned"), f.pin.commit);
  assert.equal(await shell("git rev-list --count acme/alpha/pinned"), "2");
  assert.equal((await shell(`git blame --porcelain ${f.pin.commit} -- README.md`)).slice(0, 40), f.commits[0]);
  const loose = () => shell("git count-objects -v | sed -n 's/^\\(count\\|in-pack\\): //p' | paste -sd' '");
  // Only the two directory trees above the pin and the baseline commit are new; nothing is copied from the cache.
  assert.equal(await loose(), "3 0");
  await workspace.writeFile("acme/alpha/README.md", "changed\n", authorize);
  await workspace.execute({ kind: "git.commit", message: "Owner change" }, false, authorize);
  assert.equal(await workspace.gitStatus(authorize), "");
  // An owner commit writes its blob and the changed trees only.
  assert.equal(await loose(), "8 0");
  // Running the checkout again never touches a ready session.
  await workspace.materializeFromCache([f.pin], authorize);
  assert.equal(await workspace.readFile("acme/alpha/README.md", authorize), "changed\n");
  // Its objects live in the cache, so a snapshot of it would not restore.
  await assert.rejects(workspace.snapshot(authorize), /backups of sessions checked out from the host repository cache are not supported yet/);
});

test("a cache-backed session refuses cache paths other than the ones it was checked out with", hostMode, async t => {
  const f = await fixture(t);
  const root = join(f.root, "session");
  const first = new HostWorkspace(binding("cache-session", [f.pin]), root, { repositoryObjects: { [f.pin.path]: f.objects } });
  await first.initialize();
  first.enableRepositoryCache();
  await first.materializeFromCache([f.pin], authorize);
  await first.close();
  for (const [options, reason] of [
    [{ repositoryObjects: { [f.pin.path]: join(f.root, "elsewhere", "objects") } }, /mounts do not match this session/],
    [{}, /needs the host repository cache; its connector must run with --repo-cache/],
  ] as const) {
    const reopened = new HostWorkspace(binding("cache-session", [f.pin]), root, options);
    t.after(() => reopened.close());
    await reopened.initialize();
    await assert.rejects(reopened.repositoryCacheState([f.pin], authorize), reason);
    await assert.rejects(reopened.readFile("acme/alpha/README.md", authorize), reason);
  }
  const unconfigured = new HostWorkspace(binding("other-session", [f.pin]), join(f.root, "other"));
  t.after(() => unconfigured.close());
  await unconfigured.initialize();
  await assert.rejects(unconfigured.materializeFromCache([f.pin], authorize), /not configured/);
});

test("a pinned commit missing from the cache fails before anything is written", hostMode, async t => {
  const f = await fixture(t);
  const pin = pinFor("e".repeat(40));
  const root = join(f.root, "session");
  const workspace = new HostWorkspace(binding("missing", [pin]), root, { repositoryObjects: { [pin.path]: f.objects } });
  t.after(() => workspace.close());
  await workspace.initialize();
  workspace.enableRepositoryCache();
  await assert.rejects(workspace.materializeFromCache([pin], authorize), /missing from the repository cache/);
  assert.deepEqual(await readdir(join(root, "worktree")), [".git"]);
  await assert.rejects(lstat(join(root, "worktree", ".git", "repository-cache.json")), { code: "ENOENT" });
  assert.equal(await workspace.repositoryCacheState([pin], authorize), "absent");
});

/** Runs the production sandbox helper's Python definitions directly, like the durability probes in repository-cache.test.ts. */
async function helper(t: TestContext, root: string, script: string, input: unknown): Promise<Record<string, unknown>> {
  const source = await readFile(new URL("../apps/runner/src/sandbox.ts", import.meta.url), "utf8");
  const match = /const HELPER = String.raw`([\s\S]*?)`;/u.exec(source);
  assert.ok(match, "production helper must be present");
  const code = match[1]!.replace("${JSON.stringify(repositoryLimits)}", JSON.stringify(repositoryLimits));
  const work = join(root, "worktree");
  await mkdir(work, { recursive: true });
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", code.slice(0, code.lastIndexOf("\ntry:\n    main()")) + "\n" + script], {
    encoding: "utf8", timeout: 60_000, input: JSON.stringify(input),
    env: { PATH: "/usr/bin:/bin", HOME: root, SANDBOX_WORKTREE: work, GIT_AUTHOR_NAME: "Alice Owner", GIT_AUTHOR_EMAIL: "alice@example.test",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  t.diagnostic(result.stderr.trim());
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const checkoutScript = String.raw`
request = json.load(sys.stdin)
run(GIT + ['init', '--quiet', '--template=', '--initial-branch=main', WORK])
work = os.open(WORK, DIR_FLAGS)
git = os.open('.git', DIR_FLAGS, dir_fd=work)
result = {}
try:
    materialize_from_cache(work, git, request['repositories'], request['alternates'])
    result['state'] = cache_ready(work, git, request['repositories'], request['alternates'])
    materialize_from_cache(work, git, request['repositories'], request['alternates'])
    for name, alternates in (('moved', ['/elsewhere/objects']), ('unmounted', [])):
        try:
            cache_ready(work, git, request['repositories'], alternates)
            result[name] = 'accepted'
        except ValueError as error:
            result[name] = str(error)
except ValueError as error:
    result['error'] = str(error)
result['entries'] = sorted(os.listdir(WORK))
print(json.dumps(result))
`;

test("the sandbox helper checks pinned trees out of read-only cache mounts with the same guarantees", { skip: process.platform !== "linux" || hostMode.skip }, async t => {
  const f = await fixture(t);
  const root = join(f.root, "helper");
  const result = await helper(t, root, checkoutScript, { repositories: [f.pin], alternates: [f.objects] });
  assert.deepEqual({ state: result.state, moved: result.moved, unmounted: result.unmounted, error: result.error },
    { state: "cache", moved: "repository cache mounts do not match this session",
      unmounted: "this session needs the host repository cache; its connector must run with --repo-cache", error: undefined });
  const work = join(root, "worktree");
  assert.equal(await readlink(join(work, "acme", "alpha", "link")), "README.md");
  assert.equal(await readFile(join(work, "acme", "alpha", "README.md"), "utf8"), README);
  assert.deepEqual(await readdir(join(work, "acme", "alpha", "vendor", "lib")), []);
  assert.equal(git(work, ["status", "--porcelain"]), "");
  assert.equal(git(work, ["rev-list", "--count", "refs/remotes/acme/alpha/pinned"]), "2");
  assert.equal(git(work, ["count-objects", "-v"]).split("\n").find(line => line.startsWith("in-pack:")), "in-pack: 0");
  const marker = JSON.parse(await readFile(join(work, ".git", "repository-cache.json"), "utf8"));
  assert.equal(marker.version, 2);
  assert.equal(marker.status, "ready");
  assert.equal(git(work, ["rev-parse", "HEAD"]), marker.baseline);
});

test("the sandbox helper refuses mounts inside the session and missing commits before writing anything", { skip: process.platform !== "linux" || hostMode.skip }, async t => {
  const f = await fixture(t);
  const inside = await helper(t, join(f.root, "inside"), checkoutScript, { repositories: [f.pin], alternates: [join(f.root, "inside", "worktree", "objects")] });
  assert.equal(inside.error, "invalid repository cache mount");
  assert.deepEqual(inside.entries, [".git"]);
  const missing = await helper(t, join(f.root, "missing"), checkoutScript, { repositories: [pinFor("e".repeat(40))], alternates: [f.objects] });
  assert.equal(missing.error, "pinned commit is missing from the repository cache");
  assert.deepEqual(missing.entries, [".git"]);
  await assert.rejects(lstat(join(f.root, "missing", "worktree", ".git", "repository-cache.json")), { code: "ENOENT" });
});

test("the Linux sandbox mounts the cache read-only for every process and checks pinned trees out of it", linux, async t => {
  const f = await fixture(t);
  const sandbox = new Sandbox(binding("sandbox-cache", [f.pin], "faux"), join(f.root, "sandbox"), undefined, { repositoryObjects: { [f.pin.path]: f.objects } });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = (command: string, readOnly = true) => sandbox.execute({ kind: "bash", command }, readOnly, authorize, { allowTestShell: true });
  // Configured but not enabled, as for an archive-backed session on a cache host: the cache is not there at all.
  assert.equal((await shell("test -e /repository-cache/0 && echo visible || echo hidden")).trim(), "hidden");
  await assert.rejects(sandbox.materializeFromCache([f.pin], authorize), /not mounted/);
  sandbox.enableRepositoryCache();
  await sandbox.materializeFromCache([f.pin], authorize);
  assert.equal(await sandbox.repositoryCacheState([f.pin], authorize), "cache");
  assert.equal(await sandbox.gitStatus(authorize), "");
  assert.equal(await sandbox.readFile("acme/alpha/docs/up", authorize), README);
  assert.equal((await shell("git rev-list --count acme/alpha/pinned")).trim(), "2");
  assert.equal((await shell("cat .git/objects/info/alternates")).trim(), "/repository-cache/0");
  await assert.rejects(shell("touch /repository-cache/0/written", false));
  await sandbox.writeFile("acme/alpha/README.md", "changed\n", authorize);
  await sandbox.execute({ kind: "git.commit", message: "Owner change" }, false, authorize);
  assert.equal(await sandbox.gitStatus(authorize), "");
  assert.equal((await shell("git rev-list --count HEAD")).trim(), "2");
  await assert.rejects(sandbox.snapshot(authorize), /not supported yet/);
});

test("the sandbox helper refuses to snapshot a session checked out from the cache", { skip: process.platform !== "linux" || hostMode.skip }, async t => {
  const f = await fixture(t);
  const root = join(f.root, "helper");
  assert.equal((await helper(t, root, checkoutScript, { repositories: [f.pin], alternates: [f.objects] })).state, "cache");
  const handled = await helper(t, root, String.raw`
try:
    main()
    print(json.dumps({'error': None}))
except ValueError as error:
    print(json.dumps({'error': str(error)}))
`, { kind: "snapshot", expectedRepositories: [f.pin], repositoryAlternates: [f.objects] });
  assert.equal(handled.error, "backups of sessions checked out from the host repository cache are not supported yet");
});
