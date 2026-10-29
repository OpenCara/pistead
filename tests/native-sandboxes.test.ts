import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { assertConnectorPlatform } from "../apps/runner/src/connect-setup.js";
import { EgressProxy, egressEnvironment, type EgressEndpoint } from "../apps/runner/src/egress.js";
import { egressPort, HelperWorkspace, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "../apps/runner/src/helper-workspace.js";
import { NODE_HELPER, NODE_HELPER_KINDS } from "../apps/runner/src/node-helper.js";
import { HELPER, type SandboxRequest } from "../apps/runner/src/sandbox.js";
import { validWindowsLimits } from "../apps/runner/src/sandbox-backend.js";
import { SeatbeltBackend, seatbeltProfile } from "../apps/runner/src/seatbelt.js";
import { WINDOWS_RUNNER, WINDOWS_SUPPORT_CHECK, WindowsBackend, windowsSandboxSupport } from "../apps/runner/src/windows-sandbox.js";
import type { EgressGrant } from "../packages/shared/src/network.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

// The macOS and Windows sandboxes can only run on those platforms. What runs anywhere is tested here: the egress
// proxy's loopback mode, the workspace layer with both helpers run unconfined (the Python helper as macOS runs it, the
// Node helper as Windows does), the Seatbelt profile, and the Windows scripts' syntax.

const allow = async () => {};
const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path))!;
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const posix = process.platform !== "win32" && !!git && !!bash;

function binding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "Native", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner", gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:alice", workspaceId: "workspace", version: 1, name: "Agent", description: "", instructions: "Use tools.", tools: ["read_file", "write_file", "bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Model", provider: "openai", modelId: "local" },
  };
}

/** A backend that runs a helper with no boundary at all: the workspace layer and the helper's own logic, nothing else. */
class Unconfined implements HelperBackend {
  readonly path = "/usr/bin:/bin";
  readonly launched: { request: SandboxRequest; context: HelperContext }[] = [];
  constructor(readonly name: string, readonly limitedShell: boolean, readonly helper: "python" | "node") {}
  supports(kind: SandboxRequest["kind"]): boolean { return this.helper === "python" || NODE_HELPER_KINDS.has(kind); }
  async prepare(layout: HelperLayout): Promise<void> {
    if (this.helper === "node") await writeFile(join(layout.bin, "helper.mjs"), NODE_HELPER, { mode: 0o400 }).catch(() => undefined);
  }
  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    this.launched.push({ request, context });
    const env = { ...context.environment, SANDBOX_GITDIR: layout.git, SANDBOX_GIT: git, SANDBOX_BASH: bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig };
    return this.helper === "python"
      ? { command: python, args: ["-I", "-c", HELPER], env, cwd: layout.worktree }
      : { command: process.execPath, args: [join(layout.bin, "helper.mjs")], env, cwd: layout.worktree };
  }
}

async function workspace(t: TestContext, backend: HelperBackend): Promise<HelperWorkspace> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "native-")));
  const instance = new HelperWorkspace(binding(`native-${backend.name}`), join(directory, "sandbox"), backend);
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  await instance.initialize();
  return instance;
}

