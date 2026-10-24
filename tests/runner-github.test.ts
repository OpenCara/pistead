import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { AuthorizationRequest, GitHubIssueRequest, GitHubIssueResult, GitHubIssueView, GitHubMergeRequest, GitHubReadRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
const head = "c".repeat(40);

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "GitHub", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "github_read", "github_merge"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
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

/** The card a tool call waits on for a person's decision. */
async function pendingApproval(session: RunnerSession) {
  for (let count = 0; count < 1000; count++) {
    const approval = (await session.view()).approvals.find(candidate => candidate.status === "pending");
    if (approval) return approval;
    await delay(20);
  }
  assert.fail("no pending approval");
}

test("agents read GitHub pull requests through the broker and merges always wait for a human, failing definitely only on GitHub's refusal", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-github-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reads: GitHubReadRequest[] = [];
  const merges: GitHubMergeRequest[] = [];
  let merge = async (): Promise<{ sha: string; url: string }> => ({ sha: "d".repeat(40), url: "https://github.com/acme/alpha/pull/7" });
  const view: GitHubIssueView = { repository: "acme/alpha", number: 7, url: "https://github.com/acme/alpha/pull/7", title: "Fix the parser", state: "open",
    author: "alice", createdAt: "2026-10-01T00:00:00Z", body: "", labels: [], comments: [] };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("github_read", { repository: "ACME/Alpha", issue: 7 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_read", { repository: "acme/beta", issue: 1 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: "c0ffee", method: "squash" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "squash" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Merge requested."),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "rebase" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Merge requested."),
    fauxAssistantMessage([fauxToolCall("github_merge", { repository: "acme/alpha", pull: 7, sha: head, method: "merge" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Merge requested."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-github-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    githubRead: async request => {
      reads.push(request);
      if (request.repository.toLowerCase() !== "acme/alpha") throw new RunnerError(403, "acme/beta is not a GitHub repository of this workspace");
      return view;
    },
    githubMerge: async request => { merges.push(request); return merge(); },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "github-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));

  // Even an auto-approve message reads at once but only asks to merge.
  const admissionId = await sha256("github admission");
  await session.submit(await ticket(id, "submit"), { content: "Read the review and merge.", requestId: "auto", admissionId, options: { access: "auto" } }, "write");
  await pendingApproval(session);
  // The name as written and the message's admission reach the broker, which decides whether the workspace has it.
  assert.equal(reads.length, 2);
  assert.deepEqual({ ...reads[0], callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, repository: "ACME/Alpha", issue: 7 });
  assert.match(reads[0]!.callId, /^[A-Za-z0-9_-]+$/);
  const transcript = (await session.view()).entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /Fix the parser/);
  assert.match(transcript, /acme\/beta is not a GitHub repository of this workspace/);
  assert.match(transcript, /full 40-character head commit/);
  const approvals = (await session.view()).approvals;
  assert.equal(approvals.length, 1, "an abbreviated head commit never becomes an approval");
  const squash = approvals[0]!;
  assert.equal(squash.status, "pending");
  assert.equal(squash.automatic, undefined);
  assert.deepEqual(squash.operation, { kind: "github.merge", repository: "acme/alpha", pull: 7, sha: head, method: "squash" });
  assert.deepEqual(Object.keys(squash.operation), ["kind", "repository", "pull", "sha", "method"]);
  assert.deepEqual(merges, []);

  await assert.rejects(session.decide(await ticket(id, "approve"), squash.id, { decision: "approve", operation: squash.operation }), /broker capability/);
  const executed = await session.decide(await ticket(id, "approve"), squash.id, { decision: "approve", operation: squash.operation, brokerCapability: "capability-1" });
  assert.equal(executed.status, "executed");
  assert.deepEqual(JSON.parse(executed.result!), { merged: true, sha: "d".repeat(40), url: "https://github.com/acme/alpha/pull/7" });
  assert.deepEqual(merges, [{ sessionId: id, actorId: "test:alice", approvalId: squash.id, capability: "capability-1", repository: "acme/alpha", pull: 7, sha: head, method: "squash" }]);
  await idle(session);
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes('\\"merged\\":true')), "the agent learns the merge went through");

  // GitHub's refusal is definite, so the agent sees its reason; any other failure leaves the outcome open.
  for (const [requestId, failure, status, result] of [
    ["refused", new RunnerError(422, "GitHub did not merge acme/alpha#7: Head branch was modified. Review and try the merge again."), "failed", "GitHub did not merge acme/alpha#7: Head branch was modified. Review and try the merge again."],
    ["unknown", new RunnerError(502, "GitHub could not confirm the outcome."), "interrupted", "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."],
  ] as const) {
    merge = async () => { throw failure; };
    await session.submit(await ticket(id, "submit"), { content: "Merge again.", requestId, admissionId }, "write");
    const pending = await pendingApproval(session);
    const decided = await session.decide(await ticket(id, "approve"), pending.id, { decision: "approve", operation: pending.operation, brokerCapability: `capability-${requestId}` });
    assert.deepEqual([decided.status, decided.result], [status, result]);
    await idle(session);
  }
  assert.equal(merges.length, 3);
});

test("agents open GitHub issues through the broker, always after a human approves the exact title and body", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-github-issue-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issues: GitHubIssueRequest[] = [];
  let open = async (): Promise<GitHubIssueResult> => ({ number: 63, url: "https://github.com/acme/alpha/issues/63" });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Two\nlines", body: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "https://github.com/acme/alpha", title: "A URL", body: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Sandbox has no CA certificates", body: "## Summary\n\nHTTPS fails." })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Issue requested."),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Again", body: "" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Issue requested."),
    fauxAssistantMessage([fauxToolCall("github_issue", { repository: "acme/alpha", title: "Once more", body: "" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Issue requested."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-github-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    githubIssue: async request => { issues.push(request); return open(); },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "github-issue-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: [...base.agent.tools, "github_issue"] } }, await ticket(id, "create"));

  // Even an auto-approve message only asks to open the issue; a multi-line title or a URL never becomes a card.
  const admissionId = await sha256("github issue admission");
  await session.submit(await ticket(id, "submit"), { content: "File the bug.", requestId: "auto", admissionId, options: { access: "auto" } }, "write");
  const pending = await pendingApproval(session);
  const transcript = (await session.view()).entries.map(entry => entry.text).join("\n");
  assert.match(transcript, /title must be one non-empty line/);
  assert.match(transcript, /repository must be a github\.com owner\/name/);
  assert.equal((await session.view()).approvals.length, 1);
  assert.equal(pending.automatic, undefined);
  assert.deepEqual(pending.operation, { kind: "github.issue", repository: "acme/alpha", title: "Sandbox has no CA certificates", body: "## Summary\n\nHTTPS fails." });
  assert.deepEqual(Object.keys(pending.operation), ["kind", "repository", "title", "body"]);
  assert.deepEqual(issues, []);

  await assert.rejects(session.decide(await ticket(id, "approve"), pending.id, { decision: "approve", operation: pending.operation }), /broker capability/);
  const executed = await session.decide(await ticket(id, "approve"), pending.id, { decision: "approve", operation: pending.operation, brokerCapability: "capability-1" });
  assert.equal(executed.status, "executed");
  assert.deepEqual(JSON.parse(executed.result!), { number: 63, url: "https://github.com/acme/alpha/issues/63" });
  assert.deepEqual(issues, [{ sessionId: id, actorId: "test:alice", approvalId: pending.id, capability: "capability-1", repository: "acme/alpha",
    title: "Sandbox has no CA certificates", body: "## Summary\n\nHTTPS fails." }]);
  await idle(session);
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes("issues/63")), "the agent learns the issue's URL");

  // GitHub's refusal is definite, so the agent sees its reason; any other failure leaves the outcome open.
  for (const [requestId, failure, status, result] of [
    ["refused", new RunnerError(422, "GitHub did not open an issue in acme/alpha: Issues are disabled for this repo."), "failed", "GitHub did not open an issue in acme/alpha: Issues are disabled for this repo."],
    ["unknown", new RunnerError(502, "GitHub could not confirm the outcome."), "interrupted", "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."],
  ] as const) {
    open = async () => { throw failure; };
    await session.submit(await ticket(id, "submit"), { content: "File another.", requestId, admissionId }, "write");
    const card = await pendingApproval(session);
    const decided = await session.decide(await ticket(id, "approve"), card.id, { decision: "approve", operation: card.operation, brokerCapability: `capability-${requestId}` });
    assert.deepEqual([decided.status, decided.result], [status, result]);
    await idle(session);
  }
  assert.equal(issues.length, 3);
});

