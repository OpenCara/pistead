import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { signToken, sha256 } from "../packages/shared/src/crypto.js";
import type { ApprovalRecord, RunnerBinding, RunnerTicket, RunnerAction, Permission, AuthorizationRequest, SessionView } from "../packages/shared/src/types.js";
import { applyViewPatch, isRevision, type SessionViewPatch } from "../packages/shared/src/view-patch.js";
import type { RestoreDescriptor, RestoreInput } from "../packages/shared/src/connector.js";
import { RunnerError, assertId, requestKey, stableJson, validateBinding, validateOperation, verifyRunnerTicket } from "../apps/runner/src/protocol.js";
import { RunnerService, createRunnerApp } from "../apps/runner/src/server.js";
import { RunnerSession } from "../apps/runner/src/session.js";
import { commandLimits, type CommandLimits } from "../apps/runner/src/host-config.js";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { defaultHostConfig } from "../packages/shared/src/host-config.js";
import { acquireRunnerLease } from "../apps/runner/src/lease.js";
import { runnerModels } from "../apps/runner/src/provider.js";

const SECRET = "runner-test-secret-not-a-production-secret-123456";
const allowTestOperation = async (): Promise<void> => {};
function binding(id: string, ownerId = "test:alice"): RunnerBinding {
  const name = ownerId === "test:alice" ? "Alice" : "Bob";
  return {
    session: { id, workspaceId: "workspace", ownerId, agentVersionId: "version-1", title: "Test", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: ownerId, githubId: null, githubLogin: name.toLowerCase(), displayName: name, gitName: name, gitEmail: `${name.toLowerCase()}@example.test`, env: { APP_COLOR: name.toLowerCase() }, githubConnected: false },
    agent: { id: "version-1", agentId: "shared-agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Shared", description: "Tests", instructions: "Use tools.", tools: ["identity", "read_file", "write_file", "list_files", "bash", "github_comment"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "faux-1" },
  };
}
async function ticket(id: string, action: RunnerAction, actorId = "test:alice", body = "", ownerId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body) };
}
async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 500; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}
/** Waits for the session's pending permission request: the card its owner answers. */
async function permissionRequest(session: RunnerSession): Promise<ApprovalRecord> {
  for (let count = 0; count < 500; count++) {
    const request = (await session.view()).approvals.find(approval => approval.operation.kind === "permission" && approval.status === "pending");
    if (request) return request;
    await delay(20);
  }
  assert.fail("no permission request");
}
/** Waits for `count` pending operation cards: the tool calls waiting on a person's decision. */
/** Commands auto-approve ran have no card: the view marks their tool calls instead (see EntryView.autoApproved). */
function autoApproved(view: SessionView) {
  assert.deepEqual(view.approvals.filter(approval => approval.automatic && approval.operation.kind === "bash"), [], "no card repeats an auto-approved command");
  return view.entries.flatMap(entry => entry.autoApproved ?? []);
}
const toolOutput = (view: SessionView, marker: RegExp) => view.entries.some(entry => entry.role === "toolResult" && marker.test(entry.text));

async function operationRequests(session: RunnerSession, count = 1): Promise<ApprovalRecord[]> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const requests = (await session.view()).approvals.filter(approval => approval.operation.kind !== "permission" && approval.status === "pending");
    if (requests.length >= count) return requests;
    await delay(20);
  }
  assert.fail("no operation request");
}
/**
 * Waits for card `id` to settle and returns it as the session keeps it: an approved shell command runs in the background,
 * as host commands do, so deciding reports it executing.
 */
async function settledCard(session: RunnerSession, id: string): Promise<ApprovalRecord> {
  const metadata = () => (session as unknown as { metadata(): Promise<{ approvals: Record<string, ApprovalRecord> }> }).metadata();
  for (let attempt = 0; attempt < 500; attempt++) {
    const card = (await metadata()).approvals[id];
    if (card && !["pending", "approved", "executing"].includes(card.status)) return card;
    await delay(20);
  }
  assert.fail("the card did not settle");
}
const rejectedWith = (code: number, message: RegExp) => (error: unknown) => error instanceof RunnerError && error.status === code && message.test(error.message);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "runner-unit-"));
  const grants: Record<string, Permission[]> = { "test:alice": ["read", "ask", "write", "approve", "manage"], "test:bob": ["read", "ask", "write"] };
  const fetcher: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as AuthorizationRequest;
    return Response.json({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 });
  };
  const service = new RunnerService({ dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, allowTestShell: true, fetch: fetcher });
  await service.initialize();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, grants };
}

test("signed runner tickets bind action, body, audience, owner/session and expiry", async () => {
  const body = JSON.stringify({ content: "TEST_IDENTITY", requestId: "a" });
  const claims = await ticket("session-a", "submit", "test:alice", body);
  const token = await signToken(claims, SECRET);
  assert.deepEqual(await verifyRunnerTicket(token, SECRET, "submit", "session-a", body), claims);
  await assert.rejects(verifyRunnerTicket(token, SECRET, "ask", "session-a", body));
  await assert.rejects(verifyRunnerTicket(token, SECRET, "submit", "session-b", body));
  await assert.rejects(verifyRunnerTicket(token, SECRET, "submit", "session-a", `${body} `));
  await assert.rejects(verifyRunnerTicket(token, SECRET, "submit", "session-a", body, (claims.exp + 1) * 1000));
  const wrongAud = await signToken({ ...claims, aud: "worker" }, SECRET);
  await assert.rejects(verifyRunnerTicket(wrongAud, SECRET, "submit", "session-a", body));
});

test("path IDs, exact operations and composite dedup keys cannot collide", async () => {
  for (const value of ["../escape", "a/b", "a%2fb", "", ".", "x\\y"]) assert.throws(() => assertId(value));
  assert.equal(assertId("session_1-abc"), "session_1-abc");
  assert.notEqual(await requestKey("alice", "write", "id"), await requestKey("bob", "write", "id"));
  assert.notEqual(await requestKey("alice", "write", "id"), await requestKey("alice", "ask", "id"));
  assert.throws(() => validateOperation({ kind: "git.commit", message: "ok", hidden: true }));
  assert.throws(() => validateOperation({ kind: "github.comment", repository: "../escape/repo", issue: 1, body: "x" }));
  // Issues: a one-line title, a body that may be empty, and nothing else (labels, assignees) to approve unseen.
  const issue = { kind: "github.issue", repository: "owner/repo", title: "Bug", body: "" };
  assert.deepEqual(validateOperation(issue), issue);
  for (const invalid of [{ ...issue, title: "Two\nlines" }, { ...issue, title: " " }, { ...issue, title: "x".repeat(257) }, { ...issue, body: "x".repeat(60001) },
    { ...issue, body: "nul\0" }, { ...issue, repository: "https://github.com/owner/repo" }, { ...issue, labels: ["bug"] }]) assert.throws(() => validateOperation(invalid));
  assert.throws(() => validateBinding({ ...binding("a"), owner: { ...binding("a").owner, env: { APP_TOKEN: "no" } } }, "a"));
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  const native = binding("native");
  native.model.provider = "local-provider";
  native.session.connectorId = native.model.connectorId = "connector-a";
  native.session.connectorOwnerId = native.model.connectorOwnerId = "test:host";
  assert.throws(() => validateBinding(native, "native"));
  assert.equal(validateBinding(native, "native", true).model.provider, "local-provider");
  assert.throws(() => validateBinding({ ...native, model: { ...native.model, connectorId: "other" } }, "native", true));
  assert.throws(() => validateBinding({ ...native, model: { ...native.model, provider: "../provider" } }, "native", true));
});

test("unsigned HTTP session calls fail closed before opening a harness", async t => {
  const { service } = await fixture(t);
  const app = createRunnerApp(service);
  const response = await app.request("/v1/sessions/unknown/view");
  assert.equal(response.status, 401);
});

test("a view request naming a revision gets only what changed since it", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("revision-session"), await ticket("revision-session", "create"));
  const app = createRunnerApp(service);
  const get = async (path: string) => {
    const response = await app.request(path, { headers: { authorization: `Bearer ${await signToken(await ticket("revision-session", "view"), SECRET)}` } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ view?: SessionView; revision?: string; patch?: SessionViewPatch }>;
  };
  const whole = await get("/v1/sessions/revision-session/view");
  assert.ok(isRevision(whole.revision));
  assert.deepEqual(await get(`/v1/sessions/revision-session/view/${whole.revision}`), { patch: { base: whole.revision, revision: whole.revision } });
  await session.submit(await ticket("revision-session", "submit"), { content: "TEST_IDENTITY", requestId: "revision" }, "write");
  await idle(session);
  const { patch } = await get(`/v1/sessions/revision-session/view/${whole.revision}`);
  assert.ok(patch && patch.revision !== whole.revision);
  const latest = await get("/v1/sessions/revision-session/view");
  assert.equal(latest.revision, patch.revision);
  assert.deepEqual(applyViewPatch(whole.view!, patch), latest.view);
  // A revision the runner never issued gets the whole view.
  assert.deepEqual(await get(`/v1/sessions/revision-session/view/${"f".repeat(32)}`), latest);
  for (const path of ["view/abc", `view/${"A".repeat(32)}`, `view/${whole.revision}/x`]) {
    const response = await app.request(`/v1/sessions/revision-session/${path}`, { headers: { authorization: `Bearer ${await signToken(await ticket("revision-session", "view"), SECRET)}` } });
    assert.equal(response.status, 404, path);
  }
});

