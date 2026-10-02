import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "../packages/shared/src/crypto.js";
import type { AgentVersion, ApprovalRecord, ModelDefinition, SessionRecord, SessionView, SubmitResult, UserProfile, Workspace } from "../packages/shared/src/types.js";

const base = (process.env.APP_URL ?? "http://localhost:8787").replace(/\/$/, "");
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

await check("unauthenticated APIs fail closed; test accounts are explicit and isolated", async () => {
  await new Client("anonymous").request("GET", "/api/sessions", undefined, [401]);
  await Promise.all([alice.login(), bob.login(), eve.login()]);
  assert.notEqual(alice.user.id, bob.user.id);
  assert.ok(alice.user.id.startsWith("test:"));
  assert.equal(alice.user.githubConnected, false);
  await alice.request("PATCH", "/api/me", { env: { HOME: "/home/other" } }, [400]);
  await alice.request("PATCH", "/api/me", { env: { APP_API_KEY: "not-a-real-key" } }, [400]);
});

await check("workspace membership and model administration are enforced", async () => {
  workspace = (await alice.request("POST", "/api/workspaces", { name: `Integration ${run}` })).workspace;
  await bob.request("GET", `/api/workspaces/${workspace.id}/agents`, undefined, [403, 404]);
  await alice.request("POST", `/api/workspaces/${workspace.id}/members`, { userId: bob.user.id, role: "member" });
  model = (await alice.request("POST", `/api/workspaces/${workspace.id}/models`, { name: "Deterministic integration fixture", provider: "faux", modelId: "faux-1" })).model;
  await bob.request("POST", `/api/workspaces/${workspace.id}/models`, { name: "Forbidden", provider: "faux", modelId: "faux-1" }, [403]);
  await eve.request("POST", `/api/workspaces/${workspace.id}/members`, { userId: eve.user.id, role: "admin" }, [403, 404]);
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

await check("the same published agent starts distinct owner-bound sessions", async () => {
  aliceSession = (await alice.request("POST", "/api/sessions", { workspaceId: workspace.id, agentVersionId: published.id, title: "Alice's session" })).session;
  bobSession = (await bob.request("POST", "/api/sessions", { workspaceId: workspace.id, agentVersionId: published.id, title: "Bob's session" })).session;
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
  await bob.request("POST", `/api/sessions/${aliceSession.id}/approvals/${approval.id}`, { decision: "approve" }, [403]);
  const decided: ApprovalRecord = (await alice.request("POST", `/api/sessions/${aliceSession.id}/approvals/${approval.id}`, { decision: "approve" })).approval;
  assert.ok(["approved", "executing", "executed"].includes(decided.status));
  const query: ApprovalRecord = (await alice.request("POST", `/api/sessions/${aliceSession.id}/operations`, { kind: "bash", command: "git log -1 --format='%an <%ae>|%cn <%ce>'" })).approval;
  const inspected: ApprovalRecord = (await alice.request("POST", `/api/sessions/${aliceSession.id}/approvals/${query.id}`, { decision: "approve" })).approval;
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
  report.push({ name: "SQLite-consistent backup upload/download and owner-only access", status: "blocked: R2 not configured" });
  console.warn("BLOCKED backup upload/download: R2 not configured; verified explicit 503 instead.");
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
}

await check("audit history is visible only to authorized session participants", async () => {
  const audit = await alice.request("GET", `/api/sessions/${aliceSession.id}/audit`);
  assert.ok(Array.isArray(audit.events) && audit.events.length > 0);
  await eve.request("GET", `/api/sessions/${aliceSession.id}/audit`, undefined, [403, 404]);
});

console.log(JSON.stringify({ target: base, mode: "deterministic-pi-faux", status: report.every(item => item.status === "passed") ? "passed" : "partial", assertions, checks: report, fixtures: { workspaceId: workspace!.id, aliceSessionId: aliceSession!.id, bobSessionId: bobSession!.id }, limitations: ["No real LLM calls billed", "GitHub OAuth and remote writes need a configured OAuth application and real user consent"] }, null, 2));
