import type { HostInspection, HostState } from "../../../runner/src/desktop-protocol.js";
import type { HostView, LogLine, Outcome, StartInput } from "../shared/bridge.js";
import type { HostProcess } from "./host-process.js";
import { isLoopbackHttp } from "./origin.js";
import type { SettingsStore } from "./settings.js";

// The app's view of its connector host: what the host process reports, the owner's host settings, and the start flow
// with the native unsandboxed consent. Windows and the tray render from `view()` and re-render on every change.

const LOG_LIMIT = 200;

export interface HostControllerOptions {
  title: string;
  settings: SettingsStore;
  /** Fixture models instead of Pi's: development builds only. */
  fixtureModels: boolean;
  /** Shows the CLI's warning in a native dialog; resolves true only when the owner accepts it. */
  confirmUnsandboxed(warning: string): Promise<boolean>;
  loginItem?: { get(): boolean; set(enabled: boolean): void };
}

export class HostController {
  private state: HostState = "stopped";
  private running?: { server: string; unsandboxed: boolean };
  private inspection?: HostInspection;
  private inspecting = 0;
  private error?: string;
  private readonly logs: LogLine[] = [];
  private readonly listeners = new Set<() => void>();
  private process?: HostProcess;

  constructor(private readonly options: HostControllerOptions) {}

  attach(process: HostProcess): void { this.process = process; }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void { for (const listener of this.listeners) listener(); }

  get hostState(): HostState { return this.state; }

  view(): HostView {
    const settings = this.options.settings.get();
    const view: HostView = {
      title: this.options.title, server: settings.server, state: this.state, inspecting: this.inspecting > 0,
      logs: [...this.logs], fixtureModels: this.options.fixtureModels,
    };
    if (this.running) view.running = { ...this.running };
    if (this.inspection) view.inspection = this.inspection;
    if (this.error) view.error = this.error;
    if (this.options.loginItem) view.openAtLogin = this.options.loginItem.get();
    return view;
  }

  log(level: LogLine["level"], message: string): void {
    this.logs.push({ time: Date.now(), level, message });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.changed();
  }

  /** Host process events, already shape-checked by HostProcess. */
  handleStatus(state: HostState, detail: { server?: string; unsandboxed?: boolean }): void {
    const previous = this.state;
    this.state = state;
    if (state === "stopped") this.running = undefined;
    else if (detail.server !== undefined) this.running = { server: detail.server, unsandboxed: detail.unsandboxed === true };
    if (state === "connected") this.error = undefined;
    this.changed();
    // A first connection may have just saved a pairing: show it.
    if (state === "connected" && previous !== "connected") void this.refresh();
  }

  /** A started host failed or stopped by itself: it is not running, so the next launch must not resume it. */
  handleFailure(message: string): void {
    if (this.options.settings.get().resumeHost) this.options.settings.update({ resumeHost: undefined });
    this.error = message;
    this.log("error", message);
  }

  handleExit(code: number, expected: boolean): void {
    const wasRunning = this.state !== "stopped";
    this.state = "stopped";
    this.running = undefined;
    if (!expected) this.handleFailure(`The host process exited unexpectedly (code ${code})${wasRunning ? "; the host is offline" : ""}. Start it again when ready.`);
    else this.changed();
  }

  private developmentOptions(server: string): { allowFaux?: true; allowInsecureLoopback?: true } {
    return { ...(this.options.fixtureModels ? { allowFaux: true } : {}), ...(isLoopbackHttp(server) ? { allowInsecureLoopback: true } : {}) };
  }

  async refresh(): Promise<HostInspection | undefined> {
    if (!this.process) return undefined;
    this.inspecting++;
    this.changed();
    try {
      const result = await this.process.request({ type: "inspect", ...this.developmentOptions(this.options.settings.get().server) });
      if (result.ok && result.inspection) this.inspection = result.inspection;
      else if (!result.ok) this.error = result.error.message;
      return this.inspection;
    } finally {
      this.inspecting--;
      this.changed();
    }
  }

  /**
   * The owner's start: refuses early what the host would refuse, asks for unsandboxed consent in a native dialog, then
   * hands the request to the host. `resume` replays consent recorded at the owner's last start instead of asking.
   */
  async start(input: StartInput, resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (!this.process) return { ok: false, error: "The host is unavailable." };
    if (this.state !== "stopped") return { ok: false, error: "The host is already running." };
    const inspection = await this.refresh();
    if (!inspection) return { ok: false, error: this.error ?? "This computer could not be inspected." };
    const failure = inspection.unsupported ?? inspection.prerequisitesError
      ?? (!input.pairing && !inspection.pairedServer ? inspection.pairingError ?? "This computer is not paired yet. In Pistead, open Settings › Hosts, create a pairing code, then enter its pairing ID and code here." : undefined);
    if (failure) return this.refuse(failure);
    let unsandboxedConsent = false;
    if (inspection.mode === "unsandboxed") {
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await this.options.confirmUnsandboxed(inspection.unsandboxedWarning ?? "");
      if (!unsandboxedConsent) return this.refuse(resume ? "Hosting was not resumed: this computer now runs agent work unsandboxed, which needs your consent. Start the host to review it." : "Unsandboxed mode was not confirmed; nothing was started.");
    }
    const server = this.options.settings.get().server;
    this.error = undefined;
    if (input.pairing) this.log("info", input.replacePairing ? `Replacing this computer's pairing with one for ${server}.` : `Pairing this computer with ${server}.`);
    const result = await this.process.request({
      type: "start", server,
      ...(input.pairing ? { pairing: input.pairing, replacePairing: input.replacePairing } : {}),
      ...(unsandboxedConsent ? { unsandboxedConsent: true } : {}),
      ...this.developmentOptions(server),
    });
    if (!result.ok) return this.refuse(result.error.message);
    this.options.settings.update({ resumeHost: { unsandboxedConsent } });
    this.changed();
    return { ok: true };
  }

  private refuse(error: string): Outcome {
    this.error = error;
    this.changed();
    return { ok: false, error };
  }

  async stop(): Promise<Outcome> {
    // The owner's stop also ends resuming: the next launch leaves the host stopped.
    this.options.settings.update({ resumeHost: undefined });
    if (!this.process?.running || this.state === "stopped") { this.changed(); return { ok: true }; }
    const result = await this.process.request({ type: "stop" });
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  /** At launch: start again if the owner left the host running, without asking for consent they already gave. */
  async resume(): Promise<void> {
    const resume = this.options.settings.get().resumeHost;
    if (!resume) return;
    const outcome = await this.start({ replacePairing: false }, resume);
    if (!outcome.ok) this.options.settings.update({ resumeHost: undefined });
  }

  setOpenAtLogin(enabled: boolean): Outcome {
    if (!this.options.loginItem) return { ok: false, error: "Open at login is not available on this system." };
    this.options.loginItem.set(enabled);
    this.changed();
    return this.options.loginItem.get() === enabled ? { ok: true } : { ok: false, error: "The system did not accept the login item. Check System Settings › General › Login Items." };
  }
}
