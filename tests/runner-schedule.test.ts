import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { AuthorizationRequest, PermissionRequest, RunnerAction, RunnerBinding, RunnerTicket, ScheduleToolRequest, SessionSchedule } from "../packages/shared/src/types.js";
import { scheduleToolTarget } from "../packages/shared/src/cron.js";
import { sha256 } from "../packages/shared/src/crypto.js";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Schedules", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    // A session from before the schedule tool: its agent lacks it.
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction, actorId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

async function pendingApproval(session: RunnerSession) {
  for (let count = 0; count < 1000; count++) {
    const approval = (await session.view()).approvals.find(candidate => candidate.status === "pending");
    if (approval) return approval;
    await delay(20);
  }
  assert.fail("no pending approval");
}

test("the agent schedules prompts from the chat for the session owner, never adding access its message lacked", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-schedule-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: ScheduleToolRequest[] = [];
  const schedule = { id: "schedule-1", name: "Check the build", cron: "0 9 * * 1-5", timeZone: "Europe/Berlin", access: "approval", enabled: true } as SessionSchedule;
  const create = { action: "create", message: "Check the build", cron: "0 9 * * 1-5", time_zone: "Europe/Berlin" };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("schedule", create)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Scheduled."),
    fauxAssistantMessage([fauxToolCall("schedule", { ...create, access: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not allowed."),
    fauxAssistantMessage([fauxToolCall("schedule", { action: "list" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not allowed."),
    fauxAssistantMessage([fauxToolCall("schedule", { action: "update", id: "schedule-1", enabled: false })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Paused."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-schedule-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    schedules: async request => { requests.push(request); return { schedule: { ...schedule, enabled: request.enabled ?? true } }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "schedule-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const admissionId = await sha256("schedule admission");
  const transcript = async () => (await session.view()).entries.map(entry => entry.text).join("\n");

  // The agent lacks the tool, so the owner allows this one call, seeing exactly what it schedules.
  await session.submit(await ticket(id, "submit"), { content: "Every weekday at nine, check the build.", requestId: "create", admissionId }, "write");
  const permission = await pendingApproval(session);
  const fields = { cron: "0 9 * * 1-5", timeZone: "Europe/Berlin", content: "Check the build" };
  assert.equal((permission.operation as PermissionRequest).tool, "schedule");
  assert.equal((permission.operation as PermissionRequest).target, scheduleToolTarget({ action: "create", ...fields }));
  assert.equal(requests.length, 0, "nothing is scheduled before the owner allows it");
  await session.decide(await ticket(id, "approve"), permission.id, { decision: "approve", operation: permission.operation });
  await idle(session);
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...requests[0], callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "create", ...fields });
  assert.match(requests[0]!.callId, /^[A-Za-z0-9_-]+$/);
  assert.match(await transcript(), /schedule-1/);

  // Without the owner's Auto-approve, an auto-approved schedule is refused before it reaches the control plane.
  await session.submit(await ticket(id, "submit"), { content: "Schedule it with auto-approve.", requestId: "auto", admissionId }, "write");
  await idle(session);
  assert.match(await transcript(), /Only a message the session owner sent with auto-approve schedules an auto-approved prompt/);
  // A collaborator's message schedules nothing: each run would be the owner's.
  await session.submit(await ticket(id, "submit", "test:bob"), { content: "What is scheduled?", requestId: "bob", admissionId: await sha256("bob admission") }, "write");
  await idle(session);
  assert.match(await transcript(), /Only the session owner's messages schedule prompts/);
  assert.equal(requests.length, 1);

  // The owner's Auto-approve message needs no permission card.
  await session.submit(await ticket(id, "submit"), { content: "Pause it.", requestId: "pause", admissionId, options: { access: "auto" } }, "write");
  await idle(session);
  assert.equal(requests.length, 2);
  assert.deepEqual({ ...requests[1], callId: undefined }, { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "update", scheduleId: "schedule-1", enabled: false });
  assert.equal((await session.view()).approvals.filter(approval => approval.status === "pending").length, 0);
});
