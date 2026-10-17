/**
 * A local Pistead for developing the native apps: a test-mode server on 127.0.0.1, a test user with a native app token,
 * a workspace and, unless --no-host, this machine as a host offering the deterministic fixture model (not an LLM), with
 * one session on it. --pairing also creates a pairing code for the desktop app to pair this machine itself.
 *
 *   pnpm dev:native [--port 8787] [--no-host] [--pairing]
 *
 * Everything lives in a temporary directory that is removed on Ctrl-C; .local/dev-native.json has what the apps need.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createConnector } from "../apps/runner/src/connector.js";
import { createFauxLocalModels } from "../apps/runner/src/local-pi.js";
import type { ConnectorPairing } from "../packages/shared/src/connector.js";
import type { ModelDefinition, NativeSignIn, SessionRecord, Workspace } from "../packages/shared/src/types.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "8787" }, "no-host": { type: "boolean" }, pairing: { type: "boolean" } } });
const repository = fileURLToPath(new URL("../", import.meta.url));
const origin = `http://127.0.0.1:${Number(values.port)}`;
const secret = () => Buffer.from(randomBytes(32)).toString("base64url");
const testSecret = secret();
// The connector refuses state under a symlink, and macOS's temporary directory lives behind /var -> /private/var.
const temporary = await realpath(await mkdtemp(join(tmpdir(), "pistead-dev-native-")));
let server: ChildProcess | undefined;
let stopHost = async () => {};

async function shutdown(): Promise<void> {
  await stopHost().catch(() => {});
  if (server?.pid && server.exitCode === null) {
    const exited = new Promise<void>(resolve => server!.once("exit", () => resolve()));
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already gone. */ }
    await Promise.race([exited, delay(5_000)]);
  }
  await rm(temporary, { recursive: true, force: true });
}

/** A test user's browser-style client: the session cookie plus a CSRF token for every change. */
async function signIn(id: string) {
  const login = await fetch(`${origin}/api/auth/test`, { method: "POST", body: JSON.stringify({ id, displayName: "Dev", gitName: "Dev", gitEmail: "dev@example.test" }),
    headers: { Authorization: `Bearer ${testSecret}`, "Content-Type": "application/json", Origin: origin } });
  if (!login.ok) throw new Error(`Test sign-in failed (${login.status})`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken } = await (await fetch(`${origin}/api/auth/csrf`, { headers: { Cookie: cookie } })).json() as { csrfToken: string };
  return async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Cookie: cookie, Origin: origin, "x-csrf-token": csrfToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${value.error ?? ""}`);
    return value;
  };
}

try {
  await mkdir(join(temporary, "backups"));
  const environment: NodeJS.ProcessEnv = {
    ...process.env, DATABASE_URL: `sqlite://${join(temporary, "pistead.sqlite")}`, STORAGE_URL: `file://${join(temporary, "backups")}`,
    APP_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(Number(values.port)), TRUST_PROXY: "false", RUNNER_URL: "",
    TEST_AUTH_ENABLED: "true", TEST_AUTH_SECRET: testSecret, TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 24 * 3600_000).toISOString(),
    SESSION_SECRET: secret(), RUNNER_SHARED_SECRET: secret(), VAULT_KEY: secret(), STATIC_DIR: join(repository, "dist", "web"),
  };
  server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], { cwd: repository, env: environment, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error("The server exited during start-up; is the port in use?");
    const health = await fetch(`${origin}/api/health`).then(response => response.json() as Promise<{ testMode?: boolean }>).catch(() => undefined);
    if (health?.testMode) break;
    if (Date.now() > deadline) throw new Error("The server did not start within a minute");
    await delay(200);
  }
  const request = await signIn("dev");
  const native = await fetch(`${origin}/api/auth/test`, { method: "POST", body: JSON.stringify({ id: "dev", client: "native", deviceName: "Development app" }),
    headers: { Authorization: `Bearer ${testSecret}`, "Content-Type": "application/json" } }).then(response => response.json() as Promise<NativeSignIn>);
  const { workspace } = await request<{ workspace: Workspace }>("POST", "/api/workspaces", { name: "Dev workspace" });
  let session: SessionRecord | undefined;
  if (!values["no-host"]) {
    const { pairing } = await request<{ pairing: ConnectorPairing }>("POST", "/api/connectors/pairings", { name: "Fixture host", workspaceId: workspace.id });
    const host = createConnector({
      server: origin, dataDir: join(temporary, "connector"), pairing: { id: pairing.id, code: pairing.code },
      localModels: createFauxLocalModels("faux-1"), allowFaux: true, allowTestShell: true, allowInsecureLoopback: true,
      // macOS has no sandbox: the fixture's approved commands run directly on this machine, as `pistead connect --unsafe-no-sandbox`.
      unsandboxed: process.platform !== "linux", capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    });
    stopHost = () => host.stop();
    await host.start();
    const { models } = await request<{ models: ModelDefinition[] }>("GET", `/api/workspaces/${workspace.id}/models`);
    ({ session } = await request<{ session: SessionRecord }>("POST", "/api/sessions", { workspaceId: workspace.id, modelId: models[0]!.id, title: "Fixture session" }));
  }
  const desktopPairing = values.pairing
    ? (await request<{ pairing: ConnectorPairing }>("POST", "/api/connectors/pairings", { name: "Desktop app", workspaceId: workspace.id })).pairing
    : undefined;
  const details = { server: origin, token: native.token, testSecret, workspaceId: workspace.id, sessionId: session?.id ?? null,
    pairing: desktopPairing ? { id: desktopPairing.id, code: desktopPairing.code } : null };
  await mkdir(join(repository, ".local"), { recursive: true });
  await writeFile(join(repository, ".local", "dev-native.json"), `${JSON.stringify(details, null, 2)}\n`, { mode: 0o600 });
  console.log(`
Pistead for native app development is running at ${origin}
  Native app token (developer sign-in): ${native.token}
  Workspace: ${workspace.id}${session ? `\n  Session on the fixture host: ${session.id} (send "TEST_BASH echo hi" for an approval)` : ""}${desktopPairing ? `
  Desktop pairing: id ${desktopPairing.id}, code ${desktopPairing.code} (valid 10 minutes)` : ""}
  More tokens: curl -X POST ${origin}/api/auth/test -H 'Authorization: Bearer ${testSecret}' -H 'Content-Type: application/json' -d '{"id":"dev","client":"native"}'
Details are in .local/dev-native.json. Ctrl-C stops everything and deletes its data.`);
  const stopped = Promise.withResolvers<void>();
  process.once("SIGINT", () => stopped.resolve());
  process.once("SIGTERM", () => stopped.resolve());
  await stopped.promise;
} finally {
  await shutdown();
}