test("host_bash auto-approves only on the session owner's own host; shared hosts require their owner's exact decision", hostMode, async t => {
  for (const hostOwner of ["test:alice", "test:bob"]) await t.test(hostOwner, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-host-command-")));
    const faux = fauxProvider({ models: [{ id: "faux-1" }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("host_bash", { command: "printf host-command-marker", timeout_seconds: 10 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Requested."),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const target = binding(`host-command-${hostOwner.split(":")[1]}`);
    target.agent.tools = ["host_bash"];
    target.session.connectorId = target.model.connectorId = "host-connector";
    target.session.connectorOwnerId = target.model.connectorOwnerId = hostOwner;
    const service = new RunnerService({
      dataDir: directory, sharedSecret: "host-command-test-secret-not-for-deployment", controlPlaneUrl: "http://127.0.0.1:8787",
      connectorId: "host-connector", allowFaux: true, unsandboxed: true,
      authorize: async input => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
      resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    });
    await service.initialize();
    t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
    const claims = async (action: RunnerAction, actorId = "test:alice") => ({ ...await ticket(target.session.id, action), actorId, connectorId: "host-connector" });
    const session = await service.provision(target, await claims("create"));
    await session.submit(await claims("submit"), { content: "Run on host", requestId: "host", admissionId: await sha256("host-command-admission"), options: { access: "auto" } }, "write");
    if (hostOwner === "test:alice") {
      await idle(session);
      // The host's owner auto-approved it: no card, its call is marked and its result is in the transcript.
      const view = await session.view();
      assert.deepEqual(view.approvals, []);
      assert.deepEqual(view.entries.flatMap(entry => entry.autoApproved ?? []), [{ tool: "host_bash", status: "executed" }]);
      assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes('"automatic":true') && entry.text.includes("host-command-marker")));
    } else {
      const approval = await pendingApproval(session);
      assert.equal(approval.status, "pending");
      assert.equal(approval.automatic, undefined);
      await assert.rejects(session.decide(await claims("approve"), approval.id, { decision: "approve", operation: approval.operation }), /host owner/);
      await assert.rejects(session.decide(await claims("approve", hostOwner), approval.id, {
        decision: "approve", operation: { kind: "host.bash", command: "printf changed", timeoutSeconds: 10 },
      }), /mismatch/);
      await session.decide(await claims("approve", hostOwner), approval.id, { decision: "approve", operation: approval.operation });
      await idle(session);
      const settled = (await session.view()).approvals[0]!;
      assert.equal(settled.status, "executed");
      assert.equal(settled.decidedBy, hostOwner);
      assert.match(settled.result!, /host-command-marker/);
      await assert.rejects(session.decide(await claims("approve", hostOwner), approval.id, { decision: "approve", operation: approval.operation }), /already been decided/);
    }
  });
});
