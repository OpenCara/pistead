import test from "node:test";
import assert from "node:assert/strict";
import type { EntryView, SessionView } from "../packages/shared/src/types.js";
import {
  applyList, applyViewPatch, diffList, diffView, isPatchableView, isRevision, isViewPatch, newRevision, reuseUnchanged, sameView, ViewRevisions,
} from "../packages/shared/src/view-patch.js";

const owner = { id: "u1", displayName: "Owner", gitName: "Owner", gitEmail: "owner@example.test", githubLogin: null } as unknown as SessionView["owner"];
const entry = (id: string, text = id): EntryView => ({ id, kind: "message", role: "assistant", text, conversationId: id.split(":")[0] });

function view(entries: EntryView[], extra: Partial<SessionView> = {}): SessionView {
  return { sessionId: "s1", owner, entries, approvals: [], conversations: [{ id: "0", mode: "write" }], busy: false, ...extra };
}

const byId = (item: { id: string }) => item.id;

test("list patches rebuild the next list from the base for appends, edits, removals and moves", () => {
  const base = ["a", "b", "c", "d", "e"].map(id => entry(id));
  const cases: EntryView[][] = [
    [...base, entry("f")],
    [base[0]!, entry("b", "edited"), ...base.slice(2)],
    [base[0]!, base[2]!, base[4]!],
    [base[3]!, base[0]!, base[1]!, base[2]!, base[4]!],
    [],
    [entry("x"), ...base],
    base.slice(0, 2),
  ];
  for (const next of cases) {
    const patch = diffList(base, next, byId);
    assert.deepEqual(applyList(base, patch), next);
  }
  // Unchanged items travel as counts only, and keep their identity.
  const appended = [...base, entry("f")];
  const patch = diffList(base, appended, byId);
  assert.deepEqual(patch, [5, appended[5]]);
  const rebuilt = applyList(base, patch);
  assert.ok(rebuilt.slice(0, 5).every((item, index) => item === base[index]));
  // An item with the same id but other content travels in full.
  assert.deepEqual(diffList(base, [base[0]!, entry("b", "edited")], byId), [1, entry("b", "edited")]);
});

test("a view patch carries the changed entries and the small fields, never the unchanged entries", () => {
  const entries = Array.from({ length: 200 }, (_, index) => entry(`0:${index}`, "x".repeat(500)));
  const before = view(entries);
  const after = view([...entries, entry("0:200", "new")], { busy: true, queue: [{ submissionId: "q1", actorId: "u1", mode: "write", status: "running" }] });
  const patch = diffView(before, after, "a".repeat(32), "b".repeat(32));
  assert.ok(JSON.stringify(patch).length < 1000, "The patch is tiny next to the 100 kB view");
  assert.deepEqual(applyViewPatch(before, patch), after);
  assert.ok(isViewPatch(JSON.parse(JSON.stringify(patch))));
  // queue is optional: absent from the next view, it stays absent.
  const withoutQueue = applyViewPatch(after, diffView(after, before, "b".repeat(32), "c".repeat(32)));
  assert.deepEqual(withoutQueue, before);
  assert.equal(Object.hasOwn(withoutQueue, "queue"), false);
  // No change sends nothing but the revision, and leaves the very same view.
  const unchanged = diffView(before, before, "a".repeat(32), "a".repeat(32));
  assert.deepEqual(unchanged, { base: "a".repeat(32), revision: "a".repeat(32) });
  assert.equal(applyViewPatch(before, unchanged), before);
});

test("malformed patches are refused instead of producing a partial view", () => {
  const base = view([entry("a"), entry("b")]);
  const valid = { base: "a".repeat(32), revision: "b".repeat(32), view: { sessionId: "s1", owner, busy: false }, lists: { entries: [2], approvals: [], conversations: [] } };
  assert.deepEqual(applyViewPatch(base, valid as never).entries, base.entries);
  const invalid: unknown[] = [
    { ...valid, lists: { ...valid.lists, entries: [3] } },
    { ...valid, lists: { ...valid.lists, entries: [-3] } },
    { ...valid, lists: { ...valid.lists, entries: [0] } },
    { ...valid, lists: { ...valid.lists, entries: [1.5] } },
    { ...valid, lists: { ...valid.lists, entries: ["text"] } },
    { ...valid, lists: { ...valid.lists, entries: [null] } },
    { ...valid, lists: { ...valid.lists, entries: [[entry("c")]] } },
    { ...valid, lists: { ...valid.lists, entries: undefined } },
    { ...valid, lists: { ...valid.lists, other: [] } },
    { ...valid, view: { ...valid.view, entries: [] } },
    { ...valid, base: "not a revision" },
    { ...valid, revision: "B".repeat(32) },
    { base: "a".repeat(32), revision: "a".repeat(32), view: valid.view },
    { ...valid, view: undefined },
    null, [], "patch",
  ];
  for (const patch of invalid) assert.throws(() => applyViewPatch(base, patch as never), JSON.stringify(patch));
});

test("revisions name only views someone kept, and an unchanged view keeps its revision and objects", () => {
  assert.ok(isRevision(newRevision()));
  assert.notEqual(newRevision(), newRevision());
  const revisions = new ViewRevisions(2);
  const first = revisions.record(view([entry("a")]));
  const again = revisions.record(view([entry("a")]));
  assert.equal(again.revision, first.revision);
  assert.equal(again.view, first.view);
  const second = revisions.record(view([entry("a"), entry("b")]));
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(revisions.since(first.revision, second)?.lists?.entries, [1, entry("b")]);
  assert.deepEqual(revisions.since(second.revision, second), { base: second.revision, revision: second.revision });
  assert.equal(revisions.since(undefined, second), null);
  assert.equal(revisions.since("f".repeat(32), second), null);
  // Only the latest `keep` revisions answer.
  const third = revisions.record(view([entry("c")]));
  assert.equal(revisions.since(first.revision, third), null);
  assert.ok(revisions.since(second.revision, third));
});

test("a whole view adopts the base's unchanged items, so only changed ones are new objects", () => {
  const base = view([entry("a"), entry("b")]);
  const next = view([entry("a"), entry("b", "edited"), entry("c")]);
  const adopted = reuseUnchanged(base, next);
  assert.deepEqual(adopted, next);
  assert.equal(adopted.entries[0], base.entries[0]);
  assert.notEqual(adopted.entries[1], base.entries[1]);
  assert.ok(sameView(adopted, next));
  assert.ok(!sameView(base, next));
});

test("only views whose lists are arrays of objects are patched", () => {
  assert.ok(isPatchableView(view([entry("a")])));
  assert.ok(isPatchableView({ ...view([]), queue: [] }));
  for (const value of [null, [], "view", { ...view([]), entries: undefined }, { ...view([]), conversations: {} },
    { ...view([]), entries: [null] }, { ...view([]), approvals: ["x"] }, { ...view([]), queue: [[]] }]) {
    assert.equal(isPatchableView(value), false, JSON.stringify(value));
  }
});
