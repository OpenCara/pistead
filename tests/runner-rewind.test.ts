import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { AuthorizationRequest, EntryView, RunnerAction, RunnerBinding, RunnerTicket, SessionView, SubmitInput } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";

// Going back to an earlier message of the shared conversation (revert), and starting a new session from one (fork), on
// a real Harness and SQLite. The model answers with the user messages it was given, so each test sees the model's context.
const ALICE = "test:alice";
const BOB = "test:bob";

function binding(id: string, ownerId = ALICE): RunnerBinding {
  const createdAt = "2026-01-01T00:00:00Z";
  return {
    session: { id, workspaceId: "workspace", ownerId, agentVersionId: "version-1", title: "Rewind", policyVersion: 1, status: "ready", createdAt, repositories: [], repositoryMode: "clone" },
    owner: { id: ownerId, githubId: null, githubLogin: ownerId.slice(5), displayName: ownerId.slice(5), gitName: "Owner", gitEmail: "owner@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: ownerId, workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["identity"], modelId: "model-1", createdAt },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(session: RunnerSession, action: RunnerAction, actorId = session.binding.owner.id): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: session.binding.session.id, actorId, ownerId: session.binding.owner.id, action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

function text(content: unknown): string {
  return typeof content === "string" ? content : (content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("");
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-rewind-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // "TOOL" makes a tool call and then answers; "HOLD" waits for `release`; anything else is answered with every user
  // message the model was given.
  let release = Promise.withResolvers<void>();
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] });
  const respond: FauxResponseFactory = async context => {
    faux.appendResponses([respond]);
    const latest = context.messages.at(-1);
    if (latest?.role === "toolResult") return fauxAssistantMessage("Tool done.");
    const prompt = text(latest?.role === "user" ? latest.content : "");
    if (prompt === "TOOL") return fauxAssistantMessage([fauxToolCall("identity", {})], { stopReason: "toolUse" });
    if (prompt === "HOLD") await release.promise;
    if (prompt === "FAIL") throw new Error("400 Bad Request");
    return fauxAssistantMessage(`saw ${context.messages.filter(message => message.role === "user").map(message => text(message.content)).join("|")}`);
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const backups = new Map<string, Uint8Array>();
  const config = {
    readBackup: async (descriptor: { backupId: string }) => backups.get(descriptor.backupId)!,
    dataDir: directory, sharedSecret: "runner-rewind-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async (model: RunnerBinding["model"]) => ({ models, provider: model.provider, modelId: model.modelId }),
  };
  let service = new RunnerService(config);
  await service.initialize();
  t.after(() => service.close());
  return {
    get service() { return service; },
    backups,
    hold() { release = Promise.withResolvers<void>(); return () => release.resolve(); },
    async provision(id: string, ownerId = ALICE) {
      const input = binding(id, ownerId);
      const now = Math.floor(Date.now() / 1000);
      return service.provision(input, { aud: "runner", sessionId: id, actorId: ownerId, ownerId, action: "create", policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") });
    },
    async reopen(id: string) {
      await service.close();
      service = new RunnerService(config);
      await service.initialize();
      return service.get(id);
    },
  };
}

async function idle(session: RunnerSession): Promise<SessionView> {
  for (let count = 0; count < 1000; count++) {
    const view = await session.view();
    if (!view.busy) return view;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

async function send(session: RunnerSession, content: string, options?: SubmitInput["options"]): Promise<SessionView> {
  await session.submit(await ticket(session, "submit"), { content, requestId: randomUUID(), ...(options ? { options } : {}) }, "write");
  return idle(session);
}

/** What the session reports it is doing (as its activity reporter reads it). */
function activity(session: RunnerSession): Promise<string> {
  return (session as unknown as { activity(): Promise<string> }).activity();
}

/** The shared conversation as people read it, without the empty bookkeeping entries the apps leave out. */
function shared(view: SessionView): EntryView[] {
  const write = new Set(view.conversations.filter(conversation => conversation.mode === "write").map(conversation => conversation.id));
  return view.entries.filter(entry => entry.conversationId !== undefined && write.has(entry.conversationId) && !(entry.role === "system" && !entry.text.trim()));
}

function lines(view: SessionView): string[] {
  return shared(view).map(entry => `${entry.role}: ${entry.text}`);
}

function find(view: SessionView, role: string, text: string): EntryView {
  const entry = shared(view).find(candidate => candidate.role === role && candidate.text === text);
  assert.ok(entry, `no ${role} entry "${text}" in ${JSON.stringify(lines(view))}`);
  return entry;
}

function refused(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof RunnerError, String(error));
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  };
}

test("going back to a message keeps the shared conversation up to it, for the model and the view, and survives a reopen", async t => {
  const runner = await fixture(t);
  const session = await runner.provision("rewind-session");
  await send(session, "one");
  await send(session, "two");
  let view = await send(session, "three");
  assert.deepEqual(lines(view), ["user: one", "assistant: saw one", "user: two", "assistant: saw one|two", "user: three", "assistant: saw one|two|three"]);
  assert.equal(view.rewindable, true);
  const original = view.conversations.find(conversation => conversation.mode === "write")!.id;

  // Before a user message: it and everything after it leave the conversation, which the next message continues.
  const { conversationId } = await session.revert(await ticket(session, "revert"), { entryId: find(view, "user", "two").id });
  assert.notEqual(conversationId, original);
  view = await session.view();
  assert.deepEqual(view.conversations.map(conversation => [conversation.id, conversation.mode]), [[conversationId, "write"]], "the old conversation leaves the view");
  assert.deepEqual(lines(view), ["user: one", "assistant: saw one"]);
  assert.equal(find(view, "user", "one").actorId, ALICE, "kept messages keep who sent them");
  view = await send(session, "four");
  assert.deepEqual(lines(view), ["user: one", "assistant: saw one", "user: four", "assistant: saw one|four"]);
  // A side ask starts from the conversation as it is now.
  const ask = await session.submit(await ticket(session, "ask"), { content: "aside", requestId: randomUUID() }, "ask");
  view = await idle(session);
  assert.equal(view.entries.filter(entry => entry.conversationId === ask.conversationId).at(-1)!.text, "saw one|four|aside");
  assert.deepEqual(lines(view).at(-1), "assistant: saw one|four", "the side ask stays out of the shared conversation");

  // After a final reply; going back to the latest one changes nothing.
  assert.deepEqual(await session.revert(await ticket(session, "revert"), { entryId: find(view, "assistant", "saw one|four").id }), { conversationId });
  await session.revert(await ticket(session, "revert"), { entryId: find(view, "assistant", "saw one").id });
  view = await send(session, "five");
  assert.deepEqual(lines(view), ["user: one", "assistant: saw one", "user: five", "assistant: saw one|five"]);

  // Before the first message: the conversation starts again, with the session's tools.
  await session.revert(await ticket(session, "revert"), { entryId: find(view, "user", "one").id });
  assert.deepEqual(lines(await session.view()), []);
  view = await send(session, "six");
  assert.deepEqual(lines(view), ["user: six", "assistant: saw six"]);
  view = await send(session, "TOOL");
  assert.ok(shared(view).some(entry => entry.role === "toolResult"), "the restarted conversation still has its tools");

  // A reopened session continues where it went back to.
  const reopened = await runner.reopen("rewind-session");
  view = await reopened.view();
  assert.deepEqual(lines(view).slice(0, 2), ["user: six", "assistant: saw six"]);
  view = await send(reopened, "seven");
  assert.equal(shared(view).at(-1)!.text, "saw six|TOOL|seven");
});

test("going back is refused inside a turn, for a message no longer shown, and while work runs", async t => {
  const runner = await fixture(t);
  const session = await runner.provision("rewind-refusals");
  await send(session, "one");
  let view = await send(session, "TOOL");
  const call = shared(view).find(entry => entry.role === "assistant" && entry.text.startsWith("identity("));
  const result = shared(view).find(entry => entry.role === "toolResult");
  assert.ok(call && result, JSON.stringify(lines(view)));
  for (const entry of [call, result]) {
    await assert.rejects(session.revert(await ticket(session, "revert"), { entryId: entry.id }), refused(409, /final reply/));
  }
  await assert.rejects(session.revert(await ticket(session, "revert"), { entryId: "nonsense" }), refused(400, /Invalid message/));
  await assert.rejects(session.revert(await ticket(session, "revert"), { entryId: find(view, "user", "one").id, extra: true }), refused(400, /Invalid message/));
  const old = find(view, "user", "TOOL").id;
  await session.revert(await ticket(session, "revert"), { entryId: old });
  await assert.rejects(session.revert(await ticket(session, "revert"), { entryId: old }), refused(409, /no longer in the shared conversation/));

  view = await session.view();
  const release = runner.hold();
  await session.submit(await ticket(session, "submit"), { content: "HOLD", requestId: randomUUID() }, "write");
  await assert.rejects(session.revert(await ticket(session, "revert"), { entryId: find(view, "user", "one").id }), refused(409, /Stop the session's work/));
  release();
  await idle(session);
});

test("a fork starts a new session with the shared conversation up to a message, on the same host, for its owner only", async t => {
  const runner = await fixture(t);
  const source = await runner.provision("fork-source");
  await send(source, "one");
  await send(source, "TOOL");
  const view = await send(source, "three");
  const target = await runner.provision("fork-target");

  // Up to the reply to TOOL: its tool call and result come along, so the model's context is whole.
  const entryId = find(view, "assistant", "Tool done.").id;
  const input = { sourceSessionId: "fork-source", entryId };
  const result = await runner.service.fork(target, await ticket(target, "fork"), input);
  assert.ok(result.entries >= 4, JSON.stringify(result));
  let forked = await target.view();
  assert.deepEqual(lines(forked).filter(line => !line.startsWith("assistant: identity(")), ["user: one", "assistant: saw one", "user: TOOL", "toolResult: " + shared(view).find(entry => entry.role === "toolResult")!.text, "assistant: Tool done."]);
  assert.ok(shared(forked).every(entry => entry.kind === "workspace.forked"));
  assert.ok(!forked.entries.some(entry => entry.role === "system"), "the source's system prompt stays behind: the fork renders its own");
  // The same fork again is answered as before; another one is refused.
  assert.deepEqual(await runner.service.fork(target, await ticket(target, "fork"), input), result);
  await assert.rejects(runner.service.fork(target, await ticket(target, "fork"), { sourceSessionId: "fork-source", entryId: find(view, "assistant", "saw one").id }), refused(409, /already forked/));
  forked = await send(target, "four");
  assert.equal(shared(forked).at(-1)!.text, "saw one|TOOL|four");
  assert.deepEqual(lines(await source.view()).at(-1), "assistant: saw one|TOOL|three", "the source session is unchanged");

  // Before the first message, a fork starts empty; only a new session takes one.
  const empty = await runner.provision("fork-empty");
  assert.deepEqual(await runner.service.fork(empty, await ticket(empty, "fork"), { sourceSessionId: "fork-source", entryId: find(view, "user", "one").id }), { conversationId: (await empty.view()).conversations[0]!.id, entries: 0 });
  await assert.rejects(runner.service.fork(source, await ticket(source, "fork"), { sourceSessionId: "fork-target", entryId: shared(forked)[0]!.id }), refused(409, /Only a new session/));
  await assert.rejects(runner.service.fork(target, await ticket(target, "fork"), { sourceSessionId: "fork-target", entryId }), refused(400, /into itself/));
  await assert.rejects(runner.service.fork(target, await ticket(target, "fork"), { sourceSessionId: "fork-source" }), refused(400, /Invalid fork request/));

  // Someone else's session isn't theirs to fork, and a fork lands only in the forking owner's own session.
  const bobs = await runner.provision("fork-bob", BOB);
  await assert.rejects(runner.service.fork(bobs, await ticket(bobs, "fork"), input), refused(403, /owner/));
  const other = await runner.provision("fork-other");
  await assert.rejects(runner.service.fork(other, await ticket(other, "fork", BOB), input), refused(403, /owner/));
});

test("a backup of a session that went back keeps the conversation it went back from, and a restore takes exactly one as current", async t => {
  const runner = await fixture(t);
  const source = await runner.provision("restore-source");
  await send(source, "one");
  const view = await send(source, "two");
  await source.revert(await ticket(source, "revert"), { entryId: find(view, "user", "two").id });
  const backup = await source.backup(await ticket(source, "backup"), { conversationOnly: true });
  assert.deepEqual(backup.manifest.branches.map(branch => [branch.mode, branch.superseded ?? false]), [["write", true], ["write", false]]);
  // Restored history names exactly one current shared conversation, and nothing else as superseded.
  const restore = async (branches: unknown[], id: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...backup, manifest: { ...backup.manifest, branches } }));
    runner.backups.set(id, bytes);
    const now = Math.floor(Date.now() / 1000);
    return runner.service.restore({ binding: binding(`target-${id}`), restore: { id: `restore-${id}`, sourceSessionId: "restore-source", backupId: id,
      sha256: createHash("sha256").update(bytes).digest("base64url"), size: bytes.byteLength, downloadToken: "token" } },
    { aud: "runner", sessionId: `target-${id}`, actorId: ALICE, ownerId: ALICE, action: "restore", policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: "" });
  };
  const [old, current] = backup.manifest.branches;
  for (const [index, branches] of [[old, { ...current, superseded: true }], [{ ...old, superseded: undefined }, current], [{ ...old, superseded: "yes" }, current]].entries()) {
    await assert.rejects(restore(branches, `tampered-${index}`), refused(400, /Invalid backup branches/));
  }
});

test("going back to before a failed message, or before the first, leaves its status behind", async t => {
  const runner = await fixture(t);
  const session = await runner.provision("rewind-activity");
  await send(session, "one");
  assert.equal(await activity(session), "done");
  let view = await send(session, "FAIL");
  assert.equal(await activity(session), "failed");
  assert.equal(view.activity, "failed");
  await session.revert(await ticket(session, "revert"), { entryId: find(view, "user", "FAIL").id });
  assert.equal(await activity(session), "done", "the message that is left finished");
  assert.equal((await session.view()).activity, "done");
  view = await session.view();
  await session.revert(await ticket(session, "revert"), { entryId: find(view, "user", "one").id });
  assert.equal(await activity(session), "idle", "nothing was sent in what is left");
  await send(session, "two");
  assert.equal(await activity(session), "done");
});

test("a fork goes on with the model and reasoning the conversation uses now", async t => {
  const runner = await fixture(t);
  const source = await runner.provision("fork-model-source");
  await send(source, "one");
  const view = await send(source, "two", { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "high" });
  assert.deepEqual(view.agent, { provider: "faux", modelId: "faux-2", thinkingLevel: "high" });
  const target = await runner.provision("fork-model-target");
  assert.equal((await target.view()).agent?.modelId, "faux-1");
  await runner.service.fork(target, await ticket(target, "fork"), { sourceSessionId: "fork-model-source", entryId: find(view, "assistant", "saw one|two").id });
  assert.deepEqual((await target.view()).agent, { provider: "faux", modelId: "faux-2", thinkingLevel: "high" });
});
