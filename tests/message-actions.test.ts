import test from "node:test";
import assert from "node:assert/strict";
import { copyText, messageCut, resendText, rewindable } from "../packages/client/src/message-actions.js";
import type { EntryView } from "../packages/shared/src/types.js";

function entry(role: string, text: string, id = "3:12"): EntryView {
  return { id, kind: `pi.${role}`, role, text, conversationId: "3" };
}

test("a conversation goes back, or forks, just before a user message or just after a final reply, never inside a turn", () => {
  assert.deepEqual(messageCut(entry("user", "Fix the build")), { entryId: "3:12", before: true });
  assert.deepEqual(messageCut(entry("assistant", "Done: the build passes.")), { entryId: "3:12", before: false });
  // A reply that calls tools goes on with their results.
  assert.equal(messageCut(entry("assistant", 'Let me look.\nread_file({"path":"a.ts"})')), undefined);
  assert.equal(messageCut(entry("assistant", 'bash({"command":"ls"})')), undefined);
  // A code block that looks like a call is prose.
  assert.deepEqual(messageCut(entry("assistant", '```\nbash({"command":"ls"})\n```')), { entryId: "3:12", before: false });
  for (const role of ["toolResult", "system"]) assert.equal(messageCut(entry(role, "output")), undefined);
  // The view's own markers aren't the host's entries.
  assert.equal(messageCut(entry("system", "Stopped", "3:stopped:key")), undefined);
  assert.equal(messageCut(entry("assistant", "", "3:failure:key")), undefined);
  assert.equal(rewindable({ rewindable: true }), true);
  assert.equal(rewindable({}), false, "older hosts don't offer it");
});

test("copying a message takes what it says, and sending one again leaves its images' lines out", () => {
  assert.equal(copyText(entry("assistant", 'Checked it.\nbash({"command":"npm test"})')), "Checked it.");
  assert.equal(copyText(entry("user", "  keep my spacing  ")), "  keep my spacing  ");
  assert.equal(copyText(entry("assistant", 'read_file({"path":"a"})')), "");
  assert.equal(resendText(entry("user", "What is in this screenshot?\n[image image/png]\n[image image/jpeg]")), "What is in this screenshot?");
  assert.equal(resendText(entry("user", "[image] is not an image line")), "[image] is not an image line");
});