test("real pi faux sessions isolate owners and retain actor attribution", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  grants["test:bob"] = ["read", "ask", "write", "approve", "manage"];
  const alice = await service.provision(binding("alice-session"), await ticket("alice-session", "create"));
  const bob = await service.provision(binding("bob-session", "test:bob"), await ticket("bob-session", "create", "test:bob", "", "test:bob"));
  await alice.submit(await ticket("alice-session", "submit", "test:bob"), { content: "TEST_IDENTITY", requestId: "same" }, "write");
  await bob.submit(await ticket("bob-session", "submit", "test:bob", "", "test:bob"), { content: "TEST_IDENTITY", requestId: "same" }, "write");
  await Promise.all([idle(alice), idle(bob)]);
  const aliceView = await alice.view();
  const bobView = await bob.view();
  assert.ok(aliceView.entries.some(entry => entry.text.includes('"actingAs":"test:alice"') && entry.text.includes('"initiatedBy":"test:bob"')));
  assert.ok(bobView.entries.some(entry => entry.text.includes('"actingAs":"test:bob"')));
  assert.notEqual(alice.sandbox.home, bob.sandbox.home);
  assert.notEqual(alice.sandbox.worktree, bob.sandbox.worktree);
  assert.ok(aliceView.entries.filter(entry => entry.role === "user").every(entry => entry.actorId === "test:bob"));
});

test("read-only durable ask inherits transcript but cannot write; restart preserves dedup", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("readonly-session"), await ticket("readonly-session", "create"));
  const input = { content: "TEST_WRITE evidence.txt\noriginal", requestId: "stable" };
  const submitTicket = await ticket("readonly-session", "submit");
  const original = await session.submit(submitTicket, input, "write");
  await idle(session);
  const ask = await session.submit(await ticket("readonly-session", "ask", "test:bob"), { content: "TEST_WRITE evidence.txt\nchanged", requestId: "stable" }, "ask");
  assert.notEqual(ask.conversationId, original.conversationId);
  await idle(session);
  assert.equal(await session.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  assert.ok((await session.view()).entries.some(entry => entry.conversationId === ask.conversationId && entry.text.includes("Denied:")));
  await session.restart();
  const duplicate = await session.submit(await ticket("readonly-session", "submit"), input, "write");
  assert.equal(duplicate.submissionId, original.submissionId);
  await assert.rejects(session.submit(await ticket("readonly-session", "submit"), { ...input, content: "changed" }, "write"));
  await assert.rejects(session.sandbox.readFile("../binding.json", allowTestOperation));
  await assert.rejects(session.sandbox.writeFile(".git/config", "unsafe", allowTestOperation));
});

test("writer cannot self-approve without approve permission; exact authorized operation uses owner git identity", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  const session = await service.provision(binding("approval-session"), await ticket("approval-session", "create"));
  // The session's own Git metadata is read-only to commands; the agent commits in repositories it makes or clones.
  const operation = { kind: "bash" as const, command: "git init -q app && cd app && echo hello > hello.txt && git add -A && git commit -q -m 'Owner identity'" };
  const approval = await session.createApproval("test:bob", operation);
  await assert.rejects(session.decide(await ticket("approval-session", "approve", "test:bob"), approval.id, { decision: "approve", operation }));
  await assert.rejects(session.decide(await ticket("approval-session", "approve"), approval.id, { decision: "approve", operation: { ...operation, command: "true" } }));
  const decided = await session.decide(await ticket("approval-session", "approve"), approval.id, { decision: "approve", operation });
  assert.equal(decided.status, "executing", "an approved command runs in the background");
  const result = await settledCard(session, approval.id);
  assert.equal(result.status, "executed", result.result);
  assert.equal(result.requestedBy, "test:bob");
  assert.equal(result.decidedBy, "test:alice");
  const log = await session.sandbox.execute({ kind: "bash", command: "cd app && git log -1 --format='%an <%ae> / %cn <%ce>'" }, true, allowTestOperation, { allowTestShell: true });
  assert.match(log, /Alice <alice@example.test> \/ Alice <alice@example.test>/);
  await assert.rejects(session.decide(await ticket("approval-session", "approve"), approval.id, { decision: "approve", operation }));
  grants["test:bob"] = ["read"];
  await assert.rejects(session.submit(await ticket("approval-session", "submit", "test:bob"), { content: "TEST_IDENTITY", requestId: "revoked" }, "write"));
});

test("checkpointed backup carries SQLite binding/branches and recovers in a fresh service", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const session = await service.provision(binding("backup-session"), await ticket("backup-session", "create"));
  const request = { content: "TEST_WRITE persisted.txt\nbacked up", requestId: "backup-write" };
  const receipt = await session.submit(await ticket("backup-session", "submit"), request, "write");
  await idle(session);
  const backup = await session.backup(await ticket("backup-session", "backup"));
  assert.equal(backup.format, "pi-runner-backup-v1");
  assert.equal(Buffer.from(backup.sqlite, "base64").subarray(0, 15).toString(), "SQLite format 3");
  const restoreRoot = join(directory, "restored");
  const restoreSession = join(restoreRoot, "sessions", "backup-session");
  await mkdir(restoreSession, { recursive: true, mode: 0o700 });
  await writeFile(join(restoreSession, "binding.json"), JSON.stringify(backup.binding), { mode: 0o600 });
  await writeFile(join(restoreSession, "session.sqlite"), Buffer.from(backup.sqlite, "base64"), { mode: 0o600 });
  for (const file of backup.files) {
    const destination = join(restoreSession, "sandbox", file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.from(file.data, "base64"), { mode: file.mode });
  }
  const restored = new RunnerService({ ...service.config, dataDir: restoreRoot });
  await restored.initialize();
  try {
    const recovered = await restored.get("backup-session");
    assert.equal(await recovered.sandbox.readFile("persisted.txt", allowTestOperation), "backed up");
    const duplicate = await recovered.submit(await ticket("backup-session", "submit"), request, "write");
    assert.equal(duplicate.submissionId, receipt.submissionId);
  } finally { await restored.close(); }
});

