import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultHostConfig, parseHostCompaction, parseHostConfig, parseHostConfigChange, readHostConfig } from "../packages/shared/src/host-config.js";
import { commandLimits, detectGpu, gpuMounts, HostConfigSource } from "../apps/runner/src/host-config.js";
import { movedOptionsNotice } from "../apps/runner/src/connect-cli.js";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

const MiB = 1024 * 1024;
const sandboxed = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

/** The sysfs directory of the stand-in GPU below a test's root, as the host's /sys/devices names it. */
const GPU_DEVICE = "sys/devices/pci0000:00/0000:00:02.0";

/**
 * A Linux GPU below `root` as gpuMounts finds one: DRM nodes in /dev/dri (a KMS card0; renderD128 with its sysfs entry,
 * renderD129 without one) and the /sys/class/drm link to renderD128's entry in its device's sysfs directory.
 */
async function standInGpu(root: string): Promise<void> {
  await mkdir(join(root, "dev/dri"), { recursive: true });
  for (const name of ["card0", "renderD128", "renderD129"]) await writeFile(join(root, "dev/dri", name), "");
  await mkdir(join(root, GPU_DEVICE, "drm/renderD128"), { recursive: true });
  await writeFile(join(root, GPU_DEVICE, "drm/renderD128/dev"), "226:128\n");
  await symlink("../../../0000:00:02.0", join(root, GPU_DEVICE, "drm/renderD128/device"));
  await mkdir(join(root, "sys/class/drm"), { recursive: true });
  await symlink("../../devices/pci0000:00/0000:00:02.0/drm/renderD128", join(root, "sys/class/drm/renderD128"));
}

function fauxBinding(id: string): RunnerBinding {
  return {
    session: { id, workspaceId: "workspace", ownerId: "test:alice", agentVersionId: "version-1", title: "GPU test", policyVersion: 1,
      status: "ready", createdAt: "2026-01-01T00:00:00Z", repositories: [] },
    owner: { id: "test:alice", githubId: null, githubLogin: "alice", displayName: "Alice", gitName: "Alice Owner",
      gitEmail: "alice@example.test", env: {}, githubConnected: false },
    agent: { id: "version-1", agentId: "agent", authorId: "test:template-author", workspaceId: "workspace", version: 1, name: "GPU agent",
      description: "Test", instructions: "Use tools.", tools: ["bash"], modelId: "model-1", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model-1", workspaceId: "workspace", name: "Explicit faux test provider", provider: "faux", modelId: "gpu-faux" },
  };
}

test("a host configuration is whole and within bounds, or refused", () => {
  const config = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: true, repositoryCache: "owner", hostSessions: true,
    compaction: { reserveTokens: 32_768, modelOverrides: { "anthropic/opus": { keepRecentTokens: 20_000 } } } };
  assert.deepEqual(parseHostConfig(config), config);
  assert.deepEqual(parseHostConfig({ ...defaultHostConfig }), { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {} });
  for (const invalid of [undefined, null, [], "config", { ...config, commandTimeoutSeconds: 29 }, { ...config, commandTimeoutSeconds: 3601 },
    { ...config, commandTimeoutSeconds: 60.5 }, { ...config, commandTimeoutSeconds: "60" }, { ...config, gpu: 1 }, { ...config, gitCredentials: "true" },
    { ...config, repositoryCache: "shared" }, { ...config, hostSessions: "true" }, { ...config, extra: true },
    { ...config, compaction: undefined }, { ...config, compaction: { reserveTokens: -1 } },
    { commandTimeoutSeconds: 60, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false },
    { ...config, toString: "x" }]) {
    assert.throws(() => parseHostConfig(invalid), /host configuration|time limit|setting|token counts/, JSON.stringify(invalid));
  }
});

test("a change of configuration names one or more valid settings, and only those", () => {
  assert.deepEqual(parseHostConfigChange({ commandTimeoutSeconds: 120 }), { commandTimeoutSeconds: 120 });
  assert.deepEqual(parseHostConfigChange({ gpu: true, repositoryCache: "host" }), { gpu: true, repositoryCache: "host" });
  assert.deepEqual(parseHostConfigChange({ compaction: { keepRecentTokens: 8000 } }), { compaction: { keepRecentTokens: 8000 } });
  const whole = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: true, repositoryCache: "owner", hostSessions: true, compaction: {} };
  assert.deepEqual(parseHostConfigChange(whole), whole);
  for (const invalid of [undefined, null, [], "config", {}, { commandTimeoutSeconds: 29 }, { commandTimeoutSeconds: "60" }, { gpu: 1 },
    { repositoryCache: "shared" }, { hostSessions: "true" }, { gpu: true, extra: true }, { toString: "x" }, JSON.parse('{"__proto__": {"gpu": true}}'),
    { compaction: null }, { compaction: { reserveTokens: "8192" } }]) {
    assert.throws(() => parseHostConfigChange(invalid), /host configuration|time limit|setting|token counts/, JSON.stringify(invalid));
  }
});

