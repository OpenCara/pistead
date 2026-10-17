import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { Harness } from "@earendil-works/pi-durable";
import { sha256 } from "../packages/shared/src/crypto.js";
import { repositoryLimits, repositoryPath, repositoryRemote, type GitHubSessionRepository, type SessionRepository } from "../packages/shared/src/repositories.js";
import { RepositoryCache } from "../apps/runner/src/repo-cache.js";
import { startGitHttpServer } from "./helpers/git-http.js";
import { repositoryPins } from "../apps/runner/src/sandbox.js";
import type { RestoreDescriptor } from "../packages/shared/src/connector.js";
import type { RunnerAction, RunnerBinding, RunnerTicket, SessionActivity } from "../packages/shared/src/types.js";
import { RunnerError, validateBinding, validateRepositories } from "../apps/runner/src/protocol.js";
import { runnerModels } from "../apps/runner/src/provider.js";
import { RunnerService } from "../apps/runner/src/server.js";
import { RunnerSession, type RunnerConfig } from "../apps/runner/src/session.js";

// Real lifecycle cases require the same Linux bwrap/user-namespace setup as runner.test.ts.
const linux = { skip: process.platform !== "linux", timeout: 60_000 };
const SECRET = "repository-test-secret-not-a-production-secret-123456";
const OWNER = "test:alice";
const allow = async (): Promise<void> => {};
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

async function idle(session: RunnerSession): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (!(await session.view()).busy) return;
    await delay(20);
  }
  assert.fail("repository session did not settle");
}

// A small valid GitHub-style tarball, not an archive-extraction adversarial fixture.
function archive(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  function entry(name: string, contents: Buffer, type: "0" | "5") {
    const header = Buffer.alloc(512);
    const octal = (offset: number, width: number, value: number) => header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
    header.write(name, 0, 100, "ascii");
    octal(100, 8, type === "5" ? 0o755 : 0o644);
    octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, contents.length); octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum: number, byte: number) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header, contents, Buffer.alloc((512 - contents.length % 512) % 512));
  }
  entry("github-export/", Buffer.alloc(0), "5");
  for (const [name, contents] of Object.entries(files)) entry(`github-export/${name}`, Buffer.from(contents), "0");
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
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

