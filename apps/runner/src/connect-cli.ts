import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createConnector, controlPlaneOrigin } from "./connector.js";
import { assertConnectorPlatform, assertPrerequisites, checkPrerequisites, defaultStateDir, loadConnectorModels, savedPairing, unsandboxedWarning } from "./connect-setup.js";
import { ConnectorSetupError } from "./protocol.js";
import type { ResourceConfig } from "./resources.js";
import { DEFAULT_WINDOWS_LIMITS, validWindowsLimits, windowsRuntimeDirectory, type SandboxBackendConfig } from "./sandbox-backend.js";

const HELP = `Usage: pistead connect [--server ORIGIN --pairing-id ID [--force]]

Connect this machine to Pistead as a host, using an outbound WebSocket only.

First time: in Pistead, open Settings > Hosts > Pair a host and run the command it shows:
  npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID
then type the pairing code at the hidden prompt; it is never accepted as an argument.
Later runs need no options: the connector reuses its private saved pairing.

Everything else about the host is configured in Pistead by its owner and admins
(Settings > Hosts > the host): its sharing (it stays private to you until you share it),
who may run host commands, how long sandboxed commands may run, whether they get its GPU,
whether pushes in your own sessions may use this machine's Git credentials, and its
repository cache. Changes reach running sessions within a minute; the repository cache
changes when the connector next connects.

Options:
  --server ORIGIN          HTTPS control-plane origin (first pairing only)
  --pairing-id ID          One-use pairing ID from Pistead
  --force                  With --pairing-id, replace this machine's saved pairing; the
                           old host stays in Pistead, offline, until you remove it there
  --unsafe-no-sandbox      Run agent work directly on this machine without isolation
                           (macOS, Windows, or Linux without bubblewrap); asks for confirmation
  --experimental-sandbox   macOS and native Windows: run sessions in this platform's own
                           sandbox (macOS Seatbelt; Windows 11 process containers through
                           Microsoft's MXC SDK). Experimental and not yet verified; see
                           docs/design/windows-sandbox.md
  --help                   Show this help without reading Pi configuration

This machine's own setup, when the defaults don't fit:
  --state-dir PATH         Private connector state (default ~/.local/share/pistead/connector)
  --pi-agent-dir PATH      Pi config/auth directory (default: Pi's own getAgentDir())
  --model PROVIDER/MODEL   Advertise this configured local model (repeatable); without it,
                           the models matched by enabledModels in Pi's settings.json are
                           advertised, or every authenticated Pi model when that is unset
  --resources PATH         Operator-provisioned resource configuration JSON (cgroup v2
                           limits that let bash run in every session)
  --memory-limit MIB       Windows sandbox: memory for each sandboxed step's processes (4096)
  --process-limit N        Windows sandbox: processes per step (256)
  --cpu-limit PERCENT      Windows sandbox: share of this machine's CPU per step (50)

Development:
  --allow-insecure-loopback  Permit HTTP/WS only on localhost/127.0.0.1/[::1]
  --allow-test-shell         Fixture shell opt-in; requires --allow-faux

Linux or WSL2 with working bubblewrap, Python 3, Git and flock is required for the
isolated sandbox. On native Windows run this command inside WSL2, or try
--experimental-sandbox (Windows 11 24H2/25H2 build .9550+, Git for Windows, and
Microsoft's MXC SDK, which it tells you how to install). On macOS,
--experimental-sandbox needs the developer tools (xcode-select --install); its shell
commands have no hard memory limits, so only you can let them run, in your own sessions.
--unsafe-no-sandbox needs only Git on PATH, but approved commands then run as your
user with access to your files, credentials and network, and no resource limits.
GitLab, Azure DevOps, Bitbucket, Gitea/Forgejo and GitHub Enterprise repositories are
connected in the web app (Settings > Profile > Git accounts) with personal access tokens;
the connector never receives those tokens. Each approved git_push gets a credential for
that push only, held in connector memory and sent only to the repository's Git host; the
sandbox never sees it.
Production bash additionally requires verified per-session aggregate cgroups and a
bounded private filesystem; --resources does not provision these. Missing resource
limits never enable host shell.
Pi model/auth configuration is used locally, including Pi's OAuth refresh. Provider
credentials, private history and personal extensions are not uploaded or shared.
Catalogs over 200 models need enabledModels in Pi's settings or --model. Restart to reload config.
`;

export function promptPairingCode(): Promise<string> {
  return promptHidden("Pairing code (hidden): ", "Pairing", "pairing code");
}

