import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { signToken, sha256 } from "../packages/shared/src/crypto.js";
import type { RunnerBinding, RunnerTicket, RunnerAction, Permission, AuthorizationRequest } from "../packages/shared/src/types.js";
import { assertId, requestKey, stableJson, validateBinding, validateOperation, verifyRunnerTicket } from "../apps/runner/src/protocol.js";
import { RunnerService, createRunnerApp } from "../apps/runner/src/server.js";
import { RunnerSession } from "../apps/runner/src/session.js";
import { acquireRunnerLease } from "../apps/runner/src/lease.js";

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
  const log = await session.sandbox.execute({ kind: "bash", command: "git log -1 --format='%an <%ae> / %cn <%ce>'" }, true, allowTestOperation);
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