test("owner restore publishes a new idle session, drops old authority and leaves source untouched", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const source = await service.provision(binding("restore-source"), await ticket("restore-source", "create"));
  await source.submit(await ticket("restore-source", "submit"), { requestId: "source-write", content: "TEST_WRITE evidence.txt\noriginal" }, "write");
  await idle(source);
  // An allowed permission request is settled history; what it allowed for the rest of the session stays with the source.
  await source.submit(await ticket("restore-source", "submit"), { requestId: "source-read", content: "TEST_WRITE allowed.txt\nonce", options: { access: "read" } }, "write");
  const permission = await permissionRequest(source);
  await source.decide(await ticket("restore-source", "approve"), permission.id, { decision: "approve", operation: permission.operation, scope: "session" });
  await idle(source);
  const approval = await source.createApproval("test:alice", { kind: "bash", command: "echo must-not-replay" });
  const oldTicket = await ticket("restore-source", "operations");
  await source.consumeTicket(oldTicket);
  const backup = await source.backup(await ticket("restore-source", "backup"));
  const text = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(text);
  const descriptor: RestoreDescriptor = { id: "restore-job", sourceSessionId: "restore-source", backupId: "backup-id", sha256: await sha256(text), size: bytes.byteLength, downloadToken: "opaque-scoped-test-capability" };
  const target = binding("restore-target");
  target.owner.gitName = "Alice Current";
  target.owner.env.APP_COLOR = "new-owner-profile";
  let pulls = 0;
  let policyVersion = 1;
  const restoredService = new RunnerService({ ...service.config,
    authorize: async request => ({ allowed: request.actorId === target.owner.id, ownerId: target.owner.id, policyVersion }),
    readBackup: async (requested, id) => {
    assert.deepEqual(requested, descriptor);
    assert.equal(id, target.session.id);
    pulls++;
    return bytes;
  } });
  await restoredService.initialize();
  t.after(() => restoredService.close());
  const sourceBytes = await readFile(join(directory, "sessions", source.binding.session.id, "session.sqlite"));
  const input: RestoreInput = { binding: target, restore: descriptor };
  await assert.rejects(restoredService.restore(input, await ticket(target.session.id, "restore", "test:bob")), /Only the immutable owner/);
  assert.equal(pulls, 0);
  const body = JSON.stringify(input);
  const claims = await ticket(target.session.id, "restore", "test:alice", body);
  const response = await createRunnerApp(restoredService).request(`/v1/sessions/${target.session.id}/restore`, {
    method: "POST", headers: { authorization: `Bearer ${await signToken(claims, SECRET)}`, "content-type": "application/json" }, body,
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual((await response.json() as { restore: unknown }).restore, { id: descriptor.id, sha256: descriptor.sha256, targetSessionId: target.session.id });
  policyVersion = 2;
  const retryTicket = { ...await ticket(target.session.id, "restore"), policyVersion };
  await restoredService.restore(input, retryTicket);
  assert.equal(input.binding.session.policyVersion, 1, "publication binding stays historic while retry authorization uses current policy");
  assert.equal(pulls, 1, "durable matching marker reconciles an ambiguous response without downloading or overwriting");
  await assert.rejects(restoredService.restore({ ...input, restore: { ...descriptor, id: "another-job" } }, retryTicket), /receipt|conflict/i);
  assert.deepEqual(await readFile(join(directory, "sessions", source.binding.session.id, "session.sqlite")), sourceBytes);
  const restored = await restoredService.get(target.session.id);
  const view = await restored.view();
  assert.equal(view.busy, false);
  assert.equal(view.approvals.find(item => item.id === approval.id)?.status, "interrupted");
  assert.equal(view.approvals.find(item => item.id === permission.id)?.status, "approved");
  assert.equal((await source.view()).approvals.find(item => item.id === approval.id)?.status, "pending");
  assert.equal(await restored.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  assert.match(await readFile(join(directory, "sessions", target.session.id, "sandbox", "owner.gitconfig"), "utf8"), /Alice Current/);
  await restored.consumeTicket({ ...oldTicket, sessionId: target.session.id });
  await restored.submit({ ...await ticket(target.session.id, "submit"), policyVersion }, { requestId: "target-write", content: "TEST_WRITE evidence.txt\nnew session" }, "write");
  await idle(restored);
  await restored.submit({ ...await ticket(target.session.id, "submit"), policyVersion }, { requestId: "target-read", content: "TEST_WRITE allowed.txt\nagain", options: { access: "read" } }, "write");
  const asked = await permissionRequest(restored);
  assert.deepEqual(asked.operation, { kind: "permission", tool: "write_file", target: "allowed.txt", needs: ["write"] });
  await restored.decide({ ...await ticket(target.session.id, "approve"), policyVersion }, asked.id, { decision: "deny", operation: asked.operation });
  await idle(restored);
  assert.equal(await source.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  await restoredService.close();
});

test("a conversation-only backup keeps the conversation, not the files, and its restore tells the agent so", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const source = await service.provision(binding("conversation-source"), await ticket("conversation-source", "create"));
  await source.submit(await ticket("conversation-source", "submit"), { requestId: "conversation-write", content: "TEST_WRITE evidence.txt\noriginal" }, "write");
  await idle(source);
  const full = await source.backup(await ticket("conversation-source", "backup"));
  assert.ok(full.files.some(file => file.path === "worktree/evidence.txt"));
  assert.equal("conversationOnly" in full, false);
  const backup = await source.backup(await ticket("conversation-source", "backup"), { conversationOnly: true });
  assert.equal(backup.format, "pi-runner-backup-v1");
  assert.deepEqual(backup.files, []);
  assert.equal("clones" in backup, false);
  assert.equal((backup as { conversationOnly?: boolean }).conversationOnly, true);
  assert.equal(Buffer.from(backup.sqlite, "base64").subarray(0, 15).toString(), "SQLite format 3");
  // The runner's HTTP route takes the request from the backup's body, and nothing else.
  const app = createRunnerApp(service);
  for (const [body, status] of [[JSON.stringify({ conversationOnly: true }), 200], [JSON.stringify({ conversationOnly: "yes" }), 400], [JSON.stringify({ files: false }), 400]] as const) {
    const response = await app.request("/v1/sessions/conversation-source/backup", { method: "POST",
      headers: { authorization: `Bearer ${await signToken(await ticket("conversation-source", "backup", "test:alice", body), SECRET)}`, "content-type": "application/json" }, body });
    assert.equal(response.status, status, await response.clone().text());
    if (status === 200) assert.deepEqual((await response.json() as { files: unknown[] }).files, []);
  }
  const text = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(text);
  const descriptor: RestoreDescriptor = { id: "conversation-restore", sourceSessionId: "conversation-source", backupId: "conversation-backup", sha256: await sha256(text), size: bytes.byteLength, downloadToken: "opaque-scoped-test-capability" };
  const target = binding("conversation-target");
  const restoredService = new RunnerService({ ...service.config,
    authorize: async request => ({ allowed: request.actorId === target.owner.id, ownerId: target.owner.id, policyVersion: 1 }),
    readBackup: async () => bytes });
  await restoredService.initialize();
  t.after(() => restoredService.close());
  await restoredService.restore({ binding: target, restore: descriptor }, await ticket(target.session.id, "restore"));
  const restored = await restoredService.get(target.session.id);
  assert.ok((await restored.view()).entries.some(entry => entry.text.includes("TEST_WRITE evidence.txt")), "the conversation is restored");
  await assert.rejects(restored.sandbox.readFile("evidence.txt", allowTestOperation));
  const instructions = (restored as unknown as { agentInstructions(mode: "write"): string }).agentInstructions("write");
  assert.match(instructions, /restored from a backup that kept only its conversation/);
  assert.doesNotMatch((source as unknown as { agentInstructions(mode: "write"): string }).agentInstructions("write"), /kept only its conversation/);
  // The note follows the latest restore: a full backup of the restored session still carries it, and restoring that
  // backup in full brings back its files, so the note goes.
  await restored.submit(await ticket(target.session.id, "submit"), { requestId: "conversation-again", content: "TEST_WRITE again.txt\nmade again" }, "write");
  await idle(restored);
  const again = await restored.backup(await ticket(target.session.id, "backup"));
  assert.equal(again.manifest.conversationOnlyRestore, true);
  const againText = JSON.stringify(again);
  const againBytes = new TextEncoder().encode(againText);
  const fullTarget = binding("conversation-full-target");
  const fullService = new RunnerService({ ...service.config,
    authorize: async request => ({ allowed: request.actorId === fullTarget.owner.id, ownerId: fullTarget.owner.id, policyVersion: 1 }),
    readBackup: async () => againBytes });
  await fullService.initialize();
  t.after(() => fullService.close());
  await fullService.restore({ binding: fullTarget, restore: { id: "conversation-full-restore", sourceSessionId: target.session.id, backupId: "full-backup",
    sha256: await sha256(againText), size: againBytes.byteLength, downloadToken: "opaque-scoped-test-capability" } }, await ticket(fullTarget.session.id, "restore"));
  const fullRestored = await fullService.get(fullTarget.session.id);
  assert.equal(await fullRestored.sandbox.readFile("again.txt", allowTestOperation), "made again");
  assert.doesNotMatch((fullRestored as unknown as { agentInstructions(mode: "write"): string }).agentInstructions("write"), /kept only its conversation/);
});

test("restore checks actual paused pi tasks, not only a manifest claiming idle", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const source = binding("hidden-task-source");
  const rootDir = join(directory, "hidden-task-stage");
  await mkdir(rootDir, { mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(rootDir, "session.sqlite"));
  const harness = await Harness.open(storage, { models: runnerModels(source.model, true), registry: createRegistry() }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: source.model.modelId } } });
  const manifest = { binding: source, branches: [{ id: root.id, mode: "write" as const }], runs: {}, approvals: {}, toolActors: {} };
  const state = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });
  await root.commit(async tx => { (await tx.doc(state)).json = JSON.stringify(manifest); }, context);
  await root.submit({ type: "input", content: "TEST_HOLD 5000", requestId: "hidden-live-task" }, context);
  await harness.close(context);
  const target = new RunnerSession(binding("hidden-task-target"), rootDir, service.config);
  await assert.rejects(target.prepareRestore(manifest), /incomplete durable tasks/);
});

