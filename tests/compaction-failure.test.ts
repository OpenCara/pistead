import assert from "node:assert/strict";
import test from "node:test";
import { compactionFailure } from "../apps/runner/src/compaction.js";
import { sharedView } from "../apps/server/src/session-links.js";
import { compactionFailureText } from "../packages/client/src/compaction.js";
import type { SessionView } from "../packages/shared/src/types.js";

test("only Pi's own fixed compaction failures are recognized, never text that embeds a provider's error", () => {
  assert.equal(compactionFailure("Compaction failed: Summarization hit the token limit; the summary is incomplete"), "token_limit");
  assert.equal(compactionFailure("Compaction failed: Summarization attempted to call a tool"), "tool_call");
  assert.equal(compactionFailure("Compaction failed: Summarization produced no text"), "no_text");
  assert.equal(compactionFailure("Compaction was aborted"), "aborted");
  for (const detail of [
    "Compaction failed: Summarization failed: 401 invalid x-api-key sk-provider-detail",
    "Compaction failed: Summarization failed: aborted",
    "Compaction failed: orphaned",
    "Compaction failed: Summarization hit the token limit; the summary is incomplete ",
    "The request failed", undefined, null, 5, { message: "Compaction was aborted" },
  ]) assert.equal(compactionFailure(detail), undefined, JSON.stringify(detail));
});

test("a compaction failure says what happened and that retrying as before won't help", () => {
  const text = compactionFailureText("token_limit");
  assert.match(text, /token limit/);
  assert.match(text, /lower reasoning level/);
  assert.match(text, /new session/);
  assert.match(text, /reserveTokens/);
  assert.doesNotMatch(compactionFailureText("token_limit", { advice: false }), /reasoning level/);
});

test("a share link keeps a known compaction failure and drops anything else in its place", () => {
  const base = { sessionId: "s", owner: { id: "o", displayName: "Owner", gitName: "Owner", gitEmail: "o@example.test", githubLogin: null },
    approvals: [], busy: false, conversations: [{ id: "0", mode: "write" }] };
  const entries = [
    { id: "0:1", kind: "workspace.run-failure", role: "assistant", text: "", conversationId: "0", error: { provider: "anthropic", modelId: "m", compaction: "token_limit" } },
    { id: "0:2", kind: "workspace.run-failure", role: "assistant", text: "", conversationId: "0", error: { provider: "anthropic", compaction: "sk-secret" } },
  ];
  assert.deepEqual(sharedView({ ...base, entries } as unknown as SessionView).entries.map(entry => entry.error), [
    { provider: "anthropic", modelId: "m", compaction: "token_limit" },
    { provider: "anthropic" },
  ]);
});
