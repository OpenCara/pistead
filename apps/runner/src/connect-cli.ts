import { access, constants, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createConnector, controlPlaneOrigin } from "./connector.js";
import { createFauxLocalModels, loadLocalPiModels } from "./local-pi.js";
import type { ResourceConfig } from "./resources.js";

const HELP = `Usage: pnpm connect [options]

Connect your local Pi to a workspace control plane using outbound WebSocket only.
First pair in the web app, then run:
  pnpm connect --server https://workspace.example --pairing-id PAIRING_ID
The pairing code is requested privately on a terminal, never as an argument.
Subsequent runs use the private saved connector token.

Options:
  --server ORIGIN          HTTPS control-plane origin (required for first pairing)
  --pairing-id ID          One-use pairing id from the web app
  --state-dir PATH         Private connector state (default ~/.local/share/opencara/connector)
  --pi-agent-dir PATH      Pi config/auth directory (default: Pi's own getAgentDir())
  --model PROVIDER/MODEL   Advertise this configured local model (repeatable)
  --resources PATH        Operator-provisioned resource configuration JSON
  --allow-insecure-loopback  Permit HTTP/WS only on localhost/127.0.0.1/[::1]
  --allow-faux             Explicit deterministic fixture model instead of local Pi
  --allow-test-shell       Fixture shell opt-in; requires --allow-faux
  --help                  Show this help without reading Pi configuration

Linux, bubblewrap, Python 3, Git and flock are required. Production bash additionally
requires verified per-session aggregate cgroups and a bounded private filesystem;
--resources does not provision these. Missing resource limits never enable host shell.
Pi model/auth configuration is used locally, including Pi's OAuth refresh. Provider
credentials, private history and personal extensions are not uploaded or shared.
Catalogs over 200 models require explicit --model selection. Restart to reload config.
`;

export function promptPairingCode(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) throw new Error("Pairing requires a private interactive terminal; codes are never accepted on argv or stdin pipes");
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  const completion = Promise.withResolvers<string>();
  let code = "";
  let finished = false;
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onError);
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onTerminate);
    try { process.stdin.setRawMode(wasRaw); } catch { /* Terminal may have closed. */ }
    if (wasPaused) process.stdin.pause();
    process.stderr.write("\n");
    if (error) completion.reject(error); else completion.resolve(code);
    code = "";
  };
  const onData = (chunk: Buffer | string) => {
    for (const char of (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))) {
      if (char === "\r" || char === "\n") { finish(); return; }
      if (char === "\u0003" || char === "\u0004") { finish(new Error("Pairing cancelled")); return; }
      if (char === "\u007f" || char === "\b") { code = code.slice(0, -1); continue; }
      if (!/^[A-Za-z0-9_-]$/.test(char) || code.length >= 256) { finish(new Error("Invalid pairing code")); return; }
      code += char;
    }
  };
  const onEnd = () => finish(new Error("Pairing terminal closed"));
  const onError = () => finish(new Error("Pairing terminal unavailable"));
  const onTerminate = () => finish(new Error("Pairing cancelled"));
  process.stderr.write("Pairing code (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onError);
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);
  process.stdin.resume();
  return completion.promise;
}

async function resourceConfig(path: string): Promise<ResourceConfig> {
  const raw: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("Invalid resource configuration");
  const value = raw as Record<string, unknown>;
  const numeric = ["cpuQuotaMicros", "cpuPeriodMicros", "memoryMaxBytes", "pidsMax", "writableMaxBytes", "writableMaxInodes"] as const;
  if (Object.keys(value).some(key => !["cgroupRoot", "controlRoot", ...numeric].includes(key))
    || typeof value.cgroupRoot !== "string" || !value.cgroupRoot.startsWith("/")
    || typeof value.controlRoot !== "string" || !value.controlRoot.startsWith("/")
    || numeric.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 1)) throw new Error("Invalid resource configuration");
  return {
    cgroupRoot: value.cgroupRoot, controlRoot: value.controlRoot,
    cpuQuotaMicros: Number(value.cpuQuotaMicros), cpuPeriodMicros: Number(value.cpuPeriodMicros),
    memoryMaxBytes: Number(value.memoryMaxBytes), pidsMax: Number(value.pidsMax),
    writableMaxBytes: Number(value.writableMaxBytes), writableMaxInodes: Number(value.writableMaxInodes),
  };
}

export async function connectMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: "boolean" }, server: { type: "string" }, "pairing-id": { type: "string" },
    "state-dir": { type: "string" }, "pi-agent-dir": { type: "string" }, model: { type: "string", multiple: true },
    resources: { type: "string" }, "allow-insecure-loopback": { type: "boolean" },
    "allow-faux": { type: "boolean" }, "allow-test-shell": { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or newer is required");
  if (process.platform !== "linux") throw new Error("This sandbox adapter supports Linux only; no unsafe host-shell fallback is available");
  if (values["allow-test-shell"] && !values["allow-faux"]) throw new Error("Test shell requires explicit faux mode");
  if (values["pairing-id"] && !values.server) throw new Error("First pairing requires --server");
  if (values.server) controlPlaneOrigin(values.server, values["allow-insecure-loopback"]);
  for (const binary of ["/usr/bin/bwrap", "/usr/bin/python3", "/usr/bin/git", "/usr/bin/flock"]) {
    try { await access(binary, constants.X_OK); } catch { throw new Error("Linux sandbox prerequisites are unavailable (bubblewrap, Python 3, Git, flock)"); }
  }
  const models = values.model?.map(reference => {
    const slash = reference.indexOf("/");
    if (slash < 1 || slash === reference.length - 1) throw new Error("--model expects PROVIDER/MODEL");
    return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
  });
  if (values["allow-faux"] && (values["pi-agent-dir"] || models)) throw new Error("Fixture mode cannot select personal Pi models");
  const localModels = values["allow-faux"] ? createFauxLocalModels() : await loadLocalPiModels({ agentDir: values["pi-agent-dir"], models });
  if (!(await localModels.manifest()).length) throw new Error("No authenticated local Pi models are configured");
  const resources = values.resources ? await resourceConfig(values.resources) : undefined;
  const pairing = values["pairing-id"] ? { id: values["pairing-id"], code: await promptPairingCode() } : undefined;
  const connector = createConnector({
    dataDir: values["state-dir"] ?? join(homedir(), ".local", "share", "opencara", "connector"),
    server: values.server, pairing, localModels, resources,
    allowInsecureLoopback: values["allow-insecure-loopback"], allowFaux: values["allow-faux"], allowTestShell: values["allow-test-shell"],
    // Binary presence cannot attest a working namespace or a per-session resource
    // domain. Advertise conservatively; each actual operation verifies isolation.
    capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    onStatus: status => { process.stderr.write(`Local connector: ${status}\n`); },
    onWarning: () => { process.stderr.write("Some resource domains are unavailable; production bash remains fail-closed.\n"); },
  });
  process.stderr.write("Sandbox capability is verified per session; production shell stays disabled without provisioned, verified limits.\n");
  const stopped = Promise.withResolvers<void>();
  const stop = () => { void connector.stop().then(() => stopped.resolve(), () => stopped.reject(new Error("Connector shutdown failed"))); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await connector.start(); await stopped.promise; }
  finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await connector.stop();
    if (pairing) pairing.code = "";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void connectMain().catch(() => {
    // SDK/HTTP errors can contain auth/config detail. Never log their raw text.
    process.stderr.write("Connector failed. Check --help, private state permissions, pairing, local Pi configuration and Linux sandbox prerequisites.\n");
    process.exitCode = 1;
  });
}
