import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../packages/shared/src/crypto.js";
import { repositoryLimits, repositoryPath, type GitHubSessionRepository, type SessionRepository } from "../packages/shared/src/repositories.js";
import type { RunnerAction, RunnerBinding, RunnerTicket } from "../packages/shared/src/types.js";
import { RunnerError, validateBinding, validateRepositories } from "../apps/runner/src/protocol.js";
import { RunnerSession, type RunnerConfig } from "../apps/runner/src/session.js";

// Real lifecycle cases require the same Linux bwrap/user-namespace setup as runner.test.ts.
const linux = { skip: process.platform !== "linux", timeout: 60_000 };
const SECRET = "repository-test-secret-not-a-production-secret-123456";
const OWNER = "test:alice";
const MODEL_BOUNDARY = new Error("repository test reached model resolution");

function repository(index = 1): GitHubSessionRepository {
  return { bindingId: `repo-${index}`, repositoryId: index, fullName: `acme/project-${index}`,
    path: `acme/project-${index}`, ref: "refs/heads/main", commit: String(index).repeat(40) };
}

function binding(id: string, repositories: SessionRepository[] = [repository()]): RunnerBinding {
  const createdAt = "2026-01-01T00:00:00Z";
  return {
    session: { id, workspaceId: "workspace", ownerId: OWNER, agentVersionId: "version-1", title: "Repository tests", policyVersion: 1, status: "ready", createdAt, repositories },
    owner: { id: OWNER, githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "repository-agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Repository agent", description: "Tests", instructions: "Use tools.", tools: ["read_file", "write_file", "list_files"], modelId: "model-1", createdAt },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "repository-faux" },
  };
}

function config(dataDir: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return { dataDir, controlPlaneUrl: "https://control.example.test", sharedSecret: SECRET, allowFaux: true,
    authorize: async request => ({ allowed: true, ownerId: request.ownerId, policyVersion: 1 }), ...overrides };
}

async function ticket(sessionId: string, action: RunnerAction): Promise<RunnerTicket> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: "runner", sessionId, actorId: OWNER, ownerId: OWNER, action, policyVersion: 1,
    iat: now, exp: now + 60, jti: randomUUID(), bodyHash: await sha256("") };
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runner-repositories-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function runnerError(status: number, message: RegExp) {
  return (error: unknown) => error instanceof RunnerError && error.status === status && message.test(error.message);
}

test("repository protocol accepts only exact immutable pins and returns detached values", () => {
  assert.deepEqual(validateRepositories(undefined), []);
  assert.deepEqual(validateRepositories([]), []);
  const pins = Array.from({ length: repositoryLimits.repositories }, (_, index) => repository(index + 1));
  const validated = validateRepositories(pins);
  assert.deepEqual(validated, pins);
  assert.notEqual(validated, pins);
  validated[0]!.commit = "a".repeat(40);
  assert.equal(pins[0]!.commit, "1".repeat(40));
  const input = binding("protocol", pins);
  const copied = validateBinding(input, input.session.id);
  assert.deepEqual(copied.session.repositories, pins);
  copied.session.repositories![0]!.ref = "refs/heads/changed";
  assert.equal(input.session.repositories![0]!.ref, "refs/heads/main");
});

test("repository names may match ordinary Git config filenames beneath their fixed owner directory", () => {
  for (const name of [".gitconfig", "owner.gitconfig", ".GITCONFIG", "Owner.GitConfig"]) {
    const pin = { ...repository(), fullName: `acme/${name}`, path: `acme/${name}` };
    assert.deepEqual(validateRepositories([pin]), [pin]);
    assert.deepEqual(validateBinding(binding("config-name", [pin]), "config-name").session.repositories, [pin]);
  }
});

