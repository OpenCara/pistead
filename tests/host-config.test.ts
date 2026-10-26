import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultHostConfig, parseHostConfig, readHostConfig } from "../packages/shared/src/host-config.js";
import { commandLimits, detectGpu, gpuMounts, HostConfigSource } from "../apps/runner/src/host-config.js";
import { movedOptionsNotice } from "../apps/runner/src/connect-cli.js";

const MiB = 1024 * 1024;

test("a host configuration is whole and within bounds, or refused", () => {
  const config = { commandTimeoutSeconds: 600, gpu: true, gitCredentials: true, repositoryCache: "owner", hostSessions: true };
  assert.deepEqual(parseHostConfig(config), config);
  assert.deepEqual(parseHostConfig({ ...defaultHostConfig }), { commandTimeoutSeconds: 30, gpu: false, gitCredentials: false, repositoryCache: "off", hostSessions: false });
  for (const invalid of [undefined, null, [], "config", { ...config, commandTimeoutSeconds: 29 }, { ...config, commandTimeoutSeconds: 3601 },
    { ...config, commandTimeoutSeconds: 60.5 }, { ...config, commandTimeoutSeconds: "60" }, { ...config, gpu: 1 }, { ...config, gitCredentials: "true" },
    { ...config, repositoryCache: "shared" }, { ...config, hostSessions: "true" }, { ...config, extra: true },
    { commandTimeoutSeconds: 60, gpu: false, gitCredentials: false, repositoryCache: "off" },
    { ...config, toString: "x" }]) {
    assert.throws(() => parseHostConfig(invalid), /host configuration|time limit|setting/, JSON.stringify(invalid));
  }
});

test("a connector reads what it knows of a configuration: newer settings are left out, missing ones keep their defaults", () => {
  const sent = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "host", hostSessions: true };
  assert.deepEqual(readHostConfig({ ...sent, someLaterSetting: "on" }), sent);
  assert.deepEqual(readHostConfig({ commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "host" }), { ...sent, hostSessions: false });
  assert.deepEqual(readHostConfig({}), defaultHostConfig);
  // What it does read must hold, or none of it is used.
  for (const invalid of [undefined, null, [], { ...sent, hostSessions: "yes" }, { ...sent, commandTimeoutSeconds: 5 }]) assert.throws(() => readHostConfig(invalid));
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
  const first = { commandTimeoutSeconds: 120, gpu: true, gitCredentials: false, repositoryCache: "off", hostSessions: false };
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
  const device = "sys/devices/pci0000:00/0000:00:02.0";
  await mkdir(join(root, "dev/dri"), { recursive: true });
  for (const name of ["card0", "renderD128", "renderD129"]) await writeFile(join(root, "dev/dri", name), "");
  await mkdir(join(root, device, "drm/renderD128"), { recursive: true });
  await writeFile(join(root, device, "drm/renderD128/dev"), "226:128\n");
  await symlink("../../../0000:00:02.0", join(root, device, "drm/renderD128/device"));
  await mkdir(join(root, "sys/class/drm"), { recursive: true });
  await symlink("../../devices/pci0000:00/0000:00:02.0/drm/renderD128", join(root, "sys/class/drm/renderD128"));
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

test("connect options that moved to Pistead are named, and ignored, rather than refused", () => {
  assert.equal(movedOptionsNotice([]), "");
  assert.match(movedOptionsNotice(["git-credentials"]), /^--git-credentials is ignored: the host's owner sets it in Pistead now \(Settings > Hosts > this host > Configuration\)/);
  assert.match(movedOptionsNotice(["repo-cache", "repo-cache-scope"]), /^--repo-cache, --repo-cache-scope are ignored: the host's owner sets them in Pistead now/);
});