test("queued sandbox effects recheck authority after admission and fail closed on revocation", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("queue-session"), await ticket("queue-session", "create"));
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const first = session.sandbox.writeFile("first.txt", "allowed", async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  let revoked = false;
  const second = session.sandbox.writeFile("forbidden.txt", "denied", async () => {
    if (revoked) throw new Error("revoked after enqueue");
  });
  const denied = assert.rejects(second, /revoked after enqueue/);
  revoked = true;
  gate.resolve();
  await first;
  await denied;
  await assert.rejects(session.sandbox.readFile("forbidden.txt", allowTestOperation));
});

test("generic shell requires both explicit test flags and a faux binding", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const operation = { kind: "bash" as const, command: "true" };
  const fauxDisabled = new RunnerSession(binding("shell-disabled"), join(directory, "shell-disabled"), { ...service.config, allowTestShell: false });
  await assert.rejects(fauxDisabled.createApproval("test:alice", operation), /quota-backed/);
  const realBinding = binding("shell-real");
  realBinding.model.provider = "openai";
  const real = new RunnerSession(realBinding, join(directory, "shell-real"), service.config);
  await assert.rejects(real.createApproval("test:alice", operation), /quota-backed/);
  const noFaux = new RunnerSession(binding("shell-no-faux"), join(directory, "shell-no-faux"), { ...service.config, allowFaux: false });
  await assert.rejects(noFaux.createApproval("test:alice", operation), /quota-backed/);
});

test("connected writes durably bind Worker admission to every model approval without exposing it to the model", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const connectorId = "proof-connector";
  const target = binding("proof-session");
  target.session.connectorId = target.model.connectorId = connectorId;
  target.session.connectorOwnerId = target.model.connectorOwnerId = "test:host";
  const connected = new RunnerService({ ...service.config, connectorId, resolveModels: async model => {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: model.modelId }] });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo review" }),
        fauxToolCall("bash", { command: "true" }),
        fauxToolCall("github_comment", { repository: "example/repo", issue: 1, body: "Review this comment" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("Approval requests recorded."),
    ]);
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  await connected.initialize();
  t.after(() => connected.close());
  const session = await connected.provision(target, { ...await ticket(target.session.id, "create"), connectorId });
  const writer = { ...await ticket(target.session.id, "submit", "test:bob"), connectorId };
  const admissionId = await sha256("opaque Worker-issued write admission");
  const input = { content: "Request the three reviews.", requestId: "proof-request", admissionId };
  await assert.rejects(session.submit(writer, { content: input.content, requestId: input.requestId }, "write"), /Worker write admission/);
  await assert.rejects(session.submit(writer, { ...input, admissionId: "malformed" }, "write"), /Worker write admission/);
  await assert.rejects(session.submit({ ...writer, action: "ask" }, input, "ask"), /Worker write admission/);
  const receipt = await session.submit(writer, input, "write");
  // Each call waits on its own card.
  await operationRequests(session, 3);
  const view = await session.view();
  assert.equal(view.approvals.length, 3);
  assert.ok(view.approvals.every(approval => approval.requestedBy === "test:bob" && approval.admissionId === admissionId));
  assert.deepEqual(view.approvals.map(approval => approval.operation.kind).sort(), ["bash", "bash", "github.comment"]);
  assert.ok(view.entries.every(entry => !entry.text.includes(admissionId)), "proof must not appear in user, tool-result, or model transcript content");
  const explicit = await session.createApproval("test:bob", { kind: "github.comment", repository: "example/repo", issue: 2, body: "Explicit operation" });
  assert.equal(explicit.admissionId, undefined, "explicit operations use the Worker's authenticated-request pin instead");
  const waiting = new Set(view.approvals.map(approval => approval.id));
  await session.restart();
  assert.ok((await session.view()).approvals.filter(approval => waiting.has(approval.id)).every(approval => approval.status === "interrupted"),
    "a restart ends the calls waiting on cards, and their cards with them");
  // Told its calls were interrupted, this model asks again; the new cards carry the same admission.
  const retried = (await operationRequests(session, 4)).filter(approval => approval.id !== explicit.id);
  assert.equal(retried.length, 3);
  for (const approval of retried) await session.decide({ ...await ticket(target.session.id, "approve"), connectorId }, approval.id, { decision: "deny", operation: approval.operation });
  await idle(session);
  assert.equal((await session.submit(writer, input, "write")).submissionId, receipt.submissionId);
  await assert.rejects(session.submit(writer, { ...input, admissionId: await sha256("replacement proof") }, "write"), /different Worker admission/);
  const backup = await session.backup({ ...await ticket(target.session.id, "backup"), connectorId });
  assert.equal(backup.manifest.runs[receipt.submissionId]!.admissionId, admissionId);
  assert.ok((await session.view()).approvals.filter(approval => approval.id !== explicit.id).every(approval => approval.admissionId === admissionId));
  await connected.close();
  const snapshot = JSON.stringify(backup);
  const restoredBinding = structuredClone(target);
  restoredBinding.session.id = "proof-restored";
  const restore: RestoreDescriptor = { id: "proof-restore", sourceSessionId: target.session.id, backupId: "proof-backup", size: Buffer.byteLength(snapshot), sha256: await sha256(snapshot), downloadToken: "scoped-proof-restore-capability" };
  const recoveredService = new RunnerService({ ...connected.config, readBackup: async () => new TextEncoder().encode(snapshot) });
  await recoveredService.initialize();
  t.after(() => recoveredService.close());
  await recoveredService.restore({ binding: restoredBinding, restore }, { ...await ticket(restoredBinding.session.id, "restore"), connectorId });
  const recovered = await recoveredService.get(restoredBinding.session.id);
  assert.ok((await recovered.view()).approvals.every(approval => ["interrupted", "denied"].includes(approval.status) && approval.admissionId === undefined));
  assert.equal((await recovered.view()).approvals.find(approval => approval.id === explicit.id)?.status, "interrupted", "a restored card can't be decided");
  const restoredBackup = await recovered.backup({ ...await ticket(restoredBinding.session.id, "backup"), connectorId });
  assert.equal(restoredBackup.manifest.runs[receipt.submissionId]!.admissionId, undefined, "restoring history never transfers source admission authority");
  await recoveredService.close();
});

test("the host's owner lets their own commands run without the resource limits the host lacks; nobody lifts them for a member without a host command grant", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const connectorId = "limitless-connector";
  // Neither provisioned limits nor the test shell: a command runs within limits, or with the host owner's consent.
  const limitless = new RunnerService({ ...service.config, connectorId, allowTestShell: false });
  await limitless.initialize();
  t.after(() => limitless.close());
  const admissionId = await sha256("limitless write admission");
  async function start(id: string, hostOwner: string, command: string) {
    const target = binding(id);
    target.session.connectorId = target.model.connectorId = connectorId;
    target.session.connectorOwnerId = target.model.connectorOwnerId = hostOwner;
    const session = await limitless.provision(target, { ...await ticket(id, "create"), connectorId });
    await session.submit({ ...await ticket(id, "submit"), connectorId }, { content: `TEST_BASH ${command}`, requestId: id, admissionId }, "write");
    return session;
  }
  // On someone else's host, without a host command grant there, the call fails without a card: nobody in the session
  // may lift the host's limits, and the agent learns who may run commands there.
  const shared = await start("limitless-shared", "test:host", "echo shared");
  await idle(shared);
  const sharedView = await shared.view();
  assert.deepEqual(sharedView.approvals, []);
  assert.ok(sharedView.entries.some(entry => entry.role === "toolResult" && entry.text.includes("only in sessions of its owner and of members they granted host commands")));

  const own = await start("limitless-own", "test:alice", "echo unlimited-marker");
  const request = await permissionRequest(own);
  assert.deepEqual(request.operation, { kind: "permission", tool: "bash", target: "echo unlimited-marker", needs: ["unbounded-shell"] });
  assert.equal(request.admissionId, admissionId);
  await own.decide({ ...await ticket("limitless-own", "approve"), connectorId }, request.id, { decision: "approve", operation: request.operation });
  // The consent covers running unlimited; the command itself still waits for its approval.
  const [command] = await operationRequests(own);
  assert.equal(command!.operation.kind, "bash");
  assert.equal(command!.unbounded, true);
  await own.decide({ ...await ticket("limitless-own", "approve"), connectorId }, command!.id, { decision: "approve", operation: command!.operation });
  const ran = await settledCard(own, command!.id);
  assert.equal(ran.status, "executed");
  assert.match(ran.result ?? "", /unlimited-marker/);
  await idle(own);

  // The host's owner auto-approving their own message runs the command at once, without either card.
  const auto = await start("limitless-auto", "test:alice", "echo auto-unlimited-marker");
  await auto.submit({ ...await ticket("limitless-auto", "submit"), connectorId }, { content: "TEST_BASH echo auto-unlimited-marker", requestId: "auto", admissionId, options: { access: "auto" } }, "write");
  const first = await permissionRequest(auto);
  await auto.decide({ ...await ticket("limitless-auto", "approve"), connectorId }, first.id, { decision: "deny", operation: first.operation });
  await idle(auto);
  const autoView = await auto.view();
  assert.equal(autoView.approvals.filter(approval => approval.operation.kind === "permission").length, 1, "only the default-access message asked");
  assert.deepEqual(autoApproved(autoView), [{ tool: "bash", status: "executed", unbounded: true }]);
  assert.ok(toolOutput(autoView, /auto-unlimited-marker/));
});

