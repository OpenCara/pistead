import { access, constants, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createConnector, controlPlaneOrigin, readConnectorState } from "./connector.js";
import { createFauxLocalModels, loadLocalPiModels, readPiSettings } from "./local-pi.js";
import { ConnectorSetupError } from "./protocol.js";
import type { ResourceConfig } from "./resources.js";

const HELP = `Usage: pistead connect [options]

Connect your local Pi to a Pistead workspace using outbound WebSocket only.
Use Node.js 24 on Linux or WSL2 (or macOS with --unsafe-no-sandbox). In the web app,
configure authorized repositories for your workspace and pair Pi with it, then run:
  npx pistead@latest connect --server https://pistead.com --pairing-id PAIRING_ID
The pairing code is requested privately on a terminal, never as an argument.
Subsequent runs use the private saved connector token.
Pairing keeps Pi runtime access private to you; sharing it with teammates is opt-in.
New sessions are workspace-viewable by default, without granting agent control.

Options:
  --server ORIGIN          HTTPS control-plane origin (required for first pairing)
  --pairing-id ID          One-use pairing id from the web app
  --force                  With --pairing-id, replace this machine's saved pairing; the
                           old host stays in Pistead, offline, until you remove it there
  --state-dir PATH         Private connector state (default ~/.local/share/pistead/connector)
  --pi-agent-dir PATH      Pi config/auth directory (default: Pi's own getAgentDir())
  --model PROVIDER/MODEL   Advertise this configured local model (repeatable); without it,
                           the models matched by enabledModels in Pi's settings.json are
                           advertised, or every authenticated Pi model when that is unset
  --resources PATH        Operator-provisioned resource configuration JSON
  --allow-insecure-loopback  Permit HTTP/WS only on localhost/127.0.0.1/[::1]
  --allow-test-shell       Fixture shell opt-in; requires --allow-faux
  --unsafe-no-sandbox      Run agent work directly on this machine without isolation
                           (macOS or Linux without bubblewrap); asks for confirmation
  --git-credentials        Let approved pushes in your own sessions use this machine's Git
                           credentials (its git credential helpers) where the workspace's
                           push access chooses the host's Git credentials
  --repo-cache             Check repositories out of a cache on this machine with their full
                           history, fetched with this machine's Git credentials (its git
                           credential helpers) instead of downloaded through Pistead. Pistead
                           still checks that each session's owner can read every repository
                           with their own account. Preview: backups of such sessions are not
                           supported yet
  --repo-cache-scope SCOPE host (default): one cache for every session on this machine;
                           owner: a separate cache for each session owner
  --help                  Show this help without reading Pi configuration

Linux or WSL2 with working bubblewrap, Python 3, Git and flock is required for the
isolated sandbox. Native Windows is unsupported; run this command inside WSL2.
--unsafe-no-sandbox needs only Git on PATH, but approved commands then run as your
user with access to your files, credentials and network, and no resource limits.
Session repositories are pinned into private session caches, not your current folder.
GitLab, Azure DevOps, Bitbucket, Gitea/Forgejo and GitHub Enterprise repositories are
connected in the web app (Settings > Profile > Git accounts) with personal access tokens;
the connector receives pinned snapshots, not those tokens. Each approved git_push gets a
credential for that push only, held in connector memory and sent only to the repository's
Git host; the sandbox never sees it. It is a short-lived token minted from a workspace app
or bot or, where the workspace's push access chooses the session owner's account, your
own account's token, sent only to your own hosts for your own sessions (a GitHub token
is reset when the push ends). With --git-credentials, your own sessions can push with
the credentials git on this machine would use instead, read through its credential
helpers without prompting.
Production bash additionally requires verified per-session aggregate cgroups and a
bounded private filesystem;
--resources does not provision these. Missing resource limits never enable host shell.
Pi model/auth configuration is used locally, including Pi's OAuth refresh. Provider
credentials, private history and personal extensions are not uploaded or shared.
Catalogs over 200 models need enabledModels in Pi's settings or --model. Restart to reload config.
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
  - A session owner who turns on Auto-approve in the chat box lets their agent run
    commands and commits here immediately, with no per-command approval.
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
    if (answer.trim() !== "unsandboxed") throw new ConnectorSetupError("Unsandboxed mode was not confirmed; nothing was started.");
  } finally {
    prompt.close();
  }
}

export async function connectMain(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: "boolean" }, server: { type: "string" }, "pairing-id": { type: "string" }, force: { type: "boolean" },
    "state-dir": { type: "string" }, "pi-agent-dir": { type: "string" }, model: { type: "string", multiple: true },
    resources: { type: "string" }, "allow-insecure-loopback": { type: "boolean" },
    "allow-faux": { type: "boolean" }, "allow-test-shell": { type: "boolean" }, "unsafe-no-sandbox": { type: "boolean" },
    "git-credentials": { type: "boolean" }, "repo-cache": { type: "boolean" }, "repo-cache-scope": { type: "string" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const unsandboxed = values["unsafe-no-sandbox"] === true;
  if (Number(process.versions.node.split(".")[0]) < 24) throw new ConnectorSetupError(`Node.js 24 or newer is required (found ${process.versions.node}).`);
  if (process.platform === "darwin" && !unsandboxed) {
    throw new ConnectorSetupError("macOS has no isolated sandbox: it needs Linux or WSL2 with bubblewrap. To run agent work directly on this Mac, re-run with --unsafe-no-sandbox and read its warning.");
  }
  if (process.platform === "win32") throw new ConnectorSetupError("Native Windows is not supported. Install WSL2 (in PowerShell: wsl --install), open the Ubuntu terminal, install Node.js 24, Pi, bubblewrap, Python 3, Git and util-linux there, then run this same command inside WSL2.");
  if (process.platform !== "linux" && process.platform !== "darwin") throw new ConnectorSetupError(`Unsupported platform "${process.platform}": use Linux, WSL2 or macOS.`);
  if (unsandboxed && values.resources) throw new ConnectorSetupError("--resources configures Linux sandbox limits and cannot be combined with --unsafe-no-sandbox.");
  if (values["allow-test-shell"] && !values["allow-faux"]) throw new ConnectorSetupError("--allow-test-shell requires --allow-faux.");
  const cacheScope = values["repo-cache-scope"];
  if (cacheScope !== undefined && !values["repo-cache"]) throw new ConnectorSetupError("--repo-cache-scope requires --repo-cache.");
  if (cacheScope !== undefined && cacheScope !== "host" && cacheScope !== "owner") throw new ConnectorSetupError("--repo-cache-scope must be host or owner.");
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
  const required: Record<string, string> = unsandboxed
    ? process.platform === "linux" ? { "/usr/bin/flock": "flock (util-linux)" } : { "/usr/bin/lockf": "lockf" }
    : { "/usr/bin/bwrap": "bubblewrap", "/usr/bin/python3": "Python 3", "/usr/bin/git": "Git", "/usr/bin/flock": "flock (util-linux)" };
  const missing: string[] = [];
  for (const [binary, name] of Object.entries(required)) {
    try { await access(binary, constants.X_OK); } catch { missing.push(`${name} (${binary})`); }
  }
  // Unsandboxed sessions use the owner's Git from PATH, e.g. Xcode tools or Homebrew on macOS.
  if (unsandboxed && spawnSync("git", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } }).status !== 0) missing.push("Git on PATH");
  if (missing.length) {
    const hint = process.platform === "darwin" ? " Install Git, e.g. xcode-select --install or brew install git."
      : unsandboxed ? "" : " Without bubblewrap you can run --unsafe-no-sandbox instead; read its warning first.";
    throw new ConnectorSetupError(`Missing prerequisites: ${missing.join(", ")}.${hint}`);
  }
  const models = values.model?.map(reference => {
    const slash = reference.indexOf("/");
    if (slash < 1 || slash === reference.length - 1) throw new ConnectorSetupError("--model expects PROVIDER/MODEL.");
    return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
  });
  if (values["allow-faux"] && (values["pi-agent-dir"] || models)) throw new ConnectorSetupError("Fixture mode cannot select personal Pi models.");
  const settings = values["allow-faux"] ? {} : await readPiSettings(values["pi-agent-dir"]).catch(error => {
    throw new ConnectorSetupError(`Pi settings could not be read: ${error instanceof SyntaxError ? "settings.json is not valid JSON" : error instanceof Error ? error.message : "unknown error"}.`);
  });
  const enabledModels = models ? undefined : settings.enabledModels;
  const localModels = values["allow-faux"] ? createFauxLocalModels() : await loadLocalPiModels({ agentDir: values["pi-agent-dir"], models, enabledModels,
    defaultThinkingLevel: settings.defaultThinkingLevel, modelThinkingLevels: settings.modelThinkingLevels });
  if (!(await localModels.manifest()).length) throw new ConnectorSetupError(enabledModels
    ? "None of the models enabled in Pi's settings.json (enabledModels) are authenticated on this machine."
    : "No authenticated local Pi models are configured. Configure a provider and model in Pi on this machine first.");
  const resources = values.resources ? await resourceConfig(values.resources) : undefined;
  const dataDir = values["state-dir"] ?? join(homedir(), ".local", "share", "pistead", "connector");
  // Checked before any prompt, so no pairing code is typed for nothing; the connector checks again under its lease.
  // --force never reads the saved pairing: it may be revoked, unreadable or bound to another server.
  const paired = !values.force && await readConnectorState(dataDir, undefined, values["allow-insecure-loopback"]) !== undefined;
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
  const gitCredentials = values["git-credentials"] === true;
  const repositoryCache = values["repo-cache"] ? { scope: cacheScope === "owner" ? "owner" as const : "host" as const } : undefined;
  const connector = createConnector({
    dataDir,
    server: values.server, pairing, replacePairing: values.force, localModels, resources, unsandboxed, gitCredentials, repositoryCache,
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
  if (gitCredentials) process.stderr.write("Git credentials: approved pushes in your own sessions may use this machine's Git credential helpers.\n");
  if (repositoryCache) {
    process.stderr.write(`Repository cache (${repositoryCache.scope === "owner" ? "one per session owner" : "shared by every session on this machine"}): `
      + "repositories are fetched with this machine's Git credential helpers, for every session on it, after Pistead checks the session owner's access.\n");
  }
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
