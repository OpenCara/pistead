import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "opencara-connected-ci-"));
let server: ChildProcess | undefined;
let serverOutput = "";

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate integration port");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function run(args: string[], environment = process.env): Promise<void> {
  const child = spawn(process.execPath, args, { cwd: repository, env: environment, stdio: "inherit", timeout: 300_000 });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Integration subprocess failed (${code ?? "signal"})`);
}

async function stopServer(): Promise<void> {
  if (!server?.pid) return;
  const child = server;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid!, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const deadline = setTimeout(() => signal("SIGKILL"), 5_000);
  try { if (child.exitCode === null && child.signalCode === null) await exited; }
  finally { clearTimeout(deadline); }
}

try {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const testSecret = Buffer.from(randomBytes(32)).toString("base64url");
  const backups = join(temporary, "backups");
  await mkdir(backups, { recursive: true });
  // SQLite and backups stay in this disposable directory unless TEST_DATABASE_URL points the whole run at Postgres.
  const environment: NodeJS.ProcessEnv = {
    ...process.env, CI: "true",
    DATABASE_URL: process.env.TEST_DATABASE_URL || `sqlite://${join(temporary, "db.sqlite")}`,
    STORAGE_URL: `file://${backups}`,
    APP_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(port), TRUST_PROXY: "false",
    RUNNER_URL: "", RUNNER_EVENT_TRANSPORT: "poll",
    TEST_AUTH_ENABLED: "true", TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 20 * 60_000).toISOString(),
    SESSION_SECRET: Buffer.from(randomBytes(32)).toString("base64url"),
    RUNNER_SHARED_SECRET: Buffer.from(randomBytes(32)).toString("base64url"),
    VAULT_KEY: Buffer.from(randomBytes(32)).toString("base64url"),
    TEST_AUTH_SECRET: testSecret,
  };
  await run(["--import", "tsx", "apps/server/src/main.ts", "--migrate-only"], environment);
  server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], {
    cwd: repository, env: environment,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError: Error | undefined;
  server.once("error", error => { serverError = error; });
  const collect = (chunk: Buffer) => { serverOutput = (serverOutput + Buffer.from(chunk).toString("utf8")).slice(-12_000); };
  server.stdout?.on("data", collect);
  server.stderr?.on("data", collect);
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !ready) {
    if (serverError || server.exitCode !== null || server.signalCode !== null) throw new Error("Local server exited before readiness", { cause: serverError });
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      const health = await response.json() as { testMode?: boolean; connectorsConfigured?: boolean; backupsConfigured?: boolean };
      ready = response.ok && health.testMode === true && health.connectorsConfigured === true && health.backupsConfigured === true;
    } catch { /* Wait only for this child server's bounded startup. */ }
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error("Local connected server did not become ready");
  await run(["--import", "tsx", "tests/integration.ts"], {
    ...process.env, APP_URL: origin, TEST_AUTH_SECRET: testSecret, CONNECTED_RUNTIME: "true", ALLOW_MISSING_BACKUPS: "false",
  });
} catch (error) {
  if (serverOutput) console.error(serverOutput);
  throw error;
} finally {
  await stopServer();
  await rm(temporary, { recursive: true, force: true });
}