test("write and ask instructions describe pinned relative cache paths without changing the published agent", linux, async t => {
  const root = await directory(t);
  const input = binding("instructions", [repository(), repository(2)]);
  const published = structuredClone(input.agent);
  const session = new RunnerSession(input, root, config(root));
  t.after(() => session.sandbox.close());
  const runtime = session as unknown as { agentInstructions(mode: "write" | "ask"): string };
  const write = runtime.agentInstructions("write");
  const ask = runtime.agentInstructions("ask");
  assert.ok(write.startsWith(published.instructions));
  assert.ok(ask.startsWith(write));
  for (const instructions of [write, ask]) {
    for (const pin of input.session.repositories!) {
      assert.ok(instructions.includes(`worktree/${pin.path}`));
      assert.ok(instructions.includes(`file-tool path prefix: ${pin.path}/`));
      assert.ok(instructions.includes(`pinned commit: ${pin.commit}`));
    }
    assert.match(instructions, /relative to that worktree/);
    assert.match(instructions, /not full upstream Git histories/);
    assert.equal(instructions.includes(root), false);
    assert.equal(instructions.includes(SECRET), false);
  }
  assert.match(ask, /read-only ask.*do not modify files, execute commands, or perform external effects/s);
  assert.deepEqual(input.agent, published);
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

function observeHarness(t: TestContext, events: string[], ready: () => void) {
  const open = Harness.open;
  t.mock.method(Harness, "open", async (...args: Parameters<typeof Harness.open>) => {
    ready(); events.push("harness");
    const harness = await open.apply(Harness, args);
    const resume = harness.resume.bind(harness);
    t.mock.method(harness, "resume", () => { ready(); events.push("resume"); return resume(); });
    return harness;
  });
}

test("all repository hydration precedes model resolution, Harness.open and durable resume; ready reopen preserves edits without downloads", linux, async t => {
  const root = await directory(t);
  const input = binding("lifecycle", [repository(), repository(2)]);
  const events: string[] = [];
  const downloading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hydrated = false;
  let reopen = false;
  let downloads = 0;
  observeHarness(t, events, () => assert.equal(hydrated, true, "no harness open/resume before all repositories are ready"));
  const settings = config(root, {
    readRepository: async (pin, sessionId) => {
      assert.equal(reopen, false, "ready reopen must not download");
      assert.equal(sessionId, input.session.id);
      assert.deepEqual(pin, input.session.repositories![downloads]);
      downloads++;
      events.push(`download-${downloads}`);
      if (downloads === 2) { downloading.resolve(); await release.promise; }
      const bytes = archive({ "README.md": `pinned ${pin.commit}\n` });
      pin.commit = "f".repeat(40);
      pin.ref = "refs/heads/callback-mutation";
      return bytes;
    },
    resolveModels: async model => {
      for (const pin of input.session.repositories!) {
        const expected = reopen && pin.repositoryId === 1 ? "local edit\n" : `pinned ${pin.commit}\n`;
        assert.equal(await readFile(join(root, "sessions", input.session.id, "sandbox", "worktree", pin.path, "README.md"), "utf8"), expected);
      }
      hydrated = true;
      events.push("models");
      return { models: runnerModels(model, true), provider: model.provider, modelId: model.modelId };
    },
  });
  let service = new RunnerService(settings);
  t.after(async () => { release.resolve(); await service.close(); });
  await service.initialize();
  const opening = service.provision(input, await ticket(input.session.id, "create"));
  try {
    await Promise.race([downloading.promise, opening.then(() => assert.fail("opened before download gate"))]);
    assert.deepEqual(events, ["download-1", "download-2"]);
    await assert.rejects(readFile(join(root, "sessions", input.session.id, "session.sqlite")), { code: "ENOENT" });
  } finally { release.resolve(); }
  const session = await opening;
  assert.deepEqual(events, ["download-1", "download-2", "models", "harness", "resume"]);
  assert.deepEqual(session.binding.session.repositories, input.session.repositories, "download callback only receives a detached pin");
  assert.ok(Object.isFrozen(session.binding.session.repositories));
  assert.ok(Object.isFrozen(session.binding.session.repositories![0]));
  assert.equal(await session.sandbox.repositoryCachesReady(input.session.repositories!, allow), true);
  await session.sandbox.writeFile("acme/project-1/README.md", "local edit\n", allow);
  await session.sandbox.writeFile("acme/project-1/untracked.txt", "keep me", allow);

  await session.exclusive(async () => {});
  // Persist real queued work without racing the scheduler; the fresh session uses its real drain.
  const scheduler = session as unknown as { drainQueue(): void };
  t.mock.method(scheduler, "drainQueue", () => {});
  const receipt = await session.submit(await ticket(input.session.id, "submit"), {
    content: "TEST_READ acme/project-1/README.md", requestId: "read-after-reopen",
  }, "write");
  assert.equal(receipt.status, "queued");
  await service.close();
  reopen = true;
  hydrated = false;
  events.length = 0;
  service = new RunnerService(settings);
  await service.initialize();
  const recovered = await service.get(input.session.id);
  assert.deepEqual(events, ["models", "harness", "resume"]);
  await idle(recovered);
  assert.equal(downloads, 2);
  assert.equal(await recovered.sandbox.readFile("acme/project-1/README.md", allow), "local edit\n");
  assert.equal(await recovered.sandbox.readFile("acme/project-1/untracked.txt", allow), "keep me");
  const view = await recovered.view();
  assert.equal(view.queue?.find(run => run.submissionId === receipt.submissionId)?.status, "settled");
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("local edit")), "resumed durable work sees edited, hydrated files");
  assert.equal(await service.get(input.session.id), recovered);
});

test("provisioned repository pins cannot be replaced even after their worktree has been edited", linux, async t => {
  const root = await directory(t);
  const original = binding("immutable");
  let downloads = 0;
  const service = new RunnerService(config(root, { readRepository: async () => { downloads++; return archive({ "README.md": "original" }); } }));
  t.after(() => service.close());
  await service.initialize();
  const session = await service.provision(original, await ticket(original.session.id, "create"));
  await session.sandbox.writeFile("acme/project-1/README.md", "edited", allow);
  assert.equal(await service.provision(structuredClone(original), await ticket(original.session.id, "create")), session);
  for (const change of [
    { commit: "a".repeat(40) }, { ref: "refs/heads/other" }, { bindingId: "replacement" }, { repositoryId: 999 },
    { fullName: "acme/renamed", path: "acme/renamed" },
  ]) {
    const changed = structuredClone(original);
    Object.assign(changed.session.repositories![0]!, change);
    await assert.rejects(service.provision(changed, await ticket(original.session.id, "create")), runnerError(409, /immutable/));
  }
  for (const pins of [[], [repository(), repository(2)]]) {
    await assert.rejects(service.provision(binding(original.session.id, pins), await ticket(original.session.id, "create")), runnerError(409, /immutable/));
  }
  original.session.repositories![0]!.commit = "b".repeat(40);
  assert.equal(session.binding.session.repositories![0]!.commit, "1".repeat(40));
  assert.equal(downloads, 1);
  assert.equal(await session.sandbox.readFile("acme/project-1/README.md", allow), "edited");
  const saved = JSON.parse(await readFile(join(session.directory, "binding.json"), "utf8")) as RunnerBinding;
  assert.deepEqual(saved, session.binding);
});