/** A secret typed at a hidden prompt on the terminal: never argv, never a pipe. `noun` names it in errors. */
export function promptHidden(label: string, action: string, noun: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) throw new Error(`${action} requires a private interactive terminal; ${noun}s are never accepted on argv or stdin pipes`);
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
      if (char === "\u0003" || char === "\u0004") { finish(new Error(`${action} cancelled`)); return; }
      if (char === "\u007f" || char === "\b") { code = code.slice(0, -1); continue; }
      if (!/^[A-Za-z0-9_-]$/.test(char) || code.length >= 256) { finish(new Error(`Invalid ${noun}`)); return; }
      code += char;
    }
  };
  const onEnd = () => finish(new Error(`${action} terminal closed`));
  const onError = () => finish(new Error(`${action} terminal unavailable`));
  const onTerminate = () => finish(new Error(`${action} cancelled`));
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onError);
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);
  process.stdin.resume();
  return completion.promise;
}

export async function resourceConfig(path: string): Promise<ResourceConfig> {
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

/** The macOS or Windows sandbox --experimental-sandbox asks for, with the Windows limits given. */
function experimentalBackend(dataDir: string, values: { "memory-limit"?: string; "process-limit"?: string; "cpu-limit"?: string }): SandboxBackendConfig {
  if (process.platform === "darwin") return { kind: "seatbelt" };
  const number = (value: string | undefined, name: string, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^\d{1,9}$/.test(value)) throw new ConnectorSetupError(`--${name} must be a whole number.`);
    return Number(value);
  };
  try {
    return { kind: "windows", runtime: windowsRuntimeDirectory(dataDir), limits: validWindowsLimits({
      memoryBytes: number(values["memory-limit"], "memory-limit", DEFAULT_WINDOWS_LIMITS.memoryBytes / 1024 ** 2) * 1024 ** 2,
      processes: number(values["process-limit"], "process-limit", DEFAULT_WINDOWS_LIMITS.processes),
      cpuPercent: number(values["cpu-limit"], "cpu-limit", DEFAULT_WINDOWS_LIMITS.cpuPercent),
    }) };
  } catch (error) {
    throw error instanceof ConnectorSetupError ? error : new ConnectorSetupError(error instanceof Error ? `${error.message}.` : "Invalid Windows sandbox limits.");
  }
}

export async function confirmUnsandboxed(): Promise<void> {
  process.stderr.write(unsandboxedWarning());
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write("Non-interactive terminal: --unsafe-no-sandbox is taken as your consent.\n");
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  prompt.on("SIGINT", () => prompt.close());
  try {
    const answer = await prompt.question('Type "unsandboxed" to continue: ').catch(() => "");
    if (answer.trim() !== "unsandboxed") throw new ConnectorSetupError("Unsandboxed mode was not confirmed; nothing was started.");
  } finally {
    prompt.close();
  }
}

/** Options that became host configuration in Pistead: still accepted, so existing service units keep starting, and ignored. */
const MOVED_OPTIONS = ["git-credentials", "repo-cache", "repo-cache-scope"] as const;

/** The notice for moved options someone still passes, or nothing. */
export function movedOptionsNotice(given: readonly string[]): string {
  if (!given.length) return "";
  return `${given.map(name => `--${name}`).join(", ")} ${given.length === 1 ? "is" : "are"} ignored: the host's owner sets ${given.length === 1 ? "it" : "them"} in Pistead now `
    + "(Settings > Hosts > this host > Configuration). A host that used them keeps them there.\n";
}

