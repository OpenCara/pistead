import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { HELPER, type SandboxRequest } from "./sandbox.js";
import type { HelperBackend, HelperContext, HelperLaunch, HelperLayout } from "./helper-workspace.js";
import { firstExecutable } from "./platform.js";

/**
 * macOS's kernel sandbox (Seatbelt) as a session's boundary: every step runs the same Python helper as the Linux
 * sandbox, under `sandbox-exec` with a profile generated for that step. Unlike bubblewrap there are no mounts: the
 * session's files are read and written where they are, and the profile decides what the step may reach.
 *
 * What it gives, and what it doesn't:
 * - Reads are denied by default. The session sees its own home and worktree, its Git directory, the CA bundle, and the
 *   system's read-only runtime (the system's binaries and libraries, the selected developer tools, Homebrew); nothing
 *   of the host user's home, other sessions, or the connector's state.
 * - Writes go only to the session's home and worktree; its Git directory only in the workspace's own Git steps.
 * - The network is the session's egress proxy only: outbound connections to its loopback port, which wants the
 *   session's token. Seatbelt's `localhost` also covers the host's other addresses on that port, which is why the token
 *   is required. No other loopback port is reachable, so a session can't reach its own servers either: tests that
 *   start a local server fail on this backend.
 * - No hard memory or process limits (macOS has no cgroups), so shell commands run only where the host's owner allows.
 * - `sandbox_init`/`sandbox-exec` are deprecated in Apple's headers but still ship, and Chromium, Codex and others
 *   depend on them.
 */

/** Only the system's own sandbox-exec, never one found on PATH. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The developer tools `xcode-select` selects (Command Line Tools or Xcode), when root owns the link. */
function developerDirectory(): string | undefined {
  const result = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const path = result.status === 0 ? result.stdout.trim() : "";
  if (!path.startsWith("/")) return undefined;
  // Xcode's tools load frameworks from beside its Developer directory, so the whole app is read-only to the session.
  const app = /^(.*\.app)\/Contents\/Developer$/.exec(path);
  return app ? app[1] : path;
}

