import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { WindowsJob } from "./windows-job.js";

/**
 * What differs between the hosts the connector runs on: Linux (and WSL2), macOS and native Windows. Everything that
 * depends on `process.platform` beyond choosing a sandbox backend lives here, so callers read the same everywhere.
 */
export const windows = process.platform === "win32";

/**
 * Open flags with the parts this platform has. Windows defines neither O_NOFOLLOW nor O_DIRECTORY nor O_NONBLOCK, and
 * JavaScript's `|` reads a missing flag as 0, so these keep their meaning wherever the flag exists and drop it elsewhere.
 */
export const OPEN_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const OPEN_DIRECTORY = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
export const CREATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/**
 * Whether a file or directory the connector created is private to it. POSIX hosts check owner and mode bits. Windows has
 * neither: Node reports every writable entry as 0o666 and no owner, and privacy comes from the ACLs the connector's
 * directories inherit from the user's profile, which only that user (and administrators) can read.
 */
export function privateEntry(info: { uid: number | bigint; mode: number | bigint }, mask = 0o077): boolean {
  if (windows) return true;
  return Number(info.uid) === process.getuid?.() && (Number(info.mode) & mask) === 0;
}

/** Whether the entry has exactly `mode` as its permission bits (POSIX), or is anything at all on Windows (see privateEntry). */
export function exactMode(info: { uid: number | bigint; mode: number | bigint }, mode: number): boolean {
  if (windows) return true;
  return Number(info.uid) === process.getuid?.() && (Number(info.mode) & 0o777) === mode;
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** The first of `paths` that exists and is executable. */
export function firstExecutable(paths: readonly (string | undefined)[]): string | undefined {
  return paths.find((path): path is string => !!path && executable(path));
}

/**
 * Bash for agent and host commands. POSIX hosts have /bin/bash. On Windows it is Git for Windows' bash, which comes with
 * the coreutils agents expect: found from PISTEAD_BASH, the usual install locations, or next to `git` on PATH.
 */
export function bashPath(): string | undefined {
  if (!windows) return firstExecutable(["/bin/bash", "/usr/bin/bash"]);
  const programs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
  return firstExecutable([
    process.env.PISTEAD_BASH,
    ...programs.map(root => root && join(root, "Git", "bin", "bash.exe")),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    gitForWindowsRoot() && join(gitForWindowsRoot()!, "bin", "bash.exe"),
  ]);
}

/**
 * The shell for the Windows sandbox's commands. MSYS2 programs, Git for Windows' bash among them, can't start in Windows'
 * process container (their runtime is denied its global named objects), so it is busybox-w32: from PISTEAD_SANDBOX_SHELL, the
 * per-user install at %LOCALAPPDATA%\Programs\busybox, or Git for Windows' MinGit-busybox flavor. Only that one file is
 * granted to the container, so it must be the executable itself (not a launcher such as a Scoop shim).
 */
export function sandboxShellPath(): string | undefined {
  if (!windows) return undefined;
  // Its own variable: PISTEAD_BASH is Git for Windows' bash for unsandboxed and host commands, which take bash's flags.
  if (process.env.PISTEAD_SANDBOX_SHELL) return firstExecutable([process.env.PISTEAD_SANDBOX_SHELL]);
  const root = gitForWindowsRoot();
  return firstExecutable([
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "busybox", "busybox.exe"),
    root && join(root, "mingw64", "bin", "busybox.exe"),
  ]);
}

/** Where to get the sandbox's shell. */
export const SANDBOX_SHELL_HINT = "download busybox64.exe from https://frippery.org/busybox/ and save it as %LOCALAPPDATA%\\Programs\\busybox\\busybox.exe";

let gitRoot: string | null | undefined;
/** Git for Windows' install root (the directory holding bin\bash.exe and usr\bin), from `git --exec-path`. */
export function gitForWindowsRoot(): string | undefined {
  if (!windows) return undefined;
  if (gitRoot === undefined) {
    const result = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
    // ...\Git\mingw64\libexec\git-core
    const exec = result.status === 0 ? result.stdout.trim() : "";
    gitRoot = exec ? dirname(dirname(dirname(exec))) : null;
  }
  return gitRoot ?? undefined;
}

/**
 * The variables Windows programs need to start at all (the system directories, the profile's locations), taken from
 * the connector's environment; never its tokens or provider settings.
 */
export function windowsSystemEnvironment(): Record<string, string> {
  const names = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "CommonProgramFiles", "CommonProgramW6432", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

/** The null device, as Git and shells on this platform name it. */
export const NULL_DEVICE = windows ? "NUL" : "/dev/null";

/**
 * Unsandboxed bash on Windows starts its command only once it is in its job (startHostBash): until then it waits for the
 * command on stdin, so nothing it starts can be outside the job. Its stdin is then empty, as with `stdio: "ignore"`. The
 * variable is cleared inside the evaluated text, so the command never sees it.
 */
const WINDOWS_HOST_BASH = "IFS= read -r -d '' __pistead_command || exit 125; exec 0</dev/null; eval \"unset __pistead_command; $__pistead_command\"";

/** Arguments for bash running an unsandboxed command; spawn it with a piped stdin and call startHostBash. */
export function hostBashArgs(command: string): string[] {
  return ["--noprofile", "--norc", "-c", windows ? WINDOWS_HOST_BASH : command];
}

const hostJobs = new WeakMap<ChildProcess, WindowsJob>();

/**
 * Starts bash spawned with hostBashArgs. On Windows it goes into a job first, so a time limit or cancel (killTree) ends
 * everything it started, background processes included, which `taskkill /T` misses once their parent has exited. Without
 * koffi there is no job, and killTree falls back to `taskkill /T`. Elsewhere bash already has its command.
 */
export function startHostBash(child: ChildProcess, command: string): void {
  if (!windows) { child.stdin?.end(); return; }
  if (child.pid) {
    const job = WindowsJob.hostJob();
    if (job) {
      try {
        job.assign(child.pid);
        hostJobs.set(child, job);
        child.once("close", () => job.release());
      } catch { job.release(); }
    }
  }
  child.stdin?.end(`${command}\0`);
}

/**
 * Stops a command and everything it started. POSIX commands run in their own process group (spawned `detached`), which
 * one signal ends. Windows has no process groups: unsandboxed bash's job (startHostBash) ends all of it; otherwise
 * `taskkill /T` ends the tree the process started.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  const job = hostJobs.get(child);
  if (job) { job.terminate(); return; }
  if (windows) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
}
