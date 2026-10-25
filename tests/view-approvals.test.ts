import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalRecord } from "../packages/shared/src/types.js";
import { autoApprovedCalls, viewApprovals, type StoredApproval } from "../apps/runner/src/approval-view.js";

const card = (id: string, status: ApprovalRecord["status"], extra: Partial<StoredApproval> = {}): StoredApproval => ({
  id, sessionId: "s1", requestedBy: "test:alice", operation: { kind: "bash", command: `echo ${id}` }, status, createdAt: "2026-01-01T00:00:00.000Z", ...extra,
});
const auto = (id: string, status: ApprovalRecord["status"], extra: Partial<StoredApproval> = {}) =>
  card(id, status, { automatic: true, decidedBy: "test:alice", callId: `call-${id}`, ...extra });
const permission = (call: string, status: ApprovalRecord["status"], extra: Partial<StoredApproval> = {}) =>
  card(`permission-${call}`, status, { operation: { kind: "permission", tool: "bash", target: `echo ${call}`, needs: ["unbounded-shell"] }, ...extra });

test("commands auto-approve ran are left to the transcript, which marks their calls (#54)", () => {
  const stored = [
    auto("tool-1", "executed", { result: "x".repeat(8000) }),
    auto("tool-2", "executing", { unbounded: true }),
    auto("tool-3", "interrupted", { operation: { kind: "host.bash", command: "make", timeoutSeconds: 10 } }),
    // Automatic commits, pushes and repins stay listed: their results are what people look for.
    auto("tool-4", "executed", { operation: { kind: "git.repin", repository: "acme/alpha", ref: "main" }, result: "{\"sessionId\":\"s2\"}" }),
    card("tool-5", "pending", { callId: "call-tool-5" }),
  ];
  const { approvals, olderApprovals } = viewApprovals(stored);
  assert.deepEqual(approvals.map(approval => approval.id), ["tool-4", "tool-5"]);
  assert.equal(olderApprovals, 0);
  assert.ok(approvals.every(approval => !("callId" in approval)), "the host's link to the call stays on the host");
  assert.equal(approvals[0]!.result, "{\"sessionId\":\"s2\"}", "the repinned session stays reachable");
  assert.deepEqual([...autoApprovedCalls(stored)], [
    ["call-tool-1", { status: "executed" }],
    ["call-tool-2", { status: "executing", unbounded: true }],
    ["call-tool-3", { status: "interrupted" }],
  ]);
});

test("an allowed permission request is folded into its operation's card", () => {
  const stored = [
    permission("1", "approved", { decidedBy: "test:alice", scope: "session" }),
    card("tool-1", "pending"),
    permission("2", "approved", { decidedBy: "test:bob" }),
    card("tool-2", "executed", { decidedBy: "test:alice" }),
    // Refused, or allowed with no operation card yet (or ever, for tools without one): the permission is the card.
    permission("3", "denied", { decidedBy: "test:alice" }),
    permission("4", "approved", { decidedBy: "test:alice", scope: "call" }),
    permission("5", "pending"),
  ];
  const { approvals } = viewApprovals(stored);
  assert.deepEqual(approvals.map(approval => approval.id), ["tool-1", "tool-2", "permission-3", "permission-4", "permission-5"]);
  assert.deepEqual(approvals[0]!.permission, { decidedBy: "test:alice", scope: "session" });
  assert.deepEqual(approvals[1]!.permission, { decidedBy: "test:bob" });
  assert.equal(approvals[2]!.permission, undefined);
});

test("a view lists every approval in play and only the newest settled ones, with shortened results", () => {
  const output = `start-marker${"x".repeat(7000)}end-marker`;
  const stored = [
    card("old-pending", "pending"),
    ...Array.from({ length: 120 }, (_, index) => card(`tool-${index}`, index % 7 ? "executed" : "denied", { decidedBy: "test:alice", result: output })),
    card("running", "approved"),
    card("working", "executing"),
    card("short", "interrupted", { result: "short" }),
  ];
  const { approvals, olderApprovals } = viewApprovals(stored);
  assert.equal(approvals.length, 3 + 50);
  assert.equal(olderApprovals, 120 + 1 - 50);
  // In metadata order, the oldest pending card first however old it is.
  assert.deepEqual(approvals.slice(0, 2).map(approval => approval.id), ["old-pending", "tool-71"]);
  assert.deepEqual(approvals.slice(-3).map(approval => approval.id), ["running", "working", "short"]);
  assert.equal(approvals.at(-1)!.result, "short");
  for (const approval of approvals.filter(approval => approval.result?.startsWith("start-marker"))) {
    assert.ok(approval.result!.length <= 1000, approval.id);
    assert.match(approval.result!, /characters omitted …\n/);
    assert.match(approval.result!, /end-marker$/);
  }
  assert.ok(JSON.stringify(approvals).length < 64_000);
  assert.equal(stored[1]!.result, output, "the host keeps every result whole");
});
