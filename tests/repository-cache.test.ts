import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Sandbox, type SandboxAuthorize, type SnapshotFile } from "../apps/runner/src/sandbox.js";
import { repositoryLimits, type SessionRepository } from "../packages/shared/src/repositories.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

// Like runner.test.ts, Linux requires real bwrap FD mounts/user namespaces, Python and Git.
// The explicit faux shell exercises those mounts; it does not bypass the sandbox.
const linux = { skip: process.platform !== "linux" };
const authorize: SandboxAuthorize = async () => {};
const alpha: SessionRepository = {
  bindingId: "binding-alpha", repositoryId: 101, fullName: "acme/alpha", path: "acme/alpha",
  ref: "main", commit: "a".repeat(40),
};
const beta: SessionRepository = {
  bindingId: "binding-beta", repositoryId: 202, fullName: "acme/beta", path: "acme/beta",
  ref: "release/v1", commit: "b".repeat(40),
};
const gamma: SessionRepository = {
  bindingId: "binding-gamma", repositoryId: 303, fullName: "other/gamma", path: "other/gamma",
  ref: "v2", commit: "c".repeat(40),
};
const markerPath = ".git/repository-cache.json";
const binary = Buffer.from([0, 255, 128, 10, 13, 65]);

type TarEntry = {
  name: string;
  body?: string | Buffer;
  type?: string;
  mode?: number;
  prefix?: string;
  linkname?: string;
  size?: number;
};

function tarString(header: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length <= width, `tar fixture field is too long: ${value}`);
  bytes.copy(header, offset);
}

