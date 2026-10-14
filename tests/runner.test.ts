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
import type { ApprovalRecord, RunnerBinding, RunnerTicket, RunnerAction, Permission, AuthorizationRequest } from "../packages/shared/src/types.js";
import type { RestoreDescriptor, RestoreInput } from "../packages/shared/src/connector.js";
import { RunnerError, assertId, requestKey, stableJson, validateBinding, validateOperation, verifyRunnerTicket } from "../apps/runner/src/protocol.js";
import { RunnerService, createRunnerApp } from "../apps/runner/src/server.js";
import { RunnerSession } from "../apps/runner/src/session.js";
import { acquireRunnerLease } from "../apps/runner/src/lease.js";
import { runnerModels } from "../apps/runner/src/provider.js";

const SECRET = "runner-test-secret-not-a-production-secret-123456";
const allowTestOperation = async (): Promise<void> => {};
function binding(id: string, ownerId = "test:alice"): RunnerBinding {
  const name = ownerId === "test:alice" ? "Alice" : "Bob";
  return {
    session: { id, workspaceId: "workspace", ownerId, agentVersionId: "version-1", title: "Test", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: ownerId, githubId: null, githubLogin: name.toLowerCase(), displayName: name, gitName: name, gitEmail: `${name.toLowerCase()}@example.test`, env: { APP_COLOR: name.toLowerCase() }, githubConnected: false },
    agent: { id: "version-1", agentId: "shared-agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Shared", description: "Tests", instructions: "Use tools.", tools: ["identity", "read_file", "write_file", "list_files", "git_status", "git_commit", "bash", "github_comment"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
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
  await session.sandbox.writeFile("hello.txt", "hello", allowTestOperation);
  const operation = { kind: "git.commit" as const, message: "Owner identity" };
  const approval = await session.createApproval("test:bob", operation);
  await assert.rejects(session.decide(await ticket("approval-session", "approve", "test:bob"), approval.id, { decision: "approve", operation }));
  await assert.rejects(session.decide(await ticket("approval-session", "approve"), approval.id, { decision: "approve", operation: { ...operation, message: "tampered" } }));
  const result = await session.decide(await ticket("approval-session", "approve"), approval.id, { decision: "approve", operation });
  assert.equal(result.status, "executed");
  assert.equal(result.requestedBy, "test:bob");
  assert.equal(result.decidedBy, "test:alice");
  const log = await session.sandbox.execute({ kind: "bash", command: "git log -1 --format='%an <%ae> / %cn <%ce>'" }, true, allowTestOperation, { allowTestShell: true });
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
  const approval = await source.createApproval("test:alice", { kind: "git.commit", message: "must not replay" });
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

test("restore checks actual paused pi tasks, not only a manifest claiming idle", { skip: process.platform !== "linux" }, async t => {
  const { service, directory } = await fixture(t);
  const source = binding("hidden-task-source");
  const rootDir = join(directory, "hidden-task-stage");
  await mkdir(rootDir, { mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(rootDir, "session.sqlite"));
  const harness = await Harness.open(storage, { models: runnerModels(source.model, true), registry: createRegistry() }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: source.model.modelId } } });
  const manifest = { binding: source, branches: [{ id: root.id, mode: "write" as const }], runs: {}, approvals: {}, toolActors: {} };
  const state = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }) });
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
        fauxToolCall("git_commit", { message: "Review this commit" }),
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
  await idle(session);
  const view = await session.view();
  assert.equal(view.approvals.length, 3);
  assert.ok(view.approvals.every(approval => approval.requestedBy === "test:bob" && approval.admissionId === admissionId));
  assert.deepEqual(view.approvals.map(approval => approval.operation.kind).sort(), ["bash", "git.commit", "github.comment"]);
  assert.ok(view.entries.every(entry => !entry.text.includes(admissionId)), "proof must not appear in user, tool-result, or model transcript content");
  const explicit = await session.createApproval("test:bob", { kind: "github.comment", repository: "example/repo", issue: 2, body: "Explicit operation" });
  assert.equal(explicit.admissionId, undefined, "explicit operations use the Worker's authenticated-request pin instead");
  await session.restart();
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
  assert.ok((await recovered.view()).approvals.every(approval => approval.status === "interrupted" && approval.admissionId === undefined));
  const restoredBackup = await recovered.backup({ ...await ticket(restoredBinding.session.id, "backup"), connectorId });
  assert.equal(restoredBackup.manifest.runs[receipt.submissionId]!.admissionId, undefined, "restoring history never transfers source admission authority");
  await recoveredService.close();
});