test("a member granted host commands runs commands in the sandbox without the limits the host lacks, decided as host commands are, while the grant lasts", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  // May approve the session's work, but holds no host command authority.
  grants["test:carol"] = ["read", "ask", "write", "approve"];
  // The host's owner, with approve access to the session.
  grants["test:host"] = ["read", "approve"];
  const connectorId = "granted-shell-connector";
  // What the control plane reports of alice's grant on test:host's host.
  const grant: { hostCommands?: "approve" | "auto" } = { hostCommands: "approve" };
  const asked: AuthorizationRequest[] = [];
  const authorize = async (input: AuthorizationRequest) => {
    asked.push(input);
    const allowed = grants[input.actorId]?.includes(input.permission) ?? false;
    return { allowed, ownerId: input.ownerId, policyVersion: 1,
      ...(allowed && input.host && input.actorId === "test:alice" && grant.hostCommands ? { hostCommands: grant.hostCommands } : {}) };
  };
  // Neither provisioned limits nor the test shell.
  const runner = new RunnerService({ ...service.config, connectorId, allowTestShell: false, authorize });
  await runner.initialize();
  t.after(() => runner.close());
  const admissionId = await sha256("granted shell write admission");
  const value = binding("granted-shell");
  value.session.connectorId = value.model.connectorId = connectorId;
  value.session.connectorOwnerId = value.model.connectorOwnerId = "test:host";
  const session = await runner.provision(value, { ...await ticket("granted-shell", "create"), connectorId });
  assert.ok(!(session.sandbox instanceof HostWorkspace), "it runs in the sandbox");
  const submit = async (requestId: string, command: string, access?: "auto") => session.submit({ ...await ticket("granted-shell", "submit"), connectorId },
    { content: `TEST_BASH ${command}`, requestId, admissionId, ...(access ? { options: { access } } : {}) }, "write");
  const decide = async (approval: ApprovalRecord, actorId = "test:alice", decision: "approve" | "deny" = "approve") =>
    session.decide({ ...await ticket("granted-shell", "approve", actorId), connectorId }, approval.id, { decision, operation: approval.operation });

  // With approve access to host commands, they allow running without limits as the host's owner would in theirs...
  await submit("approved", "echo granted-approved");
  const request = await permissionRequest(session);
  assert.deepEqual(request.operation, { kind: "permission", tool: "bash", target: "echo granted-approved", needs: ["unbounded-shell"] });
  assert.ok(asked.some(input => input.actorId === "test:alice" && input.host), "the host checks their grant before the card asks");
  await decide(request);
  // ...and the command waits for someone with host command authority: approve permission on the session isn't enough.
  const [command] = await operationRequests(session);
  assert.equal(command!.operation.kind, "bash");
  assert.equal(command!.unbounded, true);
  await assert.rejects(decide(command!, "test:carol"), rejectedWith(403, /on the strength of a host command grant/));
  await decide(command!);
  const ran = await settledCard(session, command!.id);
  assert.equal(ran.status, "executed", ran.result);
  assert.match(ran.result ?? "", /granted-approved/);
  await idle(session);

  // Their Auto-approve still asks for each command: they decide it themselves, or the host's owner does.
  await submit("approve-level-auto", "echo approve-level-auto", "auto");
  const [asking] = await operationRequests(session);
  assert.equal(asking!.unbounded, true);
  await decide(asking!, "test:host", "deny");
  assert.equal((await settledCard(session, asking!.id)).status, "denied");
  await idle(session);

  // With automatic host commands, it runs at once, without either card.
  grant.hostCommands = "auto";
  await submit("automatic", "echo granted-automatic", "auto");
  await idle(session);
  const automatic = await session.view();
  assert.deepEqual(autoApproved(automatic), [{ tool: "bash", status: "executed", unbounded: true }]);
  assert.ok(toolOutput(automatic, /granted-automatic/));

  // A card left waiting when the grant ends no longer runs, even approved by the host's owner.
  grant.hostCommands = "approve";
  await submit("waiting", "echo left-waiting");
  const unlimited = await permissionRequest(session);
  await decide(unlimited);
  const [waiting] = await operationRequests(session);
  delete grant.hostCommands;
  await assert.rejects(decide(waiting!), rejectedWith(403, /on the strength of a host command grant/));
  await decide(waiting!, "test:host");
  const stopped = await settledCard(session, waiting!.id);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.result ?? "", /members they granted host commands/);
  await idle(session);

  // Once the grant has ended, the next command stops before any card asks anyone, and the agent learns why.
  const refusals = (view: SessionView) => view.entries.filter(entry => entry.role === "toolResult"
    && entry.text.includes("only in sessions of its owner and of members they granted host commands")).length;
  const before = await session.view();
  await submit("ended", "echo after-the-grant", "auto");
  await idle(session);
  const view = await session.view();
  assert.equal(view.approvals.length, before.approvals.length, "no card asks anyone");
  assert.equal(refusals(view), refusals(before) + 1);
});

test("a session its host's owner started on the host runs there while the host accepts that, and only host command authority decides it", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  // May approve the session's work, but holds no host command authority.
  grants["test:carol"] = ["read", "ask", "write", "approve"];
  const connectorId = "host-sessions-connector";
  let accepted = true;
  const runner = new RunnerService({ ...service.config, connectorId, allowTestShell: false, hostConfig: async () => ({ ...defaultHostConfig, hostSessions: accepted }) });
  await runner.initialize();
  t.after(() => runner.close());
  const admissionId = await sha256("host session write admission");
  const onHost = (id: string, hostOwner: string) => {
    const value = binding(id);
    value.session.connectorId = value.model.connectorId = connectorId;
    value.session.connectorOwnerId = value.model.connectorOwnerId = hostOwner;
    value.session.hostEnvironment = true;
    return value;
  };
  const session = await runner.provision(onHost("host-own", "test:alice"), { ...await ticket("host-own", "create"), connectorId });
  assert.ok(session.sandbox instanceof HostWorkspace, "no sandbox is created for it");
  await session.submit({ ...await ticket("host-own", "submit"), connectorId }, { content: "TEST_BASH pwd", requestId: "host-own", admissionId }, "write");
  const [command] = await operationRequests(session);
  assert.equal(command!.operation.kind, "bash");
  await assert.rejects(session.decide({ ...await ticket("host-own", "approve", "test:carol"), connectorId }, command!.id, { decision: "approve", operation: command!.operation }),
    rejectedWith(403, /runs directly on its host/));
  await session.decide({ ...await ticket("host-own", "approve"), connectorId }, command!.id, { decision: "approve", operation: command!.operation });
  const ran = await settledCard(session, command!.id);
  assert.equal(ran.status, "executed", ran.result);
  assert.ok(ran.result?.includes(join(service.config.dataDir, "sessions", "host-own")), `it ran in the session's own worktree on the host: ${ran.result}`);
  await idle(session);
  // Once its host stops accepting that, the session's next command stops before any card asks anyone.
  accepted = false;
  await session.submit({ ...await ticket("host-own", "submit"), connectorId }, { content: "TEST_BASH echo never-ran", requestId: "host-own-off", admissionId }, "write");
  await idle(session);
  const view = await session.view();
  assert.equal(view.approvals.filter(approval => approval.status === "pending").length, 0);
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("no longer runs sessions directly on it")));
});