// Only the session's sandbox instance is stubbed. The real lifecycle/transport code
// must reach model resolution last; the sentinel avoids opening an actual harness.
async function boundary(t: TestContext, overrides: Partial<RunnerConfig> = {}, input = binding("boundary")) {
  const root = await directory(t);
  let ready = false;
  let models = 0;
  let materializations = 0;
  const received: Uint8Array[][] = [];
  const session = new RunnerSession(input, root, config(root, {
    resolveModels: async () => { models++; throw MODEL_BOUNDARY; }, ...overrides,
  }));
  const initialize = t.mock.method(session.sandbox, "initialize", async () => {});
  t.mock.method(session.sandbox, "repositoryCachesReady", async () => ready);
  t.mock.method(session.sandbox, "materializeRepositories", async (pins: readonly SessionRepository[], archives: readonly Uint8Array[], authorize: () => Promise<void>) => {
    await authorize();
    assert.deepEqual(pins, input.session.repositories);
    received.push([...archives]); materializations++; ready = true;
  });
  const harness = t.mock.method(Harness, "open", async () => assert.fail("harness must not open past the model sentinel"));
  t.after(() => session.sandbox.close());
  return { session, received, initialize, setReady: (value: boolean) => { ready = value; },
    counts: () => ({ models, materializations, harness: harness.mock.callCount() }),
    async untouched() {
      assert.deepEqual({ models, materializations, harness: harness.mock.callCount() }, { models: 0, materializations: 0, harness: 0 });
      await assert.rejects(readFile(session.sqlitePath), { code: "ENOENT" });
    },
  };
}

test("failed repository downloads and live authority denial stop before materialization/model/harness", linux, async t => {
  for (const kind of ["download failure", "initial denial", "revoked during download", "authority unavailable"] as const) {
    await t.test(kind, async t => {
      let downloads = 0;
      let allowed = kind !== "initial denial";
      const failure = new Error("repository broker unavailable");
      const f = await boundary(t, {
        authorize: async request => {
          assert.equal(request.actorId, OWNER); assert.equal(request.permission, "write");
          if (kind === "authority unavailable") throw failure;
          return { allowed, ownerId: OWNER, policyVersion: 1 };
        },
        readRepository: async () => {
          downloads++;
          if (kind === "download failure") throw failure;
          allowed = false;
          return archive({ "README.md": "must not publish" });
        },
      });
      const expected = kind === "download failure" ? (error: unknown) => error === failure
        : runnerError(kind === "authority unavailable" ? 503 : 403, /Authorization/);
      await assert.rejects(f.session.open(), expected);
      assert.equal(downloads, kind === "initial denial" || kind === "authority unavailable" ? 0 : 1);
      assert.equal(f.initialize.mock.callCount(), kind === "initial denial" || kind === "authority unavailable" ? 0 : 1);
      await f.untouched();
    });
  }
  await t.test("later repository fails without partially materializing earlier downloads", async t => {
    let downloads = 0;
    const failure = new Error("second repository unavailable");
    const f = await boundary(t, { readRepository: async () => {
      if (++downloads === 2) throw failure;
      return archive({ "README.md": "first" });
    } }, binding("two-repositories", [repository(), repository(2)]));
    await assert.rejects(f.session.open(), error => error === failure);
    assert.equal(downloads, 2);
    await f.untouched();
  });
});

test("repository callback bytes must be a nonempty bounded Uint8Array", linux, async t => {
  for (const [name, value] of [
    ["empty", new Uint8Array()], ["oversized", new Uint8Array(repositoryLimits.archiveBytes + 1)],
    ["array buffer", new ArrayBuffer(1)], ["plain array", [1]], ["null", null],
    ["byteLength lookalike", { byteLength: 1 }],
  ] as const) await t.test(name, async t => {
    const f = await boundary(t, { readRepository: async () => value as unknown as Uint8Array });
    await assert.rejects(f.session.open(), runnerError(413, /bound/));
    await f.untouched();
  });
  for (const size of [1, repositoryLimits.archiveBytes]) await t.test(`inclusive boundary ${size}`, async t => {
    const bytes = new Uint8Array(size);
    const f = await boundary(t, { readRepository: async () => bytes });
    await assert.rejects(f.session.open(), error => error === MODEL_BOUNDARY);
    assert.deepEqual(f.counts(), { models: 1, materializations: 1, harness: 0 });
    assert.equal(f.received[0]![0], bytes);
  });
});

