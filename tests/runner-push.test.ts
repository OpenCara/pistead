import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { hostGitAuthorization, HostCredentialError } from "../apps/runner/src/git-credentials.js";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerConfig, RunnerSession } from "../apps/runner/src/session.js";
import type { EgressGrant } from "../packages/shared/src/network.js";
import type { AuthorizationRequest, Permission, PushCompleteRequest, PushCredential, PushCredentialRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || !hasGit };
const sandboxMode = { skip: process.platform !== "linux" || !hasGit || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3") };
const AUTHORIZATION = "Bearer push-test-token";
const SECRET = "runner-push-test-secret-not-a-production-secret";
const ORIGIN = "https://github.com/acme/alpha.git";
const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true },
  repositories: [{ bindingId: "binding-alpha", provider: "github", host: "github.com", repositoryId: "101", fullName: "acme/alpha" }] };
const IDENTITY = { GIT_AUTHOR_NAME: "Alice Owner", GIT_AUTHOR_EMAIL: "alice@example.test", GIT_COMMITTER_NAME: "Alice Owner", GIT_COMMITTER_EMAIL: "alice@example.test" };

function git(args: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}): string {
  const result = spawnSync("git", args, {
    cwd: options.cwd, input: options.input, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...options.env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

/** A bare upstream served over smart HTTP to requests with `authorization`. */
async function upstream(t: TestContext, authorization = AUTHORIZATION) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-")));
  const source = join(directory, "source");
  await mkdir(source);
  await writeFile(join(source, "README.md"), "upstream\n");
  git(["init", "-q", "--initial-branch=main", source]);
  git(["add", "-A"], { cwd: source });
  git(["commit", "-q", "-m", "Upstream"], { cwd: source, env: { ...IDENTITY, GIT_AUTHOR_DATE: "@1700000000 +0000", GIT_COMMITTER_DATE: "@1700000000 +0000" } });
  const project = join(directory, "project");
  await mkdir(join(project, "acme"), { recursive: true });
  const bare = join(project, "acme", "alpha.git");
  git(["clone", "-q", "--bare", source, bare]);
  const server = await startGitHttpServer(project, { authorization });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const credential: PushCredential = { credentialId: "credential-1", remote: server.url("acme/alpha.git"), authorization, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  return { directory, bare, credential };
}

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Push", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [], repositoryMode: "clone" },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "git_push"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "faux", modelId: "faux-1" },
  };
}

/** Commits `content` to the session's clone `app` of the upstream (cloning it first), as the agent would with Git in bash. */
function commitToClone(session: RunnerSession, bare: string, content: string, message: string): string {
  // The sandbox's host storage, not its in-sandbox path.
  const clone = join(session.directory, "sandbox", "worktree", "app");
  if (!existsSync(clone)) {
    git(["clone", "-q", "--no-hardlinks", bare, clone]);
    git(["remote", "set-url", "origin", ORIGIN], { cwd: clone });
  }
  writeFileSync(join(clone, "README.md"), content);
  git(["commit", "-q", "-am", message], { cwd: clone, env: IDENTITY });
  return git(["rev-parse", "HEAD"], { cwd: clone }).trim();
}

async function ticket(id: string, action: RunnerAction, actorId = "test:alice"): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId: id, actorId, ownerId: "test:alice", action, policyVersion: 1, iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function idle(session: RunnerSession): Promise<void> {
  for (let count = 0; count < 1000; count++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("runner did not settle");
}

/** The card a tool call waits on for a person's decision. */
async function pendingApproval(session: RunnerSession) {
  for (let count = 0; count < 1000; count++) {
    const approval = (await session.view()).approvals.find(candidate => candidate.status === "pending");
    if (approval) return approval;
    await delay(20);
  }
  assert.fail("no pending approval");
}

test("sessions run approved clone pushes in the background, auto-push only with an admission, and always report completion", sandboxMode, async t => {
  const { bare, credential } = await upstream(t);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const grants: Record<string, Permission[]> = { "test:alice": ["read", "ask", "write", "approve", "manage"] };
  const credentialRequests: PushCredentialRequest[] = [];
  const completions: PushCompleteRequest[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("git_push", { directory: "app", branch: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Pushed automatically."),
    fauxAssistantMessage([fauxToolCall("git_push", { directory: "app", branch: "reviewed", pull_request: { title: "Review", body: "Please" } })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Push requested."),
    fauxAssistantMessage([fauxToolCall("git_push", { directory: "app", branch: "moved" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Push requested."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, egressGrant: async () => grant,
    authorize: async (input: AuthorizationRequest) => ({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    pushCredential: async request => { credentialRequests.push(request); return { ...credential, credentialId: `credential-${credentialRequests.length}` }; },
    pushComplete: async request => {
      completions.push(request);
      return request.outcome === "pushed" && request.approvalId.length ? { pullRequest: { url: "https://forge.example/acme/alpha/pull/7", number: 7, created: true } } : {};
    },
  });
  await service.initialize();
  t.after(() => service.close());
  const id = "push-session";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  const tip = commitToClone(session, bare, "from the agent\n", "Agent change");

  // Auto access with a Worker admission pushes synchronously inside the tool call.
  const admissionId = await sha256("push admission");
  await session.submit(await ticket(id, "submit"), { content: "Push.", requestId: "auto", admissionId, options: { access: "auto" } }, "write");
  await idle(session);
  const automatic = (await session.view()).approvals.find(approval => approval.operation.kind === "git.push")!;
  assert.equal(automatic.status, "executed");
  assert.equal(automatic.automatic, true);
  assert.match(automatic.result ?? "", /Pushed 1 commit to auto/);
  assert.equal(credentialRequests[0]!.admissionId, admissionId);
  assert.equal(credentialRequests[0]!.capability, undefined);
  assert.deepEqual(credentialRequests[0]!.operation, { kind: "git.push", repository: "acme/alpha", directory: "app", branch: "auto", commit: tip });
  assert.equal(git(["--git-dir", bare, "show", "refs/heads/auto:README.md"]), "from the agent\n");
  assert.deepEqual(completions[0], { sessionId: id, approvalId: automatic.id, credentialId: "credential-1", outcome: "pushed", tip });

  // Auto access without an admission waits for a human, whose decision returns while the push runs.
  commitToClone(session, bare, "for review\n", "Review change");
  await session.submit(await ticket(id, "submit"), { content: "Push for review.", requestId: "review", options: { access: "auto" } }, "write");
  const reviewed = await pendingApproval(session);
  assert.equal(reviewed.operation.kind === "git.push" && reviewed.operation.branch, "reviewed");
  assert.deepEqual(Object.keys(reviewed.operation), ["kind", "repository", "directory", "branch", "commit", "pullRequest"]);
  await assert.rejects(session.decide(await ticket(id, "approve"), reviewed.id, { decision: "approve", operation: reviewed.operation }), /broker capability/);
  const decided = await session.decide(await ticket(id, "approve"), reviewed.id, { decision: "approve", operation: reviewed.operation, brokerCapability: "capability-1" });
  assert.equal(decided.status, "executing");
  await idle(session);
  const settled = (await session.view()).approvals.find(approval => approval.id === reviewed.id)!;
  assert.equal(settled.status, "executed");
  assert.match(settled.result ?? "", /Pushed 1 commit to reviewed/);
  assert.match(settled.result ?? "", /https:\/\/forge\.example\/acme\/alpha\/pull\/7/);
  assert.equal(credentialRequests[1]!.capability, "capability-1");
  assert.equal(credentialRequests[1]!.admissionId, undefined);
  assert.ok((await session.view()).entries.some(entry => entry.role === "toolResult" && entry.text.includes("Pushed 1 commit to reviewed")), "the agent learns the push went through");

  // A definite failure is reported as failed, and completion still revokes the credential.
  const base = git(["--git-dir", bare, "rev-parse", "refs/heads/main"]).trim();
  const other = git(["--git-dir", bare, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "elsewhere"], { env: IDENTITY }).trim();
  git(["--git-dir", bare, "update-ref", "refs/heads/moved", other]);
  await session.submit(await ticket(id, "submit"), { content: "Push to a moved branch.", requestId: "moved" }, "write");
  const moved = await pendingApproval(session);
  assert.equal((await session.decide(await ticket(id, "approve"), moved.id, { decision: "approve", operation: moved.operation, brokerCapability: "capability-2" })).status, "executing");
  await idle(session);
  const failed = (await session.view()).approvals.find(approval => approval.id === moved.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.result ?? "", /fast-forward only/);
  assert.deepEqual(completions.at(-1), { sessionId: id, approvalId: moved.id, credentialId: "credential-3", outcome: "failed" });
  assert.equal(git(["--git-dir", bare, "rev-parse", "refs/heads/moved"]).trim(), other);
});

test("close() during an automatic push aborts it, awaits settlement and reports an unknown outcome", sandboxMode, async t => {
  const { bare, credential } = await upstream(t);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-close-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A forge that accepts the connection and never answers: the push is in flight until aborted.
  let requests = 0;
  const hanging = createServer(() => { requests++; });
  hanging.listen(0, "127.0.0.1");
  await once(hanging, "listening");
  t.after(() => { hanging.closeAllConnections(); hanging.close(); });
  const { port } = hanging.address() as AddressInfo;
  const credentialRequests: PushCredentialRequest[] = [];
  const completions: PushCompleteRequest[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("git_push", { directory: "app", branch: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, egressGrant: async () => grant,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    pushCredential: async request => { credentialRequests.push(request); return { ...credential, remote: `http://127.0.0.1:${port}/acme/alpha.git` }; },
    pushComplete: async request => { completions.push(request); return {}; },
  });
  await service.initialize();
  let closed = false;
  t.after(() => { if (!closed) return service.close(); });
  const id = "push-close";
  const session = await service.provision(binding(id), await ticket(id, "create"));
  commitToClone(session, bare, "from the agent\n", "Agent change");
  await session.submit(await ticket(id, "submit"), { content: "Push.", requestId: "auto", admissionId: await sha256("admission"), options: { access: "auto" } }, "write");
  for (let count = 0; requests === 0 && count < 1000; count++) await delay(10);
  assert.equal(requests > 0, true, "the push reached the forge");
  assert.equal(completions.length, 0);
  await service.close();
  closed = true;
  assert.deepEqual(completions, [{ sessionId: id, approvalId: credentialRequests[0]!.approvalId, credentialId: credential.credentialId, outcome: "unknown" }],
    "close() waits for the aborted push, which reports an ambiguous outcome");
});

/** A Git configuration whose only credential helper runs `helper` for `get` (none when null); a prompt would run an askpass that leaves a marker. */
async function credentialConfig(directory: string, helper: string | null): Promise<NodeJS.ProcessEnv> {
  const askpass = join(directory, "askpass.sh");
  await writeFile(askpass, `#!/bin/sh\ntouch '${join(directory, "prompted")}'\necho prompted\n`, { mode: 0o755 });
  await writeFile(join(directory, "gitconfig"), `[core]\n\taskPass = ${askpass}\n${helper ? `[credential]\n\thelper = "!f() { test \\"$1\\" = get && ${helper}; }; f"\n` : ""}`);
  return { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_GLOBAL: join(directory, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: askpass, SSH_ASKPASS: askpass };
}

test("the host's Git credentials come from its credential helpers, never from a prompt", hostMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-credentials-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Without a helper Git would ask for a user name; prompts are off, so the read fails at once and no askpass runs.
  const none = await credentialConfig(directory, null);
  await assert.rejects(hostGitAuthorization("https://forge.example/acme/alpha.git", { env: none }),
    (error: unknown) => error instanceof HostCredentialError && /No Git credentials for forge\.example are set up/.test(error.message));
  const env = await credentialConfig(directory, "echo username=alice && echo password=s3cret:token");
  assert.equal(await hostGitAuthorization("https://forge.example/acme/alpha.git", { env }), `Basic ${Buffer.from("alice:s3cret:token").toString("base64")}`);
  const userOnly = await credentialConfig(directory, "echo username=alice");
  await assert.rejects(hostGitAuthorization("https://forge.example/acme/alpha.git", { env: userOnly }), HostCredentialError);
  assert.equal(existsSync(join(directory, "prompted")), false, "no askpass program ever ran");
  // Credentials go only to HTTPS remotes (plain HTTP only on loopback, for local forges).
  await assert.rejects(hostGitAuthorization("http://forge.example/acme/alpha.git", { env }), /Git remote URL is invalid/);
});

test("pushes with the host's Git credentials run only in its owner's sessions while the owner opts in", sandboxMode, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-host-credentials-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "git"));
  const env = await credentialConfig(join(directory, "git"), "echo username=host-user && echo password=host-secret");
  const { bare, credential } = await upstream(t, `Basic ${Buffer.from("host-user:host-secret").toString("base64")}`);
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const push = (branch: string) => [fauxAssistantMessage([fauxToolCall("git_push", { directory: "app", branch })], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")];
  faux.setResponses([...push("own"), ...push("shared"), ...push("off")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const completions: PushCompleteRequest[] = [];
  const connectorId = "connector-1";
  const config: RunnerConfig = {
    dataDir: join(directory, "runner"), sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, connectorId, egressGrant: async () => grant,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    pushCredential: async request => ({ credentialId: request.approvalId, remote: credential.remote, hostCredentials: true, expiresAt: credential.expiresAt }),
    pushComplete: async request => { completions.push(request); return {}; },
    hostGitCredential: (remote, signal) => hostGitAuthorization(remote, { env, signal }),
  };
  const service = new RunnerService(config);
  await service.initialize();
  t.after(() => service.close());
  const run = async (id: string, hostOwner: string) => {
    const value = binding(id);
    value.session.connectorId = value.model.connectorId = connectorId;
    value.session.connectorOwnerId = value.model.connectorOwnerId = hostOwner;
    const session = await service.provision(value, { ...await ticket(id, "create"), connectorId });
    commitToClone(session, bare, `${id} change\n`, `${id} change`);
    await session.submit({ ...await ticket(id, "submit"), connectorId }, { content: "Push.", requestId: id, admissionId: await sha256(id), options: { access: "auto" } }, "write");
    await idle(session);
    return (await session.view()).approvals.find(approval => approval.operation.kind === "git.push")!;
  };

  const own = await run("host-own", "test:alice");
  assert.equal(own.status, "executed");
  assert.match(own.result ?? "", /Pushed 1 commit to own/);
  assert.equal(git(["--git-dir", bare, "show", "refs/heads/own:README.md"]), "host-own change\n");
  // A teammate's session on alice's host never pushes with alice's credentials.
  const shared = await run("host-shared", "test:bob");
  assert.equal(shared.status, "failed");
  assert.match(shared.result ?? "", /Only the host's owner can push with its Git credentials\. Nothing was pushed/);
  // A runner that can't read the host's credentials says where the owner turns them on.
  delete config.hostGitCredential;
  const off = await run("host-off", "test:alice");
  assert.equal(off.status, "failed");
  assert.match(off.result ?? "", /turn them on in Pistead \(Settings → Hosts → the host → Configuration\)/);
  assert.deepEqual(completions.map(item => [item.approvalId, item.outcome]), [[own.id, "pushed"], [shared.id, "failed"], [off.id, "failed"]]);
  for (const branch of ["shared", "off"]) assert.equal(spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`]).status, 1);
});
