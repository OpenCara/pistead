import { access, constants } from "node:fs/promises";
import { homedir, release, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConnectorState } from "./connector.js";
import { createFauxLocalModels, loadLocalPiModels, readPiSettings, type LocalModels } from "./local-pi.js";
import type { Prerequisite } from "./desktop-protocol.js";
import { ConnectorSetupError } from "./protocol.js";
import { bashPath, gitForWindowsRoot, SANDBOX_SHELL_HINT, sandboxShellPath } from "./platform.js";
import { MXC_SDK_VERSION, mxcEntry, mxcInstallHint, windowsRuntimeDirectory } from "./sandbox-backend.js";
import { SANDBOX_EXEC, seatbeltTools } from "./seatbelt.js";

// Front-end-neutral connector preflight shared by `pistead connect` and the desktop host. Messages that name CLI flags
// stay in their front end; everything here reads the same in a terminal and in an app.

/** Private connector state shared by every front end, so a machine paired by one is adopted by the other. */
export const defaultStateDir = (): string => join(homedir(), ".local", "share", "pistead", "connector");

/**
 * Node.js and operating-system rules for the chosen isolation. Linux (and WSL2) runs the bubblewrap sandbox; macOS and
 * native Windows run their experimental sandboxes (`experimentalSandbox`) or, with the owner's consent, none.
 */
export function assertConnectorPlatform(mode: { unsandboxed?: boolean; experimentalSandbox?: boolean } = {}): void {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new ConnectorSetupError(`Node.js 24 or newer is required (found ${process.versions.node}).`);
  if (process.platform === "win32" && !mode.unsandboxed && !mode.experimentalSandbox) {
    throw new ConnectorSetupError("Native Windows has no sandbox by default. The isolated sandbox runs in WSL2: install it (in PowerShell: wsl --install), open the Ubuntu terminal, install Node.js 24, Pi, bubblewrap, Python 3, Git and util-linux there, then run this same command inside WSL2. On Windows 11 24H2/25H2 (build .9550 or later) you can try the native sandbox with --experimental-sandbox, or run without one with --unsafe-no-sandbox.");
  }
  if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") throw new ConnectorSetupError(`Unsupported platform "${process.platform}": use Linux, WSL2, macOS or Windows.`);
  if (process.platform === "linux" && mode.experimentalSandbox) throw new ConnectorSetupError("--experimental-sandbox is for macOS and native Windows; Linux runs the bubblewrap sandbox.");
}

const windowsGit = (): Prerequisite[] => [
  { name: "Git for Windows (git on PATH)", ok: gitForWindowsRoot() !== undefined },
  { name: "Git for Windows' bash.exe", ok: bashPath() !== undefined },
];

/** The binaries the chosen isolation mode needs, each named with where it is looked for. */
export async function checkPrerequisites(unsandboxed: boolean, experimental?: { stateDir: string }): Promise<Prerequisite[]> {
  if (process.platform === "win32") {
    if (unsandboxed || !experimental) return windowsGit();
    const runtime = windowsRuntimeDirectory(experimental.stateDir);
    const build = Number(release().split(".")[2] ?? 0);
    return [{ name: "Git for Windows (git on PATH)", ok: gitForWindowsRoot() !== undefined },
      { name: `busybox-w32, the sandbox's shell (${SANDBOX_SHELL_HINT}; or set PISTEAD_SANDBOX_SHELL)`, ok: sandboxShellPath() !== undefined },
      { name: `Windows 11 24H2 or later (build 26100+, found ${build || "unknown"}; the sandbox checks the update level itself)`, ok: build >= 26100 },
      { name: `Microsoft MXC SDK ${MXC_SDK_VERSION} in ${runtime} (install: ${mxcInstallHint(runtime)})`, ok: mxcEntry(runtime) !== undefined }];
  }
  const required: Record<string, string> = unsandboxed
    ? process.platform === "linux" ? { "/usr/bin/flock": "flock (util-linux)" } : { "/usr/bin/lockf": "lockf" }
    : process.platform === "darwin" ? { [SANDBOX_EXEC]: "sandbox-exec", "/usr/bin/lockf": "lockf" }
    : { "/usr/bin/bwrap": "bubblewrap", "/usr/bin/python3": "Python 3", "/usr/bin/git": "Git", "/usr/bin/flock": "flock (util-linux)" };
  const result: Prerequisite[] = [];
  for (const [binary, name] of Object.entries(required)) {
    result.push({ name: `${name} (${binary})`, ok: await access(binary, constants.X_OK).then(() => true, () => false) });
  }
  if (process.platform === "darwin" && !unsandboxed) {
    let tools = true;
    try { seatbeltTools(); } catch { tools = false; }
    result.push({ name: "Python 3 and Git from the developer tools (xcode-select --install)", ok: tools });
  }
  // Unsandboxed sessions use the owner's Git from PATH, e.g. Xcode tools or Homebrew on macOS.
  if (unsandboxed) result.push({ name: "Git on PATH", ok: spawnSync("git", ["--version"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } }).status === 0 });
  return result;
}

