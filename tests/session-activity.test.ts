import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ApprovalRecord, SessionActivity } from "../packages/shared/src/types.js";
import { ActivityReporter, sessionActivity, type ActivityRun } from "../apps/runner/src/activity.js";
import { sessionStatus } from "../packages/client/src/session-status.js";

const run = (status: ActivityRun["status"], sequence: number, extra: Partial<ActivityRun> = {}): ActivityRun =>
  ({ mode: "write", status, sequence, startEntry: sequence * 10, ...extra });
const approval = (status: ApprovalRecord["status"], kind: "bash" | "permission" = "bash"): Pick<ApprovalRecord, "status" | "operation"> => ({
  status, operation: kind === "bash" ? { kind: "bash", command: "make test" } : { kind: "permission", tool: "bash", target: "make test", needs: ["tool"] },
});

test("a session is idle until its first shared message, then working while any message is queued or running", () => {
  assert.equal(sessionActivity([], []), "idle");
  for (const status of ["queued", "admitting", "running"] as const) assert.equal(sessionActivity([run("settled", 0), run(status, 1)], []), "working", status);
  // Side asks share the queue, so the session works on them too.
  assert.equal(sessionActivity([run("settled", 0), run("running", 1, { mode: "ask" })], []), "working");
  assert.equal(sessionActivity([run("settled", 0)], [approval("executing")]), "working", "an approved operation runs");
});

test("approvals wait for a person, whose decision the tool call holds its message for", () => {
  assert.equal(sessionActivity([run("running", 0)], [approval("pending", "permission")]), "waiting", "the tool call holds its message");
  assert.equal(sessionActivity([run("running", 0)], [approval("pending")]), "waiting", "an operation's call holds its message too");
  assert.equal(sessionActivity([run("settled", 0)], [approval("pending")]), "waiting");
  assert.equal(sessionActivity([run("settled", 0, { failure: { reason: "model_error" } })], [approval("pending")]), "waiting");
  assert.equal(sessionActivity([], [approval("pending")]), "waiting", "an operation requested without a message");
  const decided = [approval("approved", "permission"), approval("denied", "permission"), approval("executed"), approval("failed"), approval("interrupted")];
  assert.equal(sessionActivity([run("settled", 0)], decided), "done");
});

test("the latest shared message decides done or failed; side asks and earlier messages do not", () => {
  assert.equal(sessionActivity([run("settled", 0)], []), "done");
  assert.equal(sessionActivity([run("settled", 0, { failure: { reason: "no_model" } })], []), "failed");
  assert.equal(sessionActivity([run("interrupted", 0)], []), "failed", "stopped before it ran");
  assert.equal(sessionActivity([run("settled", 0, { failure: { reason: "model_error" } }), run("settled", 1)], []), "done");
  assert.equal(sessionActivity([run("settled", 1), run("settled", 0, { failure: { reason: "model_error" } })], []), "done", "by sequence, not order");
  assert.equal(sessionActivity([run("settled", 0), run("interrupted", 1, { mode: "ask" })], []), "done");
  assert.equal(sessionActivity([run("interrupted", 0, { mode: "ask" })], []), "idle", "a side ask is not the session's work");
  assert.equal(sessionActivity([run("settled", 0), run("interrupted", 1, { stopped: {} })], []), "idle", "someone stopped it");
  assert.equal(sessionActivity([run("interrupted", 0, { stopped: { pending: true } })], []), "working", "its host is still stopping it");
  assert.equal(sessionActivity([run("interrupted", 0, { stopped: { pending: true } })], [approval("pending")]), "working", "a card the stop is about to interrupt");
  // Runs from before sequence numbers keep their submission order.
  const legacy = (status: ActivityRun["status"]): ActivityRun => ({ mode: "write", status, startEntry: 0 });
  assert.equal(sessionActivity([legacy("interrupted"), legacy("settled")], []), "done");
  assert.equal(sessionActivity([legacy("settled"), legacy("interrupted")], []), "failed");
});

test("a settled message failed when its own last entry is a failed model request", () => {
  const settled = run("settled", 1);
  assert.equal(sessionActivity([settled], [], { id: 12, failed: true }), "failed");
  assert.equal(sessionActivity([settled], [], { id: 12, failed: false }), "done");
  assert.equal(sessionActivity([settled], [], { id: 10, failed: true }), "done", "an entry of an earlier message");
  assert.equal(sessionActivity([run("running", 1)], [], { id: 12, failed: true }), "working");
});

