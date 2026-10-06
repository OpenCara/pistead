import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HostWorkspace } from "../apps/runner/src/host-workspace.js";
import { Sandbox, type SandboxAuthorize } from "../apps/runner/src/sandbox.js";
import { performPush, PushError, type PushWorkspace } from "../apps/runner/src/push.js";
import { RunnerService } from "../apps/runner/src/server.js";
import type { RunnerSession } from "../apps/runner/src/session.js";
import type { SessionRepository } from "../packages/shared/src/repositories.js";
import type { AuthorizationRequest, GitPushOperation, Permission, PushCompleteRequest, PushCredential, PushCredentialRequest, RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { sha256 } from "../packages/shared/src/crypto.js";
import { startGitHttpServer } from "./helpers/git-http.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || !hasGit };
const sandboxMode = { skip: process.platform !== "linux" || !hasGit || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3") };
const authorize: SandboxAuthorize = async () => {};
const AUTHORIZATION = "Bearer push-test-token";
const SECRET = "runner-push-test-secret-not-a-production-secret";

function git(args: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}): string {
  const result = spawnSync("git", args, {
    cwd: options.cwd, input: options.input, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...options.env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** Minimal ustar writer, as in the unsandboxed-host test. */
function tarGz(entries: { name: string; body?: string; type?: "0" | "2" | "5"; link?: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(entry.type ?? "0", 156);
    if (entry.link) header.write(entry.link, 157, "utf8");
    header.write("ustar\0" + "00", 257, "latin1");
    header.fill(32, 148, 156);
    header.write(`${header.reduce((sum: number, byte: number) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A bare upstream with an export-ignored file and a symlink, served over smart HTTP. */
async function upstream(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-")));
  const source = join(directory, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "README.md"), "pinned\n");
  await writeFile(join(source, ".gitattributes"), "ignored.txt export-ignore\n");
  await writeFile(join(source, "ignored.txt"), "export-ignored\n");
  await writeFile(join(source, "src", "a.txt"), "a\n");
  await symlink("README.md", join(source, "link"));
  const env = { GIT_AUTHOR_NAME: "Upstream", GIT_AUTHOR_EMAIL: "upstream@example.test", GIT_COMMITTER_NAME: "Upstream", GIT_COMMITTER_EMAIL: "upstream@example.test", GIT_AUTHOR_DATE: "@1700000000 +0000", GIT_COMMITTER_DATE: "@1700000000 +0000" };
  git(["init", "-q", "--initial-branch=main", source]);
  git(["add", "-A"], { cwd: source });
  git(["commit", "-q", "-m", "Upstream"], { cwd: source, env });
  const pinned = git(["rev-parse", "HEAD"], { cwd: source }).trim();
  const project = join(directory, "project");
  await mkdir(join(project, "acme"), { recursive: true });
  const bare = join(project, "acme", "alpha.git");
  git(["clone", "-q", "--bare", source, bare]);
  // Like real forges: partial clone filters, so the pinned commit arrives without blobs (ignored.txt's blob is then
  // in neither the scratch repository nor the session snapshot, and the push must not need it).
  git(["--git-dir", bare, "config", "uploadpack.allowFilter", "true"]);
  git(["--git-dir", bare, "config", "uploadpack.allowReachableSHA1InWant", "true"]);
  git(["--git-dir", bare, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  const server = await startGitHttpServer(project, { authorization: AUTHORIZATION });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const pin: SessionRepository = { bindingId: "binding-alpha", repositoryId: 101, fullName: "acme/alpha", path: "acme/alpha", ref: "main", commit: pinned };
  // The snapshot omits the export-ignored file and materializes the symlink as a regular file copy.
  const archive = tarGz([
    { name: "alpha-main/", type: "5" }, { name: "alpha-main/README.md", body: "pinned\n" },
    { name: "alpha-main/.gitattributes", body: "ignored.txt export-ignore\n" },
    { name: "alpha-main/src/", type: "5" }, { name: "alpha-main/src/a.txt", body: "a\n" },
    { name: "alpha-main/link", type: "2", link: "README.md" },
  ]);
  const credential: PushCredential = { credentialId: "credential-1", remote: server.url("acme/alpha.git"), authorization: AUTHORIZATION, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  return { directory, bare, pin, pinned, archive, credential };
}

function binding(id: string, repositories: SessionRepository[], provider = "openai"): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Push", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "git_commit", "git_push"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider, modelId: provider === "faux" ? "faux-1" : "local" },
  };
}

type Workspace = (HostWorkspace | Sandbox) & PushWorkspace;

/** Records the object count of every uploaded pack. */
function counting(workspace: Workspace, counts: number[]): PushWorkspace {
  return {
    head: value => workspace.head(value),
    pushPrepare: (id, input, pack, value) => workspace.pushPrepare(id, input, pack, value),
    pushCleanup: id => workspace.pushCleanup(id),
    pushPack: async (id, input, value) => {
      const pack = await workspace.pushPack(id, input, value);
      return (async function* () {
        let header = Buffer.alloc(0);
        for await (const chunk of pack) {
          if (header.length < 12) {
            header = Buffer.concat([header, chunk]);
            if (header.length >= 12) counts.push(header.readUInt32BE(8));
          }
          yield chunk;
        }
      })();
    },
  };
}

async function commit(workspace: Workspace, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) await workspace.writeFile(path, content, authorize);
  await workspace.execute({ kind: "git.commit", message }, false, authorize);
  return workspace.head(authorize);
}

/** The full push flow against one workspace implementation; `sessionGit` is the session's Git dir on the host. */
async function pushScenario(t: TestContext, create: (repositories: SessionRepository[], name: string) => Promise<{ workspace: Workspace; sessionGit: string }>) {
  const { bare, pin, pinned, archive, credential } = await upstream(t);
  const { workspace, sessionGit } = await create([pin], "session");
  await workspace.materializeRepositories([pin], [archive], authorize);
  const message = "Edit README\n\nBody keeps  spacing.\n";
  const first = await commit(workspace, { "acme/alpha/README.md": "changed\n", "acme/alpha/src/new.txt": "new\n", "notes.txt": "outside the repository\n" }, message);
  const counts: number[] = [];
  const pushWith = (branch: string, head: string) => performPush({
    workspace: counting(workspace, counts), credential, authorize, repository: pin,
    operation: { kind: "git.push", repository: pin.path, branch, commit: head } satisfies GitPushOperation,
  });

  const pushed = await pushWith("feature", first);
  assert.equal(pushed.outcome, "pushed");
  assert.equal(pushed.previous, null);
  assert.equal(pushed.commits.length, 1);
  const tip = git(["--git-dir", bare, "rev-parse", "refs/heads/feature"]).trim();
  assert.equal(tip, pushed.tip);
  assert.equal(git(["--git-dir", bare, "rev-parse", `${tip}^`]).trim(), pinned, "rewritten commits sit on the pinned commit");
  const format = "%an|%ae|%ad|%cn|%ce|%cd";
  assert.equal(git(["--git-dir", bare, "log", "-1", `--format=${format}`, "--date=raw", tip]), git(["--git-dir", sessionGit, "log", "-1", `--format=${format}`, "--date=raw", first]));
  assert.equal(git(["--git-dir", bare, "cat-file", "commit", tip]).split("\n\n").slice(1).join("\n\n"), message, "the exact message is kept");
  const tree = (commitish: string) => git(["--git-dir", bare, "ls-tree", "-r", commitish]).trim().split("\n").sort();
  const expected = tree(pinned).filter(line => !/\t(README\.md)$/.test(line));
  assert.deepEqual(tree(tip).filter(line => !/\t(README\.md|src\/new\.txt)$/.test(line)), expected, "export-ignored file and symlink stay untouched");
  assert.ok(tree(tip).some(line => /^120000 blob .*\tlink$/.test(line)));
  assert.ok(tree(tip).some(line => line.endsWith("\tignored.txt")));
  assert.equal(git(["--git-dir", bare, "show", `${tip}:README.md`]), "changed\n");
  assert.equal(git(["--git-dir", bare, "show", `${tip}:src/new.txt`]), "new\n");
  assert.ok(!tree(tip).some(line => line.includes("notes.txt")), "files outside the repository path never leave the session");

  const second = await commit(workspace, { "acme/alpha/src/a.txt": "a2\n" }, "Second change");
  const forward = await pushWith("feature", second);
  assert.equal(forward.outcome, "pushed");
  assert.equal(forward.previous, tip);
  assert.equal(git(["--git-dir", bare, "rev-parse", `${forward.tip}^`]).trim(), tip, "re-pushes fast-forward over the earlier rewrite");
  assert.equal(counts.at(-1), 4, "only the new commit, its two trees and one blob are uploaded");

  assert.equal((await pushWith("feature", second)).outcome, "up-to-date");

  const other = git(["--git-dir", bare, "commit-tree", `${pinned}^{tree}`, "-p", pinned, "-m", "elsewhere"], { env: { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).trim();
  git(["--git-dir", bare, "update-ref", "refs/heads/moved", other]);
  await assert.rejects(pushWith("moved", second), (error: unknown) => error instanceof PushError && /moved/.test(error.message));
  assert.equal(git(["--git-dir", bare, "rev-parse", "refs/heads/moved"]).trim(), other, "a refused push changes no ref");

  const { workspace: idle } = await create([pin], "unchanged");
  await idle.materializeRepositories([pin], [archive], authorize);
  const outside = await commit(idle, { "notes.txt": "only outside\n" }, "Outside only");
  await assert.rejects(performPush({ workspace: idle, credential, authorize, repository: pin, operation: { kind: "git.push", repository: pin.path, branch: "empty", commit: outside } }),
    (error: unknown) => error instanceof PushError && /do not change the repository/.test(error.message));
  assert.equal(spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", "refs/heads/empty"]).status, 1);
}

test("host workspaces rewrite session commits onto the pin and push fast-forward only", hostMode, async t => {
  await pushScenario(t, async (repositories, name) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-host-")));
    const workspace = new HostWorkspace(binding(`host-${name}`, repositories), join(directory, "session"));
    t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
    await workspace.initialize();
    return { workspace, sessionGit: join(workspace.worktree, ".git") };
  });
});

test("sandbox helper push kinds produce the same rewrite and push", sandboxMode, async t => {
  await pushScenario(t, async (repositories, name) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-sandbox-")));
    const root = join(directory, "session");
    const workspace = new Sandbox(binding(`sandbox-${name}`, repositories), root);
    t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
    await workspace.initialize();
    return { workspace, sessionGit: join(root, "git") };
  });
});

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

test("sessions run approved pushes in the background, auto-push only with an admission, and always report completion", hostMode, async t => {
  const { bare, pin, archive, credential } = await upstream(t);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-session-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const grants: Record<string, Permission[]> = { "test:alice": ["read", "ask", "write", "approve", "manage"] };
  const credentialRequests: PushCredentialRequest[] = [];
  const completions: PushCompleteRequest[] = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write_file", { path: "acme/alpha/README.md", content: "from the agent\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git_commit", { message: "Agent change" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git_push", { repository: "acme/alpha", branch: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Pushed automatically."),
    fauxAssistantMessage([fauxToolCall("git_push", { repository: "acme/alpha", branch: "reviewed", pull_request: { title: "Review", body: "Please" } })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Push requested."),
    fauxAssistantMessage([fauxToolCall("git_push", { repository: "acme/alpha", branch: "moved" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Push requested."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: grants[input.actorId]?.includes(input.permission) ?? false, ownerId: input.ownerId, policyVersion: 1 }),
    readRepository: async () => archive,
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
  const session = await service.provision(binding(id, [pin], "faux"), await ticket(id, "create"));

  // Auto access with a Worker admission pushes synchronously inside the tool call.
  const admissionId = await sha256("push admission");
  await session.submit(await ticket(id, "submit"), { content: "Change and push.", requestId: "auto", admissionId, options: { access: "auto" } }, "write");
  await idle(session);
  let approvals = (await session.view()).approvals;
  const automatic = approvals.find(approval => approval.operation.kind === "git.push")!;
  assert.equal(automatic.status, "executed");
  assert.equal(automatic.automatic, true);
  assert.match(automatic.result ?? "", /Pushed 1 commit to auto/);
  assert.equal(credentialRequests[0]!.admissionId, admissionId);
  assert.equal(credentialRequests[0]!.capability, undefined);
  assert.deepEqual(Object.keys(credentialRequests[0]!.operation), ["kind", "repository", "branch", "commit"]);
  assert.equal(git(["--git-dir", bare, "show", "refs/heads/auto:README.md"]), "from the agent\n");
  assert.deepEqual(completions[0], { sessionId: id, approvalId: automatic.id, credentialId: "credential-1", outcome: "pushed", tip: git(["--git-dir", bare, "rev-parse", "refs/heads/auto"]).trim() });

  // Auto access without an admission waits for a human, whose decision returns while the push runs.
  await session.submit(await ticket(id, "submit"), { content: "Push for review.", requestId: "review", options: { access: "auto" } }, "write");
  await idle(session);
  approvals = (await session.view()).approvals;
  const reviewed = approvals.find(approval => approval.operation.kind === "git.push" && approval.operation.branch === "reviewed")!;
  assert.equal(reviewed.status, "pending");
  assert.deepEqual(Object.keys(reviewed.operation), ["kind", "repository", "branch", "commit", "pullRequest"]);
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

  // A definite failure is reported as failed, and completion still revokes the credential.
  const other = git(["--git-dir", bare, "commit-tree", `${pin.commit}^{tree}`, "-p", pin.commit, "-m", "elsewhere"], { env: { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).trim();
  git(["--git-dir", bare, "update-ref", "refs/heads/moved", other]);
  await session.submit(await ticket(id, "submit"), { content: "Push to a moved branch.", requestId: "moved" }, "write");
  await idle(session);
  const moved = (await session.view()).approvals.find(approval => approval.operation.kind === "git.push" && approval.operation.branch === "moved")!;
  assert.equal((await session.decide(await ticket(id, "approve"), moved.id, { decision: "approve", operation: moved.operation, brokerCapability: "capability-2" })).status, "executing");
  await idle(session);
  const failed = (await session.view()).approvals.find(approval => approval.id === moved.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.result ?? "", /fast-forward only/);
  assert.deepEqual(completions.at(-1), { sessionId: id, approvalId: moved.id, credentialId: "credential-3", outcome: "failed" });
  assert.equal(git(["--git-dir", bare, "rev-parse", "refs/heads/moved"]).trim(), other);
});

test("push-prepare removes orphaned scratch repositories and snapshots never carry them", hostMode, async t => {
  const { bare, pin, archive, credential } = await upstream(t);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pistead-push-scratch-")));
  const workspace = new HostWorkspace(binding("host-scratch", [pin]), join(directory, "session"));
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.initialize();
  await workspace.materializeRepositories([pin], [archive], authorize);
  const head = await commit(workspace, { "acme/alpha/README.md": "scratch\n" }, "Scratch");
  const scratch = join(workspace.worktree, ".git", "pistead-push");
  const stale = join(scratch, "0".repeat(32));
  await mkdir(join(stale, "objects", "pack"), { recursive: true });
  await writeFile(join(stale, "objects", "pack", "orphan.pack"), "left by an interrupted push");
  const files = await workspace.snapshot(authorize);
  assert.ok(files.length > 0);
  assert.ok(!files.some(file => file.path.startsWith("git/pistead-push")), "snapshots exclude push scratch repositories");
  const pushed = await performPush({ workspace, credential, authorize, repository: pin, operation: { kind: "git.push", repository: pin.path, branch: "scratch", commit: head } });
  assert.equal(pushed.outcome, "pushed");
  assert.equal(git(["--git-dir", bare, "rev-parse", "refs/heads/scratch"]).trim(), pushed.tip);
  assert.ok(!existsSync(stale), "the next push removes the orphaned scratch repository");
  assert.deepEqual(await readdir(scratch), [], "the push cleans up its own scratch repository");
});

test("close() during an automatic push aborts it, awaits settlement and reports an unknown outcome", hostMode, async t => {
  const { pin, archive, credential } = await upstream(t);
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
    fauxAssistantMessage([fauxToolCall("write_file", { path: "acme/alpha/README.md", content: "from the agent\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git_commit", { message: "Agent change" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("git_push", { repository: "acme/alpha", branch: "auto" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = new RunnerService({
    dataDir: directory, sharedSecret: SECRET, controlPlaneUrl: "http://127.0.0.1:8787", allowFaux: true, unsandboxed: true,
    authorize: async (input: AuthorizationRequest) => ({ allowed: true, ownerId: input.ownerId, policyVersion: 1 }),
    readRepository: async () => archive,
    resolveModels: async model => ({ models, provider: model.provider, modelId: model.modelId }),
    pushCredential: async request => { credentialRequests.push(request); return { ...credential, remote: `http://127.0.0.1:${port}/acme/alpha.git` }; },
    pushComplete: async request => { completions.push(request); return {}; },
  });
  await service.initialize();
  let closed = false;
  t.after(() => { if (!closed) return service.close(); });
  const id = "push-close";
  const session = await service.provision(binding(id, [pin], "faux"), await ticket(id, "create"));
  await session.submit(await ticket(id, "submit"), { content: "Change and push.", requestId: "auto", admissionId: await sha256("admission"), options: { access: "auto" } }, "write");
  for (let count = 0; requests === 0 && count < 1000; count++) await delay(10);
  assert.equal(requests > 0, true, "the push reached the forge");
  assert.equal(completions.length, 0);
  await service.close();
  closed = true;
  assert.deepEqual(completions, [{ sessionId: id, approvalId: credentialRequests[0]!.approvalId, credentialId: credential.credentialId, outcome: "unknown" }],
    "close() waits for the aborted push, which reports an ambiguous outcome");
});
