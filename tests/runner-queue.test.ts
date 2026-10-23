import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, type ConversationId, type TaskInspection } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, Permission, RunnerAction, RunnerBinding, RunnerTicket, SessionActivity, SessionView, SubmitInput, SubmitResult } from "../packages/shared/src/types.js";
import { requestKey, RunnerError } from "../apps/runner/src/protocol.js";
import { runnerModels } from "../apps/runner/src/provider.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerSession, type RunnerConfig } from "../apps/runner/src/session.js";

// These are integration-style source tests: real pi Harness, SQLite and sandbox tools.
// Linux needs working bwrap FD mounts/user namespaces, Python 3 and Git, as in runner.test.ts.
// provider.ts accepts TEST_HOLD (not TEST_DELAY); no timed provider hold is needed here.
const options = { skip: process.platform !== "linux", timeout: 60_000 };
const OWNER = "test:alice";
const WRITER = "test:bob";
const SECRET = "queue-test-secret-not-a-production-secret-123456";
type Mode = "write" | "ask";
// Only the fields inspected/changed by the offline crash fixture; preserve the rest.
type Metadata = {
  runs: Record<string, {
    key: string; conversationId: number; sequence?: number; status: string; submissionId?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });

function binding(): RunnerBinding {
  const createdAt = "2026-01-01T00:00:00Z";
  return {
    session: { id: "queue-session", workspaceId: "workspace", ownerId: OWNER, agentVersionId: "version-1", title: "Queue tests", policyVersion: 1, status: "ready", createdAt },
    owner: { id: OWNER, githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "queue-agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Queue test agent", description: "Deterministic tests", instructions: "Use tools.", tools: ["identity", "read_file", "write_file"], modelId: "model-1", createdAt },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider (not an LLM)", provider: "faux", modelId: "queue-faux" },
  };
}

async function ticket(sessionId: string, action: RunnerAction, actorId = OWNER, body = ""): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId, actorId, ownerId: OWNER, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256(body) };
}

async function submit(session: RunnerSession, actorId: string, mode: Mode, input: SubmitInput): Promise<SubmitResult> {
  return session.submit(await ticket(session.binding.session.id, mode === "ask" ? "ask" : "submit", actorId, JSON.stringify(input)), input, mode);
}

async function idle(session: RunnerSession): Promise<SessionView> {
  // Real Harness tasks and sandbox processes cannot be advanced with fake timers.
  // Poll the public busy condition, as runner.test.ts does; gates establish ordering.
  for (let count = 0; count < 500; count++) {
    const view = await session.view();
    if (!view.busy) return view;
    await delay(20);
  }
  assert.fail(`runner did not settle: ${JSON.stringify((await session.view()).queue)}`);
}

function queue(view: SessionView) {
  assert.ok(view.queue, "the durable runner queue must be exposed");
  return view.queue;
}

function sameReceipt(actual: SubmitResult, expected: SubmitResult): void {
  // Status and queuePosition are observations, not part of the stable receipt identity.
  assert.equal(actual.submissionId, expected.submissionId);
  assert.equal(actual.conversationId, expected.conversationId);
}

function runnerError(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  };
}

function userEntries(view: SessionView, receipt: SubmitResult, content: string) {
  return view.entries.filter(entry => entry.conversationId === receipt.conversationId && entry.role === "user" && entry.text === content);
}

function toolResult(view: SessionView, receipt: SubmitResult, predicate: (value: Record<string, unknown>) => boolean): void {
  assert.ok(view.entries.some(entry => {
    if (entry.conversationId !== receipt.conversationId || entry.role !== "toolResult") return false;
    try { return predicate(JSON.parse(entry.text) as Record<string, unknown>); }
    catch { return false; }
  }), `missing actual tool result in conversation ${receipt.conversationId}`);
}

function file(session: RunnerSession, name: string): Promise<string> {
  // Observe the backing file only; all effects under test go through actual pi tools.
  return readFile(join(session.directory, "sandbox", "worktree", name), "utf8");
}

async function pauseQueue(session: RunnerSession): Promise<() => void> {
  await session.exclusive(async () => {});
  // A scheduling-only seam for queued-only snapshots. Admission, documents, branches,
  // authorization and pi execution are never mocked. Restore the real drain to run jobs.
  const scheduler = session as unknown as { drainQueue(): void };
  const drain = scheduler.drainQueue;
  scheduler.drainQueue = () => {};
  return () => { scheduler.drainQueue = drain; drain.call(session); };
}