test("a member the host's owner granted sessions on the host runs one there only while their grant includes it, and without approval only with automatic host commands", { skip: process.platform !== "linux" }, async t => {
  const { service, grants } = await fixture(t);
  const connectorId = "member-host-sessions-connector";
  // What the control plane reports of alice's grant on test:host's host; asked for sessions on the host only by this host.
  const grant: { hostCommands?: "approve" | "auto"; hostSessions?: true } = { hostCommands: "approve", hostSessions: true };
  const asked: AuthorizationRequest[] = [];
  const authorize = async (input: AuthorizationRequest) => {
    asked.push(input);
    const allowed = grants[input.actorId]?.includes(input.permission) ?? false;
    return { allowed, ownerId: input.ownerId, policyVersion: 1,
      ...(allowed && input.host && input.actorId === "test:alice" && grant.hostCommands ? { hostCommands: grant.hostCommands } : {}),
      ...(allowed && input.host && input.hostSessions && input.actorId === "test:alice" && grant.hostSessions ? { hostSessions: true as const } : {}) };
  };
  const runner = new RunnerService({ ...service.config, connectorId, allowTestShell: false, authorize, hostConfig: async () => ({ ...defaultHostConfig, hostSessions: true }) });
  await runner.initialize();
  t.after(() => runner.close());
  const admissionId = await sha256("member host session write admission");
  const value = binding("host-member");
  value.session.connectorId = value.model.connectorId = connectorId;
  value.session.connectorOwnerId = value.model.connectorOwnerId = "test:host";
  value.session.hostEnvironment = true;
  const session = await runner.provision(value, { ...await ticket("host-member", "create"), connectorId });
  assert.ok(session.sandbox instanceof HostWorkspace, "no sandbox is created for it");

  // With approve access to host commands, their Auto-approve still asks: they decide each command themselves.
  await session.submit({ ...await ticket("host-member", "submit"), connectorId }, { content: "TEST_BASH echo member-approved", requestId: "approved", admissionId, options: { access: "auto" } }, "write");
  const [command] = await operationRequests(session);
  assert.equal(command!.operation.kind, "bash");
  await session.decide({ ...await ticket("host-member", "approve"), connectorId }, command!.id, { decision: "approve", operation: command!.operation });
  const ran = await settledCard(session, command!.id);
  assert.equal(ran.status, "executed", ran.result);
  assert.match(ran.result ?? "", /member-approved/);
  assert.ok(asked.some(input => input.actorId === "test:alice" && input.host && input.hostSessions), "the host checks the grant before their command");
  await idle(session);

  // With automatic host commands, it runs at once.
  grant.hostCommands = "auto";
  await session.submit({ ...await ticket("host-member", "submit"), connectorId }, { content: "TEST_BASH echo member-automatic", requestId: "automatic", admissionId, options: { access: "auto" } }, "write");
  await idle(session);
  assert.deepEqual(autoApproved(await session.view()), [{ tool: "bash", status: "executed" }]);

  // Once their grant no longer includes sessions on the host, the next command stops before any card asks anyone.
  delete grant.hostSessions;
  await session.submit({ ...await ticket("host-member", "submit"), connectorId }, { content: "TEST_BASH echo never-ran", requestId: "ended", admissionId, options: { access: "auto" } }, "write");
  await idle(session);
  const view = await session.view();
  assert.equal(view.approvals.filter(approval => approval.status === "pending").length, 0);
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("grant that let them has ended")));
  assert.ok(!view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("never-ran\n")));
});

test("shell commands may reserve address space they never touch, as gh and node do when they start", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("reserve-session"), await ticket("reserve-session", "create"));
  // Mapped PROT_NONE, 16 GiB commits no memory: only an address-space cap refuses it.
  const command = "python3 -I -c 'import mmap; mmap.mmap(-1, 16 << 30, flags=mmap.MAP_PRIVATE, prot=0); print(\"reserved\")'";
  assert.match(await session.sandbox.execute({ kind: "bash", command }, true, allowTestOperation, { allowTestShell: true }), /reserved/);
});

test("a longer command time limit gives builds room; the default keeps the limits of short commands", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("limits-session"), await ticket("limits-session", "create"));
  const limits = async (options: { limits?: CommandLimits } = {}) => (await session.sandbox.execute({ kind: "bash", command: "ulimit -t; ulimit -f; ulimit -n" }, true,
    allowTestOperation, { allowTestShell: true, ...options })).trim().split("\n");
  assert.deepEqual(await limits(), ["25", "65536", "256"]);
  assert.deepEqual(await limits({ limits: commandLimits(30) }), ["25", "65536", "256"]);
  const [cpu, size, files] = await limits({ limits: commandLimits(600, 2) });
  assert.equal(cpu, "1200", "every CPU for the whole time limit");
  assert.equal(size, String(16 * 1024 * 1024), "16 GiB, in ulimit's 1024-byte blocks");
  // Never more open files than the runner's own hard limit.
  assert.ok(Number(files) > 256 && Number(files) <= 8192, files);
});

test("a stopped shell command ends at once, and one stopped before it starts never runs", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("stop-session"), await ticket("stop-session", "create"));
  const controller = new AbortController();
  const started = Date.now();
  const running = session.sandbox.execute({ kind: "bash", command: "sleep 20" }, false, allowTestOperation,
    { allowTestShell: true, limits: commandLimits(600), signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(running, /Command stopped/);
  assert.ok(Date.now() - started < 10_000);
  await assert.rejects(session.sandbox.execute({ kind: "bash", command: "touch never" }, false, allowTestOperation,
    { allowTestShell: true, signal: controller.signal }), /stopped before it started/);
  assert.doesNotMatch(await session.sandbox.execute({ kind: "bash", command: "ls -a" }, true, allowTestOperation, { allowTestShell: true }), /never/);
});

test("kernel runner lease admits one owner and releases without deleting stale files", { skip: process.platform !== "linux" }, async t => {
  const { directory } = await fixture(t);
  let lost = false;
  const release = await acquireRunnerLease(directory, () => { lost = true; });
  try {
    await assert.rejects(acquireRunnerLease(directory, () => {}), /owns DATA_DIR|flock/);
  } finally { await release(); }
  const next = await acquireRunnerLease(directory, () => { lost = true; });
  await next();
  assert.equal(lost, false);
});

// Host mode needs only Git, so chat-option behavior is exercised on macOS and Linux alike.
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };
async function hostFixture(t: { after: (fn: () => Promise<void>) => void }, extra: Partial<RunnerService["config"]> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runner-host-")));
  const grants: Record<string, Permission[]> = { "test:alice": ["read", "ask", "write", "approve", "manage"], "test:bob": ["read", "ask", "write"] };
  const authorize = async (input: AuthorizationRequest) => ({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 });
  const service = new RunnerService({ dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true, authorize, ...extra });
  await service.initialize();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, grants };
}

test("the agent gets a command's whole output; the approval record and the control plane keep an excerpt", hostMode, async t => {
  const { service } = await hostFixture(t);
  const session = await service.provision(binding("long-output"), await ticket("long-output", "create"));
  const command = "printf start-marker; head -c 20000 /dev/zero | tr '\\0' x; printf end-marker";
  const whole = new RegExp(`start-marker${"x".repeat(20000)}end-marker`);

  await session.submit(await ticket("long-output", "submit"), { content: `TEST_BASH ${command}`, requestId: "auto", options: { access: "auto" } }, "write");
  await idle(session);
  assert.ok(toolOutput(await session.view(), whole), "an auto-approved command's whole output reaches the agent");

  await session.submit(await ticket("long-output", "submit"), { content: `TEST_BASH ${command}`, requestId: "approved" }, "write");
  const [pending] = await operationRequests(session);
  await session.decide(await ticket("long-output", "approve"), pending!.id, { decision: "approve", operation: pending!.operation });
  const ran = await settledCard(session, pending!.id);
  assert.equal(ran.status, "executed");
  assert.ok(ran.result!.length <= 8192, "the control plane gets an excerpt it accepts");
  assert.match(ran.result!, /^start-marker[\s\S]*characters omitted[\s\S]*end-marker$/);
  await idle(session);
  const view = await session.view();
  assert.equal(view.entries.filter(entry => entry.role === "toolResult" && whole.test(entry.text)).length, 2, "an approved command's whole output reaches the agent too");
  assert.ok(view.approvals.every(approval => (approval.result?.length ?? 0) <= 1000));
});