const timing = { settleMs: 1, firstRetryMs: 5, maxRetryMs: 20 };

async function until(condition: () => boolean, message: string): Promise<void> {
  for (let count = 0; count < 500 && !condition(); count++) await delay(2);
  assert.ok(condition(), message);
}

test("activity reports carry each change once, a burst as one report, and nothing while the session is closed", async () => {
  let current: SessionActivity = "idle";
  const sent: SessionActivity[] = [];
  const reporter = new ActivityReporter(async () => current, async activity => { sent.push(activity); }, timing);
  reporter.changed();
  await delay(10);
  assert.deepEqual(sent, [], "nothing before the session opens");
  reporter.start();
  await until(() => sent.length === 1, "the opening report");
  current = "working"; reporter.changed();
  current = "waiting"; reporter.changed();
  current = "working"; reporter.changed();
  await until(() => sent.length === 2, "one report for the burst");
  reporter.changed();
  await delay(10);
  assert.deepEqual(sent, ["idle", "working"], "an unchanged activity is not sent again");
  reporter.stop();
  current = "done"; reporter.changed();
  await delay(10);
  assert.deepEqual(sent, ["idle", "working"], "nothing while closed");
  reporter.start();
  await until(() => sent.length === 3, "reopening reports what changed meanwhile");
  reporter.stop(); reporter.start();
  await delay(10);
  assert.deepEqual(sent, ["idle", "working", "done"], "reopening without a change sends nothing");
  reporter.stop();
});

test("a failed report is retried with the activity as it is by then, never overlapping another", async () => {
  let current: SessionActivity = "working";
  const attempts: SessionActivity[] = [];
  const pending: PromiseWithResolvers<void>[] = [];
  const reporter = new ActivityReporter(async () => current, activity => {
    attempts.push(activity);
    const attempt = Promise.withResolvers<void>();
    pending.push(attempt);
    return attempt.promise;
  }, timing);
  reporter.start();
  await until(() => attempts.length === 1, "the first report");
  current = "done"; reporter.changed();
  await delay(10);
  assert.deepEqual(attempts, ["working"], "a change waits for the report on its way");
  pending[0]!.reject(new Error("unavailable"));
  await until(() => attempts.length === 2, "the retry");
  assert.deepEqual(attempts, ["working", "done"], "the retry carries the current activity");
  pending[1]!.resolve();
  current = "failed"; reporter.changed();
  await until(() => attempts.length === 3, "the next change");
  reporter.stop();
  pending[2]!.reject(new Error("unavailable"));
  await delay(timing.maxRetryMs * 2);
  assert.deepEqual(attempts, ["working", "done", "failed"], "a closed session retries nothing");
});

test("session lists show the lifecycle while a session starts, fails to start or is archived, then its activity", () => {
  const ready = (activity?: SessionActivity) => ({ status: "ready" as const, ...(activity ? { activity } : {}) });
  assert.deepEqual(sessionStatus(ready("working")), { tone: "running", label: "In progress" });
  assert.deepEqual(sessionStatus(ready("waiting")), { tone: "warning", label: "Needs approval" });
  assert.deepEqual(sessionStatus(ready("failed")), { tone: "danger", label: "Failed" });
  assert.deepEqual(sessionStatus(ready("done")), { tone: "success", label: "Done" });
  assert.deepEqual(sessionStatus(ready("idle")), { tone: "neutral", label: "Idle" });
  assert.deepEqual(sessionStatus(ready()), { tone: "success" }, "connectors that predate activity reports");
  assert.deepEqual(sessionStatus({ status: "provisioning", activity: "done" }), { tone: "running", label: "Starting" });
  assert.deepEqual(sessionStatus({ status: "error", activity: "done" }), { tone: "danger", label: "Not started" });
  assert.deepEqual(sessionStatus({ status: "archived", activity: "working" }), { tone: "neutral", label: "Archived" });
  // The session on screen passes its live view's activity, which comes from its host unchecked.
  assert.deepEqual(sessionStatus(ready("done"), "working"), { tone: "running", label: "In progress" });
  assert.deepEqual(sessionStatus(ready("done"), undefined), { tone: "success", label: "Done" });
  assert.deepEqual(sessionStatus(ready(), "toString" as string as SessionActivity), { tone: "success" });
});