async function fixture(t: TestContext, { reportActivity = false, config: overrides = {} }: { reportActivity?: boolean; config?: Partial<RunnerConfig> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "runner-queue-"));
  const input = binding();
  const grants: Record<string, Permission[]> = {
    [OWNER]: ["read", "ask", "write", "approve", "manage"],
    [WRITER]: ["read", "ask", "write"],
  };
  const calls: AuthorizationRequest[] = [];
  const gates: { actorId: string; permission: Permission; remaining: number; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }[] = [];
  const reports: [string, SessionActivity][] = [];
  const config: RunnerConfig = {
    dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true,
    // As a connected runner reports to the control plane.
    ...(reportActivity ? { reportActivity: async (sessionId: string, activity: SessionActivity) => { reports.push([sessionId, activity]); } } : {}),
    authorize: async request => {
      calls.push({ ...request });
      for (const gate of gates) {
        if (gate.actorId === request.actorId && gate.permission === request.permission && gate.remaining > 0 && --gate.remaining === 0) {
          gate.entered.resolve();
          await gate.release.promise;
        }
      }
      return { allowed: grants[request.actorId]?.includes(request.permission) ?? false, ownerId: input.owner.id, policyVersion: 1 };
    },
    ...overrides,
  };
  let service: RunnerService | undefined;
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    try { await service?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  service = new RunnerService(config);
  await service.initialize();
  const session = await service.provision(input, await ticket(input.session.id, "create"));
  return {
    session, grants, calls, reports,
    /** Waits for the runner to report `activity`; reports follow each change once it settles. */
    async reported(activity: SessionActivity) {
      for (let count = 0; count < 250 && reports.at(-1)?.[1] !== activity; count++) await delay(20);
      assert.deepEqual(reports.at(-1), [input.session.id, activity], `reports so far: ${JSON.stringify(reports)}`);
    },
    gateTool(actorId: string, mode: Mode) {
      // A fresh submit authorizes admission, activation, then its first tool. Blocking
      // the third call leaves the runner lock free, so other jobs can be durably queued.
      const gate = { actorId, permission: mode, remaining: 3, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      gates.push(gate);
      return {
        async entered() {
          await gate.entered.promise;
          await session.exclusive(async () => {});
        },
        release: () => gate.release.resolve(),
      };
    },
    async stop() { await service!.close(); service = undefined; },
    async reopen() {
      assert.equal(service, undefined, "close the previous service before opening its SQLite database");
      service = new RunnerService(config);
      await service.initialize();
      return service.get(input.session.id);
    },
  };
}

async function stored<T>(session: RunnerSession, operation: (harness: Harness) => Promise<T>): Promise<T> {
  // Only call with RunnerService closed. Harness.open and document reads do not resume tasks.
  const storage = await openNodeSqliteStorage(session.sqlitePath);
  let harness: Harness;
  try { harness = await Harness.open(storage, { models: runnerModels(session.binding.model, true), registry: createRegistry() }, context); }
  catch (error) { await storage.close(context); throw error; }
  try { return await operation(harness); }
  finally { await harness.close(context); }
}

async function metadata(harness: Harness): Promise<Metadata> {
  const doc = await harness.snapshot(RunnerState, context);
  assert.ok(doc?.json, "runner metadata must already exist in pi storage");
  return JSON.parse(doc.json) as Metadata;
}

test("write and ask share FIFO, and placement does not let the next job overtake an active tool", options, async t => {
  const f = await fixture(t);
  const firstGate = f.gateTool(OWNER, "write");
  const firstInput = { content: "TEST_IDENTITY", requestId: "active" };
  const first = await submit(f.session, OWNER, "write", firstInput);
  await firstGate.entered();
  const writeInput = { content: "TEST_WRITE order.txt\nfirst", requestId: "write-first" };
  const write = await submit(f.session, WRITER, "write", writeInput);
  const askGate = f.gateTool(WRITER, "ask");
  const askInput = { content: "TEST_READ order.txt", requestId: "read-between" };
  const ask = await submit(f.session, WRITER, "ask", askInput);
  const lastInput = { content: "TEST_WRITE order.txt\nlast", requestId: "write-last" };
  const last = await submit(f.session, WRITER, "write", lastInput);
  const receipts = [first, write, ask, last];
  assert.deepEqual(receipts.map(receipt => receipt.queuePosition), [1, 2, 3, 4]);
  assert.equal(write.conversationId, first.conversationId);
  assert.equal(last.conversationId, first.conversationId);
  assert.notEqual(ask.conversationId, first.conversationId);
  let view = await f.session.view();
  assert.equal(view.busy, true);
  assert.deepEqual(queue(view).map(run => [run.submissionId, run.status]), receipts.map((receipt, index) => [receipt.submissionId, index === 0 ? "running" : "queued"]));
  assert.equal(userEntries(view, write, writeInput.content).length, 0);
  firstGate.release();
  await askGate.entered();
  view = await f.session.view();
  assert.deepEqual(queue(view).map(run => run.status), ["settled", "settled", "running", "queued"]);
  assert.equal(await file(f.session, "order.txt"), "first");
  assert.equal(userEntries(view, last, lastInput.content).length, 0);
  askGate.release();
  view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), receipts.map(() => "settled"));
  assert.deepEqual(queue(view).map(run => [run.actorId, run.mode]), [[OWNER, "write"], [WRITER, "write"], [WRITER, "ask"], [WRITER, "write"]]);
  assert.equal(await file(f.session, "order.txt"), "last");
  toolResult(view, ask, result => result.content === "first" && result.initiatedBy === WRITER && result.actingAs === OWNER && result.mode === "ask");
  for (const [receipt, content] of [[first, firstInput.content], [write, writeInput.content], [ask, askInput.content], [last, lastInput.content]] as const) {
    assert.equal(userEntries(view, receipt, content).length, 1);
  }
});

