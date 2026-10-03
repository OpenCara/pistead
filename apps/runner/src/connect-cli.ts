import { access, constants, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createConnector, controlPlaneOrigin, readConnectorState } from "./connector.js";
import { createFauxLocalModels, loadLocalPiModels } from "./local-pi.js";
import type { ResourceConfig } from "./resources.js";

/** Connector-authored setup failures; safe to print, unlike SDK or HTTP error text. */
export class ConnectorPreflightError extends Error {
  override name = "ConnectorPreflightError";
}

const HELP = `Usage: pistead connect [options]

Connect your local Pi to a Pistead workspace using outbound WebSocket only.
Use Node.js 24 on Linux or WSL2 (or macOS with --unsafe-no-sandbox). In the web app,
configure authorized GitHub repositories for your workspace and pair Pi with it, then run:
  npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID
The pairing code is requested privately on a terminal, never as an argument.
Subsequent runs use the private saved connector token.
Pairing keeps Pi runtime access private to you; sharing it with teammates is opt-in.
New sessions are workspace-viewable by default, without granting agent control.

Options:
  --server ORIGIN          HTTPS control-plane origin (required for first pairing)
  --pairing-id ID          One-use pairing id from the web app
  --state-dir PATH         Private connector state (default ~/.local/share/opencara/connector)
  --pi-agent-dir PATH      Pi config/auth directory (default: Pi's own getAgentDir())
  --model PROVIDER/MODEL   Advertise this configured local model (repeatable)
  --resources PATH        Operator-provisioned resource configuration JSON
  --allow-insecure-loopback  Permit HTTP/WS only on localhost/127.0.0.1/[::1]
  --allow-test-shell       Fixture shell opt-in; requires --allow-faux
  --unsafe-no-sandbox      Run agent work directly on this machine without isolation
                           (macOS or Linux without bubblewrap); asks for confirmation
  --help                  Show this help without reading Pi configuration

Linux or WSL2 with working bubblewrap, Python 3, Git and flock is required for the
isolated sandbox. Native Windows is unsupported; run this command inside WSL2.
--unsafe-no-sandbox needs only Python 3 and Git, but approved commands then run as
your user with access to your files, credentials and network, and no resource limits.
Session repositories are pinned into private session caches, not your current folder.
Production bash additionally requires verified per-session aggregate cgroups and a
bounded private filesystem;
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

function unsandboxedWarning(): string {
  return `
WARNING: running WITHOUT a sandbox (--unsafe-no-sandbox).
Agent work for sessions on this host runs directly as "${userInfo().username}" on this machine:
  - Approved shell commands and commits run with your full user permissions. They can read
    and change anything you can, including ~/.ssh, cloud and Git credentials and Pi's auth.
  - Commands have unrestricted network access and no CPU, memory or disk limits.
  - File tools are confined to each session folder by path checks only, not isolation.
  - Prompts and repository content can try to trick the agent. Read every command in the
    approval desk before approving it.
  - Anyone you share this Pi with, and anyone granted approve permission on a session that
    runs here, can cause approved commands to run on this machine.
Pistead shows this host as "Unsandboxed" to everyone who can see it.