test("ready repository caches bypass downloads, but still require live owner authority", linux, async t => {
  for (const allowed of [true, false]) await t.test(`allowed=${allowed}`, async t => {
    let downloads = 0;
    const f = await boundary(t, {
      authorize: async () => ({ allowed, ownerId: OWNER, policyVersion: 1 }),
      readRepository: async () => { downloads++; assert.fail("ready cache must not download"); },
    });
    f.setReady(true);
    await assert.rejects(f.session.open(), allowed ? error => error === MODEL_BOUNDARY : runnerError(403, /Authorization/));
    assert.equal(downloads, 0);
    assert.equal(f.initialize.mock.callCount(), allowed ? 1 : 0);
    assert.deepEqual(f.counts(), { models: allowed ? 1 : 0, materializations: 0, harness: 0 });
  });
});

test("prepareRestore verifies ready caches under manage authority without downloading or opening a harness", linux, async t => {
  for (const ready of [false, true]) await t.test(`ready=${ready}`, async t => {
    const permissions: string[] = [];
    let downloads = 0;
    const f = await boundary(t, {
      authorize: async request => { permissions.push(request.permission); return { allowed: true, ownerId: OWNER, policyVersion: 1 }; },
      readRepository: async () => { downloads++; assert.fail("restore must never redownload repositories"); },
    });
    f.setReady(ready);
    const manifest = { binding: f.session.binding, branches: [], runs: {}, approvals: {}, toolActors: {} };
    await assert.rejects(f.session.prepareRestore(manifest), ready ? error => error === MODEL_BOUNDARY : runnerError(409, /cache is not ready/));
    assert.deepEqual(permissions, ["manage"]);
    assert.equal(downloads, 0);
    assert.deepEqual(f.counts(), { models: ready ? 1 : 0, materializations: 0, harness: 0 });
  });
});

test("revoked restore authority prevents sandbox initialization, downloads, model resolution and harness opening", linux, async t => {
  const f = await boundary(t, {
    authorize: async request => {
      assert.equal(request.permission, "manage");
      return { allowed: false, ownerId: OWNER, policyVersion: 1 };
    },
    readRepository: async () => assert.fail("denied restore must not download"),
  });
  await assert.rejects(f.session.prepareRestore({ binding: f.session.binding, branches: [], runs: {}, approvals: {}, toolActors: {} }), runnerError(403, /Authorization/));
  assert.equal(f.initialize.mock.callCount(), 0);
  await f.untouched();
});

test("legacy repository downloads use only the fixed scoped endpoint with pinned commit and redirect rejection", linux, async t => {
  for (const withLength of [true, false]) await t.test(`content-length=${withLength}`, async t => {
    const bytes = archive({ "README.md": "verified response" });
    let requests = 0;
    const f = await boundary(t, { fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), "https://control.example.test/api/internal/repositories/repo-1/download");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), { sessionId: "boundary", commit: repository().commit });
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      return new Response(Buffer.from(bytes), { headers: {
        "x-repository-commit": repository().commit,
        "x-archive-sha256": createHash("sha256").update(bytes).digest("base64url"),
        ...(withLength ? { "content-length": String(bytes.byteLength) } : {}),
      } });
    } });
    await assert.rejects(f.session.open(), error => error === MODEL_BOUNDARY);
    assert.equal(requests, 1);
    assert.deepEqual(f.received[0]![0], Buffer.from(bytes));
    assert.deepEqual(f.counts(), { models: 1, materializations: 1, harness: 0 });
  });
});