test("queued write/ask FIFO and receipt identity survive a fresh service over the same SQLite", options, async t => {
  const f = await fixture(t);
  await pauseQueue(f.session);
  const jobs = [
    { mode: "write" as const, content: "TEST_WRITE durable.txt\nbefore", requestId: "durable-first" },
    { mode: "ask" as const, content: "TEST_READ durable.txt", requestId: "durable-read" },
    { mode: "write" as const, content: "TEST_WRITE durable.txt\nafter", requestId: "durable-last" },
  ];
  const receipts: SubmitResult[] = [];
  for (const job of jobs) receipts.push(await submit(f.session, WRITER, job.mode, { content: job.content, requestId: job.requestId }));
  assert.deepEqual(queue(await f.session.view()).map(run => run.status), ["queued", "queued", "queued"]);
  await f.stop();
  await stored(f.session, async harness => {
    const state = await metadata(harness);
    assert.deepEqual(Object.values(state.runs).map(run => [run.key, run.sequence, run.status, run.submissionId]), receipts.map((receipt, index) => [receipt.submissionId, index, "queued", undefined]));
  });
  const recovered = await f.reopen();
  const view = await idle(recovered);
  assert.deepEqual(queue(view).map(run => [run.submissionId, run.status]), receipts.map(receipt => [receipt.submissionId, "settled"]));
  assert.equal(await file(recovered, "durable.txt"), "after");
  toolResult(view, receipts[1], result => result.content === "before" && result.initiatedBy === WRITER);
  for (const [index, job] of jobs.entries()) {
    const retry = await submit(recovered, WRITER, job.mode, { content: job.content, requestId: job.requestId });
    sameReceipt(retry, receipts[index]);
    assert.equal(retry.status, "settled");
    assert.equal(userEntries(view, retry, job.content).length, 1);
  }
  assert.deepEqual((await recovered.view()).entries, view.entries);
});

test("concurrent retries deduplicate by actor and mode, preserve receipts across restart, and reject content conflicts", options, async t => {
  const f = await fixture(t);
  const resume = await pauseQueue(f.session);
  const input = { content: "TEST_IDENTITY", requestId: "shared-id" };
  const writes = await Promise.all(Array.from({ length: 8 }, () => submit(f.session, WRITER, "write", input)));
  const asks = await Promise.all(Array.from({ length: 8 }, () => submit(f.session, WRITER, "ask", input)));
  for (const receipt of writes) { sameReceipt(receipt, writes[0]); assert.equal(receipt.status, "queued"); }
  for (const receipt of asks) { sameReceipt(receipt, asks[0]); assert.equal(receipt.status, "queued"); }
  const otherActor = await submit(f.session, OWNER, "write", input);
  assert.equal(new Set([writes[0].submissionId, asks[0].submissionId, otherActor.submissionId]).size, 3);
  assert.equal(writes[0].submissionId, await requestKey(WRITER, "write", input.requestId));
  assert.equal(asks[0].submissionId, await requestKey(WRITER, "ask", input.requestId));
  assert.notEqual(asks[0].conversationId, writes[0].conversationId);
  let view = await f.session.view();
  assert.equal(queue(view).length, 3);
  assert.equal(view.conversations.length, 2, "duplicate asks must not fork extra branches");
  for (const mode of ["write", "ask"] as const) {
    await assert.rejects(submit(f.session, WRITER, mode, { ...input, content: "TEST_READ different.txt" }), runnerError(409, /different content/));
  }
  resume();
  view = await idle(f.session);
  toolResult(view, asks[0], result => result.mode === "ask" && result.initiatedBy === WRITER);
  assert.equal(userEntries(view, writes[0], input.content).length, 2, "one write per actor, not one per retry");
  assert.equal(userEntries(view, asks[0], input.content).length, 1);
  await f.stop();
  const recovered = await f.reopen();
  const before = await idle(recovered);
  for (const [actor, mode, receipt] of [[WRITER, "write", writes[0]], [WRITER, "ask", asks[0]], [OWNER, "write", otherActor]] as const) {
    const retry = await submit(recovered, actor, mode, input);
    sameReceipt(retry, receipt);
    assert.equal(retry.status, "settled");
    await assert.rejects(submit(recovered, actor, mode, { ...input, content: "TEST_HOLD 0" }), runnerError(409, /different content/));
  }
  assert.deepEqual(await recovered.view(), before);
});

test("simultaneous different-content requests have one durable winner and one conflict", options, async t => {
  const f = await fixture(t);
  const resume = await pauseQueue(f.session);
  const inputs = [
    { content: "TEST_WRITE winner.txt\none", requestId: "race" },
    { content: "TEST_WRITE winner.txt\ntwo", requestId: "race" },
  ];
  const results = await Promise.allSettled(inputs.map(input => submit(f.session, WRITER, "write", input)));
  const winningIndex = results.findIndex(result => result.status === "fulfilled");
  assert.notEqual(winningIndex, -1);
  const winner = results[winningIndex];
  const loser = results[1 - winningIndex];
  assert.equal(winner.status, "fulfilled");
  assert.equal(loser.status, "rejected");
  if (winner.status !== "fulfilled" || loser.status !== "rejected") assert.fail("expected exactly one winner");
  runnerError(409, /different content/)(loser.reason);
  assert.equal(queue(await f.session.view()).length, 1);
  resume();
  const view = await idle(f.session);
  assert.equal(await file(f.session, "winner.txt"), winningIndex === 0 ? "one" : "two");
  assert.equal(userEntries(view, winner.value, inputs[winningIndex].content).length, 1);
  assert.equal(userEntries(view, winner.value, inputs[1 - winningIndex].content).length, 0);
});

