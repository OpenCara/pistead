import { spawn } from "node:child_process";
import { join } from "node:path";

// macOS has no flock(1); Python's fcntl.flock takes the same BSD advisory lock.
const PYTHON_FLOCK = `import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
deadline = time.monotonic() + 5
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() > deadline:
            sys.exit(1)
        time.sleep(0.1)
print('LOCKED', flush=True)
sys.stdin.buffer.read()`;

/** Kernel flock survives stale lock files; pipe EOF releases it even after Node is SIGKILLed. */
export async function acquireRunnerLease(directory: string, onLost: () => void): Promise<() => Promise<void>> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Runner lease requires Linux or macOS flock; no PID-file fallback");
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let acquired = false;
  let releasing = false;
  let output = "";
  const lock = join(directory, "runner.lock");
  const child = process.platform === "linux"
    ? spawn("/usr/bin/flock", ["--exclusive", "--timeout", "5", "--no-fork", lock,
      "/usr/bin/python3", "-I", "-S", "-c", "import sys\nprint('LOCKED', flush=True)\nsys.stdin.buffer.read()"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "ignore"],
    })
    : spawn("/usr/bin/python3", ["-I", "-S", "-c", PYTHON_FLOCK, lock], {
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
