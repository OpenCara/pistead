import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestoreDescriptor } from "../packages/shared/src/connector.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";
import type { SessionRepository } from "../packages/shared/src/repositories.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { restoreSession, type RestoreConfig, type RestoreManifest } from "../apps/runner/src/restore.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";

const linux = { skip: process.platform !== "linux" };
type BackupArchive = {
  format: string; binding: RunnerBinding; manifest: RestoreManifest; sqlite: string;
  files: { path: string; data: string; mode: number }[]; createdAt: string;
};
function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Restore test", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: { APP_COLOR: "blue" }, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Agent", description: "Test", instructions: "Use tools.", tools: ["identity", "read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Test faux", provider: "faux", modelId: "faux-1" },
  };
}
function archive(): BackupArchive {
  const source = binding("source");
  const sqlite = Buffer.alloc(100);
  sqlite.write("SQLite format 3\0", "binary");
  const manifest: RestoreManifest = { binding: structuredClone(source), branches: [{ id: 1, mode: "write" }], runs: {}, approvals: {}, toolActors: {}, usedTickets: { "old-ticket": 123 } };
  return { format: "pi-runner-backup-v1", binding: source, manifest, sqlite: sqlite.toString("base64"),
    files: [
      { path: "worktree/evidence.txt", data: Buffer.from("original\0binary").toString("base64"), mode: 0o644 },
      { path: "home/profile.txt", data: Buffer.from("home").toString("base64"), mode: 0o600 },
      { path: "git/HEAD", data: Buffer.from("ref: refs/heads/main\n").toString("base64"), mode: 0o644 },
      { path: "owner.gitconfig", data: Buffer.from("old owner config: do not restore").toString("base64"), mode: 0o400 },
    ], createdAt: "2026-01-01T00:00:00Z" };
}
function envelope(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const descriptor: RestoreDescriptor = { id: "restore-1", sourceSessionId: "source", backupId: "backup-1", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("base64url"), downloadToken: "opaque-download-capability" };
  return { bytes, descriptor };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "runner-restore-"));
  await chmod(directory, 0o700);
  await mkdir(join(directory, "sessions"), { mode: 0o700 });
  await mkdir(join(directory, "sessions", "source"), { mode: 0o700 });
  await writeFile(join(directory, "sessions", "source", "unchanged"), "source remains untouched", { mode: 0o600 });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const target = binding("target");
  target.owner.gitName = "Current Alice";
  target.owner.gitEmail = "current@example.test";
  target.owner.env = { APP_COLOR: "green" };
  const input = archive();
  const saved = envelope(input);
  let reads = 0;
  const config: RestoreConfig = { dataDir: directory, readBackup: async (descriptor, targetId) => {
    reads++;
    assert.deepEqual(descriptor, saved.descriptor);
    assert.equal(targetId, "target");
    return saved.bytes;
  } };
  return { directory, target, input, ...saved, config, reads: () => reads };
}
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

// These are publication unit tests, not sandbox/kernel capability tests. The real
// initializer is covered by sandbox tests; restore must invoke it, not import config.
function fakeInitializer(t: TestContext, stage: () => string) {
  return t.mock.method(Sandbox.prototype, "initialize", async function () {
    const config = join(stage(), "sandbox", "owner.gitconfig");
    await absent(config);
    await writeFile(config, "regenerated current owner configuration", { mode: 0o400, flag: "wx" });
  });
}