test("legacy repository transport rejects invalid origin, redirect, commit, checksum and size before model/harness", linux, async t => {
  for (const origin of [
    "https://control.example.test/prefix", "https://user:password@control.example.test",
    "https://control.example.test/?token=secret", "https://control.example.test/#fragment",
    "http://control.example.test", "file:///tmp/",
  ]) await t.test(`origin ${origin}`, async t => {
    const f = await boundary(t, { controlPlaneUrl: origin, fetch: async () => assert.fail("invalid origin must not send credentials") });
    await assert.rejects(f.session.open(), runnerError(503, /origin/));
    await f.untouched();
  });

  const bytes = archive({ "README.md": "original bytes" });
  const checksum = createHash("sha256").update(bytes).digest("base64url");
  const cases: Array<{ name: string; status?: number; headers?: Record<string, string | null>; body?: Uint8Array | null; expected: number }> = [
    { name: "denied", status: 403, expected: 403 },
    { name: "redirect", status: 302, headers: { location: "https://attacker.example/archive" }, expected: 403 },
    { name: "missing commit", headers: { "x-repository-commit": null }, expected: 403 },
    { name: "different commit", headers: { "x-repository-commit": "f".repeat(40) }, expected: 403 },
    { name: "missing checksum", headers: { "x-archive-sha256": null }, expected: 403 },
    { name: "hex checksum", headers: { "x-archive-sha256": createHash("sha256").update(bytes).digest("hex") }, expected: 403 },
    { name: "padded checksum", headers: { "x-archive-sha256": checksum + "=" }, expected: 403 },
    { name: "noncanonical checksum", headers: { "x-archive-sha256": "A".repeat(42) + "B" }, expected: 403 },
    { name: "checksum mismatch", headers: { "x-archive-sha256": createHash("sha256").update("different").digest("base64url") }, expected: 400 },
    { name: "negative length", headers: { "content-length": "-1" }, expected: 403 },
    { name: "fractional length", headers: { "content-length": "1.5" }, expected: 403 },
    { name: "exponent length", headers: { "content-length": "1e2" }, expected: 403 },
    { name: "oversized declared length", headers: { "content-length": String(repositoryLimits.archiveBytes + 1) }, expected: 403 },
    { name: "truncated body", headers: { "content-length": String(bytes.byteLength + 1) }, expected: 400 },
    { name: "longer than declared", headers: { "content-length": String(bytes.byteLength - 1) }, expected: 400 },
    { name: "absent body", body: null, expected: 403 },
    { name: "empty body", body: new Uint8Array(), headers: { "content-length": "0" }, expected: 400 },
    { name: "stream exceeds bound without length", body: new Uint8Array(repositoryLimits.archiveBytes + 1), headers: { "content-length": null }, expected: 413 },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    let requests = 0;
    const f = await boundary(t, { fetch: async (_url, init) => {
      requests++;
      assert.equal(init?.redirect, "error");
      const headers = new Headers({ "x-repository-commit": repository().commit, "x-archive-sha256": checksum, "content-length": String(bytes.byteLength) });
      for (const [key, value] of Object.entries(item.headers ?? {})) {
        if (value === null) headers.delete(key); else headers.set(key, value);
      }
      const body = item.body === undefined ? bytes : item.body;
      return new Response(body === null ? null : Buffer.from(body), { status: item.status ?? 200, headers });
    } });
    await assert.rejects(f.session.open(), runnerError(item.expected, /Repository/));
    assert.equal(requests, 1, "redirects and failed downloads are never retried");
    await f.untouched();
  });
});

test("connected repositories require their scoped callback instead of falling back to legacy fetch", linux, async t => {
  const input = binding("connected");
  input.session.connectorId = "connector-1";
  input.model.connectorId = "connector-1";
  const f = await boundary(t, {
    connectorId: "connector-1",
    fetch: async () => assert.fail("connected repository download must not use legacy shared-secret transport"),
  }, input);
  await assert.rejects(f.session.open(), runnerError(503, /scoped callback/));
  await f.untouched();
});

