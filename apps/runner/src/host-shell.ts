import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import type { HostCommandOperation } from "../../../packages/shared/src/types.js";
import { validHostOperation } from "../../../packages/shared/src/host-operations.js";
import { MAX_OUTPUT_BYTES, SandboxProcessError } from "./process-output.js";
import { bashPath, killTree, windows, windowsSystemEnvironment } from "./platform.js";

/** No namespace or resource boundary. Callers must verify the host owner's exact approval immediately before launch. */
export async function runHostShell(operation: HostCommandOperation, options: {
  worktree: string; git: string; gitConfig: string; gitName: string; gitEmail: string; signal: AbortSignal;
}): Promise<string> {
  if (!validHostOperation(operation) || operation.kind !== "host.bash") throw new Error("Invalid host command");
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Use host tools and the host home (SDKs/caches), but never inherit the connector's tokens or provider environment.
    const bash = bashPath();
    if (!bash) throw new Error(windows ? "Host commands need Git for Windows' bash.exe" : "Host commands need /bin/bash");
    const child = spawn(bash, ["--noprofile", "--norc", "-c", operation.command], {
      cwd: options.worktree, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        // Windows needs its system variables to start anything; bash finds its own tools from Git's install.
        ...(windows ? windowsSystemEnvironment() : {}),
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: homedir(), TMPDIR: tmpdir(),
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", PWD: options.worktree,
        SANDBOX_WORKTREE: options.worktree, GIT_DIR: options.git, GIT_WORK_TREE: options.worktree,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: options.gitConfig,
        GIT_AUTHOR_NAME: options.gitName, GIT_COMMITTER_NAME: options.gitName,
        GIT_AUTHOR_EMAIL: options.gitEmail, GIT_COMMITTER_EMAIL: options.gitEmail,
      },
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    const kill = () => killTree(child);
    const stop = (reason: string) => {
      failure ??= reason;
      kill();
      // A detached descendant may retain the pipes after Bash dies; do not wait for its output forever.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const abort = () => stop("Host command cancelled");
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const timer = setTimeout(() => stop("Host command exceeded its time limit"), operation.timeoutSeconds * 1000);
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - size);
      if (remaining) target.push(chunk.subarray(0, remaining));
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) stop("Host command exceeded its output limit");
    };
    child.stdout.on("data", (chunk: Buffer) => capture(out, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(err, chunk));
    child.on("error", () => { failure ??= "Cannot start host bash"; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      // Best effort only: unrestricted commands can deliberately escape a process group.
      kill();
      const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
      if (failure || code !== 0 || signal) reject(new SandboxProcessError(
        `${failure ?? `Host command failed (${signal ?? `exit ${code}`})`}${stderr ? `: ${stderr.slice(0, 4096).trim()}` : ""}`,
        code, signal, stdout, stderr,
      ));
      else resolve(stdout + stderr);
    });
  });
}