test("restore accepts only a trusted bounded reader and exact descriptor, never a URL", linux, async t => {
  const f = await fixture(t);
  const prepare = t.mock.fn(async () => {});
  await assert.rejects(restoreSession({ dataDir: f.directory }, f.target, f.descriptor, prepare), /Trusted backup reader/);
  for (const change of [
    { id: "../restore" }, { sourceSessionId: "source/elsewhere" }, { backupId: "https://example.test/backup" },
    { sha256: "0" }, { sha256: "A".repeat(64) }, { size: 0 }, { size: 24 * 1024 * 1024 + 1 },
    { size: 1.5 }, { downloadToken: "" }, { downloadToken: "bad\ncapability" }, { url: "https://example.test/snapshot" },
  ]) {
    await assert.rejects(restoreSession(f.config, f.target, { ...f.descriptor, ...change }, prepare));
  }
  await assert.rejects(restoreSession(f.config, binding("source"), f.descriptor, prepare), /new target/);
  assert.equal(f.reads(), 0);
  assert.equal(prepare.mock.callCount(), 0);
  await absent(join(f.directory, "sessions", "target"));
});

test("restore validates exact byte count and checksum before JSON or preparation", linux, async t => {
  const f = await fixture(t);
  const prepare = t.mock.fn(async () => {});
  for (const bytes of [f.bytes.subarray(1), Buffer.concat([f.bytes, Buffer.from(" ")]), Buffer.from("x".repeat(f.bytes.length))]) {
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => bytes }, f.target, f.descriptor, prepare), /size mismatch|checksum mismatch/);
  }
  const bytes = Buffer.from([0xff, 0xfe]);
  const descriptor = { ...f.descriptor, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("base64url") };
  await assert.rejects(restoreSession({ ...f.config, readBackup: async () => bytes }, f.target, descriptor, prepare), /UTF-8 JSON/);
  assert.equal(prepare.mock.callCount(), 0);
  await absent(join(f.directory, "sessions", "target"));
});

test("restore rejects mismatched source, owner, template, workspace, model, connector, and manifest bindings", linux, async t => {
  const f = await fixture(t);
  const cases: ((value: BackupArchive) => void)[] = [
    value => { value.binding.session.id = "wrong-source"; },
    value => { value.binding.owner.id = value.binding.session.ownerId = "test:bob"; },
    value => { value.binding.session.agentVersionId = value.binding.agent.id = "other-version"; },
    value => { value.binding.agent.instructions = "changed immutable template"; },
    value => { value.binding.agent.version = 2; },
    value => { value.binding.model.modelId = "other-model"; },
    value => { value.binding.model.provider = "anthropic"; },
    value => { value.binding.model.id = value.binding.agent.modelId = "other-model-row"; },
    value => { value.binding.model.workspaceId = value.binding.session.workspaceId = value.binding.agent.workspaceId = "elsewhere"; },
    value => { value.binding.session.connectorId = value.binding.model.connectorId = "connector";
      value.binding.session.connectorOwnerId = value.binding.model.connectorOwnerId = "test:host"; },
    value => { value.manifest.binding.owner.id = "test:bob"; },
    value => { value.manifest.branches = [{ id: 1, mode: "write" }, { id: 1, mode: "ask" }]; },
    value => { value.sqlite = Buffer.from("not a database").toString("base64"); },
  ];
  const prepare = t.mock.fn(async () => {});
  for (const change of cases) {
    const value = archive();
    change(value);
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare));
  }
  assert.equal(prepare.mock.callCount(), 0);
});

test("restore requires every immutable repository pin to match before paused preparation", linux, async t => {
  const f = await fixture(t);
  const pin: SessionRepository = { bindingId: "binding-1", repositoryId: 123, fullName: "alice/project", path: "alice/project", ref: "main", commit: "a".repeat(40) };
  f.target.session.repositories = [pin];
  const prepare = t.mock.fn(async () => {});
  for (const repositories of [
    undefined, [],
    [{ ...pin, commit: "b".repeat(40) }],
    [{ ...pin, repositoryId: 456 }],
    [{ ...pin, bindingId: "binding-2" }],
    [{ ...pin, ref: "other-branch" }],
    [{ ...pin, fullName: "alice/renamed", path: "alice/renamed" }],
  ]) {
    const value = archive();
    value.binding.session.repositories = repositories;
    value.manifest.binding = structuredClone(value.binding);
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /repository pins mismatch/);
  }
  assert.equal(prepare.mock.callCount(), 0);
  await absent(join(f.directory, "sessions", "target"));
});

