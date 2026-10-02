import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Sandbox } from "../apps/runner/src/sandbox.js";
import { probeResources, recoverResourceOrphans, resourceLaunch, validateResourceConfig, type ResourceConfig } from "../apps/runner/src/resources.js";
import type { RunnerBinding } from "../packages/shared/src/types.js";

const config: ResourceConfig = {
  cgroupRoot: "/operator/delegated/sessions", controlRoot: "/operator/private-resource-control",
  cpuQuotaMicros: 25_000, cpuPeriodMicros: 100_000, memoryMaxBytes: 128 * 1024 * 1024,
  pidsMax: 24, writableMaxBytes: 16 * 1024 * 1024, writableMaxInodes: 4096,
};
const authorize = async (): Promise<void> => {};
function binding(): RunnerBinding {
  return {
    session: { id: "resource-fixture", workspaceId: "workspace", ownerId: "test:resource-owner", agentVersionId: "version", title: "Resource fixture", policyVersion: 1, status: "ready", createdAt: "2026-01-01T00:00:00Z" },
    owner: { id: "test:resource-owner", githubId: null, githubLogin: null, displayName: "Resource Owner", gitName: "Resource Owner", gitEmail: "resource@example.test", env: {}, githubConnected: false },
    agent: { id: "version", agentId: "agent", authorId: "test:author", workspaceId: "workspace", version: 1, name: "Resource fixture", description: "", instructions: "", tools: ["bash"], modelId: "model", createdAt: "2026-01-01T00:00:00Z" },
    model: { id: "model", workspaceId: "workspace", name: "Resource fixture", provider: "faux", modelId: "faux" },
  };
}

test("production resource availability never follows configuration intent alone", async () => {
  assert.equal((await probeResources()).available, false);
  assert.match((await probeResources(config)).reason!, /per-session filesystem/);
  const directory = await mkdtemp(join(tmpdir(), "resource-not-provisioned-"));
  try {
    const result = await probeResources({ ...config, cgroupRoot: directory, controlRoot: directory }, directory);
    assert.equal(result.available, false, "ordinary writable directories are not delegated cgroups or quota volumes");
    assert.ok(result.reason);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resource configuration rejects ambiguous paths and non-finite or unbounded quotas", () => {
  for (const path of ["relative", "/", "/a/../b", "/a/", "/bad\0path", "/usr/local/control"]) {
    assert.throws(() => validateResourceConfig({ ...config, cgroupRoot: path }));
    assert.throws(() => validateResourceConfig({ ...config, controlRoot: path }));
  }
  for (const field of ["cpuQuotaMicros", "cpuPeriodMicros", "memoryMaxBytes", "pidsMax", "writableMaxBytes", "writableMaxInodes"] as const) {
    for (const value of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateResourceConfig({ ...config, [field]: value }), `${field}=${value}`);
    }
  }
  assert.throws(() => validateResourceConfig({ ...config, cpuPeriodMicros: 999 }));
  assert.throws(() => validateResourceConfig({ ...config, cpuPeriodMicros: 1_000_001 }));
  assert.throws(() => validateResourceConfig({ ...config, cpuQuotaMicros: 999 }));
  assert.ok(Object.isFrozen(validateResourceConfig(config)));
});

