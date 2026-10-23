import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import { accessUnavailable, chatOptionsBody, chatPreference, parseChatPreference, preferredSelection, type ChatSelection } from "../packages/client/src/chat-options.js";

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

test("the last chatted model and reasoning start the next new chat where the host offers them", () => {
  const levels = ["off", "low", "medium", "high"] as const;
  const remembering = {
    id: "host-a", capabilities: { chatOptions: true },
    models: [
      { provider: "p", modelId: "fast", name: "Fast", thinkingLevels: [...levels], thinkingLevel: "low" },
      { provider: "p", modelId: "deep", name: "Deep", thinkingLevels: [...levels], thinkingLevel: "medium" },
      { provider: "p", modelId: "plain", name: "Plain", thinkingLevels: ["off"], thinkingLevel: "off" },
    ],
  } as unknown as ConnectorInfo;
  const fast = { provider: "p", modelId: "fast" };

  // What ran is remembered: the picked model at the level it actually applied.
  const preference = chatPreference(remembering, { model: { provider: "p", modelId: "deep" }, thinkingLevel: "high", access: "auto" });
  assert.deepEqual(preference, { connectorId: "host-a", provider: "p", modelId: "deep", thinkingLevel: "high" });
  assert.deepEqual(parseChatPreference(JSON.stringify(preference)), preference);
  assert.equal(chatPreference(remembering, { model: { provider: "p", modelId: "gone" }, access: "approval" }), undefined);
  assert.equal(chatPreference({ ...remembering, capabilities: {} } as unknown as ConnectorInfo, { model: fast, access: "approval" }), undefined);

  // A new chat starts on it, with the default access rather than the remembered run's.
  assert.deepEqual(preferredSelection(remembering, preference, fast), { model: { provider: "p", modelId: "deep" }, thinkingLevel: "high", access: "approval" });
  // Where the model isn't offered or usable, the fallback runs at the remembered level when it supports it...
  const elsewhere = { ...preference!, modelId: "gone" };
  assert.deepEqual(preferredSelection(remembering, elsewhere, fast), { model: fast, thinkingLevel: "high", access: "approval" });
  assert.deepEqual(preferredSelection(remembering, preference, fast, model => model.modelId !== "deep"), { model: fast, thinkingLevel: "high", access: "approval" });
  // ...else at the level the host's Pi starts it at.
  assert.deepEqual(preferredSelection(remembering, { ...preference!, thinkingLevel: "max" }, fast, () => false), { model: fast, thinkingLevel: "low", access: "approval" });
  // Nothing remembered: the fallback at its own level.
  assert.deepEqual(preferredSelection(remembering, undefined, fast), { model: fast, thinkingLevel: "low", access: "approval" });
  assert.deepEqual(preferredSelection(undefined, preference, fast), { access: "approval" });

  // Stored junk is ignored, and an unknown level is dropped.
  assert.equal(parseChatPreference(null), undefined);
  assert.equal(parseChatPreference("{"), undefined);
  assert.equal(parseChatPreference(JSON.stringify({ provider: "p" })), undefined);
  assert.deepEqual(parseChatPreference(JSON.stringify({ ...preference, thinkingLevel: "huge" })), { connectorId: "host-a", provider: "p", modelId: "deep" });
});

test("a message sent without picking a model remembers the conversation's current model and reasoning", () => {
  const host = {
    id: "host-a", capabilities: { chatOptions: true },
    models: [{ provider: "p", modelId: "deep", name: "Deep", thinkingLevels: ["off", "low", "high"], thinkingLevel: "low" }],
  } as unknown as ConnectorInfo;
  const current = { provider: "p", modelId: "deep", thinkingLevel: "high" as const };
  assert.deepEqual(chatPreference(host, { access: "approval" }, current), { connectorId: "host-a", provider: "p", modelId: "deep", thinkingLevel: "high" });
  // A level picked on its own applies to the current model.
  assert.deepEqual(chatPreference(host, { thinkingLevel: "off", access: "approval" }, current), { connectorId: "host-a", provider: "p", modelId: "deep", thinkingLevel: "off" });
  // Without either, there is nothing to remember.
  assert.equal(chatPreference(host, { access: "approval" }), undefined);
});