test("restore preserves exact repository pins and requires the restored ready marker before publication", linux, async t => {
  const f = await fixture(t);
  const pin: SessionRepository = { bindingId: "binding-1", repositoryId: 123, fullName: "alice/project", path: "alice/project", ref: "main", commit: "a".repeat(40) };
  f.target.session.repositories = [pin];
  const value = archive();
  value.binding.session.repositories = [pin];
  value.manifest.binding = structuredClone(value.binding);
  value.files.push({ path: "worktree/alice/project/edited.txt", data: Buffer.from("owner edits, not live branch").toString("base64"), mode: 0o600 });
  const saved = envelope(value);
  let stagePath = "";
  fakeInitializer(t, () => stagePath);
  let ready = false;
  const probe = t.mock.method(Sandbox.prototype, "repositoryCachesReady", async (repositories: readonly SessionRepository[], authorize: () => Promise<void>) => {
    assert.deepEqual(repositories, [pin]);
    await authorize();
    return ready;
  });
  const prepare = async (stage: string, manifest: RestoreManifest) => {
    stagePath = stage;
    assert.deepEqual(manifest.binding.session.repositories, [pin]);
    assert.equal(await readFile(join(stage, "sandbox", "worktree", pin.path, "edited.txt"), "utf8"), "owner edits, not live branch");
  };
  const config = { ...f.config, readBackup: async () => saved.bytes };
  await assert.rejects(restoreSession(config, f.target, saved.descriptor, prepare), /repository cache is not ready/);
  await absent(join(f.directory, "sessions", "target"));
  ready = true;
  await restoreSession(config, f.target, saved.descriptor, prepare);
  assert.equal(probe.mock.callCount(), 2);
  assert.equal(await readFile(join(f.directory, "sessions", "target", "sandbox", "worktree", pin.path, "edited.txt"), "utf8"), "owner edits, not live branch");
  const persisted = JSON.parse(await readFile(join(f.directory, "sessions", "target", "binding.json"), "utf8")) as RunnerBinding;
  assert.deepEqual(persisted.session.repositories, [pin]);
});

test("legacy restore treats omitted and empty repository pins equivalently", linux, async t => {
  const f = await fixture(t);
  f.target.session.repositories = [];
  let staged = "";
  fakeInitializer(t, () => staged);
  await restoreSession(f.config, f.target, f.descriptor, async stage => { staged = stage; });
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "sessions", "target", "binding.json"), "utf8")).session.repositories, []);
});

test("restore refuses active metadata before opening pi", linux, async t => {
  const f = await fixture(t);
  const prepare = t.mock.fn(async () => {});
  for (const status of ["admitting", "queued", "running", "unknown"]) {
    const value = archive();
    value.manifest.runs = { stale: { status } };
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /idle runs/);
  }
  const value = archive();
  value.manifest.approvals = { stale: { status: "executing" } };
  const saved = envelope(value);
  await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /idle approvals/);
  assert.equal(prepare.mock.callCount(), 0);
});