test("a connector reads what it knows of a configuration: newer settings are left out, missing ones keep their defaults", () => {
  const sent = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "host", hostSessions: true, compaction: { reserveTokens: 20_000 } };
  assert.deepEqual(readHostConfig({ ...sent, someLaterSetting: "on" }), sent);
  assert.deepEqual(readHostConfig({ commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "host" }), { ...sent, hostSessions: false, compaction: {} });
  assert.deepEqual(readHostConfig({}), defaultHostConfig);
  // What it does read must hold, or none of it is used.
  for (const invalid of [undefined, null, [], { ...sent, hostSessions: "yes" }, { ...sent, commandTimeoutSeconds: 5 }, { ...sent, compaction: { reserveTokens: 1.5 } }]) {
    assert.throws(() => readHostConfig(invalid));
  }
});

test("compaction token counts are whole numbers in bounds, for every model and per provider/modelId, kept in one order", () => {
  assert.deepEqual(parseHostCompaction({}), {});
  assert.deepEqual(parseHostCompaction({ keepRecentTokens: 0, reserveTokens: 10_000_000 }), { reserveTokens: 10_000_000, keepRecentTokens: 0 });
  // Models are sorted, and one with no counts is left out.
  const parsed = parseHostCompaction({ modelOverrides: { "openai/gpt-5": { reserveTokens: 30_000 }, "anthropic/claude-opus-4": { keepRecentTokens: 1, reserveTokens: 65_536 },
    "relay/org/model": {}, "openrouter/meta/llama-4": { keepRecentTokens: 2000 } } });
  assert.deepEqual(parsed, { modelOverrides: { "anthropic/claude-opus-4": { reserveTokens: 65_536, keepRecentTokens: 1 }, "openai/gpt-5": { reserveTokens: 30_000 },
    "openrouter/meta/llama-4": { keepRecentTokens: 2000 } } });
  assert.equal(JSON.stringify(parsed), '{"modelOverrides":{"anthropic/claude-opus-4":{"reserveTokens":65536,"keepRecentTokens":1},"openai/gpt-5":{"reserveTokens":30000},"openrouter/meta/llama-4":{"keepRecentTokens":2000}}}');
  assert.deepEqual(parseHostCompaction({ modelOverrides: { "a/b": {} } }), {});
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p/m${index}`, { reserveTokens: 1 }]));
  for (const invalid of [undefined, null, [], "{}", { reserveTokens: -1 }, { reserveTokens: 10_000_001 }, { reserveTokens: 1.5 }, { reserveTokens: "8192" },
    { keepRecentTokens: null }, { enabled: true }, { backgroundTokens: 1 }, { modelOverrides: [] }, { modelOverrides: { "no-slash": { reserveTokens: 1 } } },
    { modelOverrides: { "/model": { reserveTokens: 1 } } }, { modelOverrides: { "a/b c": { reserveTokens: 1 } } }, { modelOverrides: { "a/b": { reserveTokens: -5 } } },
    { modelOverrides: { "a/b": { modelOverrides: {} } } }, { modelOverrides: { "a/b": 5 } }, { modelOverrides: many }, JSON.parse('{"__proto__": {"reserveTokens": 1}}')]) {
    assert.throws(() => parseHostCompaction(invalid), /compaction|Compaction/, JSON.stringify(invalid));
  }
});

test("a longer command time limit gives builds room; the default keeps the short-command limits", () => {
  const short = { seconds: 30, cpuSeconds: 25, fileBytes: 64 * MiB, openFiles: 256 };
  assert.deepEqual(commandLimits(30, 8), short);
  assert.deepEqual(commandLimits(600, 8), { seconds: 600, cpuSeconds: 4800, fileBytes: 16 * 1024 * MiB, openFiles: 8192 });
  assert.equal(commandLimits(120, 0).cpuSeconds, 120, "at least one CPU");
  // Whatever arrives is kept within the bounds the control plane enforces.
  assert.deepEqual(commandLimits(5, 8), short);
  assert.deepEqual(commandLimits(Number.NaN, 8), short);
  assert.equal(commandLimits(99_999, 2).seconds, 3600);
  assert.equal(commandLimits(90.7, 1).seconds, 90);
});

test("the host's configuration is asked for again only after a while, and its last answer outlives a brief outage", async () => {
  let now = 0;
  let loads = 0;
  const answers: unknown[] = [];
  const source = new HostConfigSource(async () => {
    loads++;
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }, { now: () => now, ttlMs: 30_000, staleMs: 300_000 });
  const first = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "off", hostSessions: false, compaction: {} };
  const second = { ...first, commandTimeoutSeconds: 1800 };
  answers.push(first);
  assert.deepEqual(await source.current(), first);
  now += 29_000;
  assert.deepEqual(await source.current(), first);
  assert.equal(loads, 1, "a fresh answer is reused");
  now += 2_000;
  answers.push(second);
  // Callers that ask at the same time share one request.
  assert.deepEqual(await Promise.all([source.current(), source.current()]), [second, second]);
  assert.equal(loads, 2);
  now += 31_000;
  answers.push(new Error("control plane unreachable"));
  assert.deepEqual(await source.current(), second, "an outage keeps the last answer");
  now += 31_000;
  answers.push({ ...second, commandTimeoutSeconds: 5 });
  assert.deepEqual(await source.current(), second, "an invalid answer is no answer");
  now += 300_000;
  answers.push(new Error("still unreachable"));
  assert.deepEqual(await source.current(), defaultHostConfig, "a long outage falls back to the defaults");
  const empty = new HostConfigSource(async () => { throw new Error("no control plane"); });
  assert.deepEqual(await empty.current(), defaultHostConfig);
});

test("a GPU is lent as its render device only: WSL's /dev/dxg, or DRM render nodes with their sysfs device", async t => {
  const root = await mkdtemp(join(tmpdir(), "pistead-gpu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = realpathSync(root);
  assert.equal(gpuMounts(root), undefined, "no device, nothing to lend");
  assert.equal(detectGpu(root), undefined);
  assert.equal(gpuMounts(join(root, "missing")), undefined);

  // Linux: render nodes, never card (KMS) nodes; a node whose sysfs entry is missing is left out.
  const device = GPU_DEVICE;
  await standInGpu(root);
  assert.deepEqual(gpuMounts(root), { kind: "render", env: {}, args: [
    "--dev-bind", join(base, "dev/dri/renderD128"), "/dev/dri/renderD128",
    "--ro-bind", join(base, device), `/${device}`,
    "--symlink", `/${device}/drm/renderD128`, "/sys/dev/char/226:128",
  ] });
  assert.equal(detectGpu(root), "render");
  // A sysfs link that leads outside /sys/devices is not followed into the sandbox.
  await rm(join(root, "sys/class/drm/renderD128"));
  await mkdir(join(root, "elsewhere"), { recursive: true });
  await writeFile(join(root, "elsewhere/dev"), "226:128\n");
  await symlink("../../../elsewhere", join(root, "sys/class/drm/renderD128"));
  assert.equal(gpuMounts(root), undefined);

  // WSL: /dev/dxg wins, with the Windows driver's libraries on the library path when they are there.
  await writeFile(join(root, "dev/dxg"), "");
  assert.deepEqual(gpuMounts(root), { kind: "dxg", args: ["--dev-bind", join(base, "dev/dxg"), "/dev/dxg"], env: {} });
  await mkdir(join(root, "usr/lib/wsl/lib"), { recursive: true });
  assert.deepEqual(gpuMounts(root), { kind: "dxg", args: ["--dev-bind", join(base, "dev/dxg"), "/dev/dxg"], env: { LD_LIBRARY_PATH: "/usr/lib/wsl/lib" } });
  assert.equal(detectGpu(root), "dxg");
});

test("a sandboxed command lent the GPU finds its render node, the node's sysfs device and the /sys/dev/char link that names it", { skip: !sandboxed }, async t => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "pistead-gpu-sandbox-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await standInGpu(join(base, "host"));
  const sandbox = new Sandbox(fauxBinding("gpu-sandbox"), join(base, "session"), undefined, { gpuRoot: join(base, "host") });
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const shell = async (command: string, gpu: boolean) =>
    (await sandbox.execute({ kind: "bash", command }, true, async () => {}, { allowTestShell: true, gpu })).trim().split("\n");
  const device = `/${GPU_DEVICE}`;
  // Nothing else makes /sys/dev/char in the sandbox: bubblewrap creates the link's missing parents, as it does for
  // every mount's. The link leads through the read-only sysfs directory to the node's entry and back to its device.
  assert.deepEqual(await shell([
    "readlink /sys/dev/char/226:128", "cat /sys/dev/char/226:128/dev", "(cd -P /sys/dev/char/226:128/device && pwd)",
    "test -e /dev/dri/renderD128 && echo render-node", "test -e /dev/dri/card0 || echo no-card-node",
    "test -e /dev/dri/renderD129 || echo no-node-without-sysfs", `touch ${device}/written 2>/dev/null || echo read-only`,
  ].join("; "), true), [`${device}/drm/renderD128`, "226:128", device, "render-node", "no-card-node", "no-node-without-sysfs", "read-only"]);
  // A command not lent the GPU has none of it.
  assert.deepEqual(await shell("if [ ! -e /sys/dev/char ] && [ ! -e /sys/devices ] && [ ! -e /dev/dri ]; then echo none; fi", false), ["none"]);
});

test("connect options that moved to Pistead are named, and ignored, rather than refused", () => {
  assert.equal(movedOptionsNotice([]), "");
  assert.match(movedOptionsNotice(["git-credentials"]), /^--git-credentials is ignored: the host's owner sets it in Pistead now \(Settings > Hosts > this host > Configuration\)/);
  assert.match(movedOptionsNotice(["repo-cache", "repo-cache-scope"]), /^--repo-cache, --repo-cache-scope are ignored: the host's owner sets them in Pistead now/);
});
