import { spawn } from "node:child_process";
import { join } from "node:path";
import { ConnectorSetupError } from "./protocol.js";

// The guardian reports LOCKED, then holds the kernel lock until its stdin reaches EOF.
const GUARDIAN = ["/bin/sh", "-c", "echo LOCKED; exec /bin/cat >/dev/null"];

/** Kernel flock survives stale lock files; pipe EOF releases it even after Node is SIGKILLed. */
export async function acquireRunnerLease(directory: string, onLost: () => void): Promise<() => Promise<void>> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Runner lease requires Linux flock or macOS lockf; no PID-file fallback");
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let acquired = false;
  let releasing = false;
  let output = "";
  const lock = join(directory, "runner.lock");
  // util-linux flock(1) on Linux; macOS lockf(1) takes the same flock(2) lock via O_EXLOCK.
  const child = process.platform === "linux"
    ? spawn("/usr/bin/flock", ["--exclusive", "--timeout", "5", "--no-fork", lock, ...GUARDIAN], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "ignore"],
    })
    : spawn("/usr/bin/lockf", ["-k", "-s", "-t", "5", lock, ...GUARDIAN], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "ignore"],
    });
  child.stdin.on("error", () => { /* Exit handler makes a lost lease fatal. */ });
  child.stdout.on("data", (chunk: Uint8Array) => {
    output += new TextDecoder().decode(chunk);
    if (output === "LOCKED\n" && !acquired) { acquired = true; ready.resolve(); }
    else if (output.length > 128) child.kill("SIGKILL");
  });
  child.once("error", () => ready.reject(new Error("Cannot start mandatory flock guardian")));
  child.once("close", () => {
    exited.resolve();
    if (!acquired) ready.reject(new ConnectorSetupError("Another connector or runner is already using this state directory (or flock/lockf is unavailable)"));
    else if (!releasing) onLost();
  });
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    ready.reject(new Error("Mandatory flock guardian did not acquire its lease"));
  }, 7000);
  try { await ready.promise; } finally { clearTimeout(timeout); }
  return async () => {
    releasing = true;
    child.stdin.end();
    await exited.promise;
  };
}
