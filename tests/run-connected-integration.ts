import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "opencara-connected-ci-"));
const workerConfigPath = join(repository, "apps/worker/wrangler.jsonc");
const configPath = join(temporary, "wrangler.jsonc");
const persist = join(temporary, "state");
const wrangler = join(repository, "node_modules/wrangler/bin/wrangler.js");
let worker: ChildProcess | undefined;
let workerOutput = "";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate integration port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

async function stopWorker(): Promise<void> {
  if (!worker?.pid) return;
  const child = worker;
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
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const testSecret = Buffer.from(randomBytes(32)).toString("base64url");
  const config = JSON.parse(await readFile(workerConfigPath, "utf8"));
  delete config.$schema;
  config.main = resolve(dirname(workerConfigPath), config.main);
  config.assets.directory = resolve(dirname(workerConfigPath), config.assets.directory);
  config.d1_databases = config.d1_databases.map((database: Record<string, unknown>) => ({
    ...database, migrations_dir: resolve(dirname(workerConfigPath), String(database.migrations_dir)),
  }));
  // Production custom-domain routes make wrangler dev rewrite Origin to that host.
  delete config.routes;
  config.vars = { ...config.vars, APP_ORIGIN: origin, RUNNER_URL: "", RUNNER_EVENT_TRANSPORT: "poll",
    TEST_AUTH_ENABLED: "true", TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 20 * 60_000).toISOString() };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const secrets = {
    SESSION_SECRET: Buffer.from(randomBytes(32)).toString("base64url"),
    RUNNER_SHARED_SECRET: Buffer.from(randomBytes(32)).toString("base64url"),
    VAULT_KEY: Buffer.from(randomBytes(32)).toString("base64url"),
    TEST_AUTH_SECRET: testSecret,
  };
  await writeFile(join(temporary, ".dev.vars"), Object.entries(secrets).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"), { mode: 0o600 });
  // Both D1 and R2 stay in this disposable local persistence directory; no remote commands are issued.
  await run([wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", persist]);
  worker = spawn(process.execPath, [wrangler, "dev", "--config", configPath, "--persist-to", persist,
    "--ip", "127.0.0.1", "--port", new URL(origin).port], {
    cwd: repository, env: { ...process.env, CI: "true" },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let workerError: Error | undefined;
  worker.once("error", error => { workerError = error; });
  const collect = (chunk: Buffer) => { workerOutput = (workerOutput + Buffer.from(chunk).toString("utf8")).slice(-12_000); };
  worker.stdout?.on("data", collect);
  worker.stderr?.on("data", collect);
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !ready) {
    if (workerError || worker.exitCode !== null || worker.signalCode !== null) throw new Error("Local Worker exited before readiness", { cause: workerError });
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      const health = await response.json() as { testMode?: boolean; connectorsConfigured?: boolean; backupsConfigured?: boolean };
      ready = response.ok && health.testMode === true && health.connectorsConfigured === true && health.backupsConfigured === true;
    } catch { /* Wait only for this child server's bounded startup. */ }
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error("Local connected Worker did not become ready");
  await run(["--import", "tsx", "tests/integration.ts"], {
    ...process.env, APP_URL: origin, TEST_AUTH_SECRET: testSecret, CONNECTED_RUNTIME: "true", ALLOW_MISSING_BACKUPS: "false",
  });
} catch (error) {
  if (workerOutput) console.error(workerOutput);
  throw error;
} finally {
  await stopWorker();
  await rm(temporary, { recursive: true, force: true });
}