for (const helper of ["python", "node"] as const) {
  const label = helper === "python" ? "the Python helper as macOS runs it" : "the Node helper as Windows runs it";

  test(`${label}: a separate Git directory, file tools confined to the worktree, and .git protected`, { skip: !posix || (helper === "python" && !python) }, async t => {
    const sandbox = await workspace(t, new Unconfined(helper, true, helper));
    const { git: gitDir, worktree } = sandbox.layout;
    assert.equal(await readFile(join(worktree, ".git"), "utf8"), `gitdir: ${gitDir}\n`);
    assert.ok(existsSync(join(gitDir, "HEAD")), "the session's repository is in its own Git directory");
    await sandbox.writeFile("notes/plan.md", "inside", allow);
    assert.equal(await sandbox.readFile("notes/plan.md", allow), "inside");
    assert.deepEqual(await sandbox.listFiles(".", allow), [".git", "notes"]);
    await assert.rejects(sandbox.writeFile(".git/config", "x", allow), /Git metadata is protected/);
    await assert.rejects(sandbox.writeFile("../escape", "x", allow), /path traversal/);
    await assert.rejects(sandbox.readFile("/etc/hostname", allow), /invalid relative path/);
    const listing = await sandbox.browse(".", allow);
    assert.equal(listing.type, "directory");
    const preview = await sandbox.browse("notes/plan.md", allow);
    assert.equal(preview.type === "file" && preview.text, "inside");
  });

  test(`${label}: shell commands, and a clone's head, push preparation and pack`, { skip: !posix || (helper === "python" && !python) }, async t => {
    const sandbox = await workspace(t, new Unconfined(helper, true, helper));
    const output = await sandbox.execute({ kind: "bash", command: "echo hello && git rev-parse --is-inside-work-tree" }, false, allow);
    assert.equal(output, "hello\ntrue\n");
    await sandbox.execute({ kind: "bash", command: "git init -q -b main app && cd app && git commit -q --allow-empty -m first && git remote add origin https://github.com/acme/app" }, false, allow);
    const head = await sandbox.cloneHead("app", allow);
    assert.match(head.commit, /^[0-9a-f]{40}$/);
    assert.equal(head.origin, "https://github.com/acme/app");
    const prepared = await sandbox.clonePushPrepare("app", { commit: head.commit, old: null, tips: [] }, allow);
    assert.equal(prepared.total, 1);
    assert.deepEqual(prepared.commits.map(commit => commit.subject), ["first"]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await sandbox.clonePushPack("app", { commit: head.commit, exclude: [] }, allow)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).subarray(0, 4).toString(), "PACK");
    const files = await sandbox.snapshot(allow, ["app"]);
    const paths = files.map(file => file.path);
    assert.ok(paths.includes("owner.gitconfig") && paths.includes("git/HEAD"));
    assert.ok(!paths.some(path => path.startsWith("worktree/app/")), "clones are left out of the snapshot");
    await assert.rejects(sandbox.execute({ kind: "bash", command: "exit 3" }, false, allow), /exit 3/);
  });
}

test("the Python helper backs up clones on macOS too; the Node helper's backend refuses what it can't do yet", { skip: !posix || !python }, async t => {
  const mac = await workspace(t, new Unconfined("python", false, "python"));
  await mac.execute({ kind: "bash", command: "git init -q -b main app && cd app && git commit -q --allow-empty -m first" }, false, allow, { unbounded: true });
  const backup = await mac.cloneBackup(allow);
  assert.deepEqual(backup.found, ["app"]);
  const windows = await workspace(t, new Unconfined("node", true, "node"));
  await assert.rejects(windows.cloneBackup(allow), /can't do this yet \(clone-backup\)/);
});

test("without hard limits (macOS), shell commands run only where the host's owner allowed them", { skip: !posix || !python }, async t => {
  const sandbox = await workspace(t, new Unconfined("unlimited", false, "python"));
  await assert.rejects(sandbox.execute({ kind: "bash", command: "true" }, false, allow), /no hard per-session resource limits/);
  assert.equal(await sandbox.execute({ kind: "bash", command: "echo ok" }, false, allow, { unbounded: true }), "ok\n");
});

test("each step gets only what it needs: read-only file reads, a writable Git directory only for the workspace's own Git, the network only for commands",
  { skip: !posix || !python }, async t => {
    const backend = new Unconfined("contexts", true, "python");
    const sandbox = await workspace(t, backend);
    await sandbox.readFile(".git", allow).catch(() => undefined);
    await sandbox.writeFile("a.txt", "x", allow);
    await sandbox.execute({ kind: "bash", command: "true" }, false, allow);
    const by = (kind: string) => backend.launched.find(entry => entry.request.kind === kind)!.context;
    assert.deepEqual([by("initialize").readOnly, by("initialize").gitWritable], [false, true]);
    assert.deepEqual([by("read").readOnly, by("read").gitWritable, by("read").egress], [true, false, false]);
    assert.deepEqual([by("write").readOnly, by("write").gitWritable], [false, false]);
    // No proxy was configured for this workspace, so not even the command reaches one.
    assert.equal(by("bash").egress, false);
  });

function call(port: number, init: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: init.method ?? "GET", path: init.path, headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("connect", response => { response.resume(); resolve({ status: response.statusCode!, headers: response.headers, body: "" }); request.destroy(); });
    request.on("error", reject);
    request.end();
  });
}