`;
}

async function confirmUnsandboxed(): Promise<void> {
  process.stderr.write(unsandboxedWarning());
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write("Non-interactive terminal: --unsafe-no-sandbox is taken as your consent.\n");
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  prompt.on("SIGINT", () => prompt.close());
  try {
    const answer = await prompt.question('Type "unsandboxed" to continue: ').catch(() => "");
    if (answer.trim() !== "unsandboxed") throw new ConnectorPreflightError("Unsandboxed mode was not confirmed; nothing was started.");
  } finally {
    prompt.close();
  }
}

export async function connectMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: "boolean" }, server: { type: "string" }, "pairing-id": { type: "string" },
    "state-dir": { type: "string" }, "pi-agent-dir": { type: "string" }, model: { type: "string", multiple: true },
    resources: { type: "string" }, "allow-insecure-loopback": { type: "boolean" },
    "allow-faux": { type: "boolean" }, "allow-test-shell": { type: "boolean" }, "unsafe-no-sandbox": { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const unsandboxed = values["unsafe-no-sandbox"] === true;
  if (Number(process.versions.node.split(".")[0]) < 24) throw new ConnectorPreflightError(`Node.js 24 or newer is required (found ${process.versions.node}).`);
  if (process.platform === "darwin" && !unsandboxed) {
    throw new ConnectorPreflightError("macOS has no isolated sandbox: it needs Linux or WSL2 with bubblewrap. To run agent work directly on this Mac, re-run with --unsafe-no-sandbox and read its warning.");
  }
  if (process.platform !== "linux" && process.platform !== "darwin") throw new ConnectorPreflightError(`Unsupported platform "${process.platform}": use Linux, WSL2 or macOS.`);
  if (unsandboxed && values.resources) throw new ConnectorPreflightError("--resources configures Linux sandbox limits and cannot be combined with --unsafe-no-sandbox.");
  if (values["allow-test-shell"] && !values["allow-faux"]) throw new ConnectorPreflightError("--allow-test-shell requires --allow-faux.");
  if (values["pairing-id"] && !values.server) throw new ConnectorPreflightError("First pairing requires --server, e.g. --server https://pistead.com.");
  if (values.server) {
    try { controlPlaneOrigin(values.server, values["allow-insecure-loopback"]); }
    catch { throw new ConnectorPreflightError("--server must be an HTTPS origin such as https://pistead.com."); }
  }
  const required: Record<string, string> = unsandboxed
    ? { "/usr/bin/python3": "Python 3", "/usr/bin/git": "Git", ...(process.platform === "linux" ? { "/usr/bin/flock": "flock (util-linux)" } : {}) }
    : { "/usr/bin/bwrap": "bubblewrap", "/usr/bin/python3": "Python 3", "/usr/bin/git": "Git", "/usr/bin/flock": "flock (util-linux)" };
  const missing: string[] = [];
  for (const [binary, name] of Object.entries(required)) {
    try { await access(binary, constants.X_OK); } catch { missing.push(`${name} (${binary})`); }
  }
  if (missing.length) {
    throw new ConnectorPreflightError(`Missing prerequisites: ${missing.join(", ")}.${process.platform === "darwin" ? " Install the Xcode Command Line Tools: xcode-select --install." : unsandboxed ? "" : " Without bubblewrap you can run --unsafe-no-sandbox instead; read its warning first."}`);
  }
  const models = values.model?.map(reference => {
    const slash = reference.indexOf("/");
    if (slash < 1 || slash === reference.length - 1) throw new ConnectorPreflightError("--model expects PROVIDER/MODEL.");
    return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
  });
  if (values["allow-faux"] && (values["pi-agent-dir"] || models)) throw new ConnectorPreflightError("Fixture mode cannot select personal Pi models.");
  const localModels = values["allow-faux"] ? createFauxLocalModels() : await loadLocalPiModels({ agentDir: values["pi-agent-dir"], models });
  if (!(await localModels.manifest()).length) throw new ConnectorPreflightError("No authenticated local Pi models are configured. Configure a provider and model in Pi on this machine first.");
  const resources = values.resources ? await resourceConfig(values.resources) : undefined;
  const dataDir = values["state-dir"] ?? join(homedir(), ".local", "share", "opencara", "connector");
  if (!values["pairing-id"] && !await readConnectorState(dataDir, undefined, values["allow-insecure-loopback"])) {
    throw new ConnectorPreflightError("This machine is not paired yet. In Pistead, open Connections, create a pairing code, then run:\n  npx pistead@latest connect --server https://pistead.com --pairing-id <PAIRING_ID>");
  }
  if (unsandboxed) await confirmUnsandboxed();
  const pairing = values["pairing-id"] ? { id: values["pairing-id"], code: await promptPairingCode() } : undefined;
  const connector = createConnector({
    dataDir,
    server: values.server, pairing, localModels, resources, unsandboxed,
    allowInsecureLoopback: values["allow-insecure-loopback"], allowFaux: values["allow-faux"], allowTestShell: values["allow-test-shell"],
    // Binary presence cannot attest a working namespace or a per-session resource
    // domain. Advertise conservatively; each actual operation verifies isolation.
    capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    onStatus: status => { process.stderr.write(`Local connector: ${status}\n`); },
    onWarning: () => { process.stderr.write("Some resource domains are unavailable; production bash remains fail-closed.\n"); },
  });
  process.stderr.write(unsandboxed
    ? "Running unsandboxed: approved commands execute directly on this machine.\n"
    : "Sandbox capability is verified per session; production shell stays disabled without provisioned, verified limits.\n");
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
