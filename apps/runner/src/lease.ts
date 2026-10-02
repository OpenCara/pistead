import { spawn } from "node:child_process";
import { join } from "node:path";

/** Kernel flock survives stale lock files; pipe EOF releases it even after Node is SIGKILLed. */
export async function acquireRunnerLease(directory: string, onLost: () => void): Promise<() => Promise<void>> {
  if (process.platform !== "linux") throw new Error("Runner lease requires Linux flock; no PID-file fallback");
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let acquired = false;
  let releasing = false;
  let output = "";
  const child = spawn("/usr/bin/flock", ["--exclusive", "--timeout", "5", "--no-fork", join(directory, "runner.lock"),
    "/usr/bin/python3", "-I", "-S", "-c", "import sys\nprint('LOCKED', flush=True)\nsys.stdin.buffer.read()"], {
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
    if (!acquired) ready.reject(new Error("Another runner owns DATA_DIR or mandatory flock is unavailable"));
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
