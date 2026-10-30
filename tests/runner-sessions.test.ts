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
import type { AuthorizationRequest, PermissionRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { audienceTarget, sessionsToolTarget, type SessionsToolRequest, type SessionsToolResult } from "../packages/shared/src/cross-session.js";
import { sha256 } from "../packages/shared/src/crypto.js";

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Coordinator", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    // A session from before the sessions tool: its agent lacks it.
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

async function pendingApproval(session: RunnerSession, id?: RegExp) {
  for (let count = 0; count < 1000; count++) {
    const approval = (await session.view()).approvals.find(candidate => candidate.status === "pending" && (!id || id.test(candidate.id)));
    if (approval) return approval;
    await delay(20);
  }
  assert.fail("no pending approval");
}

test("the agent works with other sessions through the control plane, asking the owner for the tool, a Read-only message's changes and a wider audience", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-sessions-tool-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: SessionsToolRequest[] = [];
  const answers: SessionsToolResult[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("sessions", { action: "list" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Listed."),
    fauxAssistantMessage([fauxToolCall("sessions", { action: "read", session: "worker" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Read."),
    fauxAssistantMessage([fauxToolCall("sessions", { action: "wait", session: "worker", message_id: "m1", timeout_seconds: 60 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Waited."),
    fauxAssistantMessage([fauxToolCall("sessions", { action: "send", session: "worker", message: "Go", access: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not allowed."),
    fauxAssistantMessage([fauxToolCall("sessions", { action: "send", session: "worker", message: "Go" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Sent."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-sessions-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    crossSessions: async request => { requests.push(request); return answers.shift() ?? { sessions: [], models: [] }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "sessions-tool-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const admissionId = await sha256("sessions admission");
  const transcript = async () => (await session.view()).entries.map(entry => entry.text).join("\n");
  const strip = (request: SessionsToolRequest) => ({ ...request, callId: undefined });

  // The agent lacks the tool: the owner allows it for the rest of the session, seeing exactly what the call does.
  await session.submit(await ticket(id, "submit"), { content: "Which sessions are there?", requestId: "list", admissionId }, "write");
  const toolCard = await pendingApproval(session);
  assert.deepEqual(toolCard.operation, { kind: "permission", tool: "sessions", target: "list", needs: ["tool"] });
  assert.equal(requests.length, 0, "nothing reaches the control plane before the owner allows it");
  await session.decide(await ticket(id, "approve"), toolCard.id, { decision: "approve", operation: toolCard.operation, scope: "session" });
  await idle(session);
  assert.deepEqual(strip(requests[0]!), { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "list" });

  // The control plane says the read would show this session's readers a session they can't open: a second card, of
  // the same call, asks for that alone, and the call is made again once the owner allows it.
  const target = audienceTarget({ id: "worker", title: "Worker" });
  answers.push({ consent: "audience", target, reason: "This session's readers include people who can't read that session." },
    { session: { id: "worker", title: "Worker", ownerId: "test:alice", status: "ready", visibility: "private", permissions: ["read"], createdAt: "" }, busy: false, entries: [], pendingApprovals: [] });
  await session.submit(await ticket(id, "submit"), { content: "Read the worker.", requestId: "read", admissionId }, "write");
  const audienceCard = await pendingApproval(session, /_audience$/);
  assert.deepEqual(audienceCard.operation, { kind: "permission", tool: "sessions", target, needs: ["audience"] });
  await session.decide(await ticket(id, "approve"), audienceCard.id, { decision: "approve", operation: audienceCard.operation });
  await idle(session);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]!.callId, requests[2]!.callId, "the same call, again");
  assert.deepEqual(strip(requests[2]!), { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "read", targetSessionId: "worker" });
  assert.equal(audienceCard.id, `permission-${requests[2]!.callId}_audience`);

  // A wait reads the message's outcome until it is done.
  const read = (done: boolean): SessionsToolResult => ({ session: { id: "worker", title: "Worker", ownerId: "test:alice", status: "ready", visibility: "private", permissions: ["read"], createdAt: "" },
    busy: !done, entries: [{ id: "0:1", role: "assistant", kind: "message", text: "hidden" }], pendingApprovals: [],
    outcome: done ? { status: "settled", done: true, reply: "All green." } : { status: "running", done: false } });
  answers.push(read(false), read(true));
  await session.submit(await ticket(id, "submit"), { content: "Wait for it.", requestId: "wait", admissionId }, "write");
  await idle(session);
  assert.deepEqual(requests.slice(3).map(strip), [1, 2].map(() => ({ sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "read", targetSessionId: "worker", messageId: "m1", limit: 1 })));
  assert.match(await transcript(), /All green\./);
  assert.doesNotMatch(await transcript(), /hidden/, "a wait returns the outcome, not the transcript");

  // An auto-approved message only from the owner's own auto-approve message.
  await session.submit(await ticket(id, "submit"), { content: "Send it with auto-approve.", requestId: "auto", admissionId }, "write");
  await idle(session);
  assert.match(await transcript(), /Only a message the session owner sent with auto-approve sends an auto-approved message/);
  assert.equal(requests.length, 5);

  // A Read-only message changes another session only once the owner allows it.
  answers.push({ message: { id: "m2", kind: "send", originSessionId: id, targetSessionId: "worker", actorId: "test:alice", submissionId: "s", conversationId: "0", hops: 1, createdAt: "" } });
  await session.submit(await ticket(id, "submit"), { content: "Tell the worker to go.", requestId: "read-only", admissionId, options: { access: "read" } }, "write");
  const writeCard = await pendingApproval(session);
  assert.deepEqual(writeCard.operation, { kind: "permission", tool: "sessions", target: sessionsToolTarget({ action: "send", targetSessionId: "worker", message: "Go" }), needs: ["write"] });
  await session.decide(await ticket(id, "approve"), writeCard.id, { decision: "approve", operation: writeCard.operation });
  await idle(session);
  assert.deepEqual(strip(requests[5]!), { sessionId: id, actorId: "test:alice", admissionId, callId: undefined, action: "send", targetSessionId: "worker", message: "Go" });
  assert.match(await transcript(), /"m2"/);
});
