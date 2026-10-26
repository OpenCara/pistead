import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../packages/shared/src/connector.js";
import type { SessionView } from "../packages/shared/src/types.js";
import { accessUnavailable, autoApproveWarning, autoMergeAvailable, chatOptionsBody, chatPreference, initialSelection, parseChatPreference, preferredSelection, type ChatSelection } from "../packages/client/src/chat-options.js";

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

  // A new chat starts on it, on Auto-approve (the chat is its owner's) rather than the remembered run's access.
  assert.deepEqual(preferredSelection(remembering, preference, fast), { model: { provider: "p", modelId: "deep" }, thinkingLevel: "high", access: "auto" });
  // Where the model isn't offered or usable, the fallback runs at the remembered level when it supports it...
  const elsewhere = { ...preference!, modelId: "gone" };
  assert.deepEqual(preferredSelection(remembering, elsewhere, fast), { model: fast, thinkingLevel: "high", access: "auto" });
  assert.deepEqual(preferredSelection(remembering, preference, fast, model => model.modelId !== "deep"), { model: fast, thinkingLevel: "high", access: "auto" });
  // ...else at the level the host's Pi starts it at.
  assert.deepEqual(preferredSelection(remembering, { ...preference!, thinkingLevel: "max" }, fast, () => false), { model: fast, thinkingLevel: "low", access: "auto" });
  // Nothing remembered: the fallback at its own level.
  assert.deepEqual(preferredSelection(remembering, undefined, fast), { model: fast, thinkingLevel: "low", access: "auto" });
  assert.deepEqual(preferredSelection(undefined, preference, fast), { access: "auto" });

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

test("the owner's chat box starts on Auto-approve before the first shared message, then keeps that message's access", () => {
  const view = (access?: SessionView["access"], entries: SessionView["entries"] = []) => ({ entries, ...(access ? { access } : {}) }) as SessionView;
  assert.equal(initialSelection(view(), true).access, "auto");
  // An older runner leaves "approval" out of the view; a conversation with messages then keeps asking before acting.
  assert.equal(initialSelection(view(undefined, [{ id: "1", kind: "message", role: "user", text: "Hi" }]), true).access, "approval");
  assert.equal(initialSelection(view(), false).access, "approval");
  assert.equal(initialSelection(view("approval"), true).access, "approval");
  assert.equal(initialSelection(view("read"), true).access, "read");
  assert.equal(initialSelection(view("auto"), false).access, "approval", "only the owner can auto-approve");
});

test("auto-merge goes with a message only on top of Auto-approve, to a host that runs GitHub effects automatically", () => {
  const automatic = { capabilities: { chatOptions: true, automaticGitHub: true }, models: [] } as unknown as ConnectorInfo;
  const merging: ChatSelection = { access: "auto", autoMerge: true };
  assert.deepEqual(chatOptionsBody(automatic, merging, "submit"), { access: "auto", autoMerge: true });
  assert.deepEqual(chatOptionsBody(host, merging, "submit"), { access: "auto" }, "an older connector is never sent it");
  assert.deepEqual(chatOptionsBody(automatic, { access: "approval", autoMerge: true }, "submit"), { access: "approval" });
  assert.deepEqual(chatOptionsBody(automatic, merging, "ask"), {});
  assert.equal(autoMergeAvailable(automatic, auto, true), true);
  assert.equal(autoMergeAvailable(automatic, auto, false), false, "only the owner chooses it");
  assert.equal(autoMergeAvailable(automatic, { access: "approval" }, true), false);
  assert.equal(autoMergeAvailable(host, auto, true), false);
});

test("the Auto-approve warning says what runs without asking on this host", () => {
  const base = { name: "Bob's Pi", capabilities: { chatOptions: true, hostCommands: true, hostGrants: true, automaticGitHub: true } } as unknown as ConnectorInfo;
  assert.match(autoApproveWarning(base, false), /GitHub comments and new issues are posted as you without asking/);
  assert.match(autoApproveWarning(base, false), /unless you also turn on Auto-merge/);
  assert.match(autoApproveWarning({ ...base, capabilities: { ...base.capabilities, automaticGitHub: undefined } }, false), /GitHub comments and merges still need approval/);
  assert.match(autoApproveWarning({ ...base, hostCommandAccess: "auto" }, false), /granted you automatic host commands, so host_bash also runs OUTSIDE the sandbox on Bob's Pi/);
  assert.match(autoApproveWarning({ ...base, hostCommandAccess: "owner" }, false), /On someone else's host it still needs their approval/);
  assert.match(autoApproveWarning(base, false), /or one whose owner granted you automatic host commands/);
});