test("repository protocol rejects malformed pins, mutable revisions and duplicate identities", async t => {
  const pin = repository();
  const invalid: Array<[string, unknown]> = [
    ["null list", null], ["object list", {}], ["too many", Array.from({ length: repositoryLimits.repositories + 1 }, (_, index) => repository(index + 1))],
    ["null pin", [null]], ["sparse list", new Array(1)], ["array pin", [[]]], ["string pin", ["acme/project"]],
    ["missing commit", [{ bindingId: pin.bindingId, repositoryId: pin.repositoryId, fullName: pin.fullName, path: pin.path, ref: pin.ref }]],
    ["extra archive URL", [{ ...pin, url: "https://elsewhere.example/archive" }]],
  ];
  const fields: Record<string, unknown[]> = {
    bindingId: ["", "../repo", "repo/id", "x".repeat(129), 1],
    repositoryId: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"],
    commit: ["main", "HEAD", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), null],
    ref: ["", " ", "main branch", "main\n", "main\0", "main\u007f", "main\\branch", "x".repeat(256), null],
    fullName: ["project", "acme/project/nested", "-acme/project", "acme/.", "acme/..", "acme/.GiT", "acme/", "a".repeat(40) + "/project"],
    path: ["elsewhere/project", "../project", "/acme/project-1", "acme/project-1/", null],
  };
  for (const [field, values] of Object.entries(fields)) {
    for (const value of values) {
      const changed = { ...pin, [field]: value };
      if (field === "fullName") changed.path = value as string;
      invalid.push([`${field} ${JSON.stringify(value)}`, [changed]]);
    }
  }
  for (const [name, value] of invalid) await t.test(name, () => {
    assert.throws(() => validateRepositories(value), runnerError(400, /immutable repository/));
    const input = binding("invalid");
    input.session.repositories = value as SessionRepository[];
    assert.throws(() => validateBinding(input, input.session.id), runnerError(400, /immutable repository/));
  });
  for (const [name, second] of [
    ["repository id", { ...repository(2), repositoryId: pin.repositoryId }],
    ["binding id", { ...repository(2), bindingId: pin.bindingId }],
    ["case-insensitive name", { ...repository(2), fullName: "ACME/PROJECT-1", path: "ACME/PROJECT-1" }],
    ["identical pin", pin],
  ] as const) await t.test(`duplicate ${name}`, () => {
    assert.throws(() => validateRepositories([pin, second]), runnerError(400, /Duplicate/));
    assert.throws(() => validateBinding(binding("duplicate", [pin, second]), "duplicate"), runnerError(400, /Duplicate/));
  });
});

function providerPin(overrides: Record<string, unknown> = {}): SessionRepository {
  const pin = { bindingId: "gitlab-binding", provider: "gitlab", host: "gitlab.example.com", repositoryId: "4242", fullName: "group/sub/project", ref: "main", commit: "c".repeat(40), ...overrides };
  return { ...pin, path: repositoryPath(pin as SessionRepository) } as SessionRepository;
}

test("repository protocol accepts provider pins beside legacy GitHub pins", () => {
  const pins = [
    repository(),
    providerPin(),
    providerPin({ bindingId: "azure-binding", provider: "azure-devops", host: "dev.azure.com", repositoryId: "6f0c1b2a-0d4e-4c5b-9a7e-1d2c3b4a5f60", fullName: "org/My Project/repo" }),
    providerPin({ bindingId: "bitbucket-binding", provider: "bitbucket", host: "bitbucket.org", repositoryId: "{3c1f5a2e-7d4b-4e6a-8f9c-0b1a2d3e4f50}", fullName: "team/app" }),
    providerPin({ bindingId: "gitea-binding", provider: "gitea", host: "git.example.org:3000", repositoryId: "7", fullName: "owner/app" }),
  ];
  assert.equal(pins[2]!.path, "dev.azure.com/org/My-Project/repo");
  assert.equal(pins[4]!.path, "git.example.org-3000/owner/app");
  const validated = validateRepositories(pins);
  assert.deepEqual(validated, pins);
  assert.deepEqual(validateBinding(binding("providers", pins), "providers").session.repositories, pins);
});