test("64 unfinished jobs include the active run; full-queue retries are free and terminal jobs release capacity", options, async t => {
  const f = await fixture(t);
  const gate = f.gateTool(OWNER, "write");
  const activeInput = { content: "TEST_IDENTITY", requestId: "active" };
  const active = await submit(f.session, OWNER, "write", activeInput);
  await gate.entered();
  const queuedInput = { content: "TEST_HOLD 0", requestId: "queued-0" };
  let queued!: SubmitResult;
  for (let index = 0; index < 63; index++) {
    const receipt = await submit(f.session, WRITER, "write", { ...queuedInput, requestId: `queued-${index}` });
    assert.equal(receipt.queuePosition, index + 2);
    if (index === 0) queued = receipt;
  }
  const full = await f.session.view();
  assert.equal(queue(full).length, 64);
  assert.equal(queue(full).filter(run => run.status === "queued").length, 63);
  assert.equal(queue(full)[0].status, "running");
  for (const mode of ["write", "ask"] as const) {
    await assert.rejects(submit(f.session, WRITER, mode, { content: "TEST_IDENTITY", requestId: `overflow-${mode}` }), runnerError(429, /queue is full/));
  }
  sameReceipt(await submit(f.session, OWNER, "write", activeInput), active);
  sameReceipt(await submit(f.session, WRITER, "write", queuedInput), queued);
  await assert.rejects(submit(f.session, WRITER, "write", { ...queuedInput, content: "TEST_IDENTITY" }), runnerError(409, /different content/));
  assert.deepEqual(await f.session.view(), full, "rejections and retries must not allocate runs or ask branches");
  f.grants[WRITER] = ["read"];
  gate.release();
  const drained = await idle(f.session);
  assert.deepEqual(queue(drained).map(run => run.status), ["settled", ...Array<string>(63).fill("interrupted")]);
  const next = await submit(f.session, OWNER, "write", { content: "TEST_WRITE capacity.txt\nreclaimed", requestId: "after-full" });
  assert.equal(next.queuePosition, 1);
  await idle(f.session);
  assert.equal(await file(f.session, "capacity.txt"), "reclaimed");
});

test("queued content is bounded at exactly 1 MiB of UTF-8, including active content, independently of the character limit", options, async t => {
  const f = await fixture(t);
  const gate = f.gateTool(OWNER, "write");
  const activeInput = { content: "TEST_IDENTITY", requestId: "active" };
  await submit(f.session, OWNER, "write", activeInput);
  await gate.entered();
  await assert.rejects(submit(f.session, WRITER, "write", { content: "x".repeat(100_001), requestId: "too-many-characters" }), runnerError(400, /Invalid submission/));
  const multibyte = "\u20ac".repeat(100_000);
  assert.equal(multibyte.length, 100_000);
  assert.equal(Buffer.byteLength(multibyte, "utf8"), 300_000);
  let bytes = Buffer.byteLength(activeInput.content, "utf8");
  for (let index = 0; index < 3; index++) {
    await submit(f.session, WRITER, "write", { content: multibyte, requestId: `multibyte-${index}` });
    bytes += Buffer.byteLength(multibyte, "utf8");
  }
  const remaining = 1024 * 1024 - bytes;
  const exact = { content: "\u20ac".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3), requestId: "exact-byte-boundary" };
  assert.ok(exact.content.length <= 100_000);
  assert.equal(bytes + Buffer.byteLength(exact.content, "utf8"), 1024 * 1024);
  const receipt = await submit(f.session, WRITER, "write", exact);
  const full = await f.session.view();
  assert.equal(queue(full).length, 5, "the byte limit must be reached before the 64-job limit");
  for (const mode of ["write", "ask"] as const) {
    await assert.rejects(submit(f.session, WRITER, mode, { content: "x", requestId: `one-byte-over-${mode}` }), runnerError(429, /queued content limit exceeded/));
  }
  sameReceipt(await submit(f.session, WRITER, "write", exact), receipt);
  assert.deepEqual(await f.session.view(), full);
  f.grants[WRITER] = ["read"];
  gate.release();
  await idle(f.session);
  const next = await submit(f.session, OWNER, "write", { content: "TEST_WRITE bytes.txt\nreclaimed", requestId: "after-bytes" });
  assert.equal(next.queuePosition, 1);
  await idle(f.session);
  assert.equal(await file(f.session, "bytes.txt"), "reclaimed");
});

test("revoking the original queued actor interrupts its job before pi activation and continues the next valid job", options, async t => {
  const f = await fixture(t);
  const gate = f.gateTool(OWNER, "write");
  await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "active" });
  await gate.entered();
  const forbiddenInput = { content: "TEST_WRITE forbidden.txt\nrevoked", requestId: "revoked" };
  const forbidden = await submit(f.session, WRITER, "write", forbiddenInput);
  const allowedInput = { content: "TEST_WRITE allowed.txt\nowner remains authorized", requestId: "valid-next" };
  const allowed = await submit(f.session, OWNER, "write", allowedInput);
  assert.equal(queue(await f.session.view())[1].status, "queued");
  const beforeRevocation = f.calls.length;
  f.grants[WRITER] = ["read"];
  gate.release();
  const view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["settled", "interrupted", "settled"]);
  assert.ok(f.calls.slice(beforeRevocation).some(call => call.actorId === WRITER && call.permission === "write" && call.ownerId === OWNER));
  assert.equal(userEntries(view, forbidden, forbiddenInput.content).length, 0, "revoked input must never reach pi");
  await assert.rejects(file(f.session, "forbidden.txt"), { code: "ENOENT" });
  assert.equal(await file(f.session, "allowed.txt"), "owner remains authorized");
  toolResult(view, allowed, result => result.written === "allowed.txt" && result.initiatedBy === OWNER);
  await assert.rejects(submit(f.session, WRITER, "write", forbiddenInput), runnerError(403, /revoked/));
  f.grants[WRITER] = ["read", "write"];
  const retry = await submit(f.session, WRITER, "write", forbiddenInput);
  sameReceipt(retry, forbidden);
  assert.equal(retry.status, "interrupted", "regranting must not replay an interrupted receipt");
  assert.deepEqual(await f.session.view(), view);
});

