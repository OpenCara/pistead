import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { UpstreamRequest } from "../apps/runner/src/api-access.js";
import type { AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket, ToolName } from "../packages/shared/src/types.js";
import type { EgressGrant, NetworkPolicy } from "../packages/shared/src/network.js";
import type { WebSearchRequest, WebSearchResult } from "../packages/shared/src/web.js";
import { sha256 } from "../packages/shared/src/crypto.js";

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0 };

function binding(id: string, tools: ToolName[]): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Web", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools, modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

async function ticket(id: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId: "test:alice", ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

test("agents read web pages within the workspace's network access, and search the web through the control plane", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-web-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy: NetworkPolicy = { mode: "allowlist", domains: ["docs.example.com"], packageRegistries: false };
  const fetched: UpstreamRequest[] = [];
  const searches: WebSearchRequest[] = [];
  const page = `<html><head><title>Guide</title></head><body><h1>Install</h1><p>${"word ".repeat(400)}</p></body></html>`;
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.example.com/guide", max_length: 1000 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.example.com/guide", offset: 1000, max_length: 1000 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://elsewhere.example.net/" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("web_search", { query: "pistead  network access", count: 2 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("web_search", { query: "refused" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-web-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    // A session on the host has no egress proxy: web_fetch asks for the policy itself, and reaches no further.
    egressGrant: async (): Promise<EgressGrant> => ({ policy, repositories: [] }),
    webUpstream: async request => {
      fetched.push(request);
      return { status: 200, headers: { "content-type": "text/html" }, body: Readable.from([Buffer.from(page)]) };
    },
    webSearch: async (request): Promise<WebSearchResult> => {
      searches.push(request);
      if (request.query === "refused") throw new RunnerError(403, "Web search is off in this workspace");
      return { query: request.query, provider: "brave", results: [{ title: "Pistead", url: "https://github.com/OpenCara/pistead", snippet: "Self-hosted Pi" }] };
    },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "web-session";
  const session = await service.provision(binding(id, ["read_file", "web_fetch", "web_search"]), await ticket(id, "create"));
  const admissionId = await sha256("web admission");
  await session.submit(await ticket(id, "submit"), { content: "Read the guide and search.", requestId: "web", admissionId }, "write");
  await idle(session);

  const results = (await session.view()).entries.filter(entry => entry.role === "toolResult").map(entry => entry.text);
  assert.equal(results.length, 5);
  // The first part of the page as text, then the next from its offset; the page is read again for each.
  assert.match(results[0]!, /"title":"Guide"/);
  assert.match(results[0]!, /"nextOffset":1000/);
  assert.match(results[0]!, /# Install/);
  assert.match(results[0]!, /untrusted data/);
  assert.match(results[1]!, /"offset":1000/);
  assert.doesNotMatch(results[1]!, /# Install/);
  assert.equal(fetched.length, 2);
  assert.ok(fetched.every(request => request.url.href === "https://docs.example.com/guide" && request.method === "GET"));
  // A host the workspace doesn't allow is never asked.
  assert.match(results[2]!, /elsewhere\.example\.net is not allowed by this workspace's network policy/);
  // Searches go to the control plane with the message's admission and the query as the agent wrote it, tidied.
  assert.match(results[3]!, /Self-hosted Pi/);
  assert.match(results[4]!, /Web search is off in this workspace/);
  assert.deepEqual(searches.map(({ callId: _callId, ...request }) => request), [
    { sessionId: id, actorId: "test:alice", admissionId, query: "pistead network access", count: 2 },
    { sessionId: id, actorId: "test:alice", admissionId, query: "refused" },
  ]);
});

test("the web tools need a shared message: side asks don't get them", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-web-ask-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://docs.example.com/" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let fetched = 0;
  const service = new RunnerService({
    dataDir: directory, sharedSecret: "runner-web-test-secret-not-a-production-secret", controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    egressGrant: async (): Promise<EgressGrant> => ({ policy: { mode: "open", domains: [], packageRegistries: true }, repositories: [] }),
    webUpstream: async () => { fetched++; return { status: 200, headers: { "content-type": "text/plain" }, body: Readable.from([Buffer.from("hi")]) }; },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "web-ask-session";
  const session = await service.provision(binding(id, ["read_file", "web_fetch", "web_search"]), await ticket(id, "create"));
  await session.submit(await ticket(id, "ask"), { content: "What does the page say?", requestId: "ask" }, "ask");
  await idle(session);
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && /Tool web_fetch is not available/.test(entry.text)));
  assert.equal(fetched, 0);
});