export async function connectMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: "boolean" }, server: { type: "string" }, "pairing-id": { type: "string" }, force: { type: "boolean" },
    "state-dir": { type: "string" }, "pi-agent-dir": { type: "string" }, model: { type: "string", multiple: true },
    resources: { type: "string" }, "allow-insecure-loopback": { type: "boolean" },
    "allow-faux": { type: "boolean" }, "allow-test-shell": { type: "boolean" }, "unsafe-no-sandbox": { type: "boolean" },
    "git-credentials": { type: "boolean" }, "repo-cache": { type: "boolean" }, "repo-cache-scope": { type: "string" },
    "experimental-sandbox": { type: "boolean" }, "memory-limit": { type: "string" }, "process-limit": { type: "string" }, "cpu-limit": { type: "string" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  process.stderr.write(movedOptionsNotice(MOVED_OPTIONS.filter(name => values[name] !== undefined)));
  const unsandboxed = values["unsafe-no-sandbox"] === true;
  const experimental = values["experimental-sandbox"] === true;
  if (unsandboxed && experimental) throw new ConnectorSetupError("Choose one: --experimental-sandbox runs sessions in this platform's sandbox, --unsafe-no-sandbox runs them without one.");
  assertConnectorPlatform({ unsandboxed, experimentalSandbox: experimental });
  if (process.platform === "darwin" && !unsandboxed && !experimental) {
    throw new ConnectorSetupError("macOS has no default sandbox: the isolated sandbox needs Linux or WSL2 with bubblewrap. Try macOS's own sandbox with --experimental-sandbox, or run agent work directly on this Mac with --unsafe-no-sandbox and read its warning.");
  }
  if (unsandboxed && values.resources) throw new ConnectorSetupError("--resources configures Linux sandbox limits and cannot be combined with --unsafe-no-sandbox.");
  if (experimental && values.resources) throw new ConnectorSetupError("--resources configures Linux sandbox limits; the Windows sandbox takes --memory-limit, --process-limit and --cpu-limit.");
  if ((values["memory-limit"] || values["process-limit"] || values["cpu-limit"]) && !(experimental && process.platform === "win32")) {
    throw new ConnectorSetupError("--memory-limit, --process-limit and --cpu-limit apply only to the Windows sandbox (--experimental-sandbox on Windows).");
  }
  if (values["allow-test-shell"] && !values["allow-faux"]) throw new ConnectorSetupError("--allow-test-shell requires --allow-faux.");
  const pairingId = values["pairing-id"];
  if (pairingId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pairingId)) {
    throw new ConnectorSetupError(/^[A-Za-z0-9_-]{43}$/.test(pairingId)
      ? "That --pairing-id value looks like the single-use pairing code, not the pairing ID. Copy the command shown in Pistead (its --pairing-id looks like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed) and type the code only at the hidden prompt. Create a new code: this one is no longer private."
      : "--pairing-id must be the pairing ID shown in Pistead, e.g. 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.");
  }
  if (pairingId && !values.server) throw new ConnectorSetupError("First pairing requires --server, e.g. --server https://pistead.com.");
  if (values.force && !pairingId) throw new ConnectorSetupError("--force replaces this machine's saved pairing, so it needs a new one: create a pairing code in Pistead and run its command with --force added.");
  if (values.server) {
    try { controlPlaneOrigin(values.server, values["allow-insecure-loopback"]); }
    catch { throw new ConnectorSetupError("--server must be an HTTPS origin such as https://pistead.com."); }
  }
  const dataDir = values["state-dir"] ?? defaultStateDir();
  assertPrerequisites(await checkPrerequisites(unsandboxed, experimental ? { stateDir: dataDir } : undefined), unsandboxed,
    " Without bubblewrap you can run --unsafe-no-sandbox instead; read its warning first.");
  const sandboxBackend = experimental ? experimentalBackend(dataDir, values) : undefined;
  const models = values.model?.map(reference => {
    const slash = reference.indexOf("/");
    if (slash < 1 || slash === reference.length - 1) throw new ConnectorSetupError("--model expects PROVIDER/MODEL.");
    return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
  });
  const localModels = await loadConnectorModels({ allowFaux: values["allow-faux"], piAgentDir: values["pi-agent-dir"], models });
  const resources = values.resources ? await resourceConfig(values.resources) : undefined;
  // Checked before any prompt, so no pairing code is typed for nothing; the connector checks again under its lease.
  // --force never reads the saved pairing: it may be revoked, unreadable or bound to another server.
  const paired = !values.force && await savedPairing(dataDir, values["allow-insecure-loopback"]) !== undefined;
  if (!pairingId && !paired) {
    throw new ConnectorSetupError("This machine is not paired yet. In Pistead, open Connections, create a pairing code, then run:\n  npx pistead@latest connect --server https://pistead.com --pairing-id <PAIRING_ID>");
  }
  if (pairingId && paired) {
    throw new ConnectorSetupError("This machine is already paired. Add --force to replace that pairing with this new one, run without --pairing-id to keep using it, or use a separate --state-dir for a second connection.");
  }
  if (unsandboxed) await confirmUnsandboxed();
  const code = pairingId ? await promptPairingCode() : "";
  if (pairingId && !code) throw new ConnectorSetupError("No pairing code was entered. Paste the single-use code shown in Pistead at the hidden prompt.");
  const pairing = pairingId ? { id: pairingId, code } : undefined;
  const connector = createConnector({
    dataDir,
    server: values.server, pairing, replacePairing: values.force, localModels, resources, unsandboxed, ...(sandboxBackend ? { sandboxBackend } : {}),
    allowInsecureLoopback: values["allow-insecure-loopback"], allowFaux: values["allow-faux"], allowTestShell: values["allow-test-shell"],
    // Binary presence cannot attest a working namespace or a per-session resource
    // domain. Advertise conservatively; each actual operation verifies isolation.
    capabilities: { platform: process.platform, sandbox: false, productionShell: false },
    onStatus: (status, reason) => { process.stderr.write(`Local connector: ${status}${reason ? ` (${reason})` : ""}\n`); },
    onWarning: () => { process.stderr.write("Some resource domains are unavailable; production bash remains fail-closed.\n"); },
  });
  process.stderr.write(unsandboxed
    ? "Running unsandboxed: approved commands execute directly on this machine.\n"
    : sandboxBackend ? `Experimental ${sandboxBackend.kind === "seatbelt" ? "macOS (Seatbelt)" : "Windows (process container)"} sandbox: not yet verified; report what breaks.\n`
    : "Sandbox capability is verified per session; production shell stays disabled without provisioned, verified limits.\n");
  process.stderr.write("Host configuration (command time limit, GPU, Git credentials, repository cache) is set in Pistead: Settings > Hosts > this host.\n");
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
