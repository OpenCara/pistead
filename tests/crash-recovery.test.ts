import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sha256, signToken } from "../packages/shared/src/crypto.js";
import type { AuthorizationRequest, RunnerAction, RunnerBinding, RunnerTicket, SessionView, SubmitInput, SubmitResult } from "../packages/shared/src/types.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const heldText = "Deterministic test provider held for 5000ms.";

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
type RunnerChild = {
  process: ChildProcess;
  exited: Promise<Exit>;
  output: () => string;
  ready: Promise<string>;
};

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  // Real child processes and sockets cannot share the test runner's fake clock.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isolationUnavailable(directory: string): string | undefined {
  const descriptor = openSync(directory, "r");
  try {
    // Exercise the actual namespace and fd-mount features, not just `which bwrap`.
    const probe = spawnSync("/usr/bin/bwrap", [
      "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
      "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
      "--proc", "/proc", "--dev", "/dev", "--ro-bind-fd", "3", "/probe",
      "--remount-ro", "/proc", "--remount-ro", "/", "--chdir", "/probe", "--clearenv",
      "--", "/usr/bin/python3", "-I", "-c",
      "import json, os; print(json.dumps({name: os.readlink('/proc/self/ns/' + name) for name in ('net', 'user')}))",
    ], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe", descriptor], encoding: "utf8",
      timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
    });
    if (probe.error || probe.status !== 0 || probe.signal) {
      return `Linux bubblewrap isolation unavailable: ${probe.error?.message ?? probe.stderr?.trim() ?? probe.signal ?? `exit ${probe.status}`}`;
    }
    const namespaces = JSON.parse(probe.stdout) as { net: string; user: string };
    if (namespaces.net === readlinkSync("/proc/self/ns/net") || namespaces.user === readlinkSync("/proc/self/ns/user")) {
      return "Bubblewrap did not create private network and user namespaces";
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

function launchRunner(dataDir: string, controlPlaneUrl: string, secret: string, home: string): RunnerChild {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/index.ts"], {
    cwd: repository,
    // Never inherit developer credentials, NODE_OPTIONS, proxies, or provider configuration.
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home,
      LANG: "C.UTF-8", TZ: "UTC", NODE_ENV: "test",
      PORT: "0", RUNNER_HOST: "127.0.0.1", DATA_DIR: dataDir,
      CONTROL_PLANE_URL: controlPlaneUrl, RUNNER_SHARED_SECRET: secret, ALLOW_FAUX_MODEL: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", error => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<string>((resolve, reject) => {
    const capture = (chunk: Uint8Array) => {
      output = (output + new TextDecoder().decode(chunk)).slice(-64 * 1024);
      const match = /pi-durable runner listening on 127\.0\.0\.1:(\d+);/.exec(output);
      if (match && Number(match[1]) > 0) resolve(`http://127.0.0.1:${match[1]}`);
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    void exited.then(exit => reject(new Error(`Runner exited before readiness: ${JSON.stringify(exit)}\n${output}`)));
  });
  return { process: child, exited, ready, output: () => output };
}