test("connected runners report what the agent is doing as it changes, as their views show it", options, async t => {
  const f = await fixture(t, { reportActivity: true });
  await f.reported("idle");
  assert.equal((await f.session.view()).activity, "idle");
  const gate = f.gateTool(OWNER, "write");
  await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "activity" });
  await gate.entered();
  assert.equal((await f.session.view()).activity, "working");
  await f.reported("working");
  gate.release();
  assert.equal((await idle(f.session)).activity, "done");
  await f.reported("done");
  assert.deepEqual(f.reports.map(([, activity]) => activity), ["idle", "working", "done"], "one report per change");
});

test("a shared message stopped before it ran leaves the session failed", options, async t => {
  const f = await fixture(t, { reportActivity: true });
  const gate = f.gateTool(OWNER, "write");
  await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "active" });
  await gate.entered();
  await submit(f.session, WRITER, "write", { content: "TEST_IDENTITY", requestId: "revoked" });
  f.grants[WRITER] = ["read"];
  gate.release();
  const view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["settled", "interrupted"]);
  assert.equal(view.activity, "failed");
  await f.reported("failed");
});

test("stopping ends the running message and those queued behind it, holds new ones until the host is done, then runs them", options, async t => {
  const f = await fixture(t, { reportActivity: true });
  const stop = async (actorId: string) => f.session.stop(await ticket(f.session.binding.session.id, "stop", actorId, "{}"));
  assert.deepEqual(await stop(WRITER), { stopped: 0 }, "nothing to stop");
  const gate = f.gateTool(OWNER, "write");
  const running = await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "running" });
  await gate.entered();
  const queuedInput = { content: "TEST_WRITE stopped.txt\nnever", requestId: "queued" };
  const queued = await submit(f.session, WRITER, "write", queuedInput);
  await assert.rejects(stop("test:carol"), runnerError(403, /revoked/), "stopping needs write access");
  assert.deepEqual(await stop(WRITER), { stopped: 2 });
  let view = await f.session.view();
  assert.equal(view.stoppable, true);
  // The running call is still in its tool, so its host has not finished stopping it.
  assert.deepEqual(queue(view).map(run => run.status), ["stopping", "stopped"]);
  assert.equal(view.busy, true);
  assert.equal(view.activity, "working");
  const nextInput = { content: "TEST_WRITE after.txt\nran", requestId: "after" };
  const next = await submit(f.session, WRITER, "write", nextInput);
  assert.deepEqual(queue(await f.session.view()).map(run => run.status), ["stopping", "stopped", "queued"], "new work waits for the stop");
  gate.release();
  view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["stopped", "stopped", "settled"]);
  assert.equal(userEntries(view, queued, queuedInput.content).length, 0, "a stopped queued message never reaches pi");
  await assert.rejects(file(f.session, "stopped.txt"), { code: "ENOENT" });
  assert.equal(await file(f.session, "after.txt"), "ran");
  toolResult(view, next, result => result.written === "after.txt" && result.initiatedBy === WRITER);
  // The stop follows the stopped message's own entries, before the next message's.
  const marker = view.entries.findIndex(entry => entry.kind === "workspace.run-stopped");
  assert.deepEqual(view.entries[marker], { id: `${running.conversationId}:stopped:${running.submissionId}`, kind: "workspace.run-stopped", role: "system", text: "Stopped", actorId: WRITER, conversationId: running.conversationId });
  assert.ok(view.entries.slice(0, marker).some(entry => entry.role === "user" && entry.text === "TEST_IDENTITY"));
  assert.ok(view.entries.slice(marker).some(entry => entry.role === "user" && entry.text === nextInput.content));
  assert.equal(view.activity, "done");
  const retry = await submit(f.session, WRITER, "write", queuedInput);
  sameReceipt(retry, queued);
  assert.equal(retry.status, "interrupted", "a stopped message is never replayed");
  await f.reported("done");
});

test("a stop the host had not finished before it closed is finished on reopen, and the held message then runs", options, async t => {
  const f = await fixture(t);
  const gate = f.gateTool(OWNER, "write");
  await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "running" });
  await gate.entered();
  assert.deepEqual(await f.session.stop(await ticket(f.session.binding.session.id, "stop", OWNER, "{}")), { stopped: 1 });
  const next = await submit(f.session, WRITER, "write", { content: "TEST_WRITE reopened.txt\nran", requestId: "held" });
  assert.deepEqual(queue(await f.session.view()).map(run => run.status), ["stopping", "queued"]);
  // Closing waits for the gated tool call to return.
  const closing = f.stop();
  gate.release();
  await closing;
  const recovered = await f.reopen();
  const view = await idle(recovered);
  assert.deepEqual(queue(view).map(run => run.status), ["stopped", "settled"]);
  assert.equal(await file(recovered, "reopened.txt"), "ran");
  toolResult(view, next, result => result.written === "reopened.txt");
});

test("stopping interrupts the stopped message's pending cards, so a later decision cannot run them", options, async t => {
  const f = await fixture(t);
  // A write in a read-only message asks the owner first and waits on that card.
  await submit(f.session, OWNER, "write", { content: "TEST_WRITE asked.txt\nmust-not-run", requestId: "asks", options: { access: "read" } });
  let card: SessionView["approvals"][number] | undefined;
  for (let count = 0; count < 250 && !card; count++) {
    card = (await f.session.view()).approvals.find(approval => approval.status === "pending");
    if (!card) await delay(20);
  }
  assert.ok(card, "the call must ask the owner");
  assert.deepEqual(await f.session.stop(await ticket(f.session.binding.session.id, "stop", OWNER, "{}")), { stopped: 1 });
  const stopped = (await f.session.view()).approvals.find(approval => approval.id === card.id);
  assert.equal(stopped?.status, "interrupted");
  const decision = { decision: "approve" as const, operation: card.operation };
  await assert.rejects(f.session.decide(await ticket(f.session.binding.session.id, "approve", OWNER, JSON.stringify(decision)), card.id, decision), runnerError(409, /decided/));
  const view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["stopped"]);
  assert.equal(view.approvals.find(approval => approval.id === card.id)?.status, "interrupted");
  await assert.rejects(file(f.session, "asked.txt"), { code: "ENOENT" });
});

