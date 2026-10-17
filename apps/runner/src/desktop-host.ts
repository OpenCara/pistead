import { parseArgs } from "node:util";
import { z } from "zod";
import { createConnector, controlPlaneOrigin, type LocalConnector } from "./connector.js";
import { assertConnectorPlatform, assertPrerequisites, checkPrerequisites, defaultStateDir, loadConnectorModels, savedPairing, unsandboxedWarning } from "./connect-setup.js";
import { pairingCodePattern, pairingIdPattern, type HostError, type HostErrorCode, type HostEvent, type HostInspection, type HostRequest, type HostState, type Prerequisite, type StartRequest } from "./desktop-protocol.js";
import { RunnerLeaseBusyError } from "./lease.js";
import { ConnectorSetupError } from "./protocol.js";

// The connector, run by a desktop app instead of a terminal: requests arrive over the parent's IPC channel (Electron's
// utilityProcess parentPort, or Node's fork channel) and status, logs and failures go back the same way.

class HostFailure extends ConnectorSetupError {
  constructor(readonly code: HostErrorCode, message: string) { super(message); }
}

const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const developmentOptions = { allowFaux: z.boolean().optional(), allowInsecureLoopback: z.boolean().optional() };
/** Strict: unknown request types and unknown fields are refused, never ignored. */
const hostRequestSchema: z.ZodType<HostRequest> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect"), id: requestId, ...developmentOptions }).strict(),
  z.object({
    type: z.literal("start"), id: requestId, server: z.string().min(1).max(2048),
    pairing: z.object({ id: z.string().regex(pairingIdPattern), code: z.string().regex(pairingCodePattern) }).strict().optional(),
    replacePairing: z.boolean().optional(), gitCredentials: z.boolean().optional(), unsandboxedConsent: z.boolean().optional(),
    models: z.array(z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict()).min(1).max(200).optional(),
    ...developmentOptions,
  }).strict(),
  z.object({ type: z.literal("stop"), id: requestId }).strict(),
]);

interface Transport {
  send(event: HostEvent): void;
  onMessage(listener: (value: unknown) => void): void;
  onClose(listener: () => void): void;
}

/** Electron's utilityProcess `process.parentPort`. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

function parentTransport(): Transport {
  const candidate = "parentPort" in process ? process.parentPort : undefined;
  if (candidate && typeof candidate === "object" && "postMessage" in candidate && "on" in candidate) {
    // Shape checked above; Electron documents postMessage and on("message") with MessageEvent-like { data }.
    const port = candidate as ParentPort;
    // Electron tears a utility process down with its parent, so only Node's channel reports a close.
    return { send: event => port.postMessage(event), onMessage: listener => port.on("message", event => listener(event.data)), onClose: () => {} };
  }
  const send = process.send?.bind(process);
  if (!send) throw new Error("The desktop host must be started by the Pistead app");
  return {
    send: event => { if (process.connected) send(event); },
    onMessage: listener => process.on("message", listener),
    onClose: listener => process.once("disconnect", listener),
  };
}

/** Only connector-authored text crosses to the app: SDK and HTTP errors can carry auth or configuration detail. */
function hostError(error: unknown, fallback: string): HostError {
  if (error instanceof HostFailure) return { code: error.code, message: error.message };
  if (error instanceof RunnerLeaseBusyError) return { code: "lease-busy", message: "Another Pistead connector is already running with this computer's pairing, for example `pistead connect` in a terminal. Stop it there, then start the host here." };
  if (error instanceof ConnectorSetupError) return { code: "setup", message: error.message };
  return { code: "failed", message: fallback };
}

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { "state-dir": { type: "string" } } });
const stateDir = values["state-dir"] ?? defaultStateDir();
const transport = parentTransport();
let running: { connector: LocalConnector; stopRequested: boolean } | undefined;

function emit(event: HostEvent): void { transport.send(event); }
function log(level: "info" | "warning" | "error", message: string): void { emit({ type: "log", level, message }); }
function status(state: HostState, detail: { server?: string; unsandboxed?: boolean } = {}): void { emit({ type: "status", state, ...detail }); }

/** Sandboxed only on Linux with every sandbox prerequisite; anything else runs unsandboxed after explicit consent. */
async function isolation(): Promise<{ mode: HostInspection["mode"]; sandboxPrerequisites?: Prerequisite[]; prerequisites: Prerequisite[] }> {
  if (process.platform !== "linux") return { mode: "unsandboxed", prerequisites: await checkPrerequisites(true) };
  const sandboxPrerequisites = await checkPrerequisites(false);
  return sandboxPrerequisites.every(item => item.ok)
    ? { mode: "sandboxed", sandboxPrerequisites, prerequisites: sandboxPrerequisites }
    : { mode: "unsandboxed", sandboxPrerequisites, prerequisites: await checkPrerequisites(true) };
}

async function inspect(allowFaux = false, allowInsecureLoopback = false): Promise<HostInspection> {
  try { assertConnectorPlatform(); }
  catch (error) {
    return { platform: process.platform, stateDir, unsupported: hostError(error, "This computer cannot run the Pistead host.").message, mode: "unsandboxed", prerequisites: [], models: [] };
  }
  const { mode, sandboxPrerequisites, prerequisites } = await isolation();
  const inspection: HostInspection = { platform: process.platform, stateDir, mode, prerequisites, models: [] };
  if (sandboxPrerequisites) inspection.sandboxPrerequisites = sandboxPrerequisites;
  if (mode === "unsandboxed") inspection.unsandboxedWarning = unsandboxedWarning();
  try { assertPrerequisites(prerequisites, mode === "unsandboxed", ""); }
  catch (error) { inspection.prerequisitesError = hostError(error, "Prerequisites could not be checked.").message; }
  try { inspection.pairedServer = await savedPairing(stateDir, allowInsecureLoopback); }
  catch (error) { inspection.pairingError = hostError(error, "This computer's saved pairing could not be read.").message; }
  try { inspection.models = await (await loadConnectorModels({ allowFaux })).manifest(); }
  catch (error) { inspection.modelsError = hostError(error, "Pi's models could not be loaded. Check Pi's configuration on this computer; catalogs over 200 models need enabledModels in Pi's settings.json.").message; }
  return inspection;
}

