import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { AgentVersion, ApprovalRecord, ModelDefinition, SessionRecord, SessionView, SubmitResult, UserProfile, Workspace } from "../packages/shared/src/types.js";
import type { ConnectorInfo, ConnectorPairing } from "../packages/shared/src/connector.js";
import { createConnector } from "../apps/runner/src/connector.js";
import { createFauxLocalModels } from "../apps/runner/src/local-pi.js";

const base = (process.env.APP_URL ?? "http://localhost:8787").replace(/\/$/, "");
const connectedRuntime = process.env.CONNECTED_RUNTIME === "true";
const testSecret = process.env.TEST_AUTH_SECRET;
if (!testSecret) throw new Error("TEST_AUTH_SECRET is required; test authentication must be explicitly enabled with an expiry");
const run = `e2e-${Date.now().toString(36)}`;
let assertions = 0;
const report: { name: string; status: string }[] = [];

class Client {
  cookies = new Map<string, string>();
  csrf = "";
  user!: UserProfile;
  constructor(readonly name: string) {}
  async request(method: string, path: string, body?: unknown, accepted: number[] = [200, 201, 202]): Promise<any> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (this.csrf && !["GET", "HEAD"].includes(method)) headers["x-csrf-token"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (path === "/api/auth/test") headers.Authorization = `Bearer ${testSecret}`;
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const text = await response.text();
    let result: any;
    try { result = JSON.parse(text); } catch { result = { text }; }
    assert.ok(accepted.includes(response.status), `${this.name} ${method} ${path}: expected ${accepted.join("/")}, got ${response.status}: ${text.slice(0, 400)}`);
    assertions++;
    return result;
  }
  async login(): Promise<void> {
    const result = await this.request("POST", "/api/auth/test", {
      id: `${run}-${this.name.toLowerCase()}`, displayName: this.name, gitName: `${this.name} Integration`,
      gitEmail: `${this.name.toLowerCase()}@example.invalid`, githubLogin: `${this.name.toLowerCase()}-test`, env: { APP_PERSON: this.name },
    });
    this.user = result.user;
    this.csrf = (await this.request("GET", "/api/auth/csrf")).csrfToken;
    assert.ok(this.csrf);
  }
  async view(sessionId: string): Promise<SessionView> {
    return (await this.request("GET", `/api/sessions/${sessionId}/view`)).view;
  }
  async settled(sessionId: string, text?: string): Promise<SessionView> {
    const deadline = Date.now() + 30_000;
    let view: SessionView;
    do {
      view = await this.view(sessionId);
      if (!view.busy && (!text || view.entries.some((entry) => entry.text.includes(text)))) return view;
      await delay(150);
    } while (Date.now() < deadline);
    throw new Error(`Session ${sessionId} did not settle${text ? ` with ${text}` : ""}`);
  }
  async submit(sessionId: string, content: string, mode = "submit", requestId: string = crypto.randomUUID()): Promise<SubmitResult> {
    return this.request("POST", `/api/sessions/${sessionId}/${mode}`, { content, requestId });
  }
}

async function check(name: string, work: () => Promise<void>) {
  await work();
  report.push({ name, status: "passed" });
  console.log(`PASS ${name}`);
}

const alice = new Client("Alice");
const bob = new Client("Bob");
const eve = new Client("Eve");
let workspace: Workspace;
let model: ModelDefinition;
let published: AgentVersion;
let aliceSession: SessionRecord;
let bobSession: SessionRecord;
let requestId = "";
let firstSubmission: SubmitResult;
type ConnectorFixture = { id: string; token: string; connectionToken: string; stop: () => Promise<void> };
const connectorFixtures: ConnectorFixture[] = [];
let aliceConnector: ConnectorFixture | undefined;
let bobConnector: ConnectorFixture | undefined;
let bobLocalSession: SessionRecord | undefined;
let workspaceVisibleSession: SessionRecord | undefined;