test("a proxy for sandboxes that share the host's network listens on loopback only, and serves only requests carrying the session's token", async t => {
  const directory = await mkdtemp(join(tmpdir(), "egress-tcp-"));
  const grant: EgressGrant = { policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [] };
  const proxy = new EgressProxy({ socketPath: join(directory, "unused.sock"), tcp: { token: "session-token" }, grant: async () => grant,
    relay: async () => new Response("no") });
  await proxy.start();
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  assert.ok(!existsSync(join(directory, "unused.sock")), "no socket: the sandbox reaches the proxy only on its port");
  const endpoint = proxy.endpoint as EgressEndpoint;
  assert.ok(endpoint && endpoint.port > 0);
  const basic = (token: string) => `Basic ${Buffer.from(`pistead:${token}`).toString("base64")}`;

  const anonymous = await call(endpoint.port, { path: "/__pistead/status" });
  assert.equal(anonymous.status, 401);
  assert.match(String(anonymous.headers["www-authenticate"]), /Basic/);
  assert.equal((await call(endpoint.port, { path: "/__pistead/status", headers: { Authorization: basic("wrong") } })).status, 401);
  const status = await call(endpoint.port, { path: "/__pistead/status", headers: { Authorization: basic("session-token") } });
  assert.equal(status.status, 200);
  assert.match(JSON.parse(status.body).gitRemotes, new RegExp(`127\\.0\\.0\\.1:${endpoint.port}/git/`));

  assert.equal((await call(endpoint.port, { path: "http://example.com/" })).status, 407);
  assert.equal((await call(endpoint.port, { method: "CONNECT", path: "example.com:443" })).status, 407);
  // With the token the request reaches the policy, which refuses: this workspace's network is off.
  assert.equal((await call(endpoint.port, { method: "CONNECT", path: "example.com:443", headers: { "Proxy-Authorization": basic("session-token") } })).status, 403);

  const environment = egressEnvironment("pistead/work-1", endpoint, "/session/ca.crt");
  assert.equal(environment.HTTPS_PROXY, `http://pistead:session-token@127.0.0.1:${endpoint.port}`);
  assert.equal(environment.GIT_CONFIG_KEY_0, `url.http://pistead:session-token@127.0.0.1:${endpoint.port}/git/.insteadOf`);
  assert.equal(environment.SSL_CERT_FILE, "/session/ca.crt");
  assert.equal(environment.PISTEAD_SESSION_BRANCH, "pistead/work-1");
});

const layout: HelperLayout = { root: "/s", home: "/s/home", worktree: "/s/worktree", git: "/s/git", ownerConfig: "/s/owner.gitconfig", bin: "/s/bin", caBundle: "/s/ca.crt" };

