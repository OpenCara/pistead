import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedBrowse, textPreview } from "../apps/runner/src/file-browser.js";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import { worktreePath } from "../apps/server/src/session-files.js";
import { fileBrowserLimits, type RunnerBinding } from "../packages/shared/src/types.js";

const authorize: SandboxAuthorize = async () => {};
const sandboxed = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(100)]);

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Files", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

type Browser = { worktree: string; browse(path: string, authorize: SandboxAuthorize): ReturnType<Sandbox["browse"]> };

/** Lays out the same files in a worktree, and checks what the file browser makes of them. */
async function exercise(browser: Browser, outside: string): Promise<void> {
  const work = browser.worktree;
  await mkdir(join(work, "src", "deep"), { recursive: true });
  await writeFile(join(work, "src", "a.txt"), "hello\nworld\n");
  // The preview ends inside a two-byte character: it is cut before it.
  await writeFile(join(work, "src", "big.txt"), Buffer.concat([Buffer.alloc(fileBrowserLimits.textBytes - 1, "x"), Buffer.from("é")]));
  await writeFile(join(work, "src", "nul.bin"), Buffer.from("abc\0def"));
  await writeFile(join(work, "src", "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await writeFile(join(work, "src", "image.png"), png);
  await writeFile(join(work, "src", "huge.png"), Buffer.concat([png, Buffer.alloc(fileBrowserLimits.imageBytes)]));
  await writeFile(join(outside, "secret.txt"), "host secret");
  await symlink("src/a.txt", join(work, "inside"));
  await symlink(outside, join(work, "escape"));

  const root = await browser.browse(".", authorize);
  assert.equal(root.type, "directory");
  // Directories first, then by name; symlinks are listed, not followed.
  assert.deepEqual(root.type === "directory" && root.entries.map(entry => [entry.name, entry.type]),
    [[".git", "directory"], ["src", "directory"], ["escape", "symlink"], ["inside", "symlink"]]);
  const src = await browser.browse("src", authorize);
  assert.deepEqual(src.type === "directory" && src.entries.find(entry => entry.name === "a.txt"), { name: "a.txt", type: "file", size: 12 });
  assert.deepEqual(src.type === "directory" && src.entries[0], { name: "deep", type: "directory" });

  assert.deepEqual(await browser.browse("src/a.txt", authorize), { type: "file", size: 12, truncated: false, text: "hello\nworld\n" });
  assert.deepEqual(await browser.browse("inside", authorize), { type: "file", size: 12, truncated: false, text: "hello\nworld\n" });
  const big = await browser.browse("src/big.txt", authorize);
  assert.equal(big.type === "file" && big.truncated, true);
  assert.equal(big.type === "file" && big.text?.length, fileBrowserLimits.textBytes - 1);
  assert.deepEqual(await browser.browse("src/nul.bin", authorize), { type: "file", size: 7, truncated: false, binary: true });
  assert.deepEqual(await browser.browse("src/latin1.txt", authorize), { type: "file", size: 4, truncated: false, binary: true });
  assert.deepEqual(await browser.browse("src/image.png", authorize), { type: "file", size: png.length, truncated: false, image: { mimeType: "image/png", data: png.toString("base64") } });
  assert.deepEqual(await browser.browse("src/huge.png", authorize), { type: "file", size: png.length + fileBrowserLimits.imageBytes, truncated: true, binary: true });

  for (const path of ["escape", "escape/secret.txt", "../secret.txt", "/etc/hosts", "src/../../secret.txt", "missing"]) {
    await assert.rejects(browser.browse(path, authorize), `browse ${path}`);
  }
  await assert.rejects(browser.browse("src", async () => { throw new Error("access revoked"); }), /access revoked/);
}

async function directory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pistead-files-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("the sandboxed file browser lists and previews the worktree, read-only and confined", { skip: !sandboxed }, async t => {
  const base = await directory(t);
  const sandbox = new Sandbox(binding("files-sandbox"), join(base, "session"));
  t.after(() => sandbox.close());
  await sandbox.initialize();
  // The worktree as the host sees it, where the fixture files go; browse reads it inside the sandbox.
  await exercise({ worktree: join(base, "session", "worktree"), browse: (path, check) => sandbox.browse(path, check) }, await directory(t));
});

test("the unsandboxed file browser answers like the sandboxed one", hostMode, async t => {
  const base = await directory(t);
  const workspace = new HostWorkspace(binding("files-host"), join(base, "session"));
  t.after(() => workspace.close());
  await workspace.initialize();
  await exercise(workspace, await directory(t));
});

test("a browse result is checked before it leaves the runner", () => {
  assert.throws(() => checkedBrowse({ type: "file", size: 3, truncated: false, image: { mimeType: "text/html", data: "PGI+" } }));
  assert.throws(() => checkedBrowse({ type: "file", size: 3, truncated: false, text: "a", binary: true }));
  assert.throws(() => checkedBrowse({ type: "directory", entries: [{ name: "../x", type: "file" }], total: 1, truncated: false }));
  assert.throws(() => checkedBrowse({ type: "directory", entries: [], total: 5, truncated: false }));
  assert.deepEqual(checkedBrowse({ type: "directory", entries: [{ name: "a", type: "file", size: 1 }], total: 2, truncated: true }),
    { type: "directory", entries: [{ name: "a", type: "file", size: 1 }], total: 2, truncated: true });
  assert.deepEqual(textPreview(Buffer.from("xé").subarray(0, 2), true), { text: "x" });
  assert.deepEqual(textPreview(Buffer.from("xé").subarray(0, 2), false), { binary: true });
});

test("the control plane asks hosts only for relative worktree paths", () => {
  assert.equal(worktreePath(undefined), ".");
  assert.equal(worktreePath(""), ".");
  assert.equal(worktreePath("./src/"), "src");
  assert.equal(worktreePath("src/a.txt"), "src/a.txt");
  for (const path of ["/etc/hosts", "../x", "a/../b", "a//b", "a/./b", "a\\b", "a\u0000b"]) assert.throws(() => worktreePath(path), path);
});
