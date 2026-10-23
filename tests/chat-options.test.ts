import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { SessionView } from "../packages/shared/src/types.js";
import { accessUnavailable, chatOptionsBody, initialSelection, type ChatSelection } from "../packages/client/src/chat-options.js";

const host = { capabilities: { chatOptions: true }, models: [] } as unknown as ConnectorInfo;
const auto: ChatSelection = { access: "auto" };

test("a chosen access goes with every shared message, or the message waits until it can", () => {
  assert.deepEqual(chatOptionsBody(host, auto, "submit"), { access: "auto" });
  assert.equal(accessUnavailable(host, auto, "submit"), undefined);
  // Without the host the options can't be sent, and the message would run as "Ask before acting".
  assert.equal(chatOptionsBody(undefined, auto, "submit"), undefined);
  assert.match(accessUnavailable(undefined, auto, "submit") ?? "", /Auto-approve/);
  assert.match(accessUnavailable(undefined, { access: "read" }, "submit") ?? "", /Read only/);
  // The default access needs no options, and side asks are read-only whatever is picked.
  assert.equal(accessUnavailable(undefined, { access: "approval" }, "submit"), undefined);
  assert.equal(accessUnavailable(undefined, auto, "ask"), undefined);
});

test("the owner's chat box starts on Auto-approve; others start on asking, and a later message's access carries over", () => {
  const view = (access?: SessionView["access"]) => ({ ...(access ? { access } : {}) }) as SessionView;
  assert.equal(initialSelection(view(), true).access, "auto");
  assert.equal(initialSelection(view(), false).access, "approval");
  assert.equal(initialSelection(view("read"), true).access, "read");
  assert.equal(initialSelection(view("auto"), false).access, "approval", "only the owner can auto-approve");
});