test("an operation requested outside a message cannot run while a stop is still ending the stopped work", options, async t => {
  const f = await fixture(t);
  const gate = f.gateTool(OWNER, "write");
  await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "running" });
  await gate.entered();
  await f.session.stop(await ticket(f.session.binding.session.id, "stop", OWNER, "{}"));
  const outside = await f.session.createApproval(OWNER, { kind: "github.comment", repository: "owner/repo", issue: 1, body: "outside a message" }, undefined, { permitted: true });
  const decision = { decision: "approve" as const, operation: outside.operation };
  const decide = async () => f.session.decide(await ticket(f.session.binding.session.id, "approve", OWNER, JSON.stringify(decision)), outside.id, decision);
  await assert.rejects(decide(), runnerError(409, /queue to finish/));
  gate.release();
  await idle(f.session);
  // Past the queue check once the stopped work has ended: only the comment's missing broker capability refuses it now.
  await assert.rejects(decide(), runnerError(403, /broker capability/));
});

test("a session whose last shared message was stopped is idle, not failed", options, async t => {
  const f = await fixture(t);
  await pauseQueue(f.session);
  await submit(f.session, OWNER, "write", { content: "TEST_IDENTITY", requestId: "queued" });
  assert.deepEqual(await f.session.stop(await ticket(f.session.binding.session.id, "stop", OWNER, "{}")), { stopped: 1 });
  const view = await f.session.view();
  assert.equal(view.busy, false);
  assert.deepEqual(queue(view).map(run => run.status), ["stopped"]);
  assert.equal(view.activity, "idle");
  assert.equal(view.entries.length, 0);
});

test("backup refuses a queued-only session, not just an active pi generation", options, async t => {
  const f = await fixture(t);
  const resume = await pauseQueue(f.session);
  const input = { content: "TEST_WRITE backup.txt\nfinished", requestId: "queued-backup" };
  const receipt = await submit(f.session, OWNER, "write", input);
  const before = await f.session.view();
  assert.equal(before.busy, true);
  assert.deepEqual(queue(before).map(run => run.status), ["queued"]);
  assert.equal(before.entries.filter(entry => entry.role === "user").length, 0);
  await assert.rejects(f.session.backup(await ticket(f.session.binding.session.id, "backup")), runnerError(409, /idle session including queued work/));
  assert.deepEqual(await f.session.view(), before, "refused backup must leave the queue intact and the session open");
  sameReceipt(await submit(f.session, OWNER, "write", input), receipt);
  resume();
  await idle(f.session);
  const backup = await f.session.backup(await ticket(f.session.binding.session.id, "backup"));
  assert.equal(backup.format, "pi-runner-backup-v1");
  assert.equal(backup.manifest.runs[receipt.submissionId].status, "settled");
  assert.equal(Buffer.from(backup.sqlite, "base64").subarray(0, 15).toString(), "SQLite format 3");
  assert.equal(await file(f.session, "backup.txt"), "finished");
});

test("queued asks remain read-only after recovery even when their actor also has write permission", options, async t => {
  const f = await fixture(t);
  await submit(f.session, OWNER, "write", { content: "TEST_WRITE readonly.txt\noriginal", requestId: "seed" });
  const seeded = await idle(f.session);
  await pauseQueue(f.session);
  const input = { content: "TEST_WRITE readonly.txt\nforbidden", requestId: "readonly-ask" };
  const ask = await submit(f.session, WRITER, "ask", input);
  const next = await submit(f.session, WRITER, "write", { content: "TEST_WRITE next.txt\nvalid", requestId: "next-write" });
  assert.notEqual(ask.conversationId, next.conversationId);
  await f.stop();
  const recovered = await f.reopen();
  const view = await idle(recovered);
  assert.equal(await file(recovered, "readonly.txt"), "original");
  assert.equal(await file(recovered, "next.txt"), "valid");
  const askEntries = view.entries.filter(entry => entry.conversationId === ask.conversationId);
  const askStart = askEntries.findIndex(entry => entry.role === "user" && entry.text === input.content);
  assert.notEqual(askStart, -1);
  // The fork legitimately inherits the seed's write_file call; inspect only this ask.
  const askTurn = askEntries.slice(askStart + 1);
  assert.ok(askTurn.some(entry => entry.role === "assistant" && entry.text.includes("Denied: write_file is not available")));
  assert.equal(askTurn.some(entry => entry.role === "assistant" && entry.text.includes("write_file(")), false);
  assert.equal(askTurn.some(entry => entry.role === "toolResult"), false);
  assert.ok(view.entries.some(entry => entry.conversationId === ask.conversationId && entry.role === "user" && entry.text === "TEST_WRITE readonly.txt\noriginal"), "ask fork inherits the completed root transcript");
  assert.ok(view.entries.filter(entry => entry.conversationId === next.conversationId).length > seeded.entries.length);
  assert.equal(userEntries(view, ask, input.content).length, 1);
  assert.equal(userEntries(view, ask, input.content)[0].actorId, WRITER);
  assert.deepEqual(queue(view).map(run => run.status), ["settled", "settled", "settled"]);
  const retry = await submit(recovered, WRITER, "ask", input);
  sameReceipt(retry, ask);
  assert.equal(retry.status, "settled");
});