test("repository protocol rejects malformed or duplicate provider pins", async t => {
  const pin = providerPin();
  const { provider: _provider, host: _host, ...withoutProvider } = pin as SessionRepository & { provider: string; host: string };
  const invalid: Array<[string, unknown]> = [
    ["missing host", [{ ...withoutProvider, provider: "gitlab" }]],
    ["provider shape without provider", [withoutProvider]],
    ["extra field", [{ ...pin, url: "https://elsewhere.example/archive" }]],
    ["github provider shape", [{ ...pin, provider: "github", host: "github.com", path: "github.com/group/sub/project" }]],
    ["unknown provider", [{ ...pin, provider: "sourcehut" }]],
    ["localhost host", [providerPin({ host: "localhost" })]],
    ["IP host", [providerPin({ host: "10.0.0.1" })]],
    ["uppercase host", [{ ...pin, host: "GitLab.example.com" }]],
    ["internal host", [providerPin({ host: "gitlab.internal" })]],
    ["overridden fixed host", [providerPin({ provider: "bitbucket", host: "bitbucket.example.com", fullName: "team/app" })]],
    ["path mismatch", [{ ...pin, path: "group/sub/project" }]],
    ["traversal path", [{ ...pin, path: "gitlab.example.com/../project" }]],
    ["traversal name", [providerPin({ fullName: "group/../project" })]],
    ["numeric id", [{ ...pin, repositoryId: 4242 }]],
    ["bad id", [providerPin({ repositoryId: "../1" })]],
    ["azure name without project", [providerPin({ provider: "azure-devops", host: "dev.azure.com", fullName: "org/repo" })]],
    ["bad commit", [{ ...pin, commit: "main" }]],
    ["bad ref", [{ ...pin, ref: "main branch" }]],
  ];
  for (const [name, value] of invalid) await t.test(name, () => {
    assert.throws(() => validateRepositories(value), runnerError(400, /immutable repository/));
  });
  for (const [name, second] of [
    ["provider repository id", providerPin({ bindingId: "other", fullName: "group/other" })],
    ["binding id", providerPin({ repositoryId: "5", fullName: "group/other" })],
    ["case-insensitive path", providerPin({ bindingId: "other", repositoryId: "5", fullName: "GROUP/SUB/PROJECT" })],
  ] as const) await t.test(`duplicate ${name}`, () => {
    assert.throws(() => validateRepositories([pin, second]), runnerError(400, /Duplicate/));
  });
  assert.equal(validateRepositories([pin, providerPin({ bindingId: "other", host: "gitlab.com", fullName: "group/other" })]).length, 2, "same id on another host is distinct");
  assert.equal(validateRepositories([repository(), providerPin({ repositoryId: String(repository().repositoryId) })]).length, 2, "GitHub and provider ids never collide");
});


test("a session that pinned its repositories opens read-only: its history shows, and nothing runs, is decided or backed up", linux, async t => {
  const root = await directory(t);
  const input = binding("pinned-session", [repository()]);
  const session = new RunnerSession(input, root, config(root));
  t.after(() => session.close());
  await session.open();
  assert.equal((await session.view()).busy, false);
  for (const attempt of [
    async () => session.submit(await ticket(input.session.id, "submit"), { content: "hello", requestId: "frozen" }, "write"),
    async () => session.createApproval(OWNER, { kind: "bash", command: "true" }),
    async () => session.decide(await ticket(input.session.id, "approve"), "approval", { decision: "approve", operation: { kind: "bash", command: "true" } }),
    async () => session.backup(await ticket(input.session.id, "backup")),
  ]) await assert.rejects(attempt(), runnerError(409, /pinned its repositories.*read-only/));
  const names = (session as unknown as { buildTools(): { name: string }[] }).buildTools().map(tool => tool.name);
  for (const name of ["git_status", "git_commit", "git_repin", "git_push"]) assert.ok(!names.includes(name), name);
});

const hostMode = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0, timeout: 60_000 };

