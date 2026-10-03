import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import type { SessionRepository } from "../packages/shared/src/repositories.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

// Host mode needs only Git on PATH, so it runs on macOS and Linux alike.
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const authorize: SandboxAuthorize = async () => {};
const pin: SessionRepository = { bindingId: "binding-alpha", repositoryId: 101, fullName: "acme/alpha", path: "acme/alpha", ref: "main", commit: "a".repeat(40) };

function binding(id: string, repositories: SessionRepository[] = []): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Host mode", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: { APP_TEAM: "core" }, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "git_commit", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

async function hostWorkspace(t: TestContext, repositories: SessionRepository[] = []): Promise<{ workspace: HostWorkspace; outside: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-host-")));
  const workspace = new HostWorkspace(binding("host-session", repositories), join(directory, "session"));
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.initialize();
  return { workspace, outside: directory };
}

/** Minimal ustar writer: one header block per entry plus padded body and terminator. */
function tarGz(entries: { name: string; body?: string | Buffer; type?: "0" | "2" | "5"; link?: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(entry.type ?? "0", 156);
    if (entry.link) header.write(entry.link, 157, "utf8");
    header.write("ustar\0" + "00", 257, "latin1");
    header.fill(32, 148, 156);
    header.write(`${header.reduce((sum: number, byte: number) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("the Linux sandbox never falls back to host execution on other platforms", { skip: process.platform === "linux" }, () => {
  assert.throws(() => new Sandbox(binding("implicit"), join(tmpdir(), "pistead-implicit")), /requires Linux/);
});

test("unsandboxed file tools stay inside the session worktree", hostMode, async t => {
  const { workspace, outside } = await hostWorkspace(t);
  await workspace.writeFile("notes/plan.md", "inside", authorize);
  assert.equal(await workspace.readFile("notes/plan.md", authorize), "inside");
  assert.equal(await readFile(join(workspace.worktree, "notes/plan.md"), "utf8"), "inside");
  assert.deepEqual(await workspace.listFiles(".", authorize), [".git", "notes"]);
  await writeFile(join(outside, "secret.txt"), "host secret");
  await symlink(outside, join(workspace.worktree, "escape"));
  for (const path of ["../secret.txt", "../../secret.txt", "/etc/hosts", ".git/config", "escape/secret.txt", "notes/../../secret.txt"]) {
    await assert.rejects(workspace.writeFile(path, "overwritten", authorize), `write ${path}`);
  }
  await assert.rejects(workspace.readFile("escape/secret.txt", authorize), /escapes the worktree/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "host secret");
});

test("approved unsandboxed commands run in the worktree without the connector environment", hostMode, async t => {
  const { workspace } = await hostWorkspace(t);
  process.env.PISTEAD_CONNECTOR_SECRET = "must-not-leak";
  t.after(() => { delete process.env.PISTEAD_CONNECTOR_SECRET; });
  const output = await workspace.execute({ kind: "bash", command: 'pwd; echo "${PISTEAD_CONNECTOR_SECRET:-unset} $APP_TEAM"' }, false, authorize);
  assert.equal(output, `${workspace.worktree}\nunset core\n`);
  await assert.rejects(workspace.execute({ kind: "bash", command: "true" }, true, authorize), /read-only/);
  await assert.rejects(workspace.execute({ kind: "bash", command: "exit 3" }, false, authorize), /exit 3/);
  await workspace.writeFile("README.md", "hello", authorize);
  await workspace.execute({ kind: "git.commit", message: "Owner commit" }, false, authorize);
  const log = await workspace.execute({ kind: "bash", command: "git log -1 --format='%an <%ae>|%cn <%ce>|%s'" }, false, authorize);
  assert.equal(log.trim(), "Alice Owner <alice@example.test>|Alice Owner <alice@example.test>|Owner commit");
  const snapshot = await workspace.snapshot(authorize);
  assert.ok(snapshot.some(file => file.path === "worktree/README.md" && Buffer.from(file.data, "base64").toString() === "hello"));
  assert.ok(snapshot.some(file => file.path === "owner.gitconfig"));
});

test("unsandboxed repository caches unpack pinned archives once and refuse unsafe archives", hostMode, async t => {
  const { workspace } = await hostWorkspace(t, [pin]);
  assert.equal(await workspace.repositoryCachesReady([pin], authorize), false);
  await assert.rejects(workspace.readFile("acme/alpha/README.md", authorize), /not prepared/);
  for (const unsafe of [
    [{ name: "alpha-main/", type: "5" as const }, { name: "alpha-main/../escape.txt", body: "x" }],
    [{ name: "alpha-main/", type: "5" as const }, { name: "alpha-main/.git/config", body: "x" }],
    [{ name: "alpha-main/", type: "5" as const }, { name: "other-root/file.txt", body: "x" }],
    [{ name: "alpha-main/", type: "5" as const }, { name: "alpha-main/escape", type: "2" as const, link: "../../outside.txt" }],
    [{ name: "alpha-main/", type: "5" as const }, { name: "alpha-main/abs", type: "2" as const, link: "/etc/hosts" }],
    [{ name: "alpha-main/", type: "5" as const }, { name: "alpha-main/dangling", type: "2" as const, link: "missing.txt" }],
    [{ name: "alpha-main/", type: "5" as const }, { name: "alpha-main/lib", type: "5" as const }, { name: "alpha-main/dir-link", type: "2" as const, link: "lib" }],
  ]) {
    await assert.rejects(workspace.materializeRepositories([pin], [tarGz(unsafe)], authorize));
    assert.equal(await workspace.repositoryCachesReady([pin], authorize), false, "a rejected archive changes nothing");
  }
  // GitHub archives vendor multi-MiB binaries and relative library symlinks (libfoo.5.dylib -> libfoo.5.0.0.dylib).
  const binary = Buffer.alloc(3 * 1024 * 1024, 7);
  await workspace.materializeRepositories([pin], [tarGz([
    { name: "alpha-main/", type: "5" }, { name: "alpha-main/README.md", body: "pinned" }, { name: "alpha-main/src/index.ts", body: "export {};" },
    { name: "alpha-main/lib/libfoo.5.dylib", type: "2", link: "libfoo.5.0.0.dylib" }, { name: "alpha-main/lib/libfoo.5.0.0.dylib", body: binary },
    { name: "alpha-main/docs/readme-link", type: "2", link: "../README.md" },
  ])], authorize);
  const copy = await lstat(join(workspace.worktree, "acme/alpha/lib/libfoo.5.dylib"));
  assert.ok(copy.isFile() && !copy.isSymbolicLink() && copy.size === binary.length, "in-repository symlinks become regular file copies");
  assert.equal(await workspace.readFile("acme/alpha/docs/readme-link", authorize), "pinned");
  assert.equal(await workspace.repositoryCachesReady([pin], authorize), true);
  assert.equal(await workspace.readFile("acme/alpha/README.md", authorize), "pinned");
  await workspace.writeFile("acme/alpha/README.md", "edited", authorize);
  await workspace.materializeRepositories([pin], [tarGz([{ name: "alpha-main/", type: "5" }, { name: "alpha-main/README.md", body: "reset" }])], authorize);
  assert.equal(await workspace.readFile("acme/alpha/README.md", authorize), "edited", "a ready cache never overwrites edits");
});