for (const mode of ["write", "ask"] as const) {
  test(`recovery reauthorizes a queued ${mode} as its original actor and skips it after revocation`, options, async t => {
    const f = await fixture(t);
    await pauseQueue(f.session);
    const input = { content: "TEST_WRITE revoked-recovery.txt\nforbidden", requestId: `revoked-${mode}` };
    const revoked = await submit(f.session, WRITER, mode, input);
    const nextInput = { content: "TEST_WRITE recovered.txt\nvalid", requestId: "valid-after-recovery" };
    const next = await submit(f.session, OWNER, "write", nextInput);
    assert.deepEqual(queue(await f.session.view()).map(run => run.status), ["queued", "queued"]);
    await f.stop();
    f.grants[WRITER] = ["read"];
    const callIndex = f.calls.length;
    const recovered = await f.reopen();
    const view = await idle(recovered);
    assert.deepEqual(queue(view).map(run => [run.submissionId, run.actorId, run.status]), [[revoked.submissionId, WRITER, "interrupted"], [next.submissionId, OWNER, "settled"]]);
    assert.ok(f.calls.slice(callIndex).some(call => call.actorId === WRITER && call.permission === mode && call.ownerId === OWNER));
    assert.equal(userEntries(view, revoked, input.content).length, 0);
    await assert.rejects(file(recovered, "revoked-recovery.txt"), { code: "ENOENT" });
    assert.equal(await file(recovered, "recovered.txt"), "valid");
    assert.equal(userEntries(view, next, nextInput.content).length, 1);
    f.grants[WRITER] = ["read", "ask", "write"];
    const retry = await submit(recovered, WRITER, mode, input);
    sameReceipt(retry, revoked);
    assert.equal(retry.status, "interrupted");
    assert.deepEqual(await recovered.view(), view);
  });
}

test("synthetic post-submit activation crash window reuses pi requestId rather than placing the input twice", options, async t => {
  const f = await fixture(t);
  const input = { content: "TEST_WRITE once.txt\nonce", requestId: "activation-window" };
  const receipt = await submit(f.session, WRITER, "write", input);
  const before = await idle(f.session);
  assert.equal(await file(f.session, "once.txt"), "once");
  await f.stop();
  const piSubmissionId = await stored(f.session, async harness => {
    const state = await metadata(harness);
    const run = state.runs[receipt.submissionId];
    assert.equal(run.status, "settled");
    assert.equal(typeof run.submissionId, "number");
    const conversation = await harness.conversation(run.conversationId as ConversationId, context);
    assert.ok(conversation);
    const persisted = await conversation.commit(tx => tx.submissionByRequest(conversation.id, run.key), context);
    assert.ok(persisted, "the real pi submission must carry the runner's request key");
    assert.equal(persisted.id, run.submissionId);
    // Model the durable cut after pi admission but before RunnerSession saves its numeric
    // submission ID. Keep the real pi receipt/transcript/effect; do not fabricate pi rows.
    await conversation.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      const current = JSON.parse(doc.json) as Metadata;
      current.runs[run.key].status = "admitting";
      delete current.runs[run.key].submissionId;
      doc.json = JSON.stringify(current);
    }, context);
    const cut = (await metadata(harness)).runs[run.key];
    assert.equal(cut.status, "admitting");
    assert.equal(cut.submissionId, undefined);
    return persisted.id;
  });
  const recovered = await f.reopen();
  const after = await idle(recovered);
  assert.deepEqual(after.entries, before.entries, "recovery must not append another user, model or tool entry");
  assert.equal(userEntries(after, receipt, input.content).length, 1);
  assert.equal(queue(after).length, 1);
  assert.equal(queue(after)[0].status, "settled");
  assert.equal(await file(recovered, "once.txt"), "once");
  sameReceipt(await submit(recovered, WRITER, "write", input), receipt);
  await f.stop();
  await stored(recovered, async harness => {
    const run = (await metadata(harness)).runs[receipt.submissionId];
    assert.equal(run.submissionId, piSubmissionId, "recovery must rediscover the original numeric pi submission");
    assert.equal(run.status, "settled");
  });
});

/**
 * Storage a test can crash: from `crash()` on, every call fails, which fails the Harness without the close that would
 * write its running tasks back, as a host that died mid-message would. `crash()` then reopens the session.
 */
function crashableStorage() {
  let crashed = () => {};
  return {
    async open(path: string) {
      const storage = await openNodeSqliteStorage(path);
      let dead = false;
      crashed = () => { dead = true; };
      return new Proxy(storage, { get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => dead && key !== "close" ? Promise.reject(new Error("simulated host crash")) : value.apply(target, args);
      } });
    },
    async crash(session: RunnerSession) {
      crashed();
      // A commit fails the Harness, unless running work hit the crash first.
      await assert.rejects(session.consumeTicket(await ticket(session.binding.session.id, "view")), /simulated host crash|Session failed/);
      for (let count = 0; count < 250 && !session.failed; count++) await delay(20);
      assert.equal(session.failed, true);
      await session.recover();
    },
  };
}

/** A test seam: the open Harness's own view of its tasks. */
async function tasks(session: RunnerSession): Promise<readonly TaskInspection[]> {
  return (await (session as unknown as { harness: Harness }).harness.inspect(context)).tasks;
}

