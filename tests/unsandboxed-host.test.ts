import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

// Host mode needs only Python 3 and Git, so it runs on macOS and Linux alike.
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || !existsSync("/usr/bin/python3") || !existsSync("/usr/bin/git") };
const authorize: SandboxAuthorize = async () => {};

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Host mode", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: { APP_TEAM: "core" }, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "git_commit", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

async function hostSandbox(t: TestContext): Promise<{ sandbox: Sandbox; outside: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-host-")));
  const sandbox = new Sandbox(binding("host-session"), join(directory, "session"), undefined, { unsandboxed: true });
  t.after(async () => { await sandbox.close(); await rm(directory, { recursive: true, force: true }); });
  await sandbox.initialize();
  return { sandbox, outside: directory };
}

test("the sandbox never falls back to host execution without explicit owner consent", { skip: process.platform === "linux" }, () => {
  assert.throws(() => new Sandbox(binding("implicit"), join(tmpdir(), "pistead-implicit")), /requires Linux/);
});

test("unsandboxed file tools stay inside the session worktree", hostMode, async t => {
  const { sandbox, outside } = await hostSandbox(t);
  await sandbox.writeFile("notes/plan.md", "inside", authorize);
  assert.equal(await sandbox.readFile("notes/plan.md", authorize), "inside");
  assert.equal(await readFile(join(sandbox.worktree, "notes/plan.md"), "utf8"), "inside");
  await writeFile(join(outside, "secret.txt"), "host secret");
  await symlink(outside, join(sandbox.worktree, "escape"));
  for (const path of ["../secret.txt", "../../secret.txt", "/etc/hosts", ".git/config", "escape/secret.txt"]) {
    await assert.rejects(sandbox.writeFile(path, "overwritten", authorize), `write ${path}`);
  }
  await assert.rejects(sandbox.readFile("escape/secret.txt", authorize), "symlinked directories are not followed");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "host secret");
});

test("approved unsandboxed commands run in the worktree without the connector environment", hostMode, async t => {
  const { sandbox } = await hostSandbox(t);
  process.env.PISTEAD_CONNECTOR_SECRET = "must-not-leak";
  t.after(() => { delete process.env.PISTEAD_CONNECTOR_SECRET; });
  const output = await sandbox.execute({ kind: "bash", command: 'pwd; echo "${PISTEAD_CONNECTOR_SECRET:-unset} $APP_TEAM"' }, false, authorize);
  assert.equal(output, `${sandbox.worktree}\nunset core\n`);
  await assert.rejects(sandbox.execute({ kind: "bash", command: "true" }, true, authorize), /read-only/);
  await sandbox.writeFile("README.md", "hello", authorize);
  await sandbox.execute({ kind: "git.commit", message: "Owner commit" }, false, authorize);
  const log = await sandbox.execute({ kind: "bash", command: "git log -1 --format='%an <%ae>|%cn <%ce>|%s'" }, false, authorize);
  assert.equal(log.trim(), "Alice Owner <alice@example.test>|Alice Owner <alice@example.test>|Owner commit");
});
