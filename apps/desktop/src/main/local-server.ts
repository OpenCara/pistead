import { utilityProcess, type UtilityProcess } from "electron";
import type { LocalInspection, LocalServerEvent, LocalServerRequest, LocalStatus } from "../../../server/src/local/desktop-protocol.js";
import type { LocalView, LogLine, Outcome } from "../shared/bridge.js";
import type { SettingsStore } from "./settings.js";

// Pistead on this computer: the local server (`pistead serve`'s, see apps/server/src/local/desktop.ts) in an Electron
// utility process, started when the owner turns it on in Settings and again at launch while it stays on. The Pistead
// window shows it instead of the configured server while it runs.

type Request = LocalServerRequest extends infer R ? R extends LocalServerRequest ? Omit<R, "id"> : never : never;
type Result = Extract<LocalServerEvent, { type: "result" }>;

const LOG_LIMIT = 200;
const eventTypes: Record<LocalServerEvent["type"], true> = { ready: true, result: true, status: true, log: true };
const isEvent = (value: unknown): value is LocalServerEvent => typeof value === "object" && value !== null
  && "type" in value && typeof value.type === "string" && Object.hasOwn(eventTypes, value.type);

export interface LocalServerOptions {
  entry: string;
  args: string[];
  settings: SettingsStore;
  /** Development builds only: the fixture model and test sign-ins. */
  testMode: boolean;
  /** Shows the CLI's warning in a native dialog; resolves true only when the owner accepts it. */
  confirmUnsandboxed(warning: string): Promise<boolean>;
}

export class LocalServerController {
  private child?: UtilityProcess;
  private ready?: Promise<void>;
  private readonly pending = new Map<number, (result: Result) => void>();
  private nextId = 1;
  private stopping = false;
  private status: LocalStatus = { state: "stopped", host: "off" };
  private inspection?: LocalInspection;
  private error?: string;
  private readonly logs: LogLine[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: LocalServerOptions) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void { for (const listener of this.listeners) listener(); }

  /** The local server's origin while it runs; the Pistead window shows it instead of the configured server. */
  get origin(): string | undefined { return this.status.state === "running" ? this.status.origin : undefined; }
  get claimUrl(): string | undefined { return this.status.state === "running" ? this.status.claimUrl : undefined; }
  get running(): boolean { return this.child !== undefined && this.status.state !== "stopped"; }

  view(): LocalView {
    return {
      enabled: this.options.settings.get().localServer !== undefined, status: { ...this.status }, logs: [...this.logs],
      ...(this.inspection ? { inspection: this.inspection } : {}), ...(this.error ? { error: this.error } : {}),
    };
  }

  private log(level: LogLine["level"], message: string): void {
    this.logs.push({ time: Date.now(), level, message });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.changed();
  }

  private spawn(): Promise<void> {
    const child = utilityProcess.fork(this.options.entry, this.options.args, { serviceName: "Pistead Server", stdio: "pipe" });
    const ready = Promise.withResolvers<void>();
    this.child = child;
    this.stopping = false;
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = "";
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop()!.slice(-4096);
        for (const line of lines) if (line.trim()) this.log("warning", line.slice(0, 1000));
      });
    }
    child.on("message", (value: unknown) => {
      if (!isEvent(value)) return;
      if (value.type === "ready") { ready.resolve(); return; }
      if (value.type === "log") { this.log(value.level, value.message); return; }
      if (value.type === "status") {
        const { type: _type, ...status } = value;
        this.status = status;
        this.changed();
        return;
      }
      const settle = this.pending.get(value.id);
      this.pending.delete(value.id);
      settle?.(value);
    });
    child.on("error", (type, location) => this.log("error", `The server process failed: ${type} at ${location}`));
    child.once("exit", code => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      ready.reject(new Error("exited"));
      for (const [id, settle] of this.pending) settle({ type: "result", id, ok: false, error: { message: "The server process exited before it answered." } });
      this.pending.clear();
      const wasRunning = this.status.state !== "stopped";
      this.status = { state: "stopped", host: "off" };
      if (!this.stopping && wasRunning) {
        this.error = `Pistead on this computer stopped unexpectedly (code ${code}). Start it again in Settings.`;
        this.log("error", this.error);
      }
      this.changed();
    });
    return ready.promise;
  }

  private async request(message: Request): Promise<Result> {
    this.ready ??= this.spawn();
    try { await this.ready; }
    catch { return { type: "result", id: 0, ok: false, error: { message: "The server process could not start." } }; }
    const id = this.nextId++;
    const result = Promise.withResolvers<Result>();
    this.pending.set(id, result.resolve);
    this.child!.postMessage({ ...message, id });
    return result.promise;
  }

  async inspect(): Promise<LocalInspection | undefined> {
    const result = await this.request({ type: "inspect" });
    if (result.ok && result.inspection) this.inspection = result.inspection;
    else if (!result.ok) this.error = result.error.message;
    this.changed();
    return this.inspection;
  }

  /**
   * The owner's start from Settings, with their GitHub OAuth app when they entered one: asks for unsandboxed consent in
   * a native dialog where this computer would run sessions without a sandbox. `resume` replays the consent given at the
   * owner's last start instead of asking.
   */
  async start(github?: { clientId: string; clientSecret: string }, resume?: { unsandboxedConsent: boolean }): Promise<Outcome> {
    if (this.status.state !== "stopped") return { ok: false, error: "Pistead is already running on this computer." };
    const inspection = await this.inspect();
    if (!inspection) return this.refuse(this.error ?? "This computer could not be inspected.");
    if (!github && !inspection.githubClientId) return this.refuse("Add your GitHub OAuth app's client ID and secret first.");
    let unsandboxedConsent = false;
    if (inspection.hostMode === "unsandboxed" && !inspection.hostProblem) {
      unsandboxedConsent = resume ? resume.unsandboxedConsent : await this.options.confirmUnsandboxed(inspection.unsandboxedWarning ?? "");
    }
    this.error = undefined;
    const result = await this.request({ type: "start", ...(github ? { github } : {}), ...(unsandboxedConsent ? { unsandboxedConsent } : {}),
      ...(this.options.testMode ? { testMode: true } : {}) });
    if (!result.ok) return this.refuse(result.error.message);
    this.options.settings.update({ localServer: { unsandboxedConsent } });
    void this.inspect();
    return { ok: true };
  }

  private refuse(error: string): Outcome {
    this.error = error;
    this.changed();
    return { ok: false, error };
  }

  /** The owner's stop: the Pistead window goes back to the configured server, and the next launch leaves it off. */
  async stop(): Promise<Outcome> {
    this.options.settings.update({ localServer: undefined });
    if (!this.child || this.status.state === "stopped") { this.changed(); return { ok: true }; }
    const result = await this.request({ type: "stop" });
    return result.ok ? { ok: true } : this.refuse(result.error.message);
  }

  /** At launch: start again if the owner left it on, without asking for consent they already gave. */
  async resume(): Promise<void> {
    const resume = this.options.settings.get().localServer;
    if (!resume) return;
    const outcome = await this.start(undefined, resume);
    if (!outcome.ok) this.log("error", outcome.error);
  }

  /** Stops the server cleanly, then ends the process; one that does not answer in time is killed. */
  async shutdown(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    const deadline = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(child.pid, "SIGKILL"); } catch { /* Already gone. */ }
    }, timeoutMs);
    void this.request({ type: "stop" }).then(() => child.kill());
    await exited.promise;
    clearTimeout(deadline);
  }
}