/** Waits until a task `which` picks is running. */
async function running(session: RunnerSession, which: (task: TaskInspection) => boolean, what: string): Promise<void> {
  const found = async () => (await tasks(session)).some(task => task.state.kind === "running" && which(task));
  for (let count = 0; count < 250 && !(await found()); count++) await delay(20);
  assert.ok(await found(), `${what} must be running`);
}

test("a message whose work host crashes cut off again and again ends, says why, and the next message runs", options, async t => {
  const storage = crashableStorage();
  const f = await fixture(t, { config: { openStorage: path => storage.open(path) } });
  const crashing = await submit(f.session, OWNER, "write", { content: "TEST_HOLD 1000", requestId: "crashing" });
  let crashes = 0;
  while (queue(await f.session.view())[0]?.status !== "interrupted") {
    assert.ok(crashes < 10, "the runner must end the message");
    // The host goes down while the model answers the message.
    await running(f.session, () => true, "the message's model request");
    await storage.crash(f.session);
    crashes++;
  }
  assert.equal(crashes, 5, "Pi parks a task cut off five times in a row (settings.restartLimit) when it next opens");
  let view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["interrupted"]);
  assert.equal(view.activity, "failed");
  assert.deepEqual(view.entries.at(-1), { id: `${crashing.conversationId}:crashed:${crashing.submissionId}`, kind: "workspace.run-crashed", role: "system",
    text: "Stopped: the host crashed repeatedly while working on this message. Send it again to retry.", conversationId: crashing.conversationId });
  const next = await submit(f.session, WRITER, "write", { content: "TEST_WRITE after-crashes.txt\nran", requestId: "after-crashes" });
  view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["interrupted", "settled"]);
  assert.equal(await file(f.session, "after-crashes.txt"), "ran");
  toolResult(view, next, result => result.written === "after-crashes.txt");
  assert.equal(view.activity, "done");
});

test("sessions compact by the host's Pi compaction settings, per model where it names one", options, async t => {
  const compactions = async (compaction: RunnerConfig["compaction"]) => {
    const f = await fixture(t, { config: { compaction } });
    for (const requestId of ["first", "second"]) {
      await submit(f.session, OWNER, "write", { content: "TEST_HOLD 0", requestId });
      await idle(f.session);
    }
    // The second message's request compacts the first message's entries before it is sent.
    const view = await f.session.view();
    await f.stop();
    return view.entries.filter(entry => entry.kind === "pi.compaction").length;
  };
  // A threshold no context fits under, keeping nothing verbatim, compacts before every request with older entries.
  const always = { reserveTokens: Number.MAX_SAFE_INTEGER, keepRecentTokens: 0 };
  assert.ok(await compactions({ modelOverrides: { "faux/queue-faux": always } }) > 0, "the session's model compacts by its override");
  assert.equal(await compactions({ modelOverrides: { "faux/other-model": always } }), 0, "another model's override does not apply");
  assert.ok(await compactions(always) > 0, "a host-wide threshold applies to every model");
  assert.equal(await compactions({ ...always, enabled: false }), 0, "the host's Pi can turn automatic compaction off");
});

test("parked background work, such as a compaction, is aborted without ending the message that is running", options, async t => {
  const storage = crashableStorage();
  // A model that takes a second to summarize, and to answer "hold"; it answers anything else at once.
  const faux = fauxProvider({ models: [{ id: "queue-faux", name: "Deterministic test provider (not an LLM)" }] });
  const respond: FauxResponseFactory = async request => {
    faux.appendResponses([respond]);
    const summarizing = request.messages.some(message => message.role === "system" && String(message.content).startsWith("You are a context summarization assistant"));
    const prompt = request.messages.findLast(message => message.role === "user");
    const text = typeof prompt?.content === "string" ? prompt.content : prompt?.content.map(part => part.type === "text" ? part.text : "").join("");
    if (summarizing || text === "hold") await delay(1000);
    return fauxAssistantMessage(summarizing ? "Summary." : "Answered.");
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const f = await fixture(t, { config: { openStorage: path => storage.open(path),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    // Every request with older entries starts a compaction in the background, keeping nothing verbatim.
    compaction: { reserveTokens: 1000, keepRecentTokens: 0, backgroundTokens: Number.MAX_SAFE_INTEGER } } });
  for (const requestId of ["first", "second"]) {
    await submit(f.session, OWNER, "write", { content: requestId, requestId });
    await idle(f.session);
  }
  const compacting = (task: TaskInspection) => task.record.background;
  // The host goes down four times while the second message's compaction summarizes, then a fifth while a message runs too.
  for (let crash = 0; crash < 4; crash++) {
    await running(f.session, compacting, "the background compaction");
    await storage.crash(f.session);
  }
  await running(f.session, compacting, "the background compaction");
  const held = await submit(f.session, OWNER, "write", { content: "hold", requestId: "held" });
  await running(f.session, task => !compacting(task), "the held message's model request");
  await storage.crash(f.session);
  const view = await idle(f.session);
  assert.deepEqual(queue(view).map(run => run.status), ["settled", "settled", "settled"], "only the message's own work ends it");
  assert.equal(view.entries.some(entry => entry.kind === "workspace.run-crashed"), false);
  assert.ok(view.entries.some(entry => entry.conversationId === held.conversationId && entry.role === "assistant" && entry.text === "Answered."));
  // The parked compaction was aborted, so no later open finds it.
  for (let count = 0; count < 250 && (await tasks(f.session)).length; count++) await delay(20);
  assert.deepEqual(await tasks(f.session), []);
});