/** Fails with the missing prerequisites; `sandboxHint` offers the unsandboxed mode where the front end has one. */
export function assertPrerequisites(prerequisites: readonly Prerequisite[], unsandboxed: boolean, sandboxHint: string): void {
  const missing = prerequisites.filter(item => !item.ok).map(item => item.name);
  if (!missing.length) return;
  const hint = process.platform === "darwin" ? " Install Git, e.g. xcode-select --install or brew install git."
    : process.platform === "win32" ? (missing.some(name => name.startsWith("Git for Windows")) ? " Install Git for Windows from https://git-scm.com/download/win." : "")
    : unsandboxed ? "" : sandboxHint;
  throw new ConnectorSetupError(`Missing prerequisites: ${missing.join(", ")}.${hint}`);
}

export interface ModelChoice {
  /** Fixture models only; never combined with personal Pi configuration. */
  allowFaux?: boolean;
  piAgentDir?: string;
  /** Explicit subset; without it Pi's enabledModels setting, else every authenticated model, is advertised. */
  models?: readonly { provider: string; modelId: string }[];
}

/** The local models this machine would advertise, read from Pi's own settings and authentication. */
export async function loadConnectorModels(choice: ModelChoice): Promise<LocalModels> {
  if (choice.allowFaux && (choice.piAgentDir || choice.models)) throw new ConnectorSetupError("Fixture mode cannot select personal Pi models.");
  if (choice.allowFaux) return createFauxLocalModels();
  const settings = await readPiSettings(choice.piAgentDir).catch(error => {
    throw new ConnectorSetupError(`Pi settings could not be read: ${error instanceof SyntaxError ? "settings.json is not valid JSON" : error instanceof Error ? error.message : "unknown error"}.`);
  });
  const enabledModels = choice.models ? undefined : settings.enabledModels;
  const localModels = await loadLocalPiModels({ agentDir: choice.piAgentDir, models: choice.models, enabledModels,
    defaultThinkingLevel: settings.defaultThinkingLevel, modelThinkingLevels: settings.modelThinkingLevels,
    compaction: settings.compaction, attribution: settings.attribution });
  if (!(await localModels.manifest()).length) throw new ConnectorSetupError(enabledModels
    ? "None of the models enabled in Pi's settings.json (enabledModels) are authenticated on this machine."
    : "No authenticated local Pi models are configured. Configure a provider and model in Pi on this machine first.");
  return localModels;
}

/** The control-plane origin this state directory is paired with, if any. */
/** Sandboxed only on Linux with every sandbox prerequisite; anything else runs unsandboxed after explicit consent. */
export async function hostIsolation(): Promise<{ mode: "sandboxed" | "unsandboxed"; sandboxPrerequisites?: Prerequisite[]; prerequisites: Prerequisite[] }> {
  if (process.platform !== "linux") return { mode: "unsandboxed", prerequisites: await checkPrerequisites(true) };
  const sandboxPrerequisites = await checkPrerequisites(false);
  return sandboxPrerequisites.every(item => item.ok)
    ? { mode: "sandboxed", sandboxPrerequisites, prerequisites: sandboxPrerequisites }
    : { mode: "unsandboxed", sandboxPrerequisites, prerequisites: await checkPrerequisites(true) };
}

export async function savedPairing(dataDir: string, allowInsecureLoopback = false): Promise<string | undefined> {
  return (await readConnectorState(dataDir, undefined, allowInsecureLoopback))?.controlPlaneUrl;
}

export function unsandboxedWarning(): string {
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