/** Checks everything the CLI checks before it prompts, then starts the connector; progress arrives as events. */
async function start(request: StartRequest): Promise<void> {
  if (running) throw new HostFailure("already-running", "The host is already running.");
  try { assertConnectorPlatform(); }
  catch (error) { throw new HostFailure("unsupported", hostError(error, "This computer cannot run the Pistead host.").message); }
  const { mode, prerequisites } = await isolation();
  const unsandboxed = mode === "unsandboxed";
  if (unsandboxed && request.unsandboxedConsent !== true) throw new HostFailure("consent-required", "This computer has no isolated sandbox: running the host needs your consent to run agent work directly on it.");
  assertPrerequisites(prerequisites, unsandboxed, "");
  let server: string;
  try { server = controlPlaneOrigin(request.server, request.allowInsecureLoopback); }
  catch { throw new HostFailure("setup", "The server must be an HTTPS origin such as https://pistead.com."); }
  const localModels = await loadConnectorModels({ allowFaux: request.allowFaux, models: request.models });
  const replace = request.pairing !== undefined && request.replacePairing === true;
  // A replacement never reads the saved pairing: it may be revoked, unreadable or bound to another server.
  const paired = replace ? undefined : await savedPairing(stateDir, request.allowInsecureLoopback);
  if (!request.pairing && !paired) throw new HostFailure("not-paired", "This computer is not paired yet. In Pistead, open Settings › Hosts, create a pairing code, then enter its pairing ID and code here.");
  if (request.pairing && paired) throw new HostFailure("already-paired", "This computer is already paired. Choose \"Replace existing pairing\" to pair it again, or start without a new code to keep using it.");
  if (paired && paired !== server) throw new HostFailure("server-mismatch", `This computer is paired with ${paired}, not ${server}. Pair it again with a code from ${server}, or switch the server back in Settings.`);
  // Another start may have won while this one awaited its checks.
  if (running) throw new HostFailure("already-running", "The host is already running.");
  const pairing = request.pairing && { id: request.pairing.id, code: request.pairing.code };
  const connector = createConnector({
    dataDir: stateDir, server, pairing, replacePairing: replace, localModels, unsandboxed,
    gitCredentials: request.gitCredentials === true,
    allowInsecureLoopback: request.allowInsecureLoopback, allowFaux: request.allowFaux,
    // Binary presence cannot attest a working namespace or a per-session resource
    // domain. Advertise conservatively; each actual operation verifies isolation.
    capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    onStatus: state => {
      if (running?.connector !== connector) return;
      if (state !== "stopped") { status(state, { server, unsandboxed }); return; }
      const expected = running.stopRequested;
      running = undefined;
      status("stopped");
      if (!expected) emit({ type: "failed", error: { code: "failed", message: "The host stopped unexpectedly: it lost its lock on this computer's pairing. Start it again." } });
    },
    onWarning: () => log("warning", "Some resource domains are unavailable; production bash remains fail-closed."),
  });
  const current = { connector, stopRequested: false };
  running = current;
  status("starting", { server, unsandboxed });
  log("info", unsandboxed
    ? "Running unsandboxed: approved commands execute directly on this machine."
    : "Sandbox capability is verified per session; production shell stays disabled without provisioned, verified limits.");
  if (request.gitCredentials) log("info", "Git credentials: approved pushes in your own sessions may use this machine's Git credential helpers.");
  void connector.start().then(
    () => log("info", `Connected to ${server}.`),
    async (error: unknown) => {
      if (current.stopRequested) return;
      current.stopRequested = true;
      emit({ type: "failed", error: hostError(error, "The host failed to start. Check this computer's pairing, Pi configuration and prerequisites.") });
      await connector.stop().catch(() => {});
    },
  ).finally(() => { if (pairing) pairing.code = ""; });
}

async function stop(): Promise<void> {
  const current = running;
  if (!current) return;
  current.stopRequested = true;
  status("stopping");
  await current.connector.stop();
}

async function handle(request: HostRequest): Promise<void> {
  try {
    if (request.type === "inspect") {
      emit({ type: "result", id: request.id, ok: true, inspection: await inspect(request.allowFaux, request.allowInsecureLoopback) });
    } else {
      await (request.type === "start" ? start(request) : stop());
      emit({ type: "result", id: request.id, ok: true });
    }
  } catch (error) {
    emit({ type: "result", id: request.id, ok: false, error: hostError(error, request.type === "stop" ? "The host did not stop cleanly." : "The host could not start. Check this computer's pairing, Pi configuration and prerequisites.") });
  }
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await stop().catch(() => {});
  process.exit(0);
}

transport.onMessage(value => {
  const request = hostRequestSchema.safeParse(value);
  if (request.success) { void handle(request.data); return; }
  // Unknown shapes are refused; the id, when usable, lets the app settle the request it is waiting on.
  const id = value && typeof value === "object" && "id" in value && typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0 ? value.id : undefined;
  if (id === undefined) log("error", "Ignored a malformed host request.");
  else emit({ type: "result", id, ok: false, error: { code: "invalid-request", message: "The host refused a malformed request." } });
});
transport.onClose(() => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
emit({ type: "ready" });