test("unsandboxed clone sessions clone and push with the host's own Git, so they offer no git_push", hostMode, async t => {
  const root = await directory(t);
  const clone = binding("host-clone", []);
  clone.session.repositoryMode = "clone";
  clone.agent.tools = [...clone.agent.tools, "bash", "git_push"];
  const grant = { policy: { mode: "off" as const, domains: [], packageRegistries: true },
    repositories: [{ bindingId: "repo-1", provider: "github" as const, host: "github.com", repositoryId: "1", fullName: "acme/project-1" }] };
  const session = new RunnerSession(clone, root, config(root, { unsandboxed: true, egressGrant: async () => grant, resolveModels: async () => { throw MODEL_BOUNDARY; } }));
  t.after(() => session.sandbox.close());
  await assert.rejects(session.open(), error => error === MODEL_BOUNDARY);
  const internals = session as unknown as { buildTools(): { name: string }[]; agentInstructions(mode: string): string };
  assert.ok(!internals.buildTools().some(tool => tool.name === "git_push"));
  const instructions = internals.agentInstructions("write");
  assert.match(instructions, /starts empty/);
  assert.match(instructions, /https:\/\/github\.com\/acme\/project-1\.git/);
  assert.doesNotMatch(instructions, /git_push/);
  await assert.rejects(session.createApproval(OWNER, { kind: "git.push", repository: "acme/project-1", directory: "app", branch: "feature", commit: "a".repeat(40) }),
    /push with git in bash/);
});

test("clone sessions pin nothing, commit with Git and push a clone's directory", linux, async t => {
  const root = await directory(t);
  const clone = binding("clone-session", []);
  clone.session.repositoryMode = "clone";
  clone.agent.tools = [...clone.agent.tools, "git_push"];
  assert.deepEqual(validateBinding(clone, "clone-session").session.repositoryMode, "clone");
  assert.throws(() => validateBinding({ ...clone, session: { ...clone.session, repositories: [repository()] } }, "clone-session"), /repository mode/);
  assert.throws(() => validateBinding({ ...clone, session: { ...clone.session, repositoryMode: "mirror" } }, "clone-session"), /repository mode/);

  const grant = { policy: { mode: "off" as const, domains: [], packageRegistries: true },
    repositories: [{ bindingId: "repo-1", provider: "github" as const, host: "github.com", repositoryId: "1", fullName: "acme/project-1" }] };
  const session = new RunnerSession(clone, root, config(root, { egressGrant: async () => grant, resolveModels: async () => { throw MODEL_BOUNDARY; } }));
  t.after(() => session.sandbox.close());
  await assert.rejects(session.open(), error => error === MODEL_BOUNDARY);
  const internals = session as unknown as { buildTools(): { name: string }[]; agentInstructions(mode: string): string };
  const names = internals.buildTools().map(tool => tool.name);
  for (const name of ["git_status", "git_commit", "git_repin"]) assert.ok(!names.includes(name), name);
  assert.equal(names.filter(name => name === "git_push").length, 1);
  const instructions = internals.agentInstructions("write");
  assert.match(instructions, /starts empty/);
  assert.match(instructions, /https:\/\/github\.com\/acme\/project-1\.git/);
  assert.match(instructions, /git_push \{directory, branch\}/);
  assert.doesNotMatch(instructions, /pinned commit/);
  await assert.rejects(session.createApproval(OWNER, { kind: "git.commit", message: "x" }), /Commit and switch branches with git in bash/);
  await assert.rejects(session.createApproval(OWNER, { kind: "git.push", repository: "acme/project-1", branch: "feature", commit: "a".repeat(40) }), /a push names a clone.s directory/);
  // A session without pins or clones (from before either) can't name a clone directory.
  const plain = new RunnerSession(binding("plain-session", []), join(root, "plain"), config(join(root, "plain")));
  t.after(() => plain.sandbox.close());
  await assert.rejects(plain.createApproval(OWNER, { kind: "git.push", repository: "acme/project-1", directory: "app", branch: "feature", commit: "a".repeat(40) }), /Only clone sessions/);
});