async function stopRunner(runner: RunnerChild): Promise<void> {
  if (runner.process.exitCode !== null || runner.process.signalCode !== null || !runner.process.pid) return;
  runner.process.kill("SIGTERM");
  try {
    await bounded(runner.exited, 3000, "Runner did not stop gracefully during cleanup");
  } catch {
    runner.process.kill("SIGKILL");
    await bounded(runner.exited, 5000, "Runner did not exit after cleanup SIGKILL");
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function fixture(): RunnerBinding {
  const createdAt = new Date().toISOString();
  return {
    session: {
      id: randomUUID(), workspaceId: "crash-workspace", ownerId: "crash-owner",
      agentVersionId: "crash-agent-v1", title: "Actual process crash recovery", policyVersion: 1,
      status: "ready", createdAt,
    },
    owner: {
      id: "crash-owner", githubId: null, githubLogin: "fake-crash-owner", displayName: "Crash Owner",
      gitName: "Crash Owner", gitEmail: "owner@example.invalid", githubConnected: false,
      env: { APP_PRIVATE_CRASH_MARKER: randomUUID() },
    },
    agent: {
      id: "crash-agent-v1", agentId: "crash-agent", authorId: "different-agent-author",
      workspaceId: "crash-workspace", version: 1, name: "Crash recovery faux agent",
      description: "Deterministic test only", instructions: "Use deterministic test commands.",
      tools: ["identity", "read_file", "write_file"], modelId: "crash-model", createdAt,
    },
    model: { id: "crash-model", workspaceId: "crash-workspace", name: "Faux (not an LLM)", provider: "faux", modelId: "crash-faux" },
  };
}

function identityResult(view: SessionView): Record<string, unknown> {
  for (const entry of [...view.entries].reverse()) {
    if (entry.role !== "toolResult") continue;
    try {
      const value: unknown = JSON.parse(entry.text);
      if (value && typeof value === "object" && "ownerId" in value) return value as Record<string, unknown>;
    } catch { /* Other tool results are not identity records. */ }
  }
  assert.fail(`Missing actual identity tool result: ${JSON.stringify(view.entries)}`);
}

test("SIGKILL runner reopens pi SQLite, resumes pending generation, and preserves owner and submission identity", { timeout: 90_000 }, async t => {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    t.skip("Actual runner/SQLite recovery requires Node 24 or newer via process.execPath");
    return;
  }
  if (process.platform !== "linux") {
    t.skip("Actual runner sandbox requires Linux bubblewrap isolation");
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "runner-crash-"));
  const children: RunnerChild[] = [];
  const binding = fixture();
  const collaborator = "crash-collaborator";
  const secret = randomUUID() + randomUUID();
  const authorizations: AuthorizationRequest[] = [];
  const unexpectedRequests: string[] = [];
  let authorizationUnavailable = false;
  const controlPlane = createServer((request, response) => {
    void (async () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method !== "POST" || request.url !== "/api/internal/authorize"
        || request.headers.authorization !== `Bearer ${secret}`) {
        unexpectedRequests.push(`${request.method} ${request.url}`);
        response.writeHead(403).end(JSON.stringify({ error: "Unexpected control-plane request" }));
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 16 * 1024) throw new Error("Authorization body too large");
      }
      const input = JSON.parse(body) as AuthorizationRequest;
      authorizations.push(input);
      if (authorizationUnavailable) {
        response.writeHead(503).end(JSON.stringify({ error: "Simulated policy authority outage" }));
        return;
      }
      const allowed = input.sessionId === binding.session.id && input.ownerId === binding.owner.id
        && [binding.owner.id, collaborator].includes(input.actorId) && ["read", "write"].includes(input.permission);
      response.end(JSON.stringify({ allowed, policyVersion: 1, ownerId: binding.owner.id }));
    })().catch(error => {
      unexpectedRequests.push(String(error));
      if (!response.headersSent) response.writeHead(400);
      response.end(JSON.stringify({ error: "Invalid authorization request" }));
    });
  });
  controlPlane.requestTimeout = 5000;
  let active: RunnerChild | undefined;
  try {
    const unsupported = isolationUnavailable(temporary);
    if (unsupported) {
      t.skip(unsupported.slice(0, 1000));
      return;
    }
    const controlPlaneUrl = await listen(controlPlane);
    const dataDir = join(temporary, "data");
    const start = async () => {
      const runner = launchRunner(dataDir, controlPlaneUrl, secret, temporary);
      children.push(runner);
      active = runner;
      return bounded(runner.ready, 15_000, `Runner startup timed out: ${runner.output()}`);
    };
    let baseUrl = await start();
    const fetchLocal = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
      ...init, redirect: "error", signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]),
    });
    const health = await fetchLocal("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, runtime: "node24", execution: "pi-durable", faux: true });

    const request = async (action: RunnerAction, value?: unknown, actorId = collaborator) => {
      const body = value === undefined ? "" : JSON.stringify(value);
      const iat = Math.floor(Date.now() / 1000);
      const ticket: RunnerTicket = {
        aud: "runner", sessionId: binding.session.id, ownerId: binding.owner.id, actorId,
        action, policyVersion: 1, iat, exp: iat + 60, jti: randomUUID(), bodyHash: await sha256(body),
      };
      const path = action === "create" ? "/v1/sessions" : `/v1/sessions/${binding.session.id}/${action}`;
      const response = await fetchLocal(path, {
        method: action === "view" ? "GET" : "POST",
        headers: { Authorization: `Bearer ${await signToken(ticket, secret)}`, "Content-Type": "application/json" },
        ...(action === "view" ? {} : { body }),
      });
      const text = await response.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { assert.fail(`Non-JSON ${action} response (${response.status}): ${text}`); }
      return { status: response.status, json };
    };
    const view = async (): Promise<SessionView> => {
      const response = await request("view");
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const result = (response.json as { view: SessionView }).view;
      assert.ok(result && Array.isArray(result.entries));
      return result;
    };
    const waitForView = async (description: string, predicate: (value: SessionView) => boolean, timeout = 15_000) => {
      const deadline = Date.now() + timeout;
      let last: SessionView | undefined;
      do {
        t.signal.throwIfAborted();
        assert.ok(active && active.process.exitCode === null && active.process.signalCode === null, `Runner exited: ${active?.output()}`);
        last = await view();
        if (predicate(last)) return last;
        // Bounded HTTP polling observes the separate process; no guessed hold-start sleep.
        await delay(40, undefined, { signal: t.signal });
      } while (Date.now() < deadline);
      assert.fail(`${description}; last view=${JSON.stringify(last)}\n${active?.output()}`);
    };
    const submit = async (input: SubmitInput): Promise<SubmitResult> => {
      const response = await request("submit", input);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const result = response.json as SubmitResult;
      assert.equal(typeof result.submissionId, "string");
      assert.equal(typeof result.conversationId, "string");
      assert.ok(result.submissionId && result.conversationId);
      return result;
    };
    const assertDedup = async (input: SubmitInput, original: SubmitResult) => {
      const before = await view();
      const duplicate = await submit(input);
      assert.equal(duplicate.submissionId, original.submissionId, "Durable submission ID must not change on retry");
      assert.equal(duplicate.conversationId, original.conversationId);
      assert.equal(duplicate.status, "settled", "Persisted runner receipt must reconcile with the completed pi submission, not remain running/admitting");
      const conflict = await request("submit", { ...input, content: `${input.content}\nconflicting-content` });
      assert.equal(conflict.status, 409, "Persisted dedup key must reject a different body after restart");
      const after = await view();
      assert.equal(after.busy, false);
      assert.deepEqual(after.entries, before.entries, "Retry or conflict must not append/reexecute a submission");
      assert.equal(after.entries.filter(entry => entry.role === "user" && entry.text === input.content).length, 1);
    };

    const provisioned = await request("create", binding, binding.owner.id);
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.json));
    const unauthenticated = await fetchLocal(`/v1/sessions/${binding.session.id}/view`);
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();
    authorizationUnavailable = true;
    const beforeOutageAuthorizations = authorizations.length;
    const unavailable = await request("submit", { requestId: "denied-during-outage", content: "TEST_HOLD 1" });
    assert.ok([403, 503].includes(unavailable.status), "A valid signed ticket must fail closed when live policy authority is unavailable");
    assert.ok(authorizations.slice(beforeOutageAuthorizations).some(input =>
      input.actorId === collaborator && input.permission === "write" && input.sessionId === binding.session.id),
    "Rejection must follow an actual live authorization callback, not unrelated request validation");
    authorizationUnavailable = false;
    assert.equal((await view()).entries.some(entry => entry.text === "TEST_HOLD 1"), false);

    const identityInput = { requestId: randomUUID(), content: "TEST_IDENTITY" };
    const identityReceipt = await submit(identityInput);
    const identityView = await waitForView("Identity generation did not settle", value => !value.busy);
    const ownerIdentity = identityResult(identityView);
    assert.equal(ownerIdentity.ownerId, binding.owner.id);
    assert.equal(ownerIdentity.actingAs, binding.owner.id);
    assert.equal(ownerIdentity.initiatedBy, collaborator);
    assert.equal(ownerIdentity.gitName, binding.owner.gitName);
    assert.equal(ownerIdentity.gitEmail, binding.owner.gitEmail);
    assert.equal(ownerIdentity.githubLogin, binding.owner.githubLogin);
    assert.deepEqual(ownerIdentity.env, binding.owner.env);
    assert.match(String(ownerIdentity.home), /^\/sessions\/[^/]+\/home$/);
    assert.match(String(ownerIdentity.worktree), /^\/sessions\/[^/]+\/worktree$/);
    assert.notEqual(ownerIdentity.home, temporary);

    const fileContent = `private owner workspace ${randomUUID()}`;
    const writeInput = { requestId: randomUUID(), content: `TEST_WRITE crash-marker.txt\n${fileContent}` };
    const writeReceipt = await submit(writeInput);
    const baseline = await waitForView("Baseline write did not settle", value => !value.busy);
    assert.ok(baseline.entries.some(entry => entry.role === "toolResult" && entry.text.includes('"written":"crash-marker.txt"')));

    const holdInput = { requestId: randomUUID(), content: "TEST_HOLD 5000" };
    const holdReceipt = await submit(holdInput);
    assert.ok(["queued", "running"].includes(holdReceipt.status), "The durable receipt may precede model activation");
    const pending = await waitForView("Hold was not placed in the persisted pi transcript", value =>
      value.busy && value.entries.some(entry => entry.role === "user" && entry.text === holdInput.content), 3000);
    assert.equal(pending.entries.some(entry => entry.role === "assistant" && entry.text === heldText), false);
    const beforeCrashAuthorizations = authorizations.length;
    const crashed = active!;
    assert.ok(crashed.process.pid);
    assert.equal(crashed.process.kill("SIGKILL"), true, "Only the test's runner child is killed");
    const crashExit = await bounded(crashed.exited, 5000, "Crashed runner was not reaped");
    assert.equal(crashExit.error, undefined);
    assert.equal(crashExit.code, null);
    assert.equal(crashExit.signal, "SIGKILL", "A graceful restart is not a crash test");

    const sqlitePath = join(dataDir, "sessions", binding.session.id, "session.sqlite");
    const sqliteBytes = await readFile(sqlitePath);
    assert.equal(new TextDecoder().decode(sqliteBytes.subarray(0, 16)), "SQLite format 3\0");
    // Open read-only: do not checkpoint, repair, or rewrite the crashed pi store before restart.
    // Conditional platform import lets older Node installations report the explicit skip above.
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      assert.deepEqual(database.prepare("PRAGMA quick_check").all().map(row => Object.values(row)[0]), ["ok"]);
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length > 0);
    } finally {
      database.close();
    }

    baseUrl = await start();
    assert.notEqual(active!.process.pid, crashed.process.pid);
    // GET lazily opens the saved Harness. No resubmit or graceful restart endpoint may drive recovery.
    const recovered = await waitForView("Pending replay-safe generation failed to resume/reconcile after SIGKILL", value =>
      !value.busy && value.entries.some(entry => entry.role === "assistant" && entry.text === heldText));
    assert.deepEqual(recovered.owner, baseline.owner);
    assert.equal(recovered.owner.id, binding.owner.id);
    for (const entry of baseline.entries) {
      assert.deepEqual(recovered.entries.find(saved => saved.id === entry.id), entry, "Previously committed transcript must survive exactly");
    }
    const pendingInput = pending.entries.find(entry => entry.role === "user" && entry.text === holdInput.content)!;
    assert.deepEqual(recovered.entries.find(entry => entry.id === pendingInput.id), pendingInput, "The in-flight committed user entry must retain its original identity");
    assert.equal(recovered.entries.filter(entry => entry.role === "assistant" && entry.text === heldText).length, 1);
    assert.ok(authorizations.slice(beforeCrashAuthorizations).some(input => input.actorId === collaborator && input.permission === "write"), "Recovery must reauthorize the original initiating collaborator");
    await assertDedup(holdInput, holdReceipt);
    await assertDedup(identityInput, identityReceipt);
    await assertDedup(writeInput, writeReceipt);

    const readInput = { requestId: randomUUID(), content: "TEST_READ crash-marker.txt" };
    await submit(readInput);
    const readView = await waitForView("Reopened owner worktree could not be read", value => !value.busy);
    assert.ok(readView.entries.some(entry => entry.role === "toolResult" && entry.text.includes(fileContent)), "Actual sandbox file must persist independently of transcript");
    await submit({ requestId: randomUUID(), content: "TEST_IDENTITY" });
    const finalView = await waitForView("Reopened identity generation did not settle", value => !value.busy);
    assert.deepEqual(identityResult(finalView), ownerIdentity, "Owner identity, private environment, HOME and worktree must survive a collaborator's crash/reopen");
    assert.deepEqual(unexpectedRequests, [], "No GitHub/model/other control-plane calls are expected");
  } catch (error) {
    for (const runner of children) t.diagnostic(`Runner ${runner.process.pid ?? "unspawned"}:\n${runner.output()}`);
    throw error;
  } finally {
    const stopped = await Promise.allSettled(children.map(stopRunner));
    try {
      await closeServer(controlPlane);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    for (const result of stopped) if (result.status === "rejected") throw result.reason;
  }
});