test("bare Sandbox never executes production bash without verified resources", { skip: process.platform !== "linux" ? "Sandbox requires Linux" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "resource-denial-"));
  const sandbox = new Sandbox(binding(), root);
  const realBinding = binding();
  realBinding.model = { ...realBinding.model, provider: "anthropic" };
  const realSandbox = new Sandbox(realBinding, root);
  try {
    await assert.rejects(sandbox.execute({ kind: "bash", command: "printf must-not-run" }, false, authorize), /Production bash unavailable/);
    assert.deepEqual(await readdir(root), [], "denial precedes namespace launch and storage initialization");
    assert.equal((await sandbox.identity(authorize)).ownerId, binding().owner.id, "bounded identity API stays available");
    await assert.rejects(realSandbox.execute({ kind: "bash", command: "printf must-not-run" }, false, authorize, { allowTestShell: true }), /restricted.*faux/);
    assert.deepEqual(await readdir(root), [], "test-shell bypass cannot be used by a real provider");
  } finally {
    await sandbox.close();
    await realSandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* Explicitly provisioned fixture only; these tests NEVER mount filesystems, enable
 * ancestor controllers, move existing processes, or create a root-owned shell.
 * RUNNER_RESOURCE_TEST_FIXTURE names a private JSON file containing:
 * { resources: ResourceConfig, storageRoot: <dedicated mounted empty session root> }.
 * Use an isolated runner uid with an unlimited leaf, delegated sibling subtree,
 * ext4/tmpfs rw,nosuid,nodev <=16MiB, <=4096 inodes, <=128MiB RAM and <=24 pids.
 * The operator owns fixture provisioning/removal; the suite leaves session data.
 * A supplied but invalid fixture FAILS rather than silently skipping enforcement.
 */
const fixturePath = process.env.RUNNER_RESOURCE_TEST_FIXTURE;
test("real delegated kernel resource boundary", {
  skip: !fixturePath ? "No explicitly provisioned RUNNER_RESOURCE_TEST_FIXTURE; cgroup/storage enforcement NOT exercised" : false,
  timeout: 120_000,
}, async t => {
  assert.equal(process.platform, "linux");
  assert.notEqual(process.getuid?.(), 0, "never run the fixture shell as root");
  const fixture = JSON.parse(await readFile(fixturePath!, "utf8")) as { resources: ResourceConfig; storageRoot: string };
  const resources = validateResourceConfig(fixture.resources);
  assert.ok(resources.memoryMaxBytes >= 64 * 1024 * 1024 && resources.memoryMaxBytes <= 128 * 1024 * 1024);
  assert.ok(resources.pidsMax >= 12 && resources.pidsMax <= 24);
  assert.ok(resources.writableMaxBytes <= 16 * 1024 * 1024 && resources.writableMaxInodes <= 4096);
  const available = await probeResources(resources, fixture.storageRoot);
  assert.equal(available.available, true, available.reason);
  const sandbox = new Sandbox(binding(), fixture.storageRoot, resources);
  t.after(() => sandbox.close());
  await sandbox.initialize();
  const key = createHash("sha256").update(JSON.stringify([binding().owner.id, binding().session.id])).digest("hex");
  const domain = join(resources.cgroupRoot, `session-${key}`);
  const shell = (command: string) => sandbox.execute({ kind: "bash", command }, false, authorize);
  const domainEmpty = async () => {
    assert.match(await readFile(join(domain, "cgroup.events"), "utf8"), /^populated 0$/m);
    assert.equal((await readFile(join(domain, "cgroup.procs"), "utf8")).trim(), "");
  };
  const domainReady = async () => {
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        if ((await readFile(join(domain, "cgroup.procs"), "utf8")).trim()) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    assert.fail("resource command never joined its cgroup");
  };

  await t.test("a bounded filesystem cannot be substituted by its subdirectory or weaker ceilings", async () => {
    assert.equal((await probeResources(resources, join(fixture.storageRoot, "home"))).available, false);
    assert.equal((await probeResources({ ...resources, writableMaxBytes: 1 }, fixture.storageRoot)).available, false);
    assert.equal((await probeResources({ ...resources, writableMaxInodes: 1 }, fixture.storageRoot)).available, false);
  });

  await t.test("kernel controls cover multiple descendants and recover skips active locks", async () => {
    const running = shell("sleep 2 & sleep 2 & wait");
    await domainReady();
    assert.equal((await readFile(join(domain, "cpu.max"), "utf8")).trim(), `${resources.cpuQuotaMicros} ${resources.cpuPeriodMicros}`);
    assert.equal((await readFile(join(domain, "memory.max"), "utf8")).trim(), String(resources.memoryMaxBytes));
    assert.equal((await readFile(join(domain, "memory.swap.max"), "utf8")).trim(), "0");
    assert.equal((await readFile(join(domain, "memory.oom.group"), "utf8")).trim(), "1");
    assert.equal((await readFile(join(domain, "pids.max"), "utf8")).trim(), String(resources.pidsMax));
    await delay(150);
    assert.ok((await readFile(join(domain, "cgroup.procs"), "utf8")).trim().split("\n").length >= 3);
    await recoverResourceOrphans(resources);
    await running;
    await domainEmpty();
  });

  await t.test("background and detached descendants cannot survive command completion", async () => {
    await shell("setsid sleep 20 >/dev/null 2>&1 & printf returned");
    await domainEmpty();
  });

  await t.test("multiple CPU burners share the kernel bandwidth controller", async () => {
    assert.ok(resources.cpuQuotaMicros < resources.cpuPeriodMicros, "fixture requires a fractional CPU quota");
    const before = await readFile(join(domain, "cpu.stat"), "utf8");
    await shell("python3 -I -c 'while True: pass' & p1=$!; python3 -I -c 'while True: pass' & p2=$!; sleep 2; kill $p1 $p2; wait || true");
    const after = await readFile(join(domain, "cpu.stat"), "utf8");
    const beforeThrottled = Number(/^nr_throttled (\d+)$/m.exec(before)?.[1] ?? -1);
    const afterThrottled = Number(/^nr_throttled (\d+)$/m.exec(after)?.[1] ?? -1);
    assert.ok(afterThrottled > beforeThrottled, "kernel reports aggregate CPU throttling");
    await domainEmpty();
  });

  await t.test("forked processes share one pids ceiling", async () => {
    const output = await shell("python3 -I -c 'import subprocess; children=[]\ntry:\n while True: children.append(subprocess.Popen([\"sleep\",\"5\"]))\nexcept BlockingIOError: print(\"pids-enforced\", flush=True)\nfinally:\n for p in children: p.kill()\n for p in children: p.wait()'");
    assert.match(output, /pids-enforced/);
  });

  await t.test("aggregate memory limit kills allocations split across processes", async () => {
    await assert.rejects(shell("python3 -I -c 'import subprocess; children=[subprocess.Popen([\"python3\",\"-I\",\"-c\",\"import time; a=bytearray(48*1024*1024); time.sleep(10)\"]) for _ in range(4)]; [p.wait() for p in children]'"));
    await domainEmpty();
    assert.match(await readFile(join(domain, "memory.events"), "utf8"), /^oom_kill [1-9][0-9]*$/m);
  });

  await t.test("many individually small files share one persistent allocation ceiling", async () => {
    const output = await shell("python3 -I -c 'import errno, os\nnames=[]\ntry:\n for i in range(128):\n  name=\"quota-\"+str(i); names.append(name)\n  with open(name,\"wb\") as f: f.write(b\"x\"*262144)\nexcept OSError as e:\n assert e.errno in (errno.ENOSPC,errno.EDQUOT), e\n print(\"capacity-enforced\")\nfinally:\n for name in names:\n  if os.path.exists(name): os.unlink(name)'");
    assert.match(output, /capacity-enforced/);
    await assert.rejects(shell("printf no >/dev/shm/escape"));
    await assert.rejects(shell("printf no >/dev/escape"));
    await assert.rejects(shell("mkdir /tmp/escape"));
  });

  await t.test("output limit and wall timeout kill the whole resource domain", async () => {
    await assert.rejects(shell("python3 -I -c 'import sys; sys.stdout.write(\"x\"*5000000)'"), /output limit/);
    await domainEmpty();
    await assert.rejects(shell("sleep 90 & wait"), /time limit|deadline/);
    await domainEmpty();
  });

  await t.test("empty files share the session inode ceiling", async () => {
    const output = await shell("python3 -I -c 'import errno, os\nnames=[]\ntry:\n for i in range(8192):\n  name=\"inode-\"+str(i); names.append(name); open(name,\"w\").close()\nexcept OSError as e:\n assert e.errno in (errno.ENOSPC,errno.EDQUOT), e\n assert os.statvfs(\".\").f_ffree <= 1\n print(\"inodes-enforced\")\nfinally:\n for name in names:\n  if os.path.exists(name): os.unlink(name)'");
    assert.match(output, /inodes-enforced/);
  });

  await t.test("runner EOF and supervisor SIGKILL recovery remove all owned descendants", async () => {
    const handles = await Promise.all(["home", "worktree", "git", "owner.gitconfig", ""].map((path) =>
      open(join(fixture.storageRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW | (path === "owner.gitconfig" ? 0 : constants.O_DIRECTORY))));
    try {
      // Deliberately omit die-with-parent for this benign bounded sleep so the
      // recovery test proves cgroup.kill, rather than bwrap's parent-death guard.
      const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev",
        "--remount-ro", "/proc", "--remount-ro", "/dev", "--remount-ro", "/",
        "--", "/usr/bin/sleep", "20"];
      for (const termination of ["eof", "sigkill"] as const) {
        const launch = resourceLaunch(resources, key, args);
        const child = spawn(launch.command, launch.args, {
          cwd: "/", env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "ignore", "ignore", handles[0]!.fd, handles[1]!.fd, handles[2]!.fd, handles[3]!.fd, "pipe", handles[4]!.fd],
        });
        const exited = new Promise<void>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", () => resolveExit());
        });
        try {
          await domainReady();
          await delay(200);
          if (termination === "sigkill") child.kill("SIGKILL");
          else child.stdio.at(7)!.destroy();
          await exited;
          await recoverResourceOrphans(resources);
          await domainEmpty();
        } finally {
          child.kill("SIGTERM");
          child.stdio.at(7)?.destroy();
          await recoverResourceOrphans(resources);
        }
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
  });

  await t.test("closing the session cancels running descendants", async () => {
    const running = shell("sleep 20 & wait");
    const rejected = assert.rejects(running, /closed|cancelled/);
    await domainReady();
    await sandbox.close();
    await rejected;
    await domainEmpty();
  });
});