test("snapshot paths reject traversal, aliases, reserved mount points, duplicates, special modes, and file parents", linux, async t => {
  const f = await fixture(t);
  const prepare = t.mock.fn(async () => {});
  const paths = ["", "/tmp/escape", "../escape", "worktree/../../escape", "worktree/./file", "worktree//file", "worktree/file/", "worktree\\file",
    "worktree/file\0suffix", "worktree/a\nb", "session.sqlite", "binding.json", "owner.gitconfig/child", "home/.gitconfig", "home/.gitconfig/child",
    "worktree/.git", "worktree/.git/config", "home/.tmp", "git/objects", "git/refs", `worktree/${"a/".repeat(66)}file`, `home/${"a".repeat(256)}`];
  for (const path of paths) {
    const value = archive();
    value.files.push({ path, data: "", mode: 0o600 });
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /path/);
  }
  const badFiles = [
    [{ path: "worktree/evidence.txt", data: "", mode: 0o600 }],
    [{ path: "home/file/child", data: "", mode: 0o600 }, { path: "home/file", data: "", mode: 0o600 }],
    [{ path: "home/file", data: "", mode: 0o600 }, { path: "home/file/child", data: "", mode: 0o600 }],
    [{ path: "home/mode", data: "", mode: 0o120777 }],
    [{ path: "home/mode", data: "", mode: 0o4600 }],
    [{ path: "home/mode", data: "", mode: -1 }],
    [{ path: "home/data", data: "Zm9v\n", mode: 0o600 }],
    [{ path: "home/data", data: "Zh==", mode: 0o600 }],
  ];
  for (const files of badFiles) {
    const value = archive();
    value.files.push(...files);
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare));
  }
  const value = archive();
  value.files = Array.from({ length: 10_001 }, (_, i) => ({ path: `home/file-${i}`, data: "", mode: 0o600 }));
  const saved = envelope(value);
  await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /format/);
  assert.equal(prepare.mock.callCount(), 0);
  await absent(join(f.directory, "sessions", "target"));
});

test("restore stages privately, invokes paused preparation, regenerates owner config, and never modifies source", linux, async t => {
  const f = await fixture(t);
  const originalBytes = Buffer.from(f.bytes);
  let staged = "";
  const initialize = fakeInitializer(t, () => staged);
  await restoreSession(f.config, f.target, f.descriptor, async (stage, manifest) => {
    staged = stage;
    assert.equal((await lstat(stage)).mode & 0o777, 0o700);
    assert.deepEqual(manifest, f.input.manifest);
    assert.deepEqual(JSON.parse(await readFile(join(stage, "binding.json"), "utf8")), f.target);
    assert.equal(await readFile(join(stage, "sandbox", "worktree", "evidence.txt"), "utf8"), "original\0binary");
    assert.equal((await lstat(join(stage, "session.sqlite"))).nlink, 1);
    await absent(join(f.directory, "sessions", "target"));
    await absent(join(stage, "sandbox", "owner.gitconfig"));
    await writeFile(join(stage, "prepared"), "closed and rebound", { mode: 0o600 });
  });
  const target = join(f.directory, "sessions", "target");
  assert.equal(await readFile(join(target, "prepared"), "utf8"), "closed and rebound");
  assert.equal(await readFile(join(target, "sandbox", "owner.gitconfig"), "utf8"), "regenerated current owner configuration");
  assert.equal(initialize.mock.callCount(), 1);
  const marker = JSON.parse(await readFile(join(target, ".restore.json"), "utf8"));
  assert.equal(marker.restoreId, f.descriptor.id);
  assert.equal(marker.sha256, f.descriptor.sha256);
  assert.equal(JSON.stringify(marker).includes(f.descriptor.downloadToken), false);
  assert.equal(await readFile(join(f.directory, "sessions", "source", "unchanged"), "utf8"), "source remains untouched");
  assert.deepEqual(f.bytes, originalBytes);
  await absent(staged);
});