test("the Seatbelt profile denies by default, passes paths as parameters, and opens writes and the network per step", () => {
  const read = seatbeltProfile({ layout, readOnly: true, gitWritable: false, toolRoots: ["/opt/homebrew"] });
  assert.match(read.profile, /^\(version 1\)\n\(deny default\)\n/);
  // trustd would fetch certificate URLs on the host's network, outside the egress proxy.
  assert.ok(!read.profile.includes("trustd"), "no trustd lookup");
  assert.ok(!read.profile.includes("/s/"), "no session path is spliced into the profile");
  assert.equal(read.parameters.WORKTREE, "/s/worktree");
  assert.equal(read.parameters.TOOL_0, "/opt/homebrew");
  assert.ok(!/\(allow file-write\* \(subpath \(param "WORKTREE"/.test(read.profile));
  assert.ok(!read.profile.includes("network-outbound (remote ip"));
  assert.ok(read.profile.trimEnd().endsWith('(deny file-write* (subpath (param "GIT_DIR")))'));

  const command = seatbeltProfile({ layout, readOnly: false, gitWritable: false, egressPort: 51234, toolRoots: [] });
  assert.match(command.profile, /\(allow file-write\* \(subpath \(param "HOME_DIR"\)\) \(subpath \(param "WORKTREE"\)\)\)/);
  assert.match(command.profile, /\(allow network-outbound \(remote ip "localhost:51234"\)\)/);
  assert.ok(!command.profile.includes('(allow network-outbound (remote ip "localhost:*"))'));
  // The worktree's pointer to the Git directory, and the Git directory, are written last, so they win.
  const lines = command.profile.trimEnd().split("\n");
  assert.deepEqual(lines.slice(-2), ['(deny file-write* (literal (param "GIT_POINTER")))', '(deny file-write* (subpath (param "GIT_DIR")))']);

  const gitStep = seatbeltProfile({ layout, readOnly: false, gitWritable: true, toolRoots: [] });
  assert.match(gitStep.profile, /\(allow file-write\* \(subpath \(param "GIT_DIR"\)\)\)/);
  assert.ok(!gitStep.profile.includes('(deny file-write* (subpath (param "GIT_DIR")))'));
  assert.throws(() => seatbeltProfile({ layout, readOnly: false, gitWritable: false, egressPort: 70000, toolRoots: [] }), /Invalid egress port/);
});

test("the platform sandboxes refuse to start anywhere but their own platform, never falling back", { skip: process.platform === "darwin" || process.platform === "win32" }, () => {
  assert.throws(() => new SeatbeltBackend({ python: "/x", git: "/x", bash: "/x", roots: [], path: "" }), /only on macOS/);
  assert.throws(() => new WindowsBackend({ runtime: "/nowhere", limits: { memoryBytes: 1 << 30, processes: 64, cpuPercent: 50 } }), /only on Windows/);
  assert.throws(() => assertConnectorPlatform({ experimentalSandbox: true }), /for macOS and native Windows/);
});

test("a workspace opens again over its own read-only files, and a step that should have the network fails without a proxy", { skip: !posix || !python }, async t => {
  const backend = new Unconfined("reopen", true, "python");
  const first = await workspace(t, backend);
  await first.writeFile("kept.txt", "kept", allow);
  await first.close();
  const again = new HelperWorkspace(binding("native-reopen"), first.layout.root, backend);
  t.after(() => again.close());
  await again.initialize();
  assert.equal(await again.readFile("kept.txt", allow), "kept");
  const context = { readOnly: false, gitWritable: false, deadlineMs: 1000 };
  assert.equal(egressPort({ ...context, egress: false, environment: {} }), undefined);
  assert.equal(egressPort({ ...context, egress: true, environment: { HTTPS_PROXY: "http://pistead:t@127.0.0.1:41234" } }), 41234);
  assert.throws(() => egressPort({ ...context, egress: true, environment: {} }), /egress proxy endpoint is missing/);
  assert.throws(() => egressPort({ ...context, egress: true, environment: { HTTPS_PROXY: "http://127.0.0.1:41234" } }), /egress proxy endpoint is missing/);
});

/** A stand-in for MXC's SDK: `probe` reports the given tier, and the "container" echoes its input with a prefix. */
const FAKE_SDK = (tier: string) => `
import { spawn as start } from "node:child_process";
export function probe() { return { tier: ${JSON.stringify(tier)}, warnings: [], probes: {} }; }
export async function spawn(request) {
  const child = start(process.execPath, ["-e", "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write('container:'+s);process.exitCode=7})"], { stdio: ["pipe", "pipe", "pipe"] });
  return { standardInput: child.stdin, standardOutput: child.stdout, standardError: child.stderr,
    wait: () => new Promise(resolve => child.on("close", code => resolve({ exitCode: code, timedOut: false }))) };
}
`;

test("the Windows runner reads only its configuration, passes everything after it to the container once, and refuses MXC's fallback tiers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "windows-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "runner.mjs"), WINDOWS_RUNNER);
  const run = async (tier: string, input: string) => {
    await writeFile(join(directory, `sdk-${tier}.mjs`), FAKE_SDK(tier));
    const config = JSON.stringify({ sdk: join(directory, `sdk-${tier}.mjs`), request: {} });
    return spawnSync(process.execPath, [join(directory, "runner.mjs")], { input: `${config}\n${input}`, encoding: "utf8" });
  };
  const request = `${JSON.stringify({ kind: "read", path: "a" })}\n${"x".repeat(200_000)}`;
  const passed = await run("base-container", request);
  assert.equal(passed.status, 7, passed.stderr);
  assert.equal(passed.stdout, `container:${request}`);
  const refused = await run("appcontainer-dacl", request);
  assert.equal(refused.status, 70);
  assert.match(refused.stderr, /never uses MXC's AppContainer fallbacks/);
  assert.equal(refused.stdout, "");
});

test("the Node helper gives commands the session's own proxy URL back, after MXC replaced it with one without the token", { skip: !posix }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "node-helper-proxy-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "helper.mjs"), NODE_HELPER);
  const own = "http://pistead:session-token@127.0.0.1:41234";
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, [join(directory, "helper.mjs")], {
    input: JSON.stringify({ kind: "bash", command: "echo \"$HTTPS_PROXY $https_proxy $HTTP_PROXY $http_proxy ${SANDBOX_EGRESS_PROXY:-unset} [$NO_PROXY] [$no_proxy] ${SANDBOX_EGRESS_NO_PROXY:-unset}\"" }) + "\n",
    encoding: "utf8", cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, SANDBOX_WORKTREE: directory, SANDBOX_BASH: bash,
      HTTPS_PROXY: "http://127.0.0.1:41234", https_proxy: "http://127.0.0.1:41234", HTTP_PROXY: "http://127.0.0.1:41234", http_proxy: "http://127.0.0.1:41234",
      NO_PROXY: "", no_proxy: "", ...extra },
  });
  const restored = run({ SANDBOX_EGRESS_PROXY: own, SANDBOX_EGRESS_NO_PROXY: "localhost,127.0.0.1,::1" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout, `${own} ${own} ${own} ${own} unset [localhost,127.0.0.1,::1] [localhost,127.0.0.1,::1] unset\n`);
  // A step without the network has no proxy of its own to restore.
  assert.equal(run({}).stdout, "http://127.0.0.1:41234 http://127.0.0.1:41234 http://127.0.0.1:41234 http://127.0.0.1:41234 unset [] [] unset\n");
});

