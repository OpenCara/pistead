import assert from "node:assert/strict";
import test from "node:test";
import { sharedView } from "../apps/server/src/session-links.js";
import { carryEarlier, withEarlier } from "../packages/client/src/transcript-pages.js";
import { splitToolCalls } from "../packages/client/src/transcript.js";
import { briefChars, briefEntry, entriesBefore, latestEntries } from "../packages/shared/src/transcript-display.js";
import type { EntryView, SessionView } from "../packages/shared/src/types.js";

const entry = (id: string, conversationId = "0", extra: Partial<EntryView> = {}): EntryView =>
  ({ id, kind: "message", role: "assistant", text: `text of ${id}`, conversationId, ...extra });
const view = (entries: EntryView[], conversations: SessionView["conversations"] = [{ id: "0", mode: "write" }]): SessionView =>
  ({ sessionId: "s1", owner: { id: "u1" }, entries, approvals: [], conversations, busy: false } as unknown as SessionView);
const ids = (value: { entries: EntryView[] }) => value.entries.map(item => item.id);
const range = (from: number, to: number, conversationId = "0") =>
  Array.from({ length: to - from + 1 }, (_, index) => entry(`${conversationId}:${from + index}`, conversationId));

test("brief tool output keeps a tool result's first line and says how long the whole one is", () => {
  const result = entry("0:1", "0", { role: "toolResult", text: "\n  first line  \nsecond\nthird" });
  assert.deepEqual(briefEntry(result), { ...result, text: "  first line", trimmed: { lines: 4, chars: result.text.length } });
  // A result that is one short line already is the same entry, so feeds and patches see nothing new.
  const short = entry("0:2", "0", { role: "toolResult", text: "ok" });
  assert.equal(briefEntry(short), short);
  const empty = entry("0:3", "0", { role: "toolResult", text: "" });
  assert.equal(briefEntry(empty), empty);
  // A long line is cut at whole code points, with an ellipsis.
  const long = briefEntry(entry("0:4", "0", { role: "toolResult", text: "😀".repeat(briefChars + 5) }));
  assert.equal(long.text, `${"😀".repeat(briefChars)}…`);
  assert.deepEqual(long.trimmed, { lines: 1, chars: (briefChars + 5) * 2 });
  // Prose, user messages and system entries are never shortened.
  for (const role of ["user", "system"]) {
    const other = entry("0:5", "0", { role, text: "a\n".repeat(500) });
    assert.equal(briefEntry(other), other);
  }
});

test("brief tool output cuts long tool calls but keeps them tool calls, and leaves prose and code alone", () => {
  const call = `write(${JSON.stringify({ path: "src/a.ts", content: "x".repeat(5000) })})`;
  const fenced = "```\n" + call + "\n```";
  const text = `I'll write it.\n${call}\nbash({"command":"ls"})\n${fenced}`;
  const shown = briefEntry(entry("0:1", "0", { text }));
  const { prose, calls } = splitToolCalls(shown.text);
  assert.deepEqual(calls.map(item => item.name), ["write", "bash"]);
  assert.ok(calls[0]!.line.startsWith('write({"path":"src/a.ts","content":"xxx'), calls[0]!.line);
  assert.ok(calls[0]!.line.endsWith("…})") && calls[0]!.line.length < briefChars + 20, calls[0]!.line);
  assert.equal(calls[1]!.line, 'bash({"command":"ls"})');
  // A call line inside a code block is prose, and prose keeps every word.
  assert.equal(prose, `I'll write it.\n${fenced}`);
  assert.deepEqual(shown.trimmed, { lines: text.split("\n").length, chars: text.length });
  const plain = entry("0:2", "0", { text: `Short answer\nbash({"command":"ls"})` });
  assert.equal(briefEntry(plain), plain);
});

test("a paged view holds each conversation's latest entries and says what comes before", () => {
  const whole = view([...range(1, 7), ...range(1, 3, "1"), entry("unlisted:1", "9")],
    [{ id: "0", mode: "write" }, { id: "1", mode: "ask", actorId: "u1" }]);
  const paged = latestEntries(whole, 3);
  assert.deepEqual(ids(paged), ["0:5", "0:6", "0:7", "1:1", "1:2", "1:3", "unlisted:1"]);
  assert.deepEqual(paged.conversations, [{ id: "0", mode: "write", olderEntries: 4, previousEntryId: "0:4" }, { id: "1", mode: "ask", actorId: "u1" }]);
  assert.equal(latestEntries(whole, 10), whole, "A view that fits is the view itself");

  assert.deepEqual(entriesBefore(whole, "0", "0:5", 2), { entries: [entry("0:3"), entry("0:4")], older: 2 });
  assert.deepEqual(entriesBefore(whole, "0", "0:3", 50), { entries: [entry("0:1"), entry("0:2")], older: 0 });
  assert.deepEqual(entriesBefore(whole, "0", "0:1", 50), { entries: [], older: 0 });
  assert.equal(entriesBefore(whole, "0", "0:99", 50), null, "An entry the view no longer has");
  assert.equal(entriesBefore(whole, "9", "unlisted:1", 50), null, "Only conversations the view lists");
  assert.equal(entriesBefore(whole, "1", "0:5", 50), null, "Only that conversation's own entries");
});

test("a client keeps the earlier entries it read, and those that slide out of the window, as long as they join up", () => {
  const conversations = (older: number, previous: string) => [{ id: "0", mode: "write" as const, olderEntries: older, previousEntryId: previous }];
  const first = view(range(5, 7), conversations(4, "0:4"));
  let earlier = carryEarlier(new Map(), null, first);
  assert.equal(earlier.size, 0);
  assert.equal(withEarlier(first, earlier), first, "Nothing loaded shows the view itself");

  earlier = new Map([["0", range(3, 4)]]);
  const shown = withEarlier(first, earlier);
  assert.deepEqual(ids(shown), ["0:3", "0:4", "0:5", "0:6", "0:7"]);
  assert.deepEqual(shown.conversations, [{ id: "0", mode: "write", olderEntries: 2 }]);
  assert.deepEqual(withEarlier(first, new Map([["0", range(1, 4)]])).conversations, [{ id: "0", mode: "write" }], "Nothing left to read");

  // New entries push 0:5 out of the window: it stays, after the earlier ones.
  const slid = view(range(6, 8), conversations(5, "0:5"));
  earlier = carryEarlier(earlier, first, slid);
  assert.deepEqual(ids(withEarlier(slid, earlier)), ["0:3", "0:4", "0:5", "0:6", "0:7", "0:8"]);
  // Even with nothing read yet, what a reader saw doesn't vanish from the top.
  assert.deepEqual(ids(withEarlier(slid, carryEarlier(new Map(), first, slid))), ["0:5", "0:6", "0:7", "0:8"]);

  // After a compaction the history no longer joins up: the conversation starts again from its window.
  const compacted = view([entry("0:20"), ...range(7, 8)], conversations(3, "0:6"));
  assert.equal(carryEarlier(earlier, slid, compacted).size, 0);
  // So does a conversation the view no longer pages.
  assert.equal(carryEarlier(earlier, slid, view(range(1, 8))).size, 0);
});

test("share links show brief tool output when the session does", () => {
  const whole = view([entry("0:1", "0", { role: "toolResult", text: "one\ntwo" })]);
  assert.deepEqual(sharedView(whole).entries.map(item => item.text), ["one\ntwo"]);
  assert.deepEqual(sharedView(whole, "brief").entries, [{ id: "0:1", kind: "message", role: "toolResult", text: "one", trimmed: { lines: 2, chars: 7 } }]);
});
