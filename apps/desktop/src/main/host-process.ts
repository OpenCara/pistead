import { utilityProcess, type UtilityProcess } from "electron";
import type { HostEvent, HostRequest } from "../../../runner/src/desktop-protocol.js";

// Runs the connector host (dist/host/desktop-host.mjs, see scripts/build.mjs) in an Electron utility process:
// Electron's embedded Node, independent of the RunAsNode fuse, and torn down with the app. It is started on demand
// and never restarted by itself: an unexpected exit is reported and the next request starts a fresh one.

type Request = HostRequest extends infer R ? R extends HostRequest ? Omit<R, "id"> : never : never;
export type HostResult = Extract<HostEvent, { type: "result" }>;

const eventTypes: Record<HostEvent["type"], true> = { ready: true, result: true, status: true, log: true, failed: true };
const isHostEvent = (value: unknown): value is HostEvent => typeof value === "object" && value !== null
  && "type" in value && typeof value.type === "string" && Object.hasOwn(eventTypes, value.type);

export interface HostProcessOptions {
  entry: string;
  args: string[];
  onEvent(event: Exclude<HostEvent, HostResult | { type: "ready" }>): void;
  /** Lines the host process printed outside the protocol, e.g. library warnings. */
  onOutput(line: string): void;
  onExit(code: number, expected: boolean): void;
}

export class HostProcess {
  private child?: UtilityProcess;
  private ready?: Promise<void>;
  private readonly pending = new Map<number, (result: HostResult) => void>();
  private nextId = 1;
  private stopping = false;

  constructor(private readonly options: HostProcessOptions) {}

  get running(): boolean { return this.child !== undefined; }

  private spawn(): Promise<void> {
    const child = utilityProcess.fork(this.options.entry, this.options.args, { serviceName: "Pistead Host", stdio: "pipe" });
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
        for (const line of lines) if (line.trim()) this.options.onOutput(line.slice(0, 1000));
      });
    }
    child.on("message", (value: unknown) => {
      if (!isHostEvent(value)) return;
      if (value.type === "ready") { ready.resolve(); return; }
      if (value.type !== "result") { this.options.onEvent(value); return; }
      const settle = this.pending.get(value.id);
      this.pending.delete(value.id);
      settle?.(value);
    });
    // A fatal V8 error (an out-of-memory, say) arrives as "error" before "exit"; unhandled, it would throw in the main process.
    child.on("error", (type, location) => this.options.onOutput(`The host process failed: ${type} at ${location}`));
    child.once("exit", code => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      ready.reject(new Error("exited"));
      for (const [id, settle] of this.pending) settle({ type: "result", id, ok: false, error: { code: "failed", message: "The host process exited before it answered." } });
      this.pending.clear();
      this.options.onExit(code, this.stopping);
    });
    return ready.promise;
  }

  async request(message: Request): Promise<HostResult> {
    this.ready ??= this.spawn();
    try { await this.ready; }
    catch { return { type: "result", id: 0, ok: false, error: { code: "failed", message: "The host process could not start." } }; }
    const child = this.child!;
    const id = this.nextId++;
    const result = Promise.withResolvers<HostResult>();
    this.pending.set(id, result.resolve);
    child.postMessage({ ...message, id });
    return result.promise;
  }

  /** Stops the connector cleanly, then ends the process; a host that does not answer in time is killed. */
  async shutdown(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    // kill() sends SIGTERM, which a host still stopping its connector waits out, so the deadline kills outright. The
    // connector's lease is released by its guardian process once the host's end of the pipe closes.
    const deadline = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(child.pid, "SIGKILL"); } catch { /* Already gone. */ }
    }, timeoutMs);
    void this.request({ type: "stop" }).then(() => child.kill());
    await exited.promise;
    clearTimeout(deadline);
  }
}
