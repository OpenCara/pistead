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
import type { RunnerBinding, RunnerTicket, RunnerAction, Permission, AuthorizationRequest } from "../packages/shared/src/types.js";
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
  assert.equal((await source.view()).approvals.find(item => item.id === approval.id)?.status, "pending");
  assert.equal(await restored.sandbox.readFile("evidence.txt", allowTestOperation), "original");
  assert.match(await readFile(join(directory, "sessions", target.session.id, "sandbox", "owner.gitconfig"), "utf8"), /Alice Current/);
  await restored.consumeTicket({ ...oldTicket, sessionId: target.session.id });
  await restored.submit({ ...await ticket(target.session.id, "submit"), policyVersion }, { requestId: "target-write", content: "TEST_WRITE evidence.txt\nnew session" }, "write");
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
  return { service };
}

test("read access withholds write tools and auto access runs owner commands immediately", hostMode, async t => {
  const { service } = await hostFixture(t);
  const session = await service.provision(binding("options-session"), await ticket("options-session", "create"));
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_WRITE read-only.txt\nleaked", requestId: "read", options: { access: "read" } }, "write");
  await idle(session);
  await assert.rejects(session.sandbox.readFile("read-only.txt", allowTestOperation));
  let view = await session.view();
  assert.ok(view.entries.some(entry => entry.text.includes("Denied: write_file")));
  assert.equal(view.access, "read");
  assert.equal(view.approvals.length, 0);

  await session.submit(await ticket("options-session", "submit"), { content: "TEST_BASH echo auto-output-marker", requestId: "auto", options: { access: "auto" } }, "write");
  await idle(session);
  view = await session.view();
  assert.equal(view.access, "auto");
  assert.equal(view.approvals.length, 1);
  const [approval] = view.approvals;
  assert.equal(approval!.status, "executed");
  assert.equal(approval!.automatic, true);
  assert.equal(approval!.decidedBy, "test:alice");
  assert.match(approval!.result ?? "", /auto-output-marker/);

  // Without options the next run returns to per-command human approval.
  await session.submit(await ticket("options-session", "submit"), { content: "TEST_BASH echo pending-marker", requestId: "default" }, "write");
  await idle(session);
  view = await session.view();
  assert.equal(view.access, undefined);
  const pending = view.approvals.find(candidate => candidate.id !== approval!.id);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.automatic, undefined);
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