/**
 * A stand-in for MXC's SDK in the setup check: `probe` reports `tier` (and the identity-less proxy flag), and `spawn` runs
 * the check's own command in a shell, or, with `denied`, fails as Windows did before its October 2026 update.
 */
const FAKE_CHECK_SDK = (tier: string, options: { identityless?: boolean; denied?: boolean } = {}) => `
import { spawn as start } from "node:child_process";
export function probe() { return { tier: ${JSON.stringify(tier)}, warnings: [], probes: { baseContainerSupportsIdentitylessLoopbackProxy: ${options.identityless ?? true} } }; }
export async function spawn(request) {
  const child = ${options.denied
    ? `start(process.execPath, ["-e", "process.stderr.write(\\"Error: EPERM: operation not permitted, realpath 'C:\\\\\\\\work'\\\\n\\");process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] })`
    : `start(request.command, { shell: true, cwd: request.workingDirectory, stdio: ["pipe", "pipe", "pipe"] })`};
  return { standardInput: child.stdin, standardOutput: child.stdout, standardError: child.stderr,
    wait: () => new Promise(resolve => child.on("close", code => resolve({ exitCode: code, timedOut: false }))) };
}
`;

test("the Windows setup check runs a session's container and resolves a path in it, so builds where Git can't work are refused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "windows-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const check = async (name: string, source: string) => {
    await writeFile(join(directory, `${name}.mjs`), source);
    return windowsSandboxSupport(join(directory, `${name}.mjs`));
  };
  assert.deepEqual(await check("works", FAKE_CHECK_SDK("base-container")), { container: true, paths: true });
  const denied = await check("denied", FAKE_CHECK_SDK("base-container", { denied: true }));
  assert.deepEqual([denied.container, denied.paths], [true, false]);
  assert.match(denied.detail!, /EPERM: operation not permitted, realpath/);
  const fallback = await check("fallback", FAKE_CHECK_SDK("appcontainer-dacl"));
  assert.deepEqual([fallback.container, fallback.paths], [false, false]);
  assert.match(fallback.detail!, /MXC chose appcontainer-dacl/);
  assert.match((await check("no-proxy", FAKE_CHECK_SDK("base-container", { identityless: false }))).detail!, /without proxy-only egress/);
  assert.match((await windowsSandboxSupport(join(directory, "missing.mjs"))).detail!, /could not be loaded/);
});

test("the Windows runner and helper are valid modules, and job limits are checked", async t => {
  const directory = await mkdtemp(join(tmpdir(), "windows-scripts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, source] of [["runner.mjs", WINDOWS_RUNNER], ["helper.mjs", NODE_HELPER], ["check.mjs", WINDOWS_SUPPORT_CHECK]] as const) {
    await writeFile(join(directory, name), source);
    const check = spawnSync(process.execPath, ["--check", join(directory, name)], { encoding: "utf8" });
    assert.equal(check.status, 0, `${name}: ${check.stderr}`);
  }
  assert.deepEqual(validWindowsLimits({ memoryBytes: 1 << 30, processes: 64, cpuPercent: 25 }), { memoryBytes: 1 << 30, processes: 64, cpuPercent: 25 });
  assert.throws(() => validWindowsLimits({ memoryBytes: 1024, processes: 64, cpuPercent: 25 }), /memory/);
  assert.throws(() => validWindowsLimits({ memoryBytes: 1 << 30, processes: 1, cpuPercent: 25 }), /process/);
  assert.throws(() => validWindowsLimits({ memoryBytes: 1 << 30, processes: 64, cpuPercent: 0 }), /CPU/);
});
