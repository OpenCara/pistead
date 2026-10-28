import { chmod, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { egressPort, type HelperBackend, type HelperContext, type HelperLaunch, type HelperLayout } from "./helper-workspace.js";
import { NODE_HELPER, NODE_HELPER_KINDS } from "./node-helper.js";
import { bashPath, gitForWindowsRoot } from "./platform.js";
import { mxcEntry, mxcInstallHint, validWindowsLimits, type WindowsJobLimits } from "./sandbox-backend.js";
import type { SandboxRequest } from "./sandbox.js";
import { WindowsJob } from "./windows-job.js";

/**
 * Native Windows 11 as a session's boundary: every step runs the Node helper (node-helper.ts) in an OS process
 * container (PSEC, "base-container") created through Microsoft's MXC SDK, inside a job object with the host's limits.
 *
 *   connector ──spawn──▶ node runner.mjs   (put in a new job before it is told anything)
 *                           └─ MXC SDK ──▶ container: node.exe helper.mjs ──▶ bash.exe / git.exe
 *
 * The runner is a separate process so MXC's native code never runs inside the connector, and so the job holds
 * everything the step starts. It refuses to run unless MXC would use the OS container: never MXC's AppContainer
 * fallbacks, which would rewrite the host's folder permissions (the SDK has no setting to forbid them, so the runner
 * probes first).
 *
 * The container may read the system, node.exe's directory and Git for Windows, and the session's own files; it may write
 * only the session's home and worktree (and its Git directory in Git steps). Its only network is the session's egress
 * proxy on a loopback port (MXC's proxy-only egress: everything else is blocked by a per-container WFP filter), which
 * also wants the session's token.
 *
 * Needs Windows 11 24H2/25H2 builds 26100/26200.9550 or later. Untested: see docs/design/windows-sandbox.md, Spikes.
 */
export const WINDOWS_RUNNER = String.raw`
import { pathToFileURL } from "node:url";

// Line 1: the configuration (sent only once this process is in its job). Then the helper's request, passed through.
const pending = [];
let config;
let buffered = Buffer.alloc(0);
const first = new Promise((resolve, reject) => {
  // Reads only the configuration: once it is in, input waits in the stream (paused) until the container takes it.
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(10);
    if (end < 0) { if (buffered.length > 1024 * 1024) reject(new Error("configuration too large")); return; }
    process.stdin.off("data", onData);
    process.stdin.pause();
    try { config = JSON.parse(buffered.subarray(0, end).toString("utf8")); } catch { reject(new Error("invalid configuration")); return; }
    if (buffered.length > end + 1) pending.push(buffered.subarray(end + 1));
    resolve();
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", () => { if (!config) reject(new Error("no configuration")); });
});

function fail(message, code = 70) {
  process.stderr.write("sandbox: " + message + "\n");
  process.exit(code);
}

try { await first; } catch (error) { fail(error.message); }
const sdk = await import(pathToFileURL(config.sdk).href).catch(() => fail("the MXC SDK could not be loaded from " + config.sdk));
let probe;
try { probe = sdk.probe(config.request); } catch (error) { fail("this Windows can't run the process container: " + (error && error.message || "probe failed")); }
if (probe.error || probe.tier !== "base-container" || (probe.warnings && probe.warnings.length)) {
  fail("this Windows can't run the OS process container (MXC chose " + (probe.tier || "nothing") + (probe.error ? ": " + probe.error : "")
    + "); Pistead never uses MXC's AppContainer fallbacks. Windows 11 24H2/25H2 build .9550 or later is required, or run the connector in WSL2");
}
let child;
try { child = await sdk.spawn(config.request); } catch (error) { fail("the process container could not start: " + (error && error.message || "unknown error")); }
const input = child.standardInput;
if (!input) fail("the process container has no standard input");
for (const chunk of pending) input.write(chunk);
if (process.stdin.readableEnded) input.end();
else {
  process.stdin.on("data", chunk => input.write(chunk));
  process.stdin.on("end", () => input.end());
  process.stdin.resume();
}
const copies = [[child.standardOutput, process.stdout], [child.standardError, process.stderr]].filter(([from]) => from).map(([from, to]) =>
  new Promise(resolve => { from.on("data", chunk => to.write(chunk)); from.on("end", resolve); from.on("error", resolve); }));
const result = await child.wait();
await Promise.all(copies);
process.exitCode = result.timedOut ? 124 : result.exitCode;
`;

export interface WindowsBackendOptions {
  /** Where MXC is installed (see windowsRuntimeDirectory). */
  runtime: string;
  limits: WindowsJobLimits;
}

export class WindowsBackend implements HelperBackend {
  readonly name = "Windows";
  readonly limitedShell = true;
  readonly path: string;
  readonly #runtime: string;
  readonly #sdk: string;
  readonly #limits: Readonly<WindowsJobLimits>;
  readonly #git: string;
  readonly #bash: string;
  readonly #gitRoot: string;

  constructor(options: WindowsBackendOptions) {
    if (process.platform !== "win32") throw new Error("The Windows sandbox runs only on Windows");
    const sdk = mxcEntry(options.runtime);
    if (!sdk) throw new Error(`The Windows sandbox needs Microsoft's MXC SDK. Install it with: ${mxcInstallHint(options.runtime)}`);
    const gitRoot = gitForWindowsRoot();
    const bash = bashPath();
    if (!gitRoot || !bash) throw new Error("The Windows sandbox needs Git for Windows (git and bash.exe): install it from https://git-scm.com/download/win");
    this.#runtime = options.runtime;
    this.#sdk = sdk;
    this.#limits = validWindowsLimits(options.limits);
    this.#gitRoot = gitRoot;
    this.#git = join(gitRoot, "cmd", "git.exe");
    this.#bash = bash;
    const system = process.env.SystemRoot ?? "C:\\Windows";
    // Git for Windows' Unix tools first, as in its own Git Bash.
    this.path = [join(gitRoot, "usr", "bin"), join(gitRoot, "mingw64", "bin"), join(gitRoot, "cmd"), dirname(process.execPath),
      join(system, "System32"), system, join(system, "System32", "WindowsPowerShell", "v1.0")].join(";");
  }

  supports(kind: SandboxRequest["kind"]): boolean { return NODE_HELPER_KINDS.has(kind); }

  async prepare(layout: HelperLayout): Promise<void> {
    // Written afresh at every open: they may be from an older connector, and the session can only read them.
    for (const [name, source] of [["helper.mjs", NODE_HELPER], ["runner.mjs", WINDOWS_RUNNER]] as const) {
      const path = join(layout.bin, name);
      // Windows keeps the read-only attribute in the way of deleting it; clear it first.
      await chmod(path, 0o600).catch(() => undefined);
      await rm(path, { force: true });
      await writeFile(path, source, { mode: 0o400 });
      await chmod(path, 0o400);
    }
  }

  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const port = egressPort(context);
    const environment: Record<string, string> = {
      ...context.environment,
      SANDBOX_GITDIR: layout.git, SANDBOX_GIT: this.#git, SANDBOX_BASH: this.#bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig,
      SystemRoot: system, windir: system, PATH: this.path,
      TEMP: join(layout.home, ".tmp"), TMP: join(layout.home, ".tmp"), USERPROFILE: layout.home,
      // MXC refuses to start a process container whose environment lacks LOCALAPPDATA (presence-only); keep it in home.
      LOCALAPPDATA: join(layout.home, "AppData", "Local"), APPDATA: join(layout.home, "AppData", "Roaming"),
      // Git for Windows' bash starts in HOME and keeps its /tmp in TEMP.
      MSYSTEM: "MINGW64", CHERE_INVOKING: "1",
      // Node's module loader resolves every script and module with the JavaScript realpath, which lstats each folder
      // from the drive root; the container may not see those, so `node script.js` would fail (EPERM, lstat 'C:\').
      // Tools that call fs.realpathSync themselves still can (see docs/design/windows-sandbox.md, third run).
      NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main",
      // MXC replaces the proxy variables with its own URL, without the session's token, and empties NO_PROXY (so even
      // loopback goes to the proxy); the helper puts the session's back.
      ...(port !== undefined ? { SANDBOX_EGRESS_PROXY: context.environment.HTTPS_PROXY!, SANDBOX_EGRESS_NO_PROXY: context.environment.NO_PROXY ?? "" } : {}),
    };
    const readonly = [system, dirname(process.execPath), this.#gitRoot, layout.bin, layout.ownerConfig, layout.caBundle, join(layout.worktree, ".git"),
      ...(context.gitWritable ? [] : [layout.git])];
    const readwrite = context.readOnly ? [] : [layout.home, layout.worktree, ...(context.gitWritable ? [layout.git] : [])];
    if (context.readOnly) readonly.push(layout.home, layout.worktree);
    const containerRequest = {
      // The container can't lstat the drive root, which Node's realpath of the entry script needs; skip that walk.
      command: `"${process.execPath}" --preserve-symlinks-main --preserve-symlinks "${join(layout.bin, "helper.mjs")}"`,
      containment: { type: "processcontainer" },
      filesystem: { readwritePaths: readwrite, readonlyPaths: readonly, deniedPaths: [] },
      // Proxy-only egress (MXC's "Model 2"): the container reaches only the session's loopback proxy; no proxy, no network.
      network: port !== undefined
        ? { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: `http://127.0.0.1:${port}` } }
        : { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      // `disable: true` turns Win32k off, and node.exe, git.exe and whoami.exe then die in DLL init (0xC0000142). The
      // rest of MXC's UI policy (own desktop, no clipboard, no input injection) still applies.
      ui: { disable: false },
      workingDirectory: layout.worktree,
      environment,
      inheritDefaultEnvironment: false,
      timeoutMs: context.deadlineMs,
    };
    let job: WindowsJob | undefined;
    void request;
    return {
      command: process.execPath,
      args: [join(layout.bin, "runner.mjs")],
      cwd: layout.root,
      // The runner gets nothing of the connector's environment: only what Node and MXC need to start.
      env: { SystemRoot: system, windir: system, PATH: [join(system, "System32"), system].join(";"), TEMP: join(layout.home, ".tmp"), TMP: join(layout.home, ".tmp"),
        ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}), ...(process.env.SystemDrive ? { SystemDrive: process.env.SystemDrive } : {}) },
      started: async child => {
        if (!child.pid) throw new Error("the sandbox runner did not start");
        job = WindowsJob.create(this.#runtime, this.#limits);
        job.assign(child.pid);
        return JSON.stringify({ sdk: this.#sdk, request: containerRequest });
      },
      finished: () => { job?.close(); job = undefined; },
    };
  }
}
