import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import type { SessionRepository } from "../packages/shared/src/repositories.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

// Host mode needs only Git on PATH, so it runs on macOS and Linux alike.
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const authorize: SandboxAuthorize = async () => {};

function binding(id: string, repositories: SessionRepository[] = []): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Host mode", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: { APP_TEAM: "core" }, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
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
  await workspace.execute({ kind: "bash", command: "git add -A && git commit -q -m 'Owner commit'" }, false, authorize);
  const log = await workspace.execute({ kind: "bash", command: "git log -1 --format='%an <%ae>|%cn <%ce>|%s'" }, false, authorize);
  assert.equal(log.trim(), "Alice Owner <alice@example.test>|Alice Owner <alice@example.test>|Owner commit");
  const snapshot = await workspace.snapshot(authorize);
  assert.ok(snapshot.some(file => file.path === "worktree/README.md" && Buffer.from(file.data, "base64").toString() === "hello"));
  assert.ok(snapshot.some(file => file.path === "owner.gitconfig"));
});

test("an unsandboxed clone session's Git uses the host user's own credential helpers, and no other session's does", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-host-credentials-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The host user's own Git config, in their real HOME (with a quote in its path, to check the helper's quoting).
  const home = join(directory, "host user's home");
  await mkdir(home);
  await writeFile(join(home, ".gitconfig"), "[credential]\n\thelper = \"!f() { test \\\"$1\\\" = get && echo username=host-user && echo password=host-secret; }; f\"\n");
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  const fill = "printf 'protocol=https\\nhost=forge.example\\n\\n' | git credential fill 2>&1 || true";
  const clone = binding("host-clone");
  clone.session.repositoryMode = "clone";
  const cloned = new HostWorkspace(clone, join(directory, "clone"));
  t.after(() => cloned.close());
  await cloned.initialize();
  assert.match(await cloned.execute({ kind: "bash", command: fill }, false, authorize), /username=host-user\npassword=host-secret/);
  // A session from before sessions cloned keeps its owner configuration unchanged, without the host's credentials.
  const plain = new HostWorkspace(binding("host-plain"), join(directory, "plain"));
  t.after(() => plain.close());
  await plain.initialize();
  assert.doesNotMatch(await plain.execute({ kind: "bash", command: fill }, false, authorize), /host-secret/);  // Its backups keep the worktree as files, which a clone's repository has no bound for: they are refused.
  assert.ok((await cloned.snapshot(authorize)).length > 0);
  await cloned.execute({ kind: "bash", command: "git init -q app" }, false, authorize);
  await assert.rejects(cloned.snapshot(authorize), /need a host with the sandbox/);
});

test("a host clone session reads the branches its clones have checked out, as Git leaves them", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-host-branches-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clone = binding("host-branches");
  clone.session.repositoryMode = "clone";
  const workspace = new HostWorkspace(clone, join(directory, "session"));
  t.after(() => workspace.close());
  await workspace.initialize();
  const upstream = join(directory, "upstream");
  await mkdir(upstream);
  const run = (command: string) => workspace.execute({ kind: "bash", command }, false, authorize);
  await run(`git init -q -b main ${upstream} && git -C ${upstream} commit -q --allow-empty -m initial`);
  await run(`git clone -q ${upstream} app && git clone -q ${upstream} other && git -C app switch -q -c fix/parser`);
  assert.deepEqual(await workspace.cloneBranches(authorize), [{ directory: "app", origin: upstream, branch: "fix/parser" }],
    "a clone on its origin's default branch has no pull request of its own");
});