function tarOctal(header: Buffer, offset: number, width: number, value: number): void {
  tarString(header, offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`);
}

function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  const sum = header.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  tarString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
}

// All archive bytes, including malformed headers and PAX records, are built here.
function tar(entries: readonly TarEntry[], terminators = 2): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    tarString(header, 0, 100, entry.name);
    tarOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, entry.size ?? body.length);
    tarOctal(header, 136, 12, 0);
    tarString(header, 156, 1, entry.type ?? "0");
    tarString(header, 157, 100, entry.linkname ?? "");
    tarString(header, 257, 6, "ustar\0");
    tarString(header, 263, 2, "00");
    tarString(header, 345, 155, entry.prefix ?? "");
    checksum(header);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(512 * terminators));
  return Buffer.concat(chunks);
}

function pax(fields: readonly (readonly [string, string])[]): Buffer {
  return Buffer.concat(fields.map(([key, value]) => {
    const suffix = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(suffix) + 1;
    while (String(length).length + Buffer.byteLength(suffix) !== length) {
      length = String(length).length + Buffer.byteLength(suffix);
    }
    return Buffer.from(`${length}${suffix}`);
  }));
}

function archive(label: string): Buffer {
  return gzipSync(tar([
    { name: "github-checkout/", type: "5" },
    { name: "github-checkout/README.md", body: `${label}\n` },
    { name: "github-checkout/delete-me.txt", body: "delete this file\n" },
    { name: "github-checkout/bin/tool.sh", body: "#!/bin/sh\nprintf tool\\n\n", mode: 0o755 },
    { name: "github-checkout/bytes.bin", body: binary },
    { name: "github-checkout/.gitignore", body: "ignored.txt\n" },
    { name: "github-checkout/ignored.txt", body: "still part of the pinned baseline\n" },
    { name: "github-checkout/.github/workflows/check.yml", body: "name: check\n" },
  ]));
}

const validArchives = [archive("alpha"), archive("beta")];

function binding(id: string, repositories: readonly SessionRepository[] = [alpha, beta]): RunnerBinding {
  return {
    session: {
      id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1",
      title: "Repository cache test", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z",
      repositories: structuredClone([...repositories]),
    },
    owner: {
      id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice",
      gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false,
    },
    agent: {
      id: "version-1", agentId: "agent", authorId: "test:template-author", workspaceId: "workspace",
      version: 1, name: "Repository agent", description: "Test", instructions: "Use tools.",
      tools: ["read_file", "write_file", "git_status", "git_commit", "bash"], modelId: "model-1",
      createdAt: "2026-01-01T00:00:00Z",
    },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "cache-faux" },
  };
}

interface Fixture {
  directory: string;
  root: string;
  sandbox: Sandbox;
  binding: RunnerBinding;
  repositories: SessionRepository[];
  open: (binding: RunnerBinding, root: string) => Sandbox;
}

async function fixture(t: TestContext, repositories: readonly SessionRepository[] = [alpha, beta]): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "repository-cache-"));
  await chmod(directory, 0o700);
  const sandboxes: Sandbox[] = [];
  t.after(async () => {
    await Promise.all(sandboxes.map(sandbox => sandbox.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const open = (owner: RunnerBinding, root: string) => {
    const sandbox = new Sandbox(owner, root);
    sandboxes.push(sandbox);
    return sandbox;
  };
  const owner = binding("source", repositories);
  const root = join(directory, "source");
  const sandbox = open(owner, root);
  await sandbox.initialize();
  return { directory, root, sandbox, binding: owner, repositories: owner.session.repositories!, open };
}

type CacheMarker = { version: number; status: string; repositories: SessionRepository[]; baseline: string };

async function marker(sandbox: Sandbox): Promise<CacheMarker> {
  return JSON.parse(await sandbox.readFile(markerPath, authorize)) as CacheMarker;
}

function shell(sandbox: Sandbox, command: string, readOnly = true, auth = authorize): Promise<string> {
  return sandbox.execute({ kind: "bash", command }, readOnly, auth, { allowTestShell: true });
}

async function absent(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function pristine(f: Fixture): Promise<void> {
  assert.deepEqual(await readdir(join(f.root, "worktree")), [".git"], "no repository or staging output may escape validation");
  await absent(join(f.root, "git", "repository-cache.json"));
  await absent(join(f.root, "git", "refs", "heads", "main"));
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), false);
}

async function recover(f: Fixture): Promise<void> {
  await f.sandbox.materializeRepositories(f.repositories, validArchives, authorize);
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
  assert.equal(await f.sandbox.readFile("acme/alpha/README.md", authorize), "alpha\n");
  assert.equal(await f.sandbox.readFile("acme/beta/README.md", authorize), "beta\n");
  assert.equal(await f.sandbox.gitStatus(authorize), "");
}

async function rejectArchive(t: TestContext, bad: Uint8Array, reason?: RegExp): Promise<void> {
  const f = await fixture(t);
  // Exercise both positions: a valid first repository must never be published
  // before the second archive has been validated in its entirety.
  for (const archives of [[bad, validArchives[1]!], [validArchives[0]!, bad]]) {
    if (reason) await assert.rejects(f.sandbox.materializeRepositories(f.repositories, archives, authorize), reason);
    else await assert.rejects(f.sandbox.materializeRepositories(f.repositories, archives, authorize));
    await pristine(f);
  }
  await recover(f);
}

async function hostTree(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await lstat(path);
    const content = info.isSymbolicLink() ? await readlink(path)
      : info.isDirectory() ? await hostTree(path) : (await readFile(path)).toString("base64");
    entries.push({ name, mode: info.mode, ino: info.ino, nlink: info.nlink, content });
  }
  return entries;
}

async function writeTrustedSnapshot(root: string, files: readonly SnapshotFile[]): Promise<void> {
  // Only round-trip the trusted public snapshot, not arbitrary backup input.
  for (const file of files) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.from(file.data, "base64"), { mode: file.mode, flag: "wx" });
  }
}

test("repository archives create one clean multi-repo Git baseline with the session owner's identity", linux, async t => {
  const f = await fixture(t, [gamma, beta, alpha]);
  await pristine(f);
  await f.sandbox.materializeRepositories([beta, alpha, gamma], [archive("beta"), archive("alpha"), archive("gamma")], authorize);
  assert.equal(await f.sandbox.repositoryCachesReady([alpha, gamma, beta], authorize), true);
  assert.equal(await f.sandbox.gitStatus(authorize), "");
  assert.deepEqual(await f.sandbox.listFiles(".", authorize), [".git", "acme", "other"]);
  assert.deepEqual(await f.sandbox.listFiles("acme", authorize), ["alpha", "beta"]);
  for (const pin of [alpha, beta, gamma]) {
    assert.equal(await f.sandbox.readFile(`${pin.path}/README.md`, authorize), `${pin.fullName.split("/")[1]}\n`);
    await absent(join(f.root, "worktree", pin.path, "github-checkout"));
    await absent(join(f.root, "worktree", pin.path, ".git"));
    assert.deepEqual(await readFile(join(f.root, "worktree", pin.path, "bytes.bin")), binary);
    assert.equal(await shell(f.sandbox, `test -x ${pin.path}/bin/tool.sh && test ! -x ${pin.path}/README.md`), "");
  }
  const ready = await marker(f.sandbox);
  assert.equal(ready.version, 1);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.repositories, [alpha, beta, gamma]);
  assert.match(ready.baseline, /^[a-f0-9]{40}$/);
  assert.equal((await shell(f.sandbox, "git rev-parse HEAD")).trim(), ready.baseline);
  assert.equal((await shell(f.sandbox, "git rev-list --count HEAD")).trim(), "1");
  assert.equal((await shell(f.sandbox, "git log -1 --format='%an|%ae|%cn|%ce'")).trim(),
    "Alice Owner|alice@example.test|Alice Owner|alice@example.test");
  assert.equal((await shell(f.sandbox, "git config user.name")).trim(), f.binding.owner.gitName);
  assert.equal((await shell(f.sandbox, "git config user.email")).trim(), f.binding.owner.gitEmail);
  const tracked = (await shell(f.sandbox, "git ls-files")).trim().split("\n");
  const names = [".github/workflows/check.yml", ".gitignore", "README.md", "bin/tool.sh", "bytes.bin", "delete-me.txt", "ignored.txt"];
  assert.deepEqual(tracked, [alpha, beta, gamma].flatMap(pin => names.map(name => `${pin.path}/${name}`)).sort());
});

test("repository caches are private per session even for the same owner and immutable pins", linux, async t => {
  const f = await fixture(t);
  await recover(f);
  const secondRoot = join(f.directory, "second");
  const second = f.open(binding("second"), secondRoot);
  await second.initialize();
  assert.notEqual(second.worktree, f.sandbox.worktree);
  assert.equal(await second.repositoryCachesReady(f.repositories, authorize), false);
  await second.materializeRepositories(f.repositories, validArchives, authorize);
  for (const root of [f.root, secondRoot]) {
    for (const directory of [root, join(root, "home"), join(root, "git"), join(root, "worktree", alpha.path)]) {
      assert.equal((await lstat(directory)).mode & 0o077, 0);
    }
    const info = await lstat(join(root, "worktree", alpha.path, "README.md"));
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o077, 0);
  }
  const left = await lstat(join(f.root, "worktree", alpha.path, "README.md"));
  const right = await lstat(join(secondRoot, "worktree", alpha.path, "README.md"));
  assert.notDeepEqual([left.dev, left.ino], [right.dev, right.ino]);
  await f.sandbox.writeFile(`${alpha.path}/README.md`, "only source changed", authorize);
  await shell(f.sandbox, `rm -- ${alpha.path}/delete-me.txt`, false);
  assert.equal(await second.readFile(`${alpha.path}/README.md`, authorize), "alpha\n");
  assert.equal(await second.readFile(`${alpha.path}/delete-me.txt`, authorize), "delete this file\n");
  assert.equal(await second.gitStatus(authorize), "");
  await assert.rejects(shell(f.sandbox, `cat ${second.worktree}/${alpha.path}/README.md`));
  await assert.rejects(shell(second, `cat ${f.sandbox.worktree}/${alpha.path}/README.md`));
});

test("reopen and repeated materialization preserve edits, deletions and baseline ancestry after an owner commit", linux, async t => {
  const f = await fixture(t);
  await recover(f);
  const original = await marker(f.sandbox);
  await f.sandbox.writeFile(`${alpha.path}/README.md`, "owner's committed edit\n", authorize);
  await shell(f.sandbox, `rm -- ${alpha.path}/delete-me.txt`, false);
  await f.sandbox.execute({ kind: "git.commit", message: "Owner changes" }, false, authorize);
  const head = (await shell(f.sandbox, "git rev-parse HEAD")).trim();
  assert.notEqual(head, original.baseline);
  assert.equal(await shell(f.sandbox, `git merge-base --is-ancestor ${original.baseline} HEAD`), "");
  await f.sandbox.writeFile(`${beta.path}/README.md`, "uncommitted edit\n", authorize);
  await f.sandbox.writeFile(`${alpha.path}/new.txt`, "untracked owner file\n", authorize);
  await shell(f.sandbox, `rm -- ${beta.path}/delete-me.txt`, false);
  const status = await f.sandbox.gitStatus(authorize);
  assert.match(status, /M acme\/beta\/README\.md/);
  assert.match(status, /D acme\/beta\/delete-me\.txt/);
  assert.match(status, /\?\? acme\/alpha\/new\.txt/);
  const unchanged = await hostTree(join(f.root, "worktree"));
  await f.sandbox.close();
  const reopened = f.open(structuredClone(f.binding), f.root);
  await reopened.initialize();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await reopened.repositoryCachesReady(f.repositories, authorize), true);
    await reopened.materializeRepositories([beta, alpha], [archive("replacement beta"), archive("replacement alpha")], authorize);
    assert.equal(await reopened.gitStatus(authorize), status);
    assert.deepEqual(await hostTree(join(f.root, "worktree")), unchanged);
    assert.deepEqual(await marker(reopened), original);
    assert.equal((await shell(reopened, "git rev-parse HEAD")).trim(), head);
    assert.equal(await shell(reopened, `git merge-base --is-ancestor ${original.baseline} HEAD`), "");
  }
  assert.equal((await shell(reopened, "git log -1 --format='%an|%ae|%cn|%ce'")).trim(),
    "Alice Owner|alice@example.test|Alice Owner|alice@example.test");
});

test("trusted snapshot round-trip retains the same pins, marker, Git ancestry, binary modes and owner edits", linux, async t => {
  const f = await fixture(t);
  await recover(f);
  const initial = await marker(f.sandbox);
  await f.sandbox.writeFile(`${alpha.path}/README.md`, "restorable owner edit\n", authorize);
  await shell(f.sandbox, `rm -- ${alpha.path}/delete-me.txt`, false);
  await f.sandbox.execute({ kind: "git.commit", message: "Before snapshot" }, false, authorize);
  await f.sandbox.writeFile(`${beta.path}/README.md`, "dirty snapshot content\n", authorize);
  await shell(f.sandbox, `rm -- ${beta.path}/delete-me.txt`, false);
  await f.sandbox.writeFile(`${beta.path}/new.txt`, "untracked snapshot content\n", authorize);
  const status = await f.sandbox.gitStatus(authorize);
  const head = (await shell(f.sandbox, "git rev-parse HEAD")).trim();
  const files = await f.sandbox.snapshot(authorize);
  const savedMarker = files.find(file => file.path === "git/repository-cache.json");
  assert.ok(savedMarker);
  assert.deepEqual(JSON.parse(Buffer.from(savedMarker.data, "base64").toString()), initial);
  assert.equal(files.find(file => file.path === `worktree/${alpha.path}/bytes.bin`)?.data, binary.toString("base64"));
  assert.ok(files.find(file => file.path === `worktree/${alpha.path}/bin/tool.sh`)!.mode & 0o111);
  const restoreRoot = join(f.directory, "restored");
  await writeTrustedSnapshot(restoreRoot, files);
  await f.sandbox.close();
  const restored = f.open(structuredClone(f.binding), restoreRoot);
  await restored.initialize();
  assert.equal(await restored.repositoryCachesReady([beta, alpha], authorize), true);
  await restored.materializeRepositories(f.repositories, [archive("do not overwrite"), archive("do not overwrite")], authorize);
  assert.deepEqual(await marker(restored), initial);
  assert.equal(await restored.gitStatus(authorize), status);
  assert.equal((await shell(restored, "git rev-parse HEAD")).trim(), head);
  assert.equal(await shell(restored, `git merge-base --is-ancestor ${initial.baseline} HEAD`), "");
  assert.equal(await restored.readFile(`${alpha.path}/README.md`, authorize), "restorable owner edit\n");
  assert.equal(await restored.readFile(`${beta.path}/README.md`, authorize), "dirty snapshot content\n");
  assert.equal(await restored.readFile(`${beta.path}/new.txt`, authorize), "untracked snapshot content\n");
  await absent(join(restoreRoot, "worktree", alpha.path, "delete-me.txt"));
  await absent(join(restoreRoot, "worktree", beta.path, "delete-me.txt"));
  assert.deepEqual(await restored.snapshot(authorize), files);
});

test("cache marker is protected from public writes and both read-only and writable faux bash", linux, async t => {
  const f = await fixture(t);
  await recover(f);
  const before = await f.sandbox.readFile(markerPath, authorize);
  await assert.rejects(f.sandbox.writeFile(markerPath, "forged marker", authorize));
  for (const readOnly of [true, false]) {
    for (const command of [`printf forged > ${markerPath}`, `rm -- ${markerPath}`]) {
      await assert.rejects(shell(f.sandbox, command, readOnly));
      assert.equal(await f.sandbox.readFile(markerPath, authorize), before);
      assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
    }
  }
  await assert.rejects(shell(f.sandbox, "printf forbidden > read-only-probe.txt", true));
  await absent(join(f.root, "worktree", "read-only-probe.txt"));
  await shell(f.sandbox, "printf allowed > writable-probe.txt", false);
  assert.equal(await f.sandbox.readFile("writable-probe.txt", authorize), "allowed");
  await assert.rejects(shell(f.sandbox, `mv -- writable-probe.txt ${markerPath}`, false));
  assert.equal(await f.sandbox.readFile(markerPath, authorize), before);
  assert.equal(await f.sandbox.readFile("writable-probe.txt", authorize), "allowed");
});

test("authorization denies readiness and materialization effects, including on an already ready cache", linux, async t => {
  const f = await fixture(t);
  const denial = new Error("repository permission revoked");
  let calls = 0;
  const deny = async () => { calls++; throw denial; };
  await assert.rejects(f.sandbox.repositoryCachesReady(f.repositories, deny), error => error === denial);
  await assert.rejects(f.sandbox.materializeRepositories(f.repositories, validArchives, deny), error => error === denial);
  assert.equal(calls, 2);
  await pristine(f);
  await recover(f);
  const before = await f.sandbox.snapshot(authorize);
  const effects = [
    () => f.sandbox.repositoryCachesReady(f.repositories, deny),
    () => f.sandbox.materializeRepositories(f.repositories, validArchives, deny),
    () => f.sandbox.readFile(`${alpha.path}/README.md`, deny),
    () => f.sandbox.listFiles(".", deny),
    () => f.sandbox.snapshot(deny),
    () => f.sandbox.writeFile(`${alpha.path}/README.md`, "denied", deny),
    () => f.sandbox.execute({ kind: "git.commit", message: "Denied" }, false, deny),
    () => shell(f.sandbox, "printf denied > unauthorized.txt", false, deny),
  ];
  for (const effect of effects) await assert.rejects(effect(), error => error === denial);
  assert.equal(calls, effects.length + 2);
  assert.deepEqual(await f.sandbox.snapshot(authorize), before);
  assert.equal(await f.sandbox.gitStatus(authorize), "");
});

test("queued repository materialization rechecks authorization at effect time", linux, async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const blocker = f.sandbox.identity(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  let revoked = false;
  const pending = f.sandbox.materializeRepositories(f.repositories, validArchives, async () => {
    if (revoked) throw new Error("revoked after enqueue");
  });
  const rejected = assert.rejects(pending, /revoked after enqueue/);
  revoked = true;
  gate.resolve();
  await blocker;
  await rejected;
  await pristine(f);
  await recover(f);
});

const pinChanges: [string, Partial<SessionRepository>][] = [
  ["bindingId", { bindingId: "another-binding" }],
  ["repositoryId", { repositoryId: 999 }],
  ["fullName", { fullName: "acme/renamed" }],
  ["ref", { ref: "another-branch" }],
  ["commit", { commit: "d".repeat(40) }],
  ["path", { path: "acme/renamed" }],
  ["renamed fullName and path", { fullName: "acme/renamed", path: "acme/renamed" }],
];

test("both archive APIs reject mismatches in every immutable pin field and pin membership", linux, async t => {
  const f = await fixture(t);
  const mismatches: [string, SessionRepository[]][] = [
    ...pinChanges.map(([name, change]): [string, SessionRepository[]] => [name, [{ ...alpha, ...change }, beta]]),
    ["missing pin", [alpha]], ["empty pins", []], ["extra pin", [alpha, beta, gamma]],
    ["duplicate pin", [alpha, alpha]],
  ];
  let authorized = 0;
  const auth = async () => { authorized++; };
  for (const [name, pins] of mismatches) {
    await assert.rejects(f.sandbox.repositoryCachesReady(pins, auth), name);
    await assert.rejects(f.sandbox.materializeRepositories(pins, pins.map(() => validArchives[0]!), auth), name);
    await pristine(f);
  }
  assert.equal(authorized, 0);
  await recover(f);
  const before = await f.sandbox.snapshot(authorize);
  for (const [name, pins] of mismatches) {
    await assert.rejects(f.sandbox.repositoryCachesReady(pins, authorize), name);
    await assert.rejects(f.sandbox.materializeRepositories(pins, pins.map(() => validArchives[0]!), authorize), name);
  }
  assert.deepEqual(await f.sandbox.snapshot(authorize), before);
});

test("archive cardinality, empty input and compressed size limits reject without outputs and permit retry", linux, async t => {
  const f = await fixture(t);
  for (const archives of [[], [validArchives[0]!], [...validArchives, archive("extra")],
    [Buffer.alloc(0), validArchives[1]!], [Buffer.alloc(repositoryLimits.archiveBytes + 1), validArchives[1]!]]) {
    await assert.rejects(f.sandbox.materializeRepositories(f.repositories, archives, authorize));
    await pristine(f);
  }
  await recover(f);
});

test("repository count is bounded and an empty pin set needs no cache baseline", linux, async t => {
  const f = await fixture(t, []);
  assert.equal(await f.sandbox.repositoryCachesReady([], authorize), true);
  await f.sandbox.materializeRepositories([], [], authorize);
  assert.equal(await f.sandbox.gitStatus(authorize), "");
  await absent(join(f.root, "git", "repository-cache.json"));
  const tooMany = Array.from({ length: repositoryLimits.repositories + 1 }, (_, index) => ({
    ...alpha, bindingId: `binding-${index}`, repositoryId: index + 1,
    fullName: `acme/repo-${index}`, path: `acme/repo-${index}`,
  }));
  assert.throws(() => new Sandbox(binding("too-many", tooMany), join(f.directory, "too-many")));
  await absent(join(f.directory, "too-many"));
});

test("preexisting repository roots, files and symlink destinations are never merged into or replaced", linux, async t => {
  for (const kind of ["empty owner", "empty repository", "owner file", "repository with edits", "owner symlink", "repository symlink"] as const) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const work = join(f.root, "worktree");
      const outside = join(f.directory, "outside");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(join(outside, "sentinel"), "outside must not change", { mode: 0o600 });
      if (kind === "owner file") await writeFile(join(work, "acme"), "preexisting file", { mode: 0o600 });
      else if (kind === "owner symlink") await symlink(outside, join(work, "acme"));
      else {
        await mkdir(join(work, "acme"), { mode: 0o700 });
        if (kind === "repository symlink") await symlink(outside, join(work, alpha.path));
        else if (kind !== "empty owner") {
          await mkdir(join(work, alpha.path), { mode: 0o700 });
          if (kind === "repository with edits") await writeFile(join(work, alpha.path, "README.md"), "keep my edits", { mode: 0o600 });
        }
      }
      const before = await hostTree(work);
      const external = await hostTree(outside);
      await assert.rejects(f.sandbox.repositoryCachesReady(f.repositories, authorize));
      await assert.rejects(f.sandbox.materializeRepositories(f.repositories, validArchives, authorize));
      assert.deepEqual(await hostTree(work), before);
      assert.deepEqual(await hostTree(outside), external);
      if (kind !== "owner file") await absent(join(work, beta.path));
      await absent(join(f.root, "git", "repository-cache.json"));
    });
  }
});

test("a symlinked sandbox storage root is refused without touching its target", linux, async t => {
  const f = await fixture(t);
  const target = join(f.directory, "target");
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "sentinel"), "untouched", { mode: 0o600 });
  const alias = join(f.directory, "alias");
  await symlink(target, alias);
  const before = await hostTree(target);
  const sandbox = f.open(binding("alias"), alias);
  await assert.rejects(sandbox.materializeRepositories(f.repositories, validArchives, authorize));
  assert.deepEqual(await hostTree(target), before);
  assert.equal(await readlink(alias), target);
});

test("a preparing marker fails closed even on an otherwise pristine cache", linux, async t => {
  const f = await fixture(t);
  const saved = JSON.stringify({ version: 1, status: "preparing", repositories: f.repositories });
  const destination = join(f.root, "git", "repository-cache.json");
  await writeFile(destination, saved, { mode: 0o600 });
  await assert.rejects(f.sandbox.repositoryCachesReady(f.repositories, authorize));
  await assert.rejects(f.sandbox.materializeRepositories(f.repositories, validArchives, authorize));
  assert.equal(await readFile(destination, "utf8"), saved);
  assert.deepEqual(await readdir(join(f.root, "worktree")), [".git"]);
});

test("missing, corrupt, preparing and mismatched ready markers never reset owner files", linux, async t => {
  const corruptions: [string, (value: CacheMarker) => string | undefined][] = [
    ["missing", () => undefined],
    ["invalid JSON", () => "{"],
    ["null marker", () => "null"],
    ["unsupported version", value => JSON.stringify({ ...value, version: 2 })],
    ["preparing", value => JSON.stringify({ ...value, status: "preparing" })],
    ["missing status", value => JSON.stringify({ ...value, status: undefined })],
    ["missing baseline", value => JSON.stringify({ ...value, baseline: undefined })],
    ["malformed baseline", value => JSON.stringify({ ...value, baseline: "not-a-commit" })],
    ["absent baseline object", value => JSON.stringify({ ...value, baseline: "0".repeat(40) })],
    ...pinChanges.map(([name, change]): [string, (value: CacheMarker) => string] => [
      `mismatched ${name}`, value => JSON.stringify({ ...value, repositories: [{ ...alpha, ...change }, beta] }),
    ]),
  ];
  for (const [name, corrupt] of corruptions) {
    await t.test(name, async t => {
      const f = await fixture(t);
      await recover(f);
      const value = await marker(f.sandbox);
      await f.sandbox.writeFile(`${alpha.path}/README.md`, "do not reset owner edits", authorize);
      await shell(f.sandbox, `rm -- ${alpha.path}/delete-me.txt`, false);
      const before = await hostTree(join(f.root, "worktree"));
      const path = join(f.root, "git", "repository-cache.json");
      const raw = corrupt(value);
      if (raw === undefined) await rm(path);
      else await writeFile(path, raw, { mode: 0o600 });
      await f.sandbox.close();
      const reopened = f.open(structuredClone(f.binding), f.root);
      await reopened.initialize();
      await assert.rejects(reopened.repositoryCachesReady(f.repositories, authorize));
      await assert.rejects(reopened.materializeRepositories(f.repositories, validArchives, authorize));
      await assert.rejects(reopened.readFile(`${alpha.path}/README.md`, authorize));
      assert.deepEqual(await hostTree(join(f.root, "worktree")), before);
      if (raw === undefined) await absent(path);
      else assert.equal(await readFile(path, "utf8"), raw);
    });
  }
});

test("a ready marker requires a commit object that is still an ancestor of HEAD", linux, async t => {
  for (const kind of ["blob", "non-ancestor commit"] as const) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      await recover(f);
      const original = await marker(f.sandbox);
      let baseline: string;
      if (kind === "blob") baseline = (await shell(f.sandbox, `git rev-parse HEAD:${alpha.path}/README.md`)).trim();
      else {
        await f.sandbox.writeFile(`${alpha.path}/README.md`, "later commit", authorize);
        await f.sandbox.execute({ kind: "git.commit", message: "Later owner commit" }, false, authorize);
        baseline = (await shell(f.sandbox, "git rev-parse HEAD")).trim();
        // Trusted host fault injection: both commits exist, but the marker points ahead of HEAD.
        await writeFile(join(f.root, "git", "refs", "heads", "main"), `${original.baseline}\n`);
      }
      const raw = JSON.stringify({ ...original, baseline });
      await writeFile(join(f.root, "git", "repository-cache.json"), raw);
      const before = await hostTree(join(f.root, "worktree"));
      await assert.rejects(f.sandbox.repositoryCachesReady(f.repositories, authorize));
      await assert.rejects(f.sandbox.materializeRepositories(f.repositories, validArchives, authorize));
      assert.deepEqual(await hostTree(join(f.root, "worktree")), before);
      assert.equal(await readFile(join(f.root, "git", "repository-cache.json"), "utf8"), raw);
    });
  }
});

test("ordinary USTAR prefixes and supported GitHub PAX metadata materialize safely", linux, async t => {
  const f = await fixture(t);
  const longPath = `checkout/docs/${"long-".repeat(25)}file.txt`;
  const packed = gzipSync(tar([
    { name: "pax-global", type: "g", body: pax([["comment", alpha.commit]]) },
    { name: "checkout/", type: "5" },
    { name: "short.txt", prefix: "checkout/docs", body: "ustar prefix\n" },
    { name: "pax-local", type: "x", body: pax([["path", longPath], ["mtime", "123.5"], ["uid", "1000"], ["uname", "upstream"]]) },
    { name: "checkout/placeholder", body: "long PAX path\n" },
    { name: "checkout/legacy.txt", type: "\0", body: "NUL regular type\n" },
  ]));
  await f.sandbox.materializeRepositories(f.repositories, [packed, validArchives[1]!], authorize);
  assert.equal(await f.sandbox.readFile(`${alpha.path}/docs/short.txt`, authorize), "ustar prefix\n");
  assert.equal(await f.sandbox.readFile(`${alpha.path}/${longPath.slice("checkout/".length)}`, authorize), "long PAX path\n");
  assert.equal(await f.sandbox.readFile(`${alpha.path}/legacy.txt`, authorize), "NUL regular type\n");
  await absent(join(f.root, "worktree", alpha.path, "placeholder"));
  assert.equal(await f.sandbox.gitStatus(authorize), "");
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
});

const unsafePaths: [string, string][] = [
  ["parent traversal", "checkout/../escape"],
  ["nested traversal", "checkout/sub/../../escape"],
  ["traversing top prefix", "../escape"],
  ["absolute path", "/escape"],
  ["Windows absolute path", "C:/escape"],
  ["backslash", "checkout\\escape"],
  ["backslash traversal", "checkout/..\\escape"],
  ["empty component", "checkout//escape"],
  ["dot component", "checkout/./escape"],
  ["newline", "checkout/bad\nname"],
  ["tab", "checkout/bad\tname"],
  ["DEL", "checkout/bad\x7fname"],
  ["NUL with nonzero suffix", "checkout/bad\0suffix"],
  ["Git metadata", "checkout/.git/config"],
  ["nested mixed-case Git metadata", "checkout/sub/.GiT/config"],
  ["reserved top prefix", ".git/file"],
];

test("repository archive paths reject traversal, aliases, controls and reserved Git metadata", linux, async t => {
  for (const [name, path] of unsafePaths) {
    await t.test(name, t => rejectArchive(t, gzipSync(tar([{ name: path, body: "must not be written" }]))));
  }
  await t.test("USTAR prefix traversal", t => rejectArchive(t, gzipSync(tar([
    { name: "escape", prefix: "checkout/../outside", body: "forbidden" },
  ]))));
  await t.test("oversized depth", t => rejectArchive(t, gzipSync(tar([
    { name: "file", prefix: ["checkout", ...Array<string>(64).fill("d")].join("/"), body: "too deep" },
  ]))));
});

test("repository tar rejects links, devices, FIFO, unsupported types, duplicates and path conflicts", linux, async t => {
  const cases: [string, TarEntry[]][] = [
    ["symbolic link", [{ name: "checkout/link", type: "2", linkname: "../../escape" }]],
    ["hard link", [{ name: "checkout/file", body: "source" }, { name: "checkout/link", type: "1", linkname: "checkout/file" }]],
    ["character device", [{ name: "checkout/device", type: "3" }]],
    ["block device", [{ name: "checkout/device", type: "4" }]],
    ["FIFO", [{ name: "checkout/pipe", type: "6" }]],
    ["GNU sparse file", [{ name: "checkout/sparse", type: "S" }]],
    ["GNU long name", [{ name: "checkout/long", type: "L", body: "checkout/file\0" }]],
    ["regular file with link target", [{ name: "checkout/file", linkname: "elsewhere", body: "forbidden" }]],
    ["directory with data", [{ name: "checkout/", type: "5", body: "forbidden" }]],
    ["duplicate file", [{ name: "checkout/file", body: "first" }, { name: "checkout/file", body: "second" }]],
    ["duplicate directory", [{ name: "checkout/dir/", type: "5" }, { name: "checkout/dir", type: "5" }]],
    ["file before child", [{ name: "checkout/file", body: "parent" }, { name: "checkout/file/child", body: "child" }]],
    ["child before file", [{ name: "checkout/file/child", body: "child" }, { name: "checkout/file", body: "parent" }]],
    ["directory then file", [{ name: "checkout/dir", type: "5" }, { name: "checkout/dir", body: "file" }]],
    ["multiple top prefixes", [{ name: "first/file", body: "first" }, { name: "second/file", body: "second" }]],
    ["regular top-level root", [{ name: "checkout", body: "not a directory" }]],
    ["oversized file", [{ name: "checkout/large", body: Buffer.alloc(repositoryLimits.fileBytes + 1) }]],
  ];
  for (const [name, entries] of cases) await t.test(name, t => rejectArchive(t, gzipSync(tar(entries))));
});

test("PAX paths and unsupported metadata cannot bypass repository archive policy", linux, async t => {
  const paths = [
    "../escape", "checkout/../../escape", "/escape", "checkout\\escape", "checkout/bad\nname",
    "checkout/.git/config", "checkout/sub/.GIT/config", `checkout/${"x".repeat(256)}`,
    `checkout/${"\u00e9".repeat(128)}`,
    ["checkout", ...Array<string>(65).fill("d"), "file"].join("/"),
    ["checkout", ...Array<string>(6).fill("x".repeat(200))].join("/"),
  ];
  for (const [index, path] of paths.entries()) {
    await t.test(`unsafe effective path ${index + 1}`, t => rejectArchive(t, gzipSync(tar([
      { name: "pax", type: "x", body: pax([["path", path]]) },
      { name: "checkout/safe-looking", body: "forbidden" },
    ]))));
  }
  for (const key of ["size", "linkpath", "GNU.sparse.map", "SCHILY.xattr.user.test", "hdrcharset"]) {
    await t.test(`unsupported ${key}`, t => rejectArchive(t, gzipSync(tar([
      { name: "pax", type: "x", body: pax([[key, "0"]]) },
      { name: "checkout/file", body: "forbidden" },
    ]))));
  }
  const cases: [string, TarEntry[]][] = [
    ["global path override", [{ name: "pax", type: "g", body: pax([["path", "checkout/renamed"]]) }, { name: "checkout/file" }]],
    ["duplicate PAX key", [{ name: "pax", type: "x", body: pax([["path", "checkout/a"], ["path", "checkout/b"]]) }, { name: "checkout/file" }]],
    ["invalid PAX length", [{ name: "pax", type: "x", body: "999 path=checkout/file\n" }, { name: "checkout/file" }]],
    ["missing PAX newline", [{ name: "pax", type: "x", body: "9 path=x!" }, { name: "checkout/file" }]],
    ["orphan PAX header", [{ name: "checkout/", type: "5" }, { name: "pax", type: "x", body: pax([["path", "checkout/file"]]) }]],
    ["conflicting PAX headers", [{ name: "pax1", type: "x", body: pax([["path", "checkout/a"]]) },
      { name: "pax2", type: "x", body: pax([["path", "checkout/b"]]) }, { name: "checkout/file" }]],
    ["duplicate effective PAX path", [{ name: "checkout/file" }, { name: "pax", type: "x", body: pax([["path", "checkout/file"]]) }, { name: "checkout/other" }]],
  ];
  for (const [name, entries] of cases) await t.test(name, t => rejectArchive(t, gzipSync(tar(entries))));
});

test("truncated tar, invalid headers/checksums and absent terminators are rejected before publication", linux, async t => {
  const entry: TarEntry = { name: "checkout/file", body: "payload" };
  const valid = tar([entry]);
  const badChecksum = Buffer.from(valid);
  badChecksum[0] = badChecksum[0]! ^ 1;
  const badMagic = Buffer.from(valid);
  badMagic.fill(0, 257, 263);
  checksum(badMagic);
  const badNumber = Buffer.from(valid);
  badNumber[124] = "8".charCodeAt(0);
  checksum(badNumber);
  const cases: [string, Buffer][] = [
    ["truncated header", valid.subarray(0, 511)],
    ["truncated body", valid.subarray(0, 515)],
    ["declared body beyond archive", tar([{ ...entry, size: 8192 }])],
    ["bad checksum", badChecksum], ["unsupported tar magic", badMagic], ["non-octal size", badNumber],
    ["no terminators", tar([entry], 0)], ["one terminator", tar([entry], 1)],
    ["nonzero data after terminator", Buffer.concat([valid, Buffer.alloc(512, 1)])],
    ["empty archive", tar([])],
  ];
  for (const [name, bytes] of cases) await t.test(name, t => rejectArchive(t, gzipSync(bytes)));
});

test("gzip truncation, bad CRC, concatenated members and trailing garbage are rejected atomically", linux, async t => {
  const valid = validArchives[0]!;
  const badCrc = Buffer.from(valid);
  badCrc[badCrc.length - 8] = badCrc[badCrc.length - 8]! ^ 1;
  const cases: [string, Buffer][] = [
    ["not gzip", Buffer.from("not a gzip stream")],
    ["truncated header", valid.subarray(0, 5)],
    ["truncated deflate data", valid.subarray(0, Math.floor(valid.length / 2))],
    ["missing trailer", valid.subarray(0, valid.length - 8)],
    ["partial trailer", valid.subarray(0, valid.length - 1)],
    ["bad CRC", badCrc],
    ["concatenated archives", Buffer.concat([valid, validArchives[1]!])],
    ["concatenated empty member", Buffer.concat([valid, gzipSync(Buffer.alloc(0))])],
    ["trailing garbage", Buffer.concat([valid, Buffer.from("garbage")])],
  ];
  for (const [name, bytes] of cases) await t.test(name, t => rejectArchive(t, bytes));
});

test("a gzip metadata bomb exceeding 32 MiB is bounded before any PAX parsing", linux, async t => {
  // Invalid PAX content would fail parsing if it were reached. Expansion must
  // instead reject the complete stream, counting metadata as well as file data.
  const raw = tar([
    { name: "pax-bomb", type: "g", body: Buffer.alloc(32 * 1024 * 1024 + 1, 120) },
    { name: "checkout/", type: "5" },
  ]);
  assert.ok(raw.length > repositoryLimits.expandedBytes);
  const packed = gzipSync(raw);
  assert.ok(packed.length < repositoryLimits.archiveBytes);
  await rejectArchive(t, packed, /expanded size limit/i);
});

test("expanded bytes are bounded across repositories, not just per gzip member or file", linux, async t => {
  const count = Math.floor(repositoryLimits.expandedBytes / 2 / repositoryLimits.fileBytes) + 1;
  const raw = tar(Array.from({ length: count }, (_, index) => ({
    name: `checkout/file-${index}`, body: Buffer.alloc(repositoryLimits.fileBytes, 97),
  })));
  assert.ok(raw.length < repositoryLimits.expandedBytes);
  assert.ok(raw.length * 2 > repositoryLimits.expandedBytes);
  const packed = gzipSync(raw);
  assert.ok(packed.length < repositoryLimits.archiveBytes);
  const single = await fixture(t, [alpha]);
  await single.sandbox.materializeRepositories(single.repositories, [packed], authorize);
  assert.equal(await single.sandbox.repositoryCachesReady(single.repositories, authorize), true);
  assert.equal(await single.sandbox.gitStatus(authorize), "");
  const f = await fixture(t);
  await assert.rejects(f.sandbox.materializeRepositories(f.repositories, [packed, packed], authorize), /expanded size limit/i);
  await pristine(f);
  await recover(f);
});

test("archive entry counts are bounded across repositories and rejected batches leave no outputs", linux, async t => {
  const count = Math.floor(repositoryLimits.entries / 2) + 1;
  const packed = gzipSync(tar(Array.from({ length: count }, (_, index) => ({
    name: `checkout/file-${index}`, body: "",
  }))));
  const single = await fixture(t, [alpha]);
  await single.sandbox.materializeRepositories(single.repositories, [packed], authorize);
  assert.equal(await single.sandbox.repositoryCachesReady(single.repositories, authorize), true);
  assert.equal((await single.sandbox.listFiles(alpha.path, authorize)).length, count);
  const f = await fixture(t);
  await assert.rejects(f.sandbox.materializeRepositories(f.repositories, [packed, packed], authorize), /too many.*entries/i);
  await pristine(f);
  await recover(f);
});

test("imported .gitconfig and owner.gitconfig are ordinary source files, not session Git authority", linux, async t => {
  const f = await fixture(t, [alpha]);
  const spoofed = "[user]\n\tname = Mallory Upstream\n\temail = mallory@example.test\n[core]\n\thooksPath = acme/alpha/hooks\n";
  const hook = "#!/bin/sh\nprintf compromised > hook-ran.txt\nexit 23\n";
  const ownerConfig = await readFile(join(f.root, "owner.gitconfig"), "utf8");
  const packed = gzipSync(tar([
    { name: "checkout/.gitconfig", body: spoofed },
    { name: "checkout/owner.gitconfig", body: spoofed },
    { name: "checkout/nested/.GITCONFIG", body: spoofed },
    { name: "checkout/hooks/pre-commit", body: hook, mode: 0o755 },
    { name: "checkout/hooks/post-commit", body: hook, mode: 0o755 },
    { name: "checkout/README.md", body: "ordinary source\n" },
  ]));
  await f.sandbox.materializeRepositories(f.repositories, [packed], authorize);
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
  assert.equal(await f.sandbox.gitStatus(authorize), "");
  for (const path of [".gitconfig", "owner.gitconfig", "nested/.GITCONFIG"]) {
    assert.equal(await f.sandbox.readFile(`${alpha.path}/${path}`, authorize), spoofed);
  }
  for (const phase of ["baseline", "owner commit"]) {
    if (phase === "owner commit") {
      await f.sandbox.writeFile(`${alpha.path}/README.md`, "owner change\n", authorize);
      await f.sandbox.execute({ kind: "git.commit", message: "Still Alice's commit" }, false, authorize);
    }
    assert.equal((await shell(f.sandbox, "git log -1 --format='%an|%ae|%cn|%ce'")).trim(),
      "Alice Owner|alice@example.test|Alice Owner|alice@example.test");
    assert.equal((await shell(f.sandbox, "git config user.name")).trim(), "Alice Owner");
    assert.equal((await shell(f.sandbox, "git config user.email")).trim(), "alice@example.test");
    assert.equal((await shell(f.sandbox, "git config core.hooksPath")).trim(), "/dev/null");
    assert.equal(await shell(f.sandbox, 'cat "$HOME/.gitconfig"'), ownerConfig);
    assert.equal(await readFile(join(f.root, "owner.gitconfig"), "utf8"), ownerConfig);
    await absent(join(f.root, "worktree", "hook-ran.txt"));
    await absent(join(f.root, "worktree", alpha.path, "hook-ran.txt"));
  }
});

test("the 64-component bound includes owner/repo, not only the stripped tar path", linux, async t => {
  const f = await fixture(t);
  const tooDeep = gzipSync(tar([{
    name: "file", prefix: ["x", ...Array<string>(62).fill("d")].join("/"), body: "65 destination components",
  }]));
  // The archive name itself has only 64 components; the destination has 65.
  for (const archives of [[tooDeep, validArchives[1]!], [validArchives[0]!, tooDeep]]) {
    await assert.rejects(f.sandbox.materializeRepositories(f.repositories, archives, authorize));
    await pristine(f);
  }
  const relative = [...Array<string>(61).fill("d"), "file"].join("/");
  const atLimit = gzipSync(tar([{
    name: "file", prefix: ["x", ...Array<string>(61).fill("d")].join("/"), body: "64 destination components",
  }]));
  await f.sandbox.materializeRepositories(f.repositories, [atLimit, validArchives[1]!], authorize);
  assert.equal(`${alpha.path}/${relative}`.split("/").length, 64);
  assert.equal(await f.sandbox.readFile(`${alpha.path}/${relative}`, authorize), "64 destination components");
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
  assert.equal(await f.sandbox.gitStatus(authorize), "");
});

test("the 1024-byte destination bound counts owner/repo and UTF-8, with 255-byte components allowed", linux, async t => {
  for (const multibyte of [false, true]) {
    await t.test(multibyte ? "UTF-8 bytes, not character count" : "ASCII boundary", async t => {
      const f = await fixture(t);
      const accepted: Buffer[] = [];
      const paths: string[] = [];
      for (const [index, pin] of f.repositories.entries()) {
        for (const total of [1025, 1024]) {
          const leafBytes = total - Buffer.byteLength(`${pin.path}/`) - 3 * 255 - 3;
          const leaf = multibyte
            ? "\u00e9".repeat(Math.floor(leafBytes / 2)) + (leafBytes % 2 ? "z" : "")
            : "z".repeat(leafBytes);
          const relative = ["a".repeat(255), "b".repeat(255), "c".repeat(255), leaf].join("/");
          const destination = `${pin.path}/${relative}`;
          assert.equal(Buffer.byteLength(destination), total);
          assert.ok(Buffer.byteLength(`x/${relative}`) <= 1024, "tar path alone is within the bound");
          const packed = gzipSync(tar([
            { name: "pax", type: "x", body: pax([["path", `x/${relative}`]]) },
            { name: "x/placeholder", body: "bounded destination\n" },
          ]));
          if (total === 1025) {
            const archives = [...validArchives];
            archives[index] = packed;
            await assert.rejects(f.sandbox.materializeRepositories(f.repositories, archives, authorize));
            await pristine(f);
          } else {
            accepted.push(packed);
            paths.push(destination);
          }
        }
      }
      await f.sandbox.materializeRepositories(f.repositories, accepted, authorize);
      assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
      assert.equal(await f.sandbox.gitStatus(authorize), "");
      for (const path of paths) assert.equal(await f.sandbox.readFile(path, authorize), "bounded destination\n");
    });
  }
});

test("ready caches remain usable when later owner files exceed the independent backup quota", linux, async t => {
  const f = await fixture(t);
  await recover(f);
  const before = await marker(f.sandbox);
  const path = `${alpha.path}/large-owner-file.bin`;
  const bytes = 32 * 1024 * 1024 + 1;
  await shell(f.sandbox, `truncate -s ${bytes} ${path}`, false);
  assert.equal((await lstat(join(f.root, "worktree", path))).size, bytes);
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
  await assert.rejects(f.sandbox.snapshot(authorize), /size limit/i);
  await f.sandbox.materializeRepositories(f.repositories, validArchives, authorize);
  assert.equal(await f.sandbox.repositoryCachesReady(f.repositories, authorize), true);
  assert.deepEqual(await marker(f.sandbox), before);
  assert.equal((await lstat(join(f.root, "worktree", path))).size, bytes);
  assert.equal(await f.sandbox.readFile(`${alpha.path}/README.md`, authorize), "alpha\n");
});

test("a bound cache with missing HEAD cannot be silently reinitialized", linux, async t => {
  const f = await fixture(t);
  await recover(f);
  await f.sandbox.writeFile(`${alpha.path}/README.md`, "preserve owner edits despite corrupt Git metadata", authorize);
  await f.sandbox.close();
  await rm(join(f.root, "git", "HEAD"));
  const gitBefore = await hostTree(join(f.root, "git"));
  const workBefore = await hostTree(join(f.root, "worktree"));
  const reopened = f.open(structuredClone(f.binding), f.root);
  await assert.rejects(reopened.initialize());
  await assert.rejects(reopened.repositoryCachesReady(f.repositories, authorize));
  await assert.rejects(reopened.materializeRepositories(f.repositories, validArchives, authorize));
  await absent(join(f.root, "git", "HEAD"));
  assert.deepEqual(await hostTree(join(f.root, "git")), gitBefore);
  assert.deepEqual(await hostTree(join(f.root, "worktree")), workBefore);
});