async function connectFixture(client: Client): Promise<ConnectorFixture> {
  const pairing: ConnectorPairing = (await client.request("POST", "/api/connectors/pairings", { name: `${client.name} Pi ${run}`, workspaceId: workspace.id })).pairing;
  const dataDir = await mkdtemp(join(tmpdir(), "opencara-connector-e2e-"));
  const fixture: ConnectorFixture = { id: "", token: "", connectionToken: "", stop: async () => {} };
  const observeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const generationToken = headers.get("x-connection-token");
    if (generationToken) fixture.connectionToken = generationToken;
    const response = await fetch(input, init);
    if (url.endsWith(`/api/connectors/pairings/${pairing.id}/claim`) && response.ok) {
      const { credentials } = await response.clone().json() as { credentials: { connectorId: string; token: string } };
      fixture.id = credentials.connectorId;
      fixture.token = credentials.token;
    }
    return response;
  };
  const connector = createConnector({
    server: base, dataDir, pairing: { id: pairing.id, code: pairing.code },
    localModels: createFauxLocalModels("faux-1"), allowFaux: true, allowTestShell: true,
    allowInsecureLoopback: base.startsWith("http://"), fetch: observeFetch,
  });
  fixture.stop = async () => { await connector.stop(); await rm(dataDir, { recursive: true, force: true }); };
  connectorFixtures.push(fixture);
  await connector.start();
  assert.ok(fixture.id && fixture.token && fixture.connectionToken);
  const owned = await client.request("GET", "/api/connectors");
  const info: ConnectorInfo = owned.connectors.find((item: ConnectorInfo) => item.id === fixture.id);
  assert.equal(info.ownerId, client.user.id);
  assert.equal(info.online, true);
  assert.deepEqual(info.workspaceIds, [], "pairing must not implicitly share runtime access");
  assert.ok(info.connectedWorkspaceIds?.includes(workspace.id), "the owner's private connection remains workspace-associated");
  assert.ok(!JSON.stringify(owned).includes(fixture.token), "connector credentials must never enter public metadata");
  const replay = await fetch(`${base}/api/connectors/pairings/${pairing.id}/claim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, models: [{ provider: "faux", modelId: "faux-1", name: "Fixture" }],
      capabilities: { platform: process.platform, sandbox: true, productionShell: false } }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok([400, 401, 403, 409].includes(replay.status), "pairing code must be single-use");
  await replay.body?.cancel();
  const impersonation = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${fixture.token}` } });
  assert.equal(impersonation.status, 401, "connector bearer cannot authenticate as a user");
  await impersonation.body?.cancel();
  const global = await fetch(`${base}/api/internal/authorize`, {
    method: "POST", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, body: "{}",
  });
  assert.ok([401, 503].includes(global.status), "connector bearer cannot enter the global internal API");
  await global.body?.cancel();
  return fixture;
}

await check("unauthenticated APIs fail closed; test accounts are explicit and isolated", async () => {
  await new Client("anonymous").request("GET", "/api/sessions", undefined, [401]);
  await Promise.all([alice.login(), bob.login(), eve.login()]);
  assert.notEqual(alice.user.id, bob.user.id);
  assert.ok(alice.user.id.startsWith("test:"));
  assert.equal(alice.user.githubConnected, false);
  await alice.request("PATCH", "/api/me", { env: { HOME: "/home/other" } }, [400]);
  await alice.request("PATCH", "/api/me", { env: { APP_API_KEY: "not-a-real-key" } }, [400]);
});

