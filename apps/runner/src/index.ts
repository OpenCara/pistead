import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { acquireRunnerLease } from "./lease.js";
import { RunnerService, createRunnerApp } from "./server.js";
import { recoverResourceOrphans, validateResourceConfig, type ResourceConfig } from "./resources.js";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("This runner requires Node 24 or newer");
let resources: Readonly<ResourceConfig> | undefined;
if (process.env.RUNNER_RESOURCES_FILE) {
  try { resources = validateResourceConfig(JSON.parse(await readFile(process.env.RUNNER_RESOURCES_FILE, "utf8"))); }
  catch { console.error("Invalid resource configuration; production shell remains unavailable."); }
}
const service = new RunnerService({
  dataDir: process.env.DATA_DIR ?? ".local/runner",
  controlPlaneUrl: (process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""),
  sharedSecret: process.env.RUNNER_SHARED_SECRET ?? "",
  allowFaux: process.env.ALLOW_FAUX_MODEL === "true",
  allowTestShell: process.env.ALLOW_TEST_SHELL === "true",
  resources,
});
await service.initialize();
const releaseLease = await acquireRunnerLease(service.dataDir, () => {
  console.error("Mandatory runner lease lost; terminating execution");
  process.exit(1);
});
if (resources) {
  try { await recoverResourceOrphans(resources); }
  catch { console.error("Resource recovery requires operator attention; every production shell still requires its own verified resource domain."); }
}
const app = createRunnerApp(service);
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const server = serve({ fetch: app.fetch, port, hostname: process.env.RUNNER_HOST ?? "127.0.0.1" }, address => {
  console.log(`pi-durable runner listening on ${process.env.RUNNER_HOST ?? "127.0.0.1"}:${address.port}; faux test provider ${service.config.allowFaux ? "enabled (not an LLM)" : "disabled"}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  try { await service.close(); await releaseLease(); }
  finally { process.exit(0); }
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