test("read access asks the owner before a change, and auto access runs owner commands immediately", hostMode, async t => {
  const { service } = await hostFixture(t);
  const session = await service.provision(binding("options-session"), await ticket("options-session", "create"));
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_WRITE read-only.txt\nleaked", requestId: "read", options: { access: "read" } }, "write");
  const request = await permissionRequest(session);
  assert.deepEqual(request.operation, { kind: "permission", tool: "write_file", target: "read-only.txt", needs: ["write"] });
  assert.equal((await session.view()).busy, true, "the call waits on the owner");
  const denial = await session.decide(await ticket("options-session", "approve"), request.id, { decision: "deny", operation: request.operation });
  assert.equal(denial.status, "denied");
  await idle(session);
  await assert.rejects(session.sandbox.readFile("read-only.txt", allowTestOperation));
  let view = await session.view();
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("The session owner did not allow write_file on read-only.txt.")));
  assert.equal(view.access, "read");
  assert.deepEqual(view.approvals.map(approval => approval.status), ["denied"]);

  await session.submit(await ticket("options-session", "submit"), { content: "TEST_BASH echo auto-output-marker", requestId: "auto", options: { access: "auto" } }, "write");
  await idle(session);
  view = await session.view();
  assert.equal(view.access, "auto");
  assert.deepEqual(autoApproved(view), [{ tool: "bash", status: "executed" }]);
  // The call's result is the whole record: who it ran for, and its output.
  assert.ok(toolOutput(view, /"automatic":true/) && toolOutput(view, /"decidedBy":"test:alice"/) && toolOutput(view, /auto-output-marker/));

  // Without options the next run returns to per-command human approval: the call waits for it, then gets the output.
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_BASH echo pending-marker", requestId: "default" }, "write");
  const [pending] = await operationRequests(session);
  assert.equal(pending!.operation.kind, "bash");
  assert.equal(pending!.automatic, undefined);
  view = await session.view();
  assert.equal(view.access, "approval", "the view says the latest message asks before acting");
  assert.equal(view.busy, true, "the call waits on the card");
  assert.equal(view.activity, "waiting");
  assert.ok(!view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("pending-marker")), "no result before the decision");
  // Deciding doesn't wait for the message: the message waits for the decision.
  await session.decide(await ticket("options-session", "approve"), pending!.id, { decision: "approve", operation: pending!.operation });
  const ran = await settledCard(session, pending!.id);
  assert.equal(ran.status, "executed");
  await idle(session);
  view = await session.view();
  const result = view.entries.find(entry => entry.role === "toolResult" && entry.text.includes("pending-marker"));
  assert.ok(result, "the agent gets the command's outcome");
  assert.match(result.text, /"status":"executed"/);

  // A denied command ends its call with the denial; nothing runs.
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_BASH echo denied-marker", requestId: "denied" }, "write");
  const [refused] = await operationRequests(session);
  assert.equal((await session.decide(await ticket("options-session", "approve"), refused!.id, { decision: "deny", operation: refused!.operation })).status, "denied");
  await idle(session);
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes("denied-marker") && entry.text.includes('"status":"denied"')));
});

test("a tool outside the agent waits for its owner, who allows it once or for the rest of the session", hostMode, async t => {
  const { service, grants } = await hostFixture(t);
  grants["test:bob"] = ["read", "ask", "write", "approve"];
  const id = "permission-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  const commands = () => session.view().then(view => view.approvals.filter(approval => approval.operation.kind === "bash"));
  assert.equal((await session.view()).access, undefined, "no shared message has run at any access yet");

  // Bob may write and approve here, but only the owner lets a call do more than the session allows.
  await session.submit(await ticket(id, "submit", "test:bob"), { content: "TEST_BASH echo once", requestId: "once" }, "write");
  const once = await permissionRequest(session);
  assert.deepEqual(once.operation, { kind: "permission", tool: "bash", target: "echo once", needs: ["tool"] });
  assert.equal(once.requestedBy, "test:bob");
  await assert.rejects(session.decide(await ticket(id, "approve", "test:bob"), once.id, { decision: "approve", operation: once.operation }), rejectedWith(403, /session owner/));
  await assert.rejects(session.decide(await ticket(id, "approve"), once.id, { decision: "approve", operation: once.operation, scope: "forever" as never }), rejectedWith(400, /scope/));
  const allowedOnce = await session.decide(await ticket(id, "approve"), once.id, { decision: "approve", operation: once.operation, scope: "call" });
  assert.equal(allowedOnce.status, "approved");
  assert.equal(allowedOnce.scope, "call");
  // Allowing the tool doesn't run the command: it still gets its own approval.
  const deny = async () => {
    const [command] = await operationRequests(session);
    await session.decide(await ticket(id, "approve"), command!.id, { decision: "deny", operation: command!.operation });
    await idle(session);
  };
  assert.deepEqual((await operationRequests(session)).map(approval => approval.operation), [{ kind: "bash", command: "echo once" }]);
  await deny();
  await assert.rejects(session.createApproval("test:alice", { kind: "bash", command: "echo explicit" }), rejectedWith(403, /not enabled/));

  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo again", requestId: "again" }, "write");
  const again = await permissionRequest(session);
  assert.notEqual(again.id, once.id, "one call's permission doesn't cover the next");
  await session.decide(await ticket(id, "approve"), again.id, { decision: "approve", operation: again.operation, scope: "session" });
  // Allowing the tool for the session also runs the owner's commands of it, this one included, without asking.
  await idle(session);
  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo granted", requestId: "granted" }, "write");
  await idle(session);
  // Someone else's message uses the tool without a permission card, but its command still needs approval.
  await session.submit(await ticket(id, "submit", "test:bob"), { content: "TEST_BASH echo bob", requestId: "bob" }, "write");
  await deny();
  const view = await session.view();
  // The one-call permission is folded into its command's card. The commands the session grant ran have no card (their
  // calls are marked in the transcript), so its permission stays listed; and the session grant asks no more.
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind === "permission").map(approval => [approval.id, approval.status, approval.scope]),
    [[again.id, "approved", "session"]]);
  assert.deepEqual((await commands()).map(approval => [approval.operation, approval.status, approval.permission]), [
    [{ kind: "bash", command: "echo once" }, "denied", { decidedBy: "test:alice", scope: "call" }],
    [{ kind: "bash", command: "echo bob" }, "denied", undefined],
  ]);
  assert.deepEqual(view.entries.flatMap(entry => entry.autoApproved ?? []), [{ tool: "bash", status: "executed" }, { tool: "bash", status: "executed" }]);
  // The last shared message named no access, so it asked before acting, and the view says so.
  assert.equal(view.access, "approval");
  assert.equal((await session.createApproval("test:alice", { kind: "bash", command: "echo explicit" })).status, "pending");
  await assert.rejects(session.decide(await ticket(id, "approve"), again.id, { decision: "approve", operation: again.operation }), rejectedWith(409, /already been decided/));
});

test("auto access runs a tool outside the agent without a permission card", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "permission-auto";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo auto-tool-marker", requestId: "auto", options: { access: "auto" } }, "write");
  await idle(session);
  const view = await session.view();
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind === "permission"), [], "auto-approve asks nothing");
  assert.deepEqual(autoApproved(view), [{ tool: "bash", status: "executed" }]);
  assert.ok(toolOutput(view, /auto-tool-marker/));
  // Auto-approve covers its own message only: the next one asks again.
  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo after", requestId: "after" }, "write");
  const request = await permissionRequest(session);
  assert.deepEqual(request.operation, { kind: "permission", tool: "bash", target: "echo after", needs: ["tool"] });
  await session.decide(await ticket(id, "approve"), request.id, { decision: "deny", operation: request.operation });
  await idle(session);
});

test("allowing a tool for the session lets the round's other waiting calls of it go ahead", hostMode, async t => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo one" }), fauxToolCall("bash", { command: "echo two" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Both requested."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const { service } = await hostFixture(t, { resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }) });
  const id = "permission-round";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Run both.", requestId: "both" }, "write");
  // Both calls of the round wait, each on its own card.
  let requests: ApprovalRecord[] = [];
  for (let count = 0; count < 500 && requests.length < 2; count++) {
    requests = (await session.view()).approvals.filter(approval => approval.operation.kind === "permission" && approval.status === "pending");
    if (requests.length < 2) await delay(20);
  }
  assert.equal(requests.length, 2);
  await session.decide(await ticket(id, "approve"), requests[0]!.id, { decision: "approve", operation: requests[0]!.operation, scope: "session" });
  // Both commands then run without asking: the session grant approves the owner's calls of the tool.
  await idle(session);
  const view = await session.view();
  // Both permissions stay listed: the commands they let through ran without cards, marked on their calls instead.
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind === "permission").map(approval => [approval.status, approval.scope]), [["approved", "session"], ["approved", "session"]]);
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind === "bash"), []);
  assert.deepEqual(view.entries.flatMap(entry => entry.autoApproved ?? []), [{ tool: "bash", status: "executed" }, { tool: "bash", status: "executed" }]);
});

test("a restart ends a call waiting on its owner, and its card can no longer be decided", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "permission-restart";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo waiting", requestId: "waiting" }, "write");
  const request = await permissionRequest(session);
  await session.restart();
  await idle(session);
  const view = await session.view();
  assert.deepEqual(view.approvals.map(approval => [approval.id, approval.status]), [[request.id, "interrupted"]]);
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("Tool bash was interrupted")));
  await assert.rejects(session.decide(await ticket(id, "approve"), request.id, { decision: "approve", operation: request.operation }), rejectedWith(409, /already been decided/));
});