test("restore accepts files on the same mount even when overlayfs reports different directory and file devices", linux, async t => {
  const f = await fixture(t);
  let staged = "";
  fakeInitializer(t, () => staged);
  await restoreSession(f.config, f.target, f.descriptor, async stage => {
    staged = stage;
    const directory = await open(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const file = await open(join(stage, "sandbox", "worktree", "evidence.txt"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const directoryMount = (await readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8")).match(/^mnt_id:[\t ]+([1-9][0-9]*)$/m)?.[1];
      const fileMount = (await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8")).match(/^mnt_id:[\t ]+([1-9][0-9]*)$/m)?.[1];
      assert.ok(directoryMount, "kernel must report the opened directory's mount identity");
      assert.equal(fileMount, directoryMount, "both opened entries belong to one mount");
      const directoryInfo = await directory.stat();
      const fileInfo = await file.stat();
      assert.equal(fileInfo.nlink, 1);
      if (directoryInfo.dev !== fileInfo.dev) t.diagnostic("Overlayfs regression exercised: one mount reports distinct directory/file st_dev values.");
    } finally { await file.close(); await directory.close(); }
  });
  const target = join(f.directory, "sessions", "target");
  assert.equal(await readFile(join(target, "sandbox", "worktree", "evidence.txt"), "utf8"), "original\0binary");
  assert.equal(JSON.parse(await readFile(join(target, ".restore.json"), "utf8")).restoreId, f.descriptor.id);
  await absent(staged);
});

test("durable receipt makes retry idempotent but rejects restore ID, SHA, backup, and target binding conflicts", linux, async t => {
  const f = await fixture(t);
  let staged = "";
  fakeInitializer(t, () => staged);
  const prepare = t.mock.fn(async (stage: string) => { staged = stage; });
  await restoreSession(f.config, f.target, f.descriptor, prepare);
  await restoreSession(f.config, f.target, { ...f.descriptor, downloadToken: "rotated-capability" }, prepare);
  assert.equal(f.reads(), 1);
  assert.equal(prepare.mock.callCount(), 1);
  for (const change of [{ id: "restore-other" }, { sha256: "A".repeat(43) }, { backupId: "backup-other" }, { size: f.descriptor.size + 1 }]) {
    await assert.rejects(restoreSession(f.config, f.target, { ...f.descriptor, ...change }, prepare), /conflicts/);
  }
  const changed = structuredClone(f.target);
  changed.owner.gitEmail = "changed@example.test";
  await assert.rejects(restoreSession(f.config, changed, f.descriptor, prepare), /conflicts/);
  await writeFile(join(f.directory, "sessions", "target", ".restore.json"), "{}", { mode: 0o600 });
  await assert.rejects(restoreSession(f.config, f.target, f.descriptor, prepare), /conflicts/);
  assert.equal(f.reads(), 1);
});

test("kernel publication fence serializes independent identical attempts", linux, async t => {
  const f = await fixture(t);
  let staged = "";
  fakeInitializer(t, () => staged);
  const prepare = t.mock.fn(async (stage: string) => { staged = stage; });
  await Promise.all([
    restoreSession(f.config, f.target, f.descriptor, prepare),
    restoreSession(f.config, f.target, f.descriptor, prepare),
  ]);
  assert.equal(f.reads(), 1);
  assert.equal(prepare.mock.callCount(), 1);
});

test("Linux no-replace publication does not replace even an empty competing target", linux, async t => {
  const f = await fixture(t);
  let staged = "";
  fakeInitializer(t, () => staged);
  const target = join(f.directory, "sessions", "target");
  await assert.rejects(restoreSession(f.config, f.target, f.descriptor, async stage => {
    staged = stage;
    await mkdir(target, { mode: 0o700 });
  }), /already exists/);
  assert.deepEqual(await readdir(target), []);
  await absent(staged);
});

test("failed preparation is never published and can be retried from the untouched backup", linux, async t => {
  const f = await fixture(t);
  let staged = "";
  fakeInitializer(t, () => staged);
  await assert.rejects(restoreSession(f.config, f.target, f.descriptor, async stage => {
    staged = stage;
    throw new Error("pi has incomplete tasks");
  }), /incomplete tasks/);
  await absent(staged);
  await absent(join(f.directory, "sessions", "target"));
  await restoreSession(f.config, f.target, f.descriptor, async stage => { staged = stage; });
  assert.equal(f.reads(), 2);
});

test("restore refuses symlinked roots, target aliases, and unsafe staged links", linux, async t => {
  const f = await fixture(t);
  const alias = join(f.directory, "alias");
  await symlink(f.directory, alias);
  await assert.rejects(restoreSession({ ...f.config, dataDir: alias }, f.target, f.descriptor, async () => {}), /canonical/);
  const target = join(f.directory, "sessions", "target");
  await symlink(join(f.directory, "sessions", "source"), target);
  await assert.rejects(restoreSession(f.config, f.target, f.descriptor, async () => {}), /conflicts/);
  await rm(target);
  let staged = "";
  fakeInitializer(t, () => staged);
  for (const hard of [false, true]) {
    await assert.rejects(restoreSession(f.config, f.target, f.descriptor, async stage => {
      staged = stage;
      const source = join(f.directory, "sessions", "source", "unchanged");
      if (hard) await link(source, join(stage, "unsafe"));
      else await symlink(source, join(stage, "unsafe"));
    }), /Unsafe prepared restore/);
    await absent(target);
    await absent(staged);
  }
  assert.equal(await readFile(join(f.directory, "sessions", "source", "unchanged"), "utf8"), "source remains untouched");
});

test("restore requires canonical JSON and the shared base64url checksum encoding", linux, async t => {
  const f = await fixture(t);
  assert.equal(f.descriptor.sha256, await sha256(f.bytes.toString("utf8")));
  const prepare = t.mock.fn(async () => {});
  const text = f.bytes.toString("utf8");
  for (const raw of [`${text}\n`, `{"format":"ignored",${text.slice(1)}`, text.replace("pi-runner", "\\u0070i-runner")]) {
    const bytes = Buffer.from(raw);
    const descriptor = { ...f.descriptor, size: bytes.length, sha256: await sha256(raw) };
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => bytes }, f.target, descriptor, prepare), /canonical/);
  }
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), f.bytes]);
  const descriptor = { ...f.descriptor, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("base64url") };
  await assert.rejects(restoreSession({ ...f.config, readBackup: async () => bytes }, f.target, descriptor, prepare), /UTF-8 JSON/);
  await assert.rejects(restoreSession(f.config, f.target, { ...f.descriptor, sha256: `${"A".repeat(42)}B` }, prepare), /checksum/);
  assert.equal(prepare.mock.callCount(), 0);
});