test("only the host's owner lets a command run without the resource limits the host lacks", { skip: process.platform !== "linux" }, async t => {
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
  // On someone else's host the call fails without a card: nobody in the session may lift the host's limits.
  const shared = await start("limitless-shared", "test:host", "echo shared");
  await idle(shared);
  const sharedView = await shared.view();
  assert.deepEqual(sharedView.approvals, []);
  assert.ok(sharedView.entries.some(entry => entry.role === "toolResult" && entry.text.includes("quota-backed")));

  const own = await start("limitless-own", "test:alice", "echo unlimited-marker");
  const request = await permissionRequest(own);
  assert.deepEqual(request.operation, { kind: "permission", tool: "bash", target: "echo unlimited-marker", needs: ["unbounded-shell"] });
  assert.equal(request.admissionId, admissionId);
  await own.decide({ ...await ticket("limitless-own", "approve"), connectorId }, request.id, { decision: "approve", operation: request.operation });
  await idle(own);
  // The consent covers running unlimited; the command itself still waits for its approval.
  const command = (await own.view()).approvals.find(approval => approval.operation.kind === "bash");
  assert.ok(command);
  assert.equal(command.status, "pending");
  assert.equal(command.unbounded, true);
  const ran = await own.decide({ ...await ticket("limitless-own", "approve"), connectorId }, command.id, { decision: "approve", operation: command.operation });
  assert.equal(ran.status, "executed");
  assert.match(ran.result ?? "", /unlimited-marker/);
});

test("shell commands may reserve address space they never touch, as gh and node do when they start", { skip: process.platform !== "linux" }, async t => {
  const { service } = await fixture(t);
  const session = await service.provision(binding("reserve-session"), await ticket("reserve-session", "create"));
  // Mapped PROT_NONE, 16 GiB commits no memory: only an address-space cap refuses it.
  const command = "python3 -I -c 'import mmap; mmap.mmap(-1, 16 << 30, flags=mmap.MAP_PRIVATE, prot=0); print(\"reserved\")'";
  assert.match(await session.sandbox.execute({ kind: "bash", command }, true, allowTestOperation, { allowTestShell: true }), /reserved/);
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
  const approval = view.approvals.find(candidate => candidate.operation.kind === "bash");
  assert.equal(approval?.status, "executed");
  assert.equal(approval!.automatic, true);
  assert.equal(approval!.decidedBy, "test:alice");
  assert.match(approval!.result ?? "", /auto-output-marker/);

  // Without options the next run returns to per-command human approval.
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_BASH echo pending-marker", requestId: "default" }, "write");
  await idle(session);
  view = await session.view();
  assert.equal(view.access, undefined);
  const pending = view.approvals.find(candidate => candidate.operation.kind === "bash" && candidate.id !== approval!.id);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.automatic, undefined);
});

test("a tool outside the agent waits for its owner, who allows it once or for the rest of the session", hostMode, async t => {
  const { service, grants } = await hostFixture(t);
  grants["test:bob"] = ["read", "ask", "write", "approve"];
  const id = "permission-session";
  const base = binding(id);
  const session = await service.provision({ ...base, agent: { ...base.agent, tools: ["identity", "read_file"] } }, await ticket(id, "create"));
  const commands = () => session.view().then(view => view.approvals.filter(approval => approval.operation.kind === "bash"));

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
  await idle(session);
  // Allowing the tool doesn't run the command: it still gets its own approval.
  let pending = await commands();
  assert.deepEqual(pending.map(approval => [approval.operation, approval.status]), [[{ kind: "bash", command: "echo once" }, "pending"]]);
  await assert.rejects(session.createApproval("test:alice", { kind: "bash", command: "echo explicit" }), rejectedWith(403, /not enabled/));

  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo again", requestId: "again" }, "write");
  const again = await permissionRequest(session);
  assert.notEqual(again.id, once.id, "one call's permission doesn't cover the next");
  await session.decide(await ticket(id, "approve"), again.id, { decision: "approve", operation: again.operation, scope: "session" });
  await idle(session);
  await session.submit(await ticket(id, "submit"), { content: "TEST_BASH echo granted", requestId: "granted" }, "write");
  await idle(session);
  const view = await session.view();
  assert.equal(view.approvals.filter(approval => approval.operation.kind === "permission").length, 2, "the session grant asks no more");
  pending = await commands();
  assert.deepEqual(pending.map(approval => approval.operation), ["echo once", "echo again", "echo granted"].map(command => ({ kind: "bash", command })));
  assert.equal((await session.createApproval("test:alice", { kind: "bash", command: "echo explicit" })).status, "pending");
  await assert.rejects(session.decide(await ticket(id, "approve"), again.id, { decision: "approve", operation: again.operation }), rejectedWith(409, /already been decided/));
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
  await idle(session);
  const view = await session.view();
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind === "permission").map(approval => [approval.status, approval.scope]), [["approved", "session"], ["approved", "session"]]);
  assert.deepEqual(view.approvals.filter(approval => approval.operation.kind === "bash").map(approval => approval.operation.kind === "bash" && approval.operation.command).sort(), ["echo one", "echo two"]);
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