await check("workspace membership is required before associating a private Pi", async () => {
  workspace = (await alice.request("POST", "/api/workspaces", { name: `Integration ${run}` })).workspace;
  await bob.request("GET", `/api/workspaces/${workspace.id}/agents`, undefined, [403, 404]);
  await alice.request("POST", `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: "member" });
});

if (connectedRuntime) {
  await check("user-owned Pi connections pair once and never receive global or user authority", async () => {
    aliceConnector = await connectFixture(alice);
    bobConnector = await connectFixture(bob);
    assert.notEqual(aliceConnector.id, bobConnector.id);
    const owned = (await bob.request("GET", "/api/connectors")).connectors as ConnectorInfo[];
    assert.ok(!owned.some(connection => connection.id === aliceConnector!.id));
  });
  await check("private Pi runs an unpublished agent while teammates can only view its default workspace session", async () => {
    const ownModels: ModelDefinition[] = (await alice.request("GET", `/api/workspaces/${workspace.id}/models`)).models;
    const ownModel = ownModels.find(item => item.connectorId === aliceConnector!.id)!;
    assert.ok(ownModel, "owner can select their private Pi model");
    const peerModels: ModelDefinition[] = (await bob.request("GET", `/api/workspaces/${workspace.id}/models`)).models;
    assert.ok(!peerModels.some(item => item.connectorId === aliceConnector!.id));
    await bob.request("POST", "/api/agents", {
      name: "Guessed private model", description: "Unauthorized model selection", instructions: "Use private model", tools: ["identity"], modelId: ownModel.id,
    }, [403, 404]);
    const own: AgentVersion = (await alice.request("POST", "/api/agents", {
      name: "Private local agent", description: "Owner-only local agent", instructions: "Use the session owner's identity.", tools: ["identity"], modelId: ownModel.id,
    })).agent;
    assert.equal(own.workspaceId, null);
    workspaceVisibleSession = (await alice.request("POST", "/api/sessions", {
      workspaceId: workspace.id, agentVersionId: own.id, title: "Local run, workspace view",
    })).session;
    const sessionId = workspaceVisibleSession!.id;
    assert.equal(workspaceVisibleSession!.visibility, "workspace");
    assert.equal(workspaceVisibleSession!.connectorId, aliceConnector!.id);
    const listed: SessionRecord[] = (await bob.request("GET", "/api/sessions")).sessions;
    assert.deepEqual(listed.find(item => item.id === sessionId)?.permissions, ["read"]);
    assert.deepEqual((await bob.request("GET", `/api/sessions/${sessionId}`)).session.permissions, ["read"]);
    await alice.submit(sessionId, "TEST_IDENTITY");
    await alice.settled(sessionId, "alice-test");
    const viewed = await bob.view(sessionId);
    assert.equal(viewed.owner.id, alice.user.id);
    assert.equal("env" in viewed.owner, false);
    assert.equal("githubToken" in viewed.owner, false);
    await eve.request("GET", `/api/sessions/${sessionId}/view`, undefined, [403, 404]);
    for (const mode of ["submit", "ask"]) {
      await bob.request("POST", `/api/sessions/${sessionId}/${mode}`, { content: "TEST_IDENTITY", requestId: `viewer-${mode}` }, [403]);
    }
    await bob.request("POST", `/api/sessions/${sessionId}/operations`, { kind: "git.commit", message: "forbidden" }, [403]);
    await bob.request("POST", `/api/sessions/${sessionId}/approvals/${crypto.randomUUID()}`, { decision: "approve" }, [403]);
    await bob.request("POST", `/api/sessions/${sessionId}/grants`, { userId: bob.user.id, permissions: ["write", "manage"] }, [403]);
    await bob.request("POST", `/api/sessions/${sessionId}/restart`, {}, [403]);
    await bob.request("POST", `/api/sessions/${sessionId}/backup`, {}, [403]);
    await bob.request("GET", `/api/sessions/${sessionId}/backups`, undefined, [403]);
    await bob.request("PATCH", `/api/sessions/${sessionId}`, { visibility: "private" }, [403]);
    await bob.request("POST", "/api/sessions", {
      workspaceId: workspace.id, agentVersionId: own.id, title: "No private agent use", trustedConnectorId: aliceConnector!.id,
    }, [403, 404]);
  });
  await check("workspace viewing follows membership and privacy changes immediately, without granting control", async () => {
    const sessionId = workspaceVisibleSession!.id;
    await alice.request("POST", `/api/workspaces/${workspace.id}/members`, { userId: eve.user.id, role: "member" });
    assert.equal((await eve.view(sessionId)).owner.id, alice.user.id);
    await alice.request("DELETE", `/api/workspaces/${workspace.id}/members/${encodeURIComponent(eve.user.id)}`, undefined, [200, 204]);
    await eve.request("GET", `/api/sessions/${sessionId}/view`, undefined, [403, 404]);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12_000);
    try {
      const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
        headers: { Cookie: [...bob.cookies].map(([key, value]) => `${key}=${value}`).join("; "), Origin: base }, signal: abort.signal,
      });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
      const reader = response.body!.getReader();
      await reader.read();
      const changed = (await alice.request("PATCH", `/api/sessions/${sessionId}`, { visibility: "private" })).session;
      assert.equal(changed.visibility, "private");
      while (!(await reader.read()).done) { /* Privacy changes close an already-open viewer stream. */ }
      assert.equal(abort.signal.aborted, false);
    } finally { clearTimeout(timeout); abort.abort(); }
    await bob.request("GET", `/api/sessions/${sessionId}/view`, undefined, [403, 404]);
    assert.ok(!(await bob.request("GET", "/api/sessions")).sessions.some((item: SessionRecord) => item.id === sessionId));
    await alice.request("POST", `/api/sessions/${sessionId}/grants`, { userId: bob.user.id, permissions: ["read"] });
    assert.equal((await bob.view(sessionId)).owner.id, alice.user.id);
    await alice.request("DELETE", `/api/sessions/${sessionId}/grants/${encodeURIComponent(bob.user.id)}`);
    await bob.request("GET", `/api/sessions/${sessionId}/view`, undefined, [403, 404]);
    workspaceVisibleSession = (await alice.request("PATCH", `/api/sessions/${sessionId}`, { visibility: "workspace" })).session;
    assert.deepEqual((await bob.request("GET", `/api/sessions/${sessionId}`)).session.permissions, ["read"]);
  });
}

await check("workspace model discovery distinguishes private Pi from explicitly shared Pi", async () => {
  if (connectedRuntime) {
    const visible = (await bob.request("GET", `/api/workspaces/${workspace.id}/connectors`)).connectors as ConnectorInfo[];
    assert.ok(visible.some(item => item.id === bobConnector!.id), "owner can discover their private Pi");
    assert.ok(!visible.some(item => item.id === aliceConnector!.id), "teammates cannot discover another user's private Pi");
    await bob.request("PUT", `/api/connectors/${aliceConnector!.id}/shares/${workspace.id}`, {}, [403, 404]);
    await alice.request("PUT", `/api/connectors/${aliceConnector!.id}/shares/${workspace.id}`, {});
    await bob.request("PUT", `/api/connectors/${bobConnector!.id}/shares/${workspace.id}`, {});
    const models: ModelDefinition[] = (await alice.request("GET", `/api/workspaces/${workspace.id}/models`)).models;
    model = models.find(item => item.connectorId === aliceConnector!.id && item.modelId === "faux-1")!;
    assert.ok(model, "shared local model must be discovered without cloud provider configuration");
    await eve.request("GET", `/api/workspaces/${workspace.id}/connectors`, undefined, [403, 404]);
  } else {
    model = (await alice.request("POST", `/api/workspaces/${workspace.id}/models`, { name: "Deterministic integration fixture", provider: "faux", modelId: "faux-1" })).model;
  }
  await bob.request("POST", `/api/workspaces/${workspace.id}/models`, { name: "Forbidden", provider: "faux", modelId: "faux-1" }, [403]);
  await eve.request("POST", `/api/workspaces/${workspace.id}/members`, { userId: eve.user.id, role: "admin" }, [403, 404]);
});

await check("repository setup stays workspace-scoped and synthetic sign-in grants no GitHub access", async () => {
  assert.deepEqual((await alice.request("GET", `/api/workspaces/${workspace.id}/repositories`)).repositories, []);
  assert.deepEqual((await bob.request("GET", `/api/workspaces/${workspace.id}/repositories`)).repositories, []);
  await eve.request("GET", `/api/workspaces/${workspace.id}/repositories`, undefined, [403, 404]);
  const repository = { provider: "github", host: "github.com", repositoryId: "1", fullName: "example/private-repository" };
  await bob.request("POST", `/api/workspaces/${workspace.id}/repositories`, repository, [403]);
  await alice.request("POST", `/api/workspaces/${workspace.id}/repositories`, repository, [403]);
  await alice.request("GET", "/api/git/accounts/github/repositories", undefined, [403]);
  assert.deepEqual((await alice.request("GET", "/api/git/accounts")).accounts, []);
  await bob.request("DELETE", `/api/workspaces/${workspace.id}/repositories/00000000-0000-4000-8000-000000000001`, undefined, [403]);
});

await check("private agents remain private; publishing exposes definition, not author environment", async () => {
  const own: AgentVersion = (await alice.request("POST", "/api/agents", { name: `Reviewer ${run}`, description: "Shared identity-neutral integration fixture", instructions: "Use the connected session owner's identity. Never change identity configuration.", tools: ["identity", "list_files", "read_file", "write_file", "git_status", "git_commit", "bash", "github_comment"], modelId: model.id })).agent;
  await bob.request("POST", "/api/sessions", { workspaceId: workspace.id, agentVersionId: own.id, title: "Forbidden private use" }, [403, 404]);
  published = (await alice.request("POST", `/api/agents/${own.agentId}/publish`, { workspaceId: workspace.id })).agent;
  assert.equal(published.authorId, alice.user.id);
  assert.equal(published.workspaceId, workspace.id);
  const catalog: AgentVersion[] = (await bob.request("GET", `/api/workspaces/${workspace.id}/agents`)).agents;
  assert.ok(catalog.some((item) => item.id === published.id));
  assert.equal("env" in published, false);
  assert.equal("githubToken" in published, false);
});

await check("repository pins and cache destinations are assigned by the server, not the session caller", async () => {
  await alice.request("POST", "/api/sessions", {
    workspaceId: workspace.id, agentVersionId: published.id, title: "Forbidden repository injection",
    repositories: [{
      bindingId: "00000000-0000-4000-8000-000000000001", repositoryId: 1,
      fullName: "example/private-repository", ref: "main", commit: "a".repeat(40), path: "../../host",
    }],
  }, [400]);
});

await check("the same published agent starts distinct owner-bound sessions", async () => {
  aliceSession = (await alice.request("POST", "/api/sessions", { workspaceId: workspace.id, agentVersionId: published.id, title: "Alice's session", visibility: "private" })).session;
  if (connectedRuntime) {
    await bob.request("POST", "/api/sessions", { workspaceId: workspace.id, agentVersionId: published.id, title: "Missing host trust" }, [400, 403]);
  }
  bobSession = (await bob.request("POST", "/api/sessions", {
    workspaceId: workspace.id, agentVersionId: published.id, title: "Bob's session", visibility: "private",
    ...(connectedRuntime ? { trustedConnectorId: aliceConnector!.id } : {}),
  })).session;
  if (connectedRuntime) {
    assert.equal(bobSession.connectorId, aliceConnector!.id);
    assert.equal(bobSession.connectorOwnerId, alice.user.id);
  }
  assert.equal(aliceSession.ownerId, alice.user.id);
  assert.equal(bobSession.ownerId, bob.user.id);
  assert.equal(aliceSession.agentVersionId, bobSession.agentVersionId);
  await alice.submit(aliceSession.id, "TEST_IDENTITY");
  await bob.submit(bobSession.id, "TEST_IDENTITY");
  const av = await alice.settled(aliceSession.id, "alice-test");
  const bv = await bob.settled(bobSession.id, "bob-test");
  assert.equal(av.owner.id, alice.user.id);
  assert.equal(bv.owner.id, bob.user.id);
  assert.equal(av.owner.gitEmail, "alice@example.invalid");
  assert.equal(bv.owner.gitEmail, "bob@example.invalid");
  await alice.request("GET", `/api/sessions/${bobSession.id}/view`, undefined, [403, 404]);
  await bob.request("GET", `/api/sessions/${aliceSession.id}/view`, undefined, [403, 404]);
  const visible: SessionRecord[] = (await alice.request("GET", "/api/sessions")).sessions;
  assert.ok(!visible.some((session) => session.id === bobSession.id));
});

if (connectedRuntime) {
  await check("concurrent views and submissions keep the shared connector generation stable", async () => {
    const generation = aliceConnector!.connectionToken;
    const [aliceView, bobView] = await Promise.all([
      alice.view(aliceSession.id),
      bob.view(bobSession.id),
      alice.submit(aliceSession.id, "TEST_IDENTITY"),
      bob.submit(bobSession.id, "TEST_IDENTITY"),
    ]);
    assert.equal(aliceView.owner.id, alice.user.id);
    assert.equal(bobView.owner.id, bob.user.id);
    await Promise.all([alice.settled(aliceSession.id), bob.settled(bobSession.id)]);
    assert.ok(generation === aliceConnector!.connectionToken, "Ordinary concurrent requests must not replace the connector generation");
  });
}

await check("publishing an update cannot silently change existing sessions or grant author access", async () => {
  await bob.request("POST", `/api/agents/${published.agentId}/versions`, { name: "Hijack", description: "", instructions: "Replace another author's agent", tools: ["identity"], modelId: model.id }, [403, 404]);
  const next: AgentVersion = (await alice.request("POST", `/api/agents/${published.agentId}/versions`, { name: `Reviewer revised ${run}`, description: "Explicit next version", instructions: "A new version must not hot-replace active sessions.", tools: ["identity"], modelId: model.id })).agent;
  assert.ok(next.version > published.version);
  const nextPublished: AgentVersion = (await alice.request("POST", `/api/agents/${published.agentId}/publish`, { workspaceId: workspace.id })).agent;
  assert.notEqual(nextPublished.id, published.id);
  assert.equal((await bob.request("GET", `/api/sessions/${bobSession.id}`)).session.agentVersionId, published.id);
  await alice.request("GET", `/api/sessions/${bobSession.id}/view`, undefined, [403, 404]);
  await bob.request("POST", "/api/sessions", { workspaceId: workspace.id, agentVersionId: published.id, title: "Spoofed owner", ownerId: alice.user.id }, [400]);
});

await check("read-only sharing cannot prompt, ask, approve, manage, or cross workspace boundaries", async () => {
  await alice.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: bob.user.id, permissions: ["read"] });
  assert.equal((await bob.view(aliceSession.id)).owner.id, alice.user.id);
  await bob.request("POST", `/api/sessions/${aliceSession.id}/submit`, { content: "TEST_IDENTITY", requestId: "forbidden-write" }, [403]);
  await bob.request("POST", `/api/sessions/${aliceSession.id}/ask`, { content: "TEST_IDENTITY", requestId: "forbidden-ask" }, [403]);
  await bob.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: bob.user.id, permissions: ["write", "approve", "manage"] }, [403]);
  await alice.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: eve.user.id, permissions: ["read"] }, [400, 403, 404]);
});

await check("side questions retain the session owner and cannot modify its worktree", async () => {
  await alice.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: bob.user.id, permissions: ["ask"] });
  await bob.submit(aliceSession.id, "TEST_IDENTITY", "ask");
  const question = await bob.settled(aliceSession.id);
  assert.equal(question.owner.id, alice.user.id);
  assert.ok(question.conversations.some((conversation) => conversation.mode === "ask"));
  await bob.submit(aliceSession.id, "TEST_WRITE forbidden.txt\nside-question-must-not-write", "ask");
  await bob.settled(aliceSession.id);
  await alice.submit(aliceSession.id, "TEST_READ forbidden.txt");
  const after = await alice.settled(aliceSession.id);
  const toolResults = after.entries.filter((entry) => entry.kind === "pi.tool-result" || entry.role === "tool");
  assert.ok(!toolResults.some((entry) => entry.text === "side-question-must-not-write"));
});

await check("collaborative writes execute as owner; another user's worktree stays isolated", async () => {
  await alice.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: bob.user.id, permissions: ["write"] });
  await bob.submit(aliceSession.id, "TEST_IDENTITY");
  const shared = await bob.settled(aliceSession.id);
  assert.equal(shared.owner.id, alice.user.id);
  await bob.submit(aliceSession.id, "TEST_WRITE evidence.txt\nowned-by-alice");
  await bob.settled(aliceSession.id);
  await bob.submit(bobSession.id, "TEST_WRITE evidence.txt\nowned-by-bob");
  await bob.settled(bobSession.id);
  await alice.submit(aliceSession.id, "TEST_READ evidence.txt");
  await bob.submit(bobSession.id, "TEST_READ evidence.txt");
  await alice.settled(aliceSession.id, "owned-by-alice");
  await bob.settled(bobSession.id, "owned-by-bob");
});

await check("write access does not grant approval; approved git commits use owner identity", async () => {
  const approval: ApprovalRecord = (await bob.request("POST", `/api/sessions/${aliceSession.id}/operations`, { kind: "git.commit", message: `Integration ${run}` })).approval;
  assert.equal(approval.status, "pending");
  assert.ok(approval.reviewHash, "the Worker must commit to the displayed operation and requester");
  await bob.request("POST", `/api/sessions/${aliceSession.id}/approvals/${approval.id}`, { decision: "approve", reviewHash: approval.reviewHash }, [403]);
  const decided: ApprovalRecord = (await alice.request("POST", `/api/sessions/${aliceSession.id}/approvals/${approval.id}`, { decision: "approve", reviewHash: approval.reviewHash })).approval;
  assert.ok(["approved", "executing", "executed"].includes(decided.status));
  const query: ApprovalRecord = (await alice.request("POST", `/api/sessions/${aliceSession.id}/operations`, { kind: "bash", command: "git log -1 --format='%an <%ae>|%cn <%ce>'" })).approval;
  const inspected: ApprovalRecord = (await alice.request("POST", `/api/sessions/${aliceSession.id}/approvals/${query.id}`, { decision: "approve", reviewHash: query.reviewHash })).approval;
  assert.ok(inspected.result?.includes("Alice Integration <alice@example.invalid>"), "git commit author and committer must use owner identity");
});

await check("durable request deduplication and restart preserve transcript and owner files", async () => {
  requestId = `dedup-${run}`;
  firstSubmission = await bob.submit(aliceSession.id, "TEST_IDENTITY", "submit", requestId);
  await bob.settled(aliceSession.id);
  const again = await bob.submit(aliceSession.id, "TEST_IDENTITY", "submit", requestId);
  assert.equal(again.submissionId, firstSubmission.submissionId);
  await alice.request("POST", `/api/sessions/${aliceSession.id}/restart`, {});
  const recovered = await bob.submit(aliceSession.id, "TEST_IDENTITY", "submit", requestId);
  assert.equal(recovered.submissionId, firstSubmission.submissionId);
  await alice.submit(aliceSession.id, "TEST_READ evidence.txt");
  const view = await alice.settled(aliceSession.id, "owned-by-alice");
  assert.equal(view.owner.id, alice.user.id);
});

await check("durable FIFO submissions retain stable receipts and survive restart", async () => {
  await alice.submit(aliceSession.id, "TEST_HOLD 5000");
  const firstKey = `queue-first-${run}`;
  const lastKey = `queue-last-${run}`;
  const first = await bob.submit(aliceSession.id, "TEST_WRITE queue.txt\nfifo-first", "submit", firstKey);
  const last = await alice.submit(aliceSession.id, "TEST_WRITE queue.txt\nfifo-last", "submit", lastKey);
  assert.equal(first.status, "queued");
  assert.equal(last.status, "queued");
  const replay = await bob.submit(aliceSession.id, "TEST_WRITE queue.txt\nfifo-first", "submit", firstKey);
  assert.equal(replay.submissionId, first.submissionId);
  await alice.request("POST", `/api/sessions/${aliceSession.id}/restart`, {});
  await alice.settled(aliceSession.id);
  const completed = await bob.submit(aliceSession.id, "TEST_WRITE queue.txt\nfifo-first", "submit", firstKey);
  assert.equal(completed.submissionId, first.submissionId);
  await alice.submit(aliceSession.id, "TEST_READ queue.txt");
  const view = await alice.settled(aliceSession.id, "fifo-last");
  const results = view.entries.filter(entry => entry.conversationId === first.conversationId && (entry.role === "tool" || entry.kind === "pi.tool-result"));
  assert.ok(results.at(-1)?.text.includes("fifo-last"), "later FIFO write must win");
});

await check("queued work is reauthorized and revoked writers cannot delay later owner work", async () => {
  await alice.submit(aliceSession.id, "TEST_HOLD 5000");
  const revoked = await bob.submit(aliceSession.id, "TEST_WRITE revoked-queue.txt\nmust-not-run", "submit", `revoked-queue-${run}`);
  assert.equal(revoked.status, "queued");
  await alice.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: bob.user.id, permissions: ["read"] });
  await alice.submit(aliceSession.id, "TEST_WRITE after-revocation.txt\nowner-queue-continued");
  await alice.settled(aliceSession.id, "owner-queue-continued");
  const read = await alice.submit(aliceSession.id, "TEST_READ revoked-queue.txt");
  const view = await alice.settled(aliceSession.id);
  const results = view.entries.filter(entry => entry.conversationId === read.conversationId && (entry.role === "tool" || entry.kind === "pi.tool-result"));
  assert.ok(!results.some(entry => entry.text.includes("must-not-run")));
});

await check("revocation closes existing streams and blocks subsequent requests", async () => {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12_000);
  const response = await fetch(`${base}/api/sessions/${aliceSession.id}/events`, { headers: { Cookie: [...bob.cookies].map(([key, value]) => `${key}=${value}`).join("; "), Origin: base }, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
  const reader = response.body!.getReader();
  await reader.read();
  await alice.request("DELETE", `/api/sessions/${aliceSession.id}/grants/${encodeURIComponent(bob.user.id)}`);
  try {
    let ended = false;
    while (!ended) ended = (await reader.read()).done;
    assert.equal(abort.signal.aborted, false, "stream must close promptly on revocation, not only on client timeout");
  } finally { clearTimeout(timeout); abort.abort(); }
  await bob.request("GET", `/api/sessions/${aliceSession.id}/view`, undefined, [403, 404]);
  await bob.request("POST", `/api/sessions/${aliceSession.id}/submit`, { content: "TEST_IDENTITY", requestId: "after-revoke" }, [403, 404]);
});

const health = await alice.request("GET", "/api/health");
if (!health.backupsConfigured && process.env.ALLOW_MISSING_BACKUPS === "true") {
  const unavailable = await alice.request("POST", `/api/sessions/${aliceSession!.id}/backup`, {}, [503]);
  assert.equal(unavailable.code ?? unavailable.error?.code, "backup_unavailable");
  report.push({ name: "SQLite-consistent backup upload/download and owner-only access", status: "blocked: backup storage not configured" });
  console.warn("BLOCKED backup upload/download: backup storage not configured; verified explicit 503 instead.");
} else {
  await check("SQLite-consistent backup upload/download and owner-only access", async () => {
    const { backup } = await alice.request("POST", `/api/sessions/${aliceSession.id}/backup`, {});
    assert.equal(backup.sessionId, aliceSession.id);
    assert.ok(backup.size > 0 && backup.sha256);
    const listing = await alice.request("GET", `/api/sessions/${aliceSession.id}/backups`);
    assert.ok(listing.backups.some((item: { id: string }) => item.id === backup.id));
    const download = `/api/sessions/${aliceSession.id}/backups/${backup.id}/download`;
    await bob.request("GET", download, undefined, [403, 404]);
    const response = await fetch(`${base}${download}`, {
      headers: { Cookie: [...alice.cookies].map(([key, value]) => `${key}=${value}`).join("; "), Origin: base },
      signal: AbortSignal.timeout(45_000),
    });
    assert.equal(response.status, 200);
    const bytes = await response.text();
    assert.equal(await sha256(bytes), backup.sha256);
    assert.equal(response.headers.get("x-backup-sha256"), backup.sha256);
    const snapshot = JSON.parse(bytes);
    assert.equal(snapshot.format, "pi-runner-backup-v1");
    assert.equal(snapshot.binding.owner.id, alice.user.id);
    assert.equal(Buffer.from(snapshot.sqlite, "base64").subarray(0, 15).toString(), "SQLite format 3");
  });
  await check("backup restoration creates an owner-only independent session with an idempotent receipt", async () => {
    const { backups } = await alice.request("GET", `/api/sessions/${aliceSession.id}/backups`);
    const backup = backups[0];
    assert.ok(backup?.id);
    await alice.request("POST", `/api/sessions/${aliceSession.id}/grants`, { userId: bob.user.id, permissions: ["manage"] });
    const restorePath = `/api/sessions/${aliceSession.id}/backups/${backup.id}/restore`;
    const input = { requestId: `restore-${run}`, title: "Restored owner session" };
    await bob.request("POST", restorePath, input, [403]);
    await bob.request("GET", `/api/sessions/${aliceSession.id}/backups/${backup.id}/download`, undefined, [403]);
    const sourceBefore = await alice.view(aliceSession.id);
    await alice.request("PATCH", "/api/me", { gitName: "Alice Restored" });
    const restored: SessionRecord = (await alice.request("POST", restorePath, input)).session;
    assert.notEqual(restored.id, aliceSession.id);
    assert.equal(restored.visibility, "private", "restores must not republish historical session content");
    assert.equal(restored.ownerId, alice.user.id);
    assert.equal(restored.agentVersionId, aliceSession.agentVersionId);
    assert.equal(restored.connectorId, aliceSession.connectorId);
    const retry = await alice.request("POST", restorePath, input);
    assert.equal(retry.session.id, restored.id);
    await alice.request("POST", restorePath, { ...input, title: "Conflicting retry" }, [409]);
    await bob.request("GET", `/api/sessions/${restored.id}/view`, undefined, [403, 404]);
    await alice.submit(restored.id, "TEST_READ evidence.txt");
    const restoredView = await alice.settled(restored.id, "owned-by-alice");
    assert.equal(restoredView.owner.gitName, "Alice Restored");
    assert.ok(restoredView.approvals.every(approval => !["pending", "approved", "executing"].includes(approval.status)));
    await alice.submit(restored.id, "TEST_WRITE evidence.txt\nrestored-is-independent");
    await alice.settled(restored.id);
    await alice.submit(aliceSession.id, "TEST_READ evidence.txt");
    const sourceAfter = await alice.settled(aliceSession.id, "owned-by-alice");
    assert.equal(sourceAfter.owner.gitName, sourceBefore.owner.gitName);
    assert.ok(!sourceAfter.entries.some(entry => entry.text.includes("restored-is-independent")));
    await alice.request("DELETE", `/api/sessions/${aliceSession.id}/grants/${encodeURIComponent(bob.user.id)}`);
  });
}

await check("audit history is visible only to authorized session participants", async () => {
  const audit = await alice.request("GET", `/api/sessions/${aliceSession.id}/audit`);
  assert.ok(Array.isArray(audit.events) && audit.events.length > 0);
  await eve.request("GET", `/api/sessions/${aliceSession.id}/audit`, undefined, [403, 404]);
});

if (connectedRuntime) {
  await check("connector callbacks cannot authorize another host's sessions or fabricate GitHub approvals", async () => {
    const models: ModelDefinition[] = (await bob.request("GET", `/api/workspaces/${workspace.id}/models`)).models;
    const localModel = models.find(item => item.connectorId === bobConnector!.id)!;
    assert.ok(localModel);
    const privateAgent: AgentVersion = (await bob.request("POST", "/api/agents", {
      name: "Bob local fixture", description: "", instructions: "Use the owner's identity.", tools: ["identity"], modelId: localModel.id,
    })).agent;
    const shared: AgentVersion = (await bob.request("POST", `/api/agents/${privateAgent.agentId}/publish`, { workspaceId: workspace.id })).agent;
    bobLocalSession = (await bob.request("POST", "/api/sessions", {
      workspaceId: workspace.id, agentVersionId: shared.id, title: "Bob's separate host", visibility: "private",
    })).session;
    assert.ok(bobLocalSession);
    const headers = { authorization: `Bearer ${aliceConnector!.token}`, "x-connection-token": aliceConnector!.connectionToken, "content-type": "application/json" };
    const crossHost = await fetch(`${base}/api/connectors/self/authorize`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: bobLocalSession.id, actorId: bob.user.id, ownerId: bob.user.id, permission: "read" }),
    });
    if (crossHost.ok) assert.equal((await crossHost.json() as { allowed: boolean }).allowed, false);
    else { assert.ok([403, 404].includes(crossHost.status)); await crossHost.body?.cancel(); }
    const fabricated = await fetch(`${base}/api/connectors/self/github/comment`, {
      method: "POST", headers, body: JSON.stringify({
        sessionId: aliceSession.id, actorId: alice.user.id, approvalId: crypto.randomUUID(), capability: "not-a-real-capability-with-sufficient-length",
        repository: "fixture/repository", issue: 1, body: "Must never reach GitHub",
      }),
    });
    assert.equal(fabricated.status, 403);
    await fabricated.body?.cancel();
  });
  await check("unsharing and revoking a connection remove its runtime access without affecting other hosts", async () => {
    await alice.request("DELETE", `/api/connectors/${aliceConnector!.id}/shares/${workspace.id}`, undefined, [204]);
    await bob.request("GET", `/api/sessions/${bobSession.id}/view`, undefined, [403, 404, 503]);
    const shared: ConnectorInfo[] = (await bob.request("GET", `/api/workspaces/${workspace.id}/connectors`)).connectors;
    assert.ok(!shared.some(connection => connection.id === aliceConnector!.id));
    assert.ok(shared.some(connection => connection.id === bobConnector!.id));
    assert.equal((await alice.view(aliceSession.id)).owner.id, alice.user.id, "unsharing does not disable the host owner's session");
    assert.equal((await bob.view(workspaceVisibleSession!.id)).owner.id, alice.user.id, "viewing the owner's workspace session does not require sharing the Pi");
    await alice.request("DELETE", `/api/connectors/${aliceConnector!.id}`, undefined, [204]);
    const revoked = await fetch(`${base}/api/connectors/self/authorize`, {
      method: "POST", headers: { authorization: `Bearer ${aliceConnector!.token}`, "x-connection-token": aliceConnector!.connectionToken, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: aliceSession.id, actorId: alice.user.id, ownerId: alice.user.id, permission: "read" }),
    });
    assert.ok([401, 403].includes(revoked.status));
    await revoked.body?.cancel();
    await bob.submit(bobLocalSession!.id, "TEST_IDENTITY");
    await bob.settled(bobLocalSession!.id, "bob-test");
  });
}
await Promise.all(connectorFixtures.map(connector => connector.stop()));

console.log(JSON.stringify({ target: base, mode: connectedRuntime ? "connected-pi-faux" : "deterministic-pi-faux", status: report.every(item => item.status === "passed") ? "passed" : "partial", assertions, checks: report, fixtures: { workspaceId: workspace!.id, aliceSessionId: aliceSession!.id, bobSessionId: bobSession!.id }, limitations: ["No real LLM calls billed", "GitHub OAuth and remote writes need a configured OAuth application and real user consent"] }, null, 2));