test("completed metadata still binds every run and approval to the source owner and session", linux, async t => {
  const f = await fixture(t);
  const key = await sha256("receipt-key");
  const run = { key, ownerId: "test:alice", initiatedBy: "test:teammate", mode: "write", conversationId: 1,
    content: "historical input", contentHash: await sha256("historical input"), status: "settled", startEntry: 0, sequence: 0 };
  const prepare = t.mock.fn(async () => {});
  for (const change of [{ key: "different" }, { ownerId: "test:bob" }, { initiatedBy: "" }, { mode: "admin" },
    { conversationId: 99 }, { contentHash: "wrong" }, { sequence: -1 }, { startEntry: -1 }]) {
    const value = archive();
    value.manifest.runs[key] = { ...run, ...change };
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /run binding/);
  }
  const approval = { id: "approval-1", sessionId: "source", requestedBy: "test:alice", status: "pending",
    operation: { kind: "git.commit", message: "old request" }, createdAt: "2026-01-01T00:00:00Z" };
  for (const change of [{ id: "other" }, { sessionId: "other-session" }, { requestedBy: "" }]) {
    const value = archive();
    value.manifest.approvals["approval-1"] = { ...approval, ...change };
    const saved = envelope(value);
    await assert.rejects(restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, prepare), /approval binding/);
  }
  assert.equal(prepare.mock.callCount(), 0);
  const value = archive();
  value.manifest.runs[key] = run;
  value.manifest.approvals["approval-1"] = approval;
  value.manifest.toolActors["123"] = { ownerId: run.ownerId, initiatedBy: run.initiatedBy, runKey: key };
  const saved = envelope(value);
  let staged = "";
  fakeInitializer(t, () => staged);
  await restoreSession({ ...f.config, readBackup: async () => saved.bytes }, f.target, saved.descriptor, async (stage, manifest) => {
    staged = stage;
    assert.deepEqual(manifest.runs[key], run);
    assert.deepEqual(manifest.approvals["approval-1"], approval);
  });
});