test("real repository backup/restore preserves the protected ready marker and edited worktree without redownloading", linux, async t => {
  const root = await directory(t);
  const sourceBinding = binding("backup-source", [repository(), repository(2)]);
  let downloads = 0;
  const sourceService = new RunnerService(config(join(root, "source"), {
    readRepository: async pin => { downloads++; return archive({ "README.md": `original ${pin.repositoryId}`, "remove.txt": "baseline" }); },
  }));
  t.after(() => sourceService.close());
  await sourceService.initialize();
  const source = await sourceService.provision(sourceBinding, await ticket(sourceBinding.session.id, "create"));
  await source.sandbox.writeFile("acme/project-1/README.md", "edited before backup", allow);
  await source.sandbox.writeFile("acme/project-2/new.txt", "untracked before backup", allow);
  const markerPath = "git/repository-cache.json";
  const markerBytes = await readFile(join(source.directory, "sandbox", markerPath));
  const marker = JSON.parse(markerBytes.toString());
  assert.equal(marker.status, "ready");
  assert.deepEqual(marker.repositories, sourceBinding.session.repositories);
  const backup = await source.backup(await ticket(sourceBinding.session.id, "backup"));
  assert.equal(downloads, 2, "backup's reopen uses ready repositories");
  assert.deepEqual(backup.binding.session.repositories, sourceBinding.session.repositories);
  const savedMarker = backup.files.find(file => file.path === markerPath);
  assert.ok(savedMarker, "protected cache marker is included in sandbox backup");
  assert.deepEqual(Buffer.from(savedMarker.data, "base64"), markerBytes);
  const text = JSON.stringify(backup);
  const bytes = new TextEncoder().encode(text);
  const descriptor: RestoreDescriptor = {
    id: "repository-restore", sourceSessionId: sourceBinding.session.id, backupId: "repository-backup",
    sha256: await sha256(text), size: bytes.byteLength, downloadToken: "scoped-backup-capability",
  };
  const target = binding("backup-target", structuredClone(sourceBinding.session.repositories!));
  const permissions: string[] = [];
  let backupDownloads = 0;
  let repositoryDownloads = 0;
  const targetConfig = config(join(root, "target"), {
    authorize: async request => {
      permissions.push(request.permission);
      return { allowed: true, ownerId: OWNER, policyVersion: 1 };
    },
    readRepository: async () => { repositoryDownloads++; assert.fail("restore/get must preserve cached worktree, never redownload"); },
    readBackup: async (requested, sessionId) => {
      assert.deepEqual(requested, descriptor);
      assert.equal(sessionId, target.session.id);
      backupDownloads++;
      return bytes;
    },
  });
  let targetService = new RunnerService(targetConfig);
  t.after(() => targetService.close());
  await targetService.initialize();
  const restoredBinding = await targetService.restore({ binding: target, restore: descriptor }, await ticket(target.session.id, "restore"));
  assert.deepEqual(restoredBinding.session.repositories, sourceBinding.session.repositories);
  assert.ok(permissions.length >= 3);
  assert.ok(permissions.every(permission => permission === "manage"), "staged verification uses restore authority");
  const restored = await targetService.get(target.session.id);
  assert.equal(await restored.sandbox.repositoryCachesReady(target.session.repositories!, allow), true);
  assert.deepEqual(await readFile(join(restored.directory, "sandbox", markerPath)), markerBytes);
  assert.equal(await restored.sandbox.readFile("acme/project-1/README.md", allow), "edited before backup");
  assert.equal(await restored.sandbox.readFile("acme/project-2/README.md", allow), "original 2");
  assert.equal(await restored.sandbox.readFile("acme/project-2/new.txt", allow), "untracked before backup");
  assert.equal((await restored.view()).busy, false);
  await restored.sandbox.writeFile("acme/project-1/README.md", "edited after restore", allow);
  await targetService.close();
  targetService = new RunnerService(targetConfig);
  await targetService.initialize();
  await targetService.restore({ binding: target, restore: descriptor }, await ticket(target.session.id, "restore"));
  const reopened = await targetService.get(target.session.id);
  assert.equal(await reopened.sandbox.readFile("acme/project-1/README.md", allow), "edited after restore");
  assert.equal(await reopened.sandbox.readFile("acme/project-2/new.txt", allow), "untracked before backup");
  assert.deepEqual(await readFile(join(reopened.directory, "sandbox", markerPath)), markerBytes);
  assert.equal(await reopened.sandbox.repositoryCachesReady(target.session.repositories!, allow), true);
  assert.equal(await source.sandbox.readFile("acme/project-1/README.md", allow), "edited before backup");
  assert.deepEqual(await readFile(join(source.directory, "sandbox", markerPath)), markerBytes);
  assert.equal(backupDownloads, 1);
  assert.equal(repositoryDownloads, 0);
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
  assert.deepEqual(Object.keys(repositoryPins([pins[1]!])[0]!).sort(), ["bindingId", "commit", "fullName", "host", "path", "provider", "ref", "repositoryId"]);
  assert.deepEqual(repositoryPins(pins).map(pin => pin.path), pins.map(pin => pin.path).sort());
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
    assert.throws(() => repositoryPins(value as SessionRepository[]));
  });
  for (const [name, second] of [
    ["provider repository id", providerPin({ bindingId: "other", fullName: "group/other" })],
    ["binding id", providerPin({ repositoryId: "5", fullName: "group/other" })],
    ["case-insensitive path", providerPin({ bindingId: "other", repositoryId: "5", fullName: "GROUP/SUB/PROJECT" })],
  ] as const) await t.test(`duplicate ${name}`, () => {
    assert.throws(() => validateRepositories([pin, second]), runnerError(400, /Duplicate/));
    assert.throws(() => repositoryPins([pin, second]), /duplicate/);
  });
  assert.equal(validateRepositories([pin, providerPin({ bindingId: "other", host: "gitlab.com", fullName: "group/other" })]).length, 2, "same id on another host is distinct");
  assert.equal(validateRepositories([repository(), providerPin({ repositoryId: String(repository().repositoryId) })]).length, 2, "GitHub and provider ids never collide");
});

// Cache hosts in host mode: no bwrap needed, only Git.
const cacheHost = { skip: !["linux", "darwin"].includes(process.platform) || spawnSync("git", ["--version"]).status !== 0, timeout: 60_000 };
const UPSTREAM_AUTH = "Basic cGlzdGVhZDp0b2tlbg==";

function upstreamGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Upstream", GIT_AUTHOR_EMAIL: "upstream@example.test",
    GIT_COMMITTER_NAME: "Upstream", GIT_COMMITTER_EMAIL: "upstream@example.test", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("cache hosts return from create at once, hold runs until the pins are fetched and checked out, and expose history", cacheHost, async t => {
  const root = await directory(t);
  const work = join(root, "upstream");
  upstreamGit(root, ["init", "-q", "-b", "main", work]);
  await writeFile(join(work, "README.md"), "hello from upstream\n");
  upstreamGit(work, ["add", "."]);
  upstreamGit(work, ["commit", "-q", "-m", "first"]);
  await writeFile(join(work, "NOTES.md"), "notes\n");
  upstreamGit(work, ["add", "."]);
  upstreamGit(work, ["commit", "-q", "-m", "second"]);
  const served = join(root, "served");
  upstreamGit(root, ["clone", "-q", "--bare", work, join(served, "acme", "project-1.git")]);
  const server = await startGitHttpServer(served, { authorization: UPSTREAM_AUTH });
  t.after(() => server.close());
  // github.com remotes go to the local server; the second upload-pack POST (the pack itself) waits for the gate.
  const gate = Promise.withResolvers<void>();
  const packRequested = Promise.withResolvers<void>();
  let posts = 0;
  const cache = new RepositoryCache({ root: join(root, "repo-cache"), authorization: async () => UPSTREAM_AUTH, fetch: async (input, init) => {
    if (init?.method === "POST" && ++posts === 2) { packRequested.resolve(); await gate.promise; }
    return fetch(String(input).replace(/^https:\/\/github\.com\//, server.url("")), init);
  } });
  const pin: GitHubSessionRepository = { ...repository(), commit: upstreamGit(work, ["rev-parse", "HEAD"]) };
  const input = binding("cache-host", [pin]);
  let authorizations = 0;
  const reported: SessionActivity[] = [];
  const events: string[] = [];
  observeHarness(t, events, () => {});
  const service = new RunnerService(config(root, {
    unsandboxed: true, repositoryCache: cache,
    authorizeRepository: async (repository, sessionId) => {
      authorizations++;
      assert.equal(sessionId, input.session.id);
      return { bindingId: repository.bindingId, commit: repository.commit, remote: repositoryRemote(repository) };
    },
    reportActivity: async (sessionId, activity) => { assert.equal(sessionId, input.session.id); reported.push(activity); },
    readRepository: async () => assert.fail("cache hosts never download archives"),
  }));
  t.after(async () => { gate.resolve(); await service.close(); });
  await service.initialize();
  const session = await service.provision(input, await ticket(input.session.id, "create"));
  // create returned while the clone is still waiting for its pack.
  await packRequested.promise;
  assert.equal(await session.sandbox.repositoryCacheState([pin], allow), "absent");
  assert.ok(events.includes("harness") && !events.includes("resume"), "the harness stays paused while repositories are prepared");
  const preparing = await session.view();
  assert.equal(preparing.busy, true, "preparation keeps the session busy");
  assert.deepEqual(preparing.repositories, { status: "preparing", items: [{ path: pin.path, phase: "connecting", percent: null, done: null, total: null, bytes: 0 }] });
  assert.equal(preparing.activity, "working", "session lists show a session preparing its repositories in progress");
  // Its host reports that too, while the preparation still holds the session's work.
  for (let attempt = 0; attempt < 100 && !reported.length; attempt++) await delay(20);
  assert.deepEqual(reported, ["working"]);
  const receipt = await session.submit(await ticket(input.session.id, "submit"), { content: "TEST_READ acme/project-1/README.md", requestId: "read-from-cache" }, "write");
  assert.equal(receipt.status, "queued");
  gate.resolve();
  await idle(session);
  const view = await session.view();
  assert.equal(view.queue?.find(run => run.submissionId === receipt.submissionId)?.status, "settled");
  assert.ok(view.entries.some(entry => entry.role === "toolResult" && entry.text.includes("hello from upstream")), "the held run reads the checked-out file");
  assert.equal(await session.sandbox.repositoryCacheState([pin], allow), "cache");
  assert.equal(view.repositories, undefined, "a ready session reports no preparation");
  assert.equal(view.activity, "done", "once ready, the session's messages say what it is doing");
  assert.equal(events.filter(event => event === "resume").length, 1, "work resumes once, when the repositories are ready");
  assert.equal(authorizations, 1);
  await assert.rejects(session.backup(await ticket(input.session.id, "backup")), /host repository cache are not supported yet/);
  assert.equal((await session.sandbox.execute({ kind: "bash", command: "git rev-list --count acme/project-1/pinned" }, false, allow)).trim(), "2");
});

test("a cache host that cannot prepare a repository refuses new messages with the reason until the session restarts", cacheHost, async t => {
  const root = await directory(t);
  const cache = new RepositoryCache({ root: join(root, "repo-cache"), authorization: async () => assert.fail("nothing is fetched without authorization") });
  const input = binding("cache-denied");
  const reported: SessionActivity[] = [];
  const service = new RunnerService(config(root, {
    unsandboxed: true, repositoryCache: cache,
    authorizeRepository: async () => { throw new RunnerError(403, "The pinned commit is no longer readable in this GitHub repository."); },
    readRepository: async () => assert.fail("cache hosts never download archives"),
    reportActivity: async (_sessionId, activity) => { reported.push(activity); },
  }));
  t.after(() => service.close());
  await service.initialize();
  const session = await service.provision(input, await ticket(input.session.id, "create"));
  let refusal: unknown;
  for (let attempt = 0; attempt < 100 && !refusal; attempt++) {
    await delay(20);
    await session.submit(await ticket(input.session.id, "submit"), { content: "TEST_IDENTITY", requestId: `attempt-${attempt}` }, "write")
      .catch((error: unknown) => { refusal = error; });
  }
  assert.ok(refusal instanceof RunnerError);
  assert.equal(refusal.status, 502);
  assert.equal(refusal.message, "The pinned commit is no longer readable in this GitHub repository. Restart the session to try again.");
  assert.equal(await session.sandbox.repositoryCacheState(input.session.repositories!, allow), "absent");
  const view = await session.view();
  assert.deepEqual(view.repositories, { status: "failed", error: "The pinned commit is no longer readable in this GitHub repository.",
    items: [{ path: input.session.repositories![0]!.path, phase: "authorizing", percent: null, done: null, total: null, bytes: 0 }] });
  assert.equal(view.activity, "failed", "session lists show the failure, not a session still in progress");
  for (let attempt = 0; attempt < 100 && reported.at(-1) !== "failed"; attempt++) await delay(20);
  assert.equal(reported.at(-1), "failed", "its host reports the failure while the session holds its work");
});

test("archive-backed sessions on a cache host are not re-authorized against the cache and never see it", linux, async t => {
  const root = await directory(t);
  const cache = new RepositoryCache({ root: join(root, "repo-cache"), authorization: async () => assert.fail("nothing is fetched") });
  const session = new RunnerSession(binding("archive-on-cache"), root, config(root, {
    repositoryCache: cache,
    authorizeRepository: async () => assert.fail("archive sessions are not re-authorized for the cache"),
    readRepository: async () => assert.fail("a ready archive session downloads nothing"),
    resolveModels: async () => { throw MODEL_BOUNDARY; },
  }));
  t.mock.method(session.sandbox, "initialize", async () => {});
  t.mock.method(session.sandbox, "repositoryCacheState", async () => "archive");
  const enable = t.mock.method(session.sandbox, "enableRepositoryCache", () => {});
  t.after(() => session.sandbox.close());
  await assert.rejects(session.open(), error => error === MODEL_BOUNDARY);
  assert.equal(enable.mock.callCount(), 0);
});

test("a cache-backed session sees the cache only after this open re-authorized and ensured every pin", linux, async t => {
  const root = await directory(t);
  const cache = new RepositoryCache({ root: join(root, "repo-cache"), authorization: async () => assert.fail("nothing is fetched") });
  const order: string[] = [];
  const session = new RunnerSession(binding("cache-reopen", [repository(), repository(2)]), root, config(root, {
    repositoryCache: cache,
    authorizeRepository: async pin => {
      order.push(`authorize ${pin.path}`);
      return { bindingId: pin.bindingId, commit: pin.commit, remote: repositoryRemote(pin) };
    },
    resolveModels: async () => { throw MODEL_BOUNDARY; },
  }));
  t.mock.method(session.sandbox, "initialize", async () => {});
  t.mock.method(session.sandbox, "repositoryCacheState", async () => "cache");
  t.mock.method(cache, "ensure", async (target: { pin: SessionRepository }) => { order.push(`ensure ${target.pin.path}`); return { objects: "", fetched: false }; });
  const enabled = Promise.withResolvers<void>();
  t.mock.method(session.sandbox, "enableRepositoryCache", () => { order.push("enable"); enabled.resolve(); });
  t.after(() => session.sandbox.close());
  // open() stops at the model sentinel; the preparation it started continues in the background.
  await assert.rejects(session.open(), error => error === MODEL_BOUNDARY);
  await enabled.promise;
  assert.deepEqual(order, ["authorize acme/project-1", "ensure acme/project-1", "authorize acme/project-2", "ensure acme/project-2", "enable"]);
});