test("a restart ends a call waiting on a command's approval, and the command never runs", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "operation-restart";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo never-ran > never.txt", requestId: "waiting" }, "write");
  const [command] = await operationRequests(session);
  await session.restart();
  await idle(session);
  const view = await session.view();
  assert.deepEqual(view.approvals.map(approval => [approval.id, approval.status]), [[command!.id, "interrupted"]]);
  await assert.rejects(session.decide(await ticket(id, "approve"), command!.id, { decision: "approve", operation: command!.operation }), rejectedWith(409, /already been decided/));
  await assert.rejects(session.sandbox.readFile("never.txt", allowTestOperation));
});

test("chat options are validated against owner, mode, model and request idempotency", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "validate-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const status = (code: number) => (error: unknown) => error instanceof RunnerError && error.status === code;
  await assert.rejects(session.submit(await ticket(id, "submit", "test:bob"), { content: "TEST_IDENTITY", requestId: "bob-auto", options: { access: "auto" } }, "write"), status(403));
  await assert.rejects(session.submit(await ticket(id, "ask"), { content: "TEST_IDENTITY", requestId: "ask-access", options: { access: "read" } }, "ask"), status(422));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "thinking", options: { thinkingLevel: "high" } }, "write"), status(422));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "model", options: { model: { provider: "faux", modelId: "other" } } }, "write"), status(422));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "extra", options: { access: "read", extra: true } as never }, "write"), status(422));
  const input = { content: "TEST_IDENTITY", requestId: "stable", options: { access: "read" as const, thinkingLevel: "off" as const, model: { provider: "faux", modelId: "faux-1" } } };
  const first = await session.submit(await ticket(id, "submit"), input, "write");
  assert.equal((await session.submit(await ticket(id, "submit"), input, "write")).submissionId, first.submissionId);
  await assert.rejects(session.submit(await ticket(id, "submit"), { ...input, options: { access: "approval" } }, "write"), status(409));
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: input.content, requestId: input.requestId }, "write"), status(409));
  await idle(session);
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-1", thinkingLevel: "off" });
});

test("failed model turns expose provider, model and HTTP status but never the provider message", hostMode, async t => {
  const providerText = "401 invalid key sk-provider-detail for account acct-private";
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: model.modelId }] });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: providerText })]);
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  const session = await service.provision(binding("error-session"), await ticket("error-session", "create"));
  await session.submit(await ticket("error-session", "submit"), { content: "hello", requestId: "fails" }, "write");
  await idle(session);
  const view = await session.view();
  const failed = view.entries.find(entry => entry.error);
  assert.deepEqual(failed?.error, { provider: "faux", modelId: "faux-1", status: 401 });
  assert.equal(JSON.stringify(view).includes("sk-provider-detail"), false);
  assert.equal(JSON.stringify(view).includes("acct-private"), false);
});

test("a run Pi settles without an answer shows as a failed model turn instead of silence", hostMode, async t => {
  // A model the host no longer offers ends the run like a failed compaction does: unanswered, with no entry for it.
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    models.setProvider(fauxProvider({ models: [{ id: "another-model" }] }).provider);
    return { models, provider: model.provider, modelId: model.modelId };
  } });
  const id = "unanswered-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "hello", requestId: "unanswered" }, "write");
  await idle(session);
  const entries = (await session.view()).entries;
  assert.deepEqual(entries.map(entry => [entry.role, entry.text]), [["user", "hello"], ["assistant", ""]]);
  assert.deepEqual(entries[1]!.error, { provider: "faux", modelId: "faux-1" });
  assert.equal(entries[1]!.actorId, "test:alice");
});

test("a conversation starts at the host's level for its model, and a model switch without a level takes the new model's", hostMode, async t => {
  const levels = { "faux-1": "high", "faux-2": "low" } as const;
  const { service } = await hostFixture(t, { resolveModels: async model => {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    models.setProvider(faux.provider);
    return { models, provider: model.provider, modelId: model.modelId, thinkingLevel: levels[model.modelId as keyof typeof levels] };
  } });
  const id = "level-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-1", thinkingLevel: "high" });
  await session.submit(await ticket(id, "submit"), { content: "switch", requestId: "switch", options: { model: { provider: "faux", modelId: "faux-2" } } }, "write");
  await idle(session);
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-2", thinkingLevel: "low" });
  // A level named with the switch wins over the model's own.
  await session.submit(await ticket(id, "submit"), { content: "back", requestId: "back", options: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "medium" } }, "write");
  await idle(session);
  assert.deepEqual((await session.view()).agent, { provider: "faux", modelId: "faux-1", thinkingLevel: "medium" });
});

test("edit_file replaces exact text in place, keeps a CRLF file CRLF, and refuses an ambiguous edit without writing", hostMode, async t => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("edit_file", { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }, { oldText: "alpha\n", newText: "ALPHA\n" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Edited."),
    fauxAssistantMessage([fauxToolCall("edit_file", { path: "notes.txt", edits: [{ oldText: "a", newText: "b" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Not edited."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const { service } = await hostFixture(t, { resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }) });
  const id = "edit-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: [...base.agent.tools, "edit_file"] } }, await ticket(id, "create"));
  await session.sandbox.writeFile("notes.txt", "alpha\r\nbeta\r\ngamma\r\n", allowTestOperation);
  // Both edits match the file as it was, the second one across a line break the model wrote as LF.
  await session.submit(await ticket(id, "submit"), { content: "Edit it.", requestId: "edit" }, "write");
  await idle(session);
  assert.equal(await session.sandbox.readFile("notes.txt", allowTestOperation), "ALPHA\r\nBETA\r\ngamma\r\n");
  await session.submit(await ticket(id, "submit"), { content: "Edit again.", requestId: "ambiguous" }, "write");
  await idle(session);
  assert.equal(await session.sandbox.readFile("notes.txt", allowTestOperation), "ALPHA\r\nBETA\r\ngamma\r\n");
  assert.ok(JSON.stringify((await session.view()).entries).includes("occurs 2 times in notes.txt"));
});

/** Real SQLite storage with faults switched on demand, as a full disk or an I/O error would cause them. */
function faultyStorage(fault: { calls?: boolean; close?: boolean }) {
  return async (path: string): Promise<Storage> => {
    const storage = await openNodeSqliteStorage(path);
    return new Proxy(storage, { get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      // Closing always releases the real database first, so no connection outlives a test.
      if (key === "close") return async (...args: unknown[]) => {
        await Reflect.apply(value, target, args);
        if (fault.close) throw new Error("disk I/O error");
      };
      return (...args: unknown[]) => fault.calls ? Promise.reject(new Error("disk I/O error")) : Reflect.apply(value, target, args);
    } });
  };
}

test("a session whose storage failed is reopened from its SQLite file by the next request", hostMode, async t => {
  const fault = { calls: false };
  const { service } = await hostFixture(t, { openStorage: faultyStorage(fault) });
  const id = "storage-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "before" }, "write");
  await idle(session);
  const before = (await session.view()).entries;

  fault.calls = true;
  await assert.rejects(session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "during" }, "write"));
  for (let count = 0; count < 200 && !session.failed; count++) await delay(10);
  assert.equal(session.failed, true);
  // While storage keeps failing, each request tries to reopen the session and reports the failure.
  await assert.rejects(service.get(id));
  assert.equal(session.failed, true);

  fault.calls = false;
  // Requests arriving together share one reopen and all get the fully reopened session.
  assert.deepEqual(await Promise.all([service.get(id), service.get(id)]), [session, session]);
  assert.equal(session.failed, false);
  assert.deepEqual((await session.view()).entries, before);
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "after" }, "write");
  await idle(session);
  assert.ok((await session.view()).entries.length > before.length);
});

test("a backup fails instead of copying a database that did not close cleanly", hostMode, async t => {
  const fault = { close: false };
  const { service } = await hostFixture(t, { openStorage: faultyStorage(fault) });
  const id = "backup-close-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "before" }, "write");
  await idle(session);

  fault.close = true;
  await assert.rejects(session.backup(await ticket(id, "backup")), /disk I\/O error/);
  fault.close = false;
  assert.equal(await service.get(id), session);
  assert.ok((await session.view()).entries.length > 0);
});

test("entries carry how long each reply took and each tool ran", hostMode, async t => {
  const { service } = await hostFixture(t);
  const id = "duration-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "TEST_IDENTITY", requestId: "timed" }, "write");
  await idle(session);
  const entries = (await session.view()).entries;
  const timed = (role: string) => entries.filter(entry => entry.role === role).map(entry => typeof entry.durationMs === "number" && entry.durationMs >= 0);
  // The identity call and the answer after it, then the identity tool's own run.
  assert.deepEqual(timed("assistant"), [true, true]);
  assert.deepEqual(timed("toolResult"), [true]);
  assert.deepEqual(timed("user"), [false]);
});