/** A tool's real path via xcrun, so sessions don't run the /usr/bin shims, which want caches outside the sandbox. */
function xcrunFind(tool: string): string | undefined {
  const result = spawnSync("/usr/bin/xcrun", ["--find", tool], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const path = result.status === 0 ? result.stdout.trim() : "";
  return path.startsWith("/") && firstExecutable([path]) ? path : undefined;
}

export interface SeatbeltTools {
  python: string;
  git: string;
  bash: string;
  /** Directories with tools and libraries the session may read and run. */
  roots: string[];
  path: string;
}

/** The host's tools for sessions; throws with what is missing. */
export function seatbeltTools(): SeatbeltTools {
  const developer = developerDirectory();
  const python = xcrunFind("python3") ?? firstExecutable(["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]);
  const git = xcrunFind("git") ?? firstExecutable(["/opt/homebrew/bin/git", "/usr/local/bin/git"]);
  if (!python || !git) throw new Error("The macOS sandbox needs Python 3 and Git from the developer tools: run xcode-select --install");
  const homebrew = ["/opt/homebrew", "/usr/local/Homebrew", "/usr/local/Cellar", "/usr/local/opt", "/usr/local/bin", "/usr/local/lib", "/usr/local/share"].filter(path => existsSync(path));
  const roots = [...new Set([developer, ...homebrew, dirname(dirname(python)), dirname(dirname(git))].filter((path): path is string => !!path)
    .map(path => { try { return realpathSync(path); } catch { return path; } }))];
  const binaries = [existsSync("/opt/homebrew/bin") ? "/opt/homebrew/bin" : undefined, existsSync("/usr/local/bin") ? "/usr/local/bin" : undefined,
    developer && !developer.endsWith(".app") ? join(developer, "usr", "bin") : undefined];
  return {
    python, git, bash: "/bin/bash", roots,
    path: ["/usr/bin", "/bin", "/usr/sbin", "/sbin", ...binaries.filter((path): path is string => !!path)].join(":"),
  };
}

export interface SeatbeltPolicy {
  layout: HelperLayout;
  /** Home and worktree read-only: file reads, listings, snapshots, Git reads. */
  readOnly: boolean;
  /** The session's Git directory writable: the workspace's own Git steps. */
  gitWritable: boolean;
  /** The egress proxy's loopback port, when the step may use the network. */
  egressPort?: number;
  /** Tool and library directories, read-only. */
  toolRoots: readonly string[];
}

/**
 * The profile for one step. Paths go in as parameters (`-D NAME=path`), never spliced into the text, so no path can
 * change the profile's meaning. Seatbelt applies the last matching rule, so the denies come last.
 */
export function seatbeltProfile(policy: SeatbeltPolicy): { profile: string; parameters: Record<string, string> } {
  const { layout } = policy;
  const parameters: Record<string, string> = {
    HOME_DIR: layout.home, WORKTREE: layout.worktree, GIT_DIR: layout.git, GIT_POINTER: join(layout.worktree, ".git"),
    OWNER_CONFIG: layout.ownerConfig, CA_BUNDLE: layout.caBundle, BIN: layout.bin,
  };
  policy.toolRoots.forEach((root, index) => { parameters[`TOOL_${index}`] = root; });
  const tools = policy.toolRoots.map((_, index) => `(subpath (param "TOOL_${index}"))`).join(" ");
  const lines = [
    "(version 1)",
    "(deny default)",
    // Processes of the step: they inherit this profile, and may signal and inspect only each other.
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    // What every process needs to start: sysctls of the machine itself (never of other processes' arguments), the
    // user database, POSIX semaphores (Python's multiprocessing) and ptys (tools that spawn shells).
    `(allow sysctl-read ${SYSCTLS.map(name => name.endsWith(".") ? `(sysctl-name-prefix "${name}")` : `(sysctl-name "${name}")`).join(" ")})`,
    "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.system.opendirectoryd.membership\") (global-name \"com.apple.bsd.dirhelper\"))",
    "(allow ipc-posix-sem)",
    "(allow pseudo-tty)",
    "(allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\") (regex #\"^/dev/ttys[0-9]+$\"))",
    "(allow file-read* file-write-data (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\") (literal \"/dev/dtracehelper\"))",
    "(allow file-read* file-write-data (subpath \"/dev/fd\"))",
    // Path resolution reads the metadata of every ancestor; contents stay denied.
    "(allow file-read-metadata)",
    // The system's read-only runtime.
    `(allow file-read* ${SYSTEM_PATHS.map(path => `(subpath "${path}")`).join(" ")} (literal "/"))`,
    `(allow file-map-executable ${EXECUTABLE_PATHS.map(path => `(subpath "${path}")`).join(" ")}${tools ? ` ${tools}` : ""})`,
    ...(tools ? [`(allow file-read* ${tools})`] : []),
    // The session: its files, its read-only configuration and helpers.
    "(allow file-read* (subpath (param \"HOME_DIR\")) (subpath (param \"WORKTREE\")) (subpath (param \"GIT_DIR\")) (subpath (param \"BIN\"))"
      + " (literal (param \"OWNER_CONFIG\")) (literal (param \"CA_BUNDLE\")))",
  ];
  if (!policy.readOnly) {
    lines.push("(allow file-write* (subpath (param \"HOME_DIR\")) (subpath (param \"WORKTREE\")))");
    // Tools talk to their own helpers over Unix sockets in the session's files, never to the host's.
    lines.push("(allow network-bind (local unix-socket (subpath (param \"HOME_DIR\")) (subpath (param \"WORKTREE\"))))");
    lines.push("(allow network-outbound (remote unix-socket (subpath (param \"HOME_DIR\")) (subpath (param \"WORKTREE\"))))");
  }
  if (policy.gitWritable) lines.push("(allow file-write* (subpath (param \"GIT_DIR\")))");
  if (policy.egressPort !== undefined) {
    if (!Number.isInteger(policy.egressPort) || policy.egressPort < 1 || policy.egressPort > 65535) throw new Error("Invalid egress port");
    lines.push(`(allow network-outbound (remote ip "localhost:${policy.egressPort}"))`);
  }
  // Last, so they win: the worktree's pointer to the Git directory, and the Git directory itself outside Git steps.
  lines.push("(deny file-write* (literal (param \"GIT_POINTER\")))");
  if (!policy.gitWritable) lines.push("(deny file-write* (subpath (param \"GIT_DIR\")))");
  return { profile: `${lines.join("\n")}\n`, parameters };
}

/** System paths every step may read: binaries, libraries, frameworks, time zones, and /etc (no secrets on macOS). */
const SYSTEM_PATHS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", "/System", "/Library/Apple",
  "/Library/Preferences", "/private/etc", "/private/var/db/timezone", "/private/var/db/dyld", "/private/var/select"];
const EXECUTABLE_PATHS = ["/usr/lib", "/System/Library/Frameworks", "/System/Library/PrivateFrameworks", "/System/Library/SubFrameworks",
  "/System/Library/Extensions", "/Library/Apple/System/Library/Frameworks", "/Library/Apple/System/Library/PrivateFrameworks", "/Library/Apple/usr/lib"];
/** The machine's own facts (Codex's and Chromium's list); never kern.procargs, which shows other processes' environment. */
const SYSCTLS = ["hw.activecpu", "hw.byteorder", "hw.cacheconfig", "hw.cachelinesize_compat", "hw.cpufamily", "hw.cputype", "hw.logicalcpu", "hw.logicalcpu_max",
  "hw.machine", "hw.model", "hw.memsize", "hw.ncpu", "hw.nperflevels", "hw.optional.", "hw.packages", "hw.pagesize", "hw.pagesize_compat",
  "hw.perflevel", "hw.physicalcpu", "hw.physicalcpu_max", "hw.tbfrequency_compat", "hw.vectorunit", "machdep.cpu.brand_string",
  "kern.argmax", "kern.hostname", "kern.maxfilesperproc", "kern.maxproc", "kern.osproductversion", "kern.osrelease", "kern.ostype",
  "kern.osvariant_status", "kern.osversion", "kern.secure_kernel", "kern.sysv.semmns", "kern.usrstack64", "kern.version",
  "sysctl.proc_cputype", "vm.loadavg", "kern.proc.pid.", "kern.proc.pgrp."];

/** The steps' helper is the Linux sandbox's, told where things are instead of having them mounted. */
export class SeatbeltBackend implements HelperBackend {
  readonly name = "macOS";
  readonly limitedShell = false;
  readonly #tools: SeatbeltTools;

  constructor(tools: SeatbeltTools = seatbeltTools()) {
    if (process.platform !== "darwin") throw new Error("The Seatbelt sandbox runs only on macOS");
    if (!firstExecutable([SANDBOX_EXEC])) throw new Error("The macOS sandbox needs /usr/bin/sandbox-exec");
    this.#tools = tools;
  }

  get path(): string { return this.#tools.path; }

  // The host repository cache isn't available here, so clone steps never borrow from a mirror.
  supports(_kind: SandboxRequest["kind"]): boolean { return true; }

  async prepare(_layout: HelperLayout): Promise<void> {}

  async launch(request: SandboxRequest, context: HelperContext, layout: HelperLayout): Promise<HelperLaunch> {
    const proxy = context.egress ? /^http:\/\/[^@/]+@127\.0\.0\.1:(\d+)$/.exec(context.environment.HTTPS_PROXY ?? "") : null;
    const { profile, parameters } = seatbeltProfile({
      layout, readOnly: context.readOnly, gitWritable: context.gitWritable, toolRoots: this.#tools.roots,
      ...(proxy ? { egressPort: Number(proxy[1]) } : {}),
    });
    void request;
    return {
      command: SANDBOX_EXEC,
      args: ["-p", profile, ...Object.entries(parameters).flatMap(([name, value]) => ["-D", `${name}=${value}`]), this.#tools.python, "-I", "-c", HELPER],
      cwd: layout.worktree,
      env: {
        ...context.environment,
        SANDBOX_GITDIR: layout.git, SANDBOX_GIT: this.#tools.git, SANDBOX_BASH: this.#tools.bash, SANDBOX_OWNER_CONFIG: layout.ownerConfig,
        // The developer tools' shims and Python look for these; there is no other user directory to find.
        TMPDIR: join(layout.home, ".tmp"),
      },
    };
  }
}
