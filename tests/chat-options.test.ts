import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import { accessUnavailable, chatOptionsBody, type ChatSelection } from "../packages/client/src/chat-options.js";

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
