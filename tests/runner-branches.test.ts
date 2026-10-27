import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import type { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket, SessionBranch } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Branches", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

test("a clone session on the host reports its clones' branches of the workspace's GitHub repositories once the agent stops", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-branches-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([fauxAssistantMessage("Opened a pull request."), fauxAssistantMessage("Nothing changed.")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: [string, SessionBranch[]][] = [];
  const grant = { policy: { mode: "off" as const, domains: [], packageRegistries: true },
    repositories: [{ bindingId: "repo-1", provider: "github" as const, host: "github.com", repositoryId: "1", fullName: "acme/alpha" }] };
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-branches-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    egressGrant: async () => grant,
    reportActivity: async () => {},
    reportBranches: async (sessionId, branches) => { reports.push([sessionId, branches]); },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "branches-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const reported = async (count: number) => {
    for (let attempt = 0; attempt < 250 && reports.length < count; attempt++) await delay(20);
    assert.equal(reports.length, count, `reports so far: ${JSON.stringify(reports)}`);
  };
  // Opened with no clone yet.
  await reported(1);
  assert.deepEqual(reports[0], [id, []]);

  // The agent clones and switches to a branch with the host's own Git; then it stops.
  const git = join((session.sandbox as HostWorkspace).worktree, "alpha", ".git");
  await mkdir(join(git, "refs", "remotes", "origin"), { recursive: true });
  await writeFile(join(git, "HEAD"), "ref: refs/heads/fix-parser\n");
  await writeFile(join(git, "config"), '[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n');
  await writeFile(join(git, "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
  await session.submit(await ticket(id, "submit"), { content: "Fix the parser and open a pull request.", requestId: "first" }, "write");
  await idle(session);
  await reported(2);
  assert.deepEqual(reports[1], [id, [{ repository: "acme/alpha", branch: "fix-parser" }]]);

  // Unchanged branches aren't reported again.
  await session.submit(await ticket(id, "submit"), { content: "Anything else?", requestId: "second" }, "write");
  await idle(session);
  await delay(600);
  assert.equal(reports.length, 2);
});
