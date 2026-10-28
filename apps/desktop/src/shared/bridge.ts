import type { HostInspection, HostState } from "../../../runner/src/desktop-protocol.js";
import type { LocalInspection, LocalStatus } from "../../../server/src/local/desktop-protocol.js";

// The typed surface between the app's local pages and its main process. Remote content never sees any of it.

export type { HostInspection, HostState, LocalInspection, LocalStatus };

export const channels = {
  hostView: "host:view",
  hostUpdate: "host:update",
  hostRefresh: "host:refresh",
  hostStart: "host:start",
  hostStop: "host:stop",
  hostOpenAtLogin: "host:open-at-login",
  settingsView: "settings:view",
  settingsServer: "settings:server",
  settingsUpdate: "settings:update",
  localStart: "local:start",
  localStop: "local:stop",
} as const;

export interface LogLine { time: number; level: "info" | "warning" | "error"; message: string }

export const stateLabels: Record<HostState, string> = {
  stopped: "Stopped", starting: "Starting…", connecting: "Connecting…", connected: "Online",
  disconnected: "Reconnecting…", stopping: "Stopping…",
};

export interface HostView {
  /** "This Mac" on macOS, "This computer" elsewhere. */
  title: string;
  /** The configured Pistead server; the host pairs with and connects to it. */
  server: string;
  state: HostState;
  /** Set while the connector runs: the server it connects to and whether it runs unsandboxed. */
  running?: { server: string; unsandboxed: boolean };
  inspection?: HostInspection;
  inspecting: boolean;
  /** The latest failure, cleared by the next start. */
  error?: string;
  logs: LogLine[];
  /** Absent where the platform has no login items (Linux). */
  openAtLogin?: boolean;
  /** Development builds may advertise fixture models instead of Pi's. */
  fixtureModels: boolean;
}

export interface StartInput {
  pairing?: { id: string; code: string };
  replacePairing: boolean;
}

export type Outcome = { ok: true } | { ok: false; error: string };

/** Pistead on this computer (Settings): the local server's state and what starting it would do. */
export interface LocalView {
  /** On while the owner wants it running: it starts again at launch. */
  enabled: boolean;
  status: LocalStatus;
  inspection?: LocalInspection;
  /** The latest failure, cleared by the next start. */
  error?: string;
  logs: LogLine[];
}

export interface LocalStartInput { github?: { clientId: string; clientSecret: string } }

export interface SettingsView { server: string; defaultServer: string; local: LocalView }

export interface PisteadBridge {
  host: {
    view(): Promise<HostView>;
    refresh(): Promise<void>;
    start(input: StartInput): Promise<Outcome>;
    stop(): Promise<Outcome>;
    setOpenAtLogin(enabled: boolean): Promise<Outcome>;
    onUpdate(listener: (view: HostView) => void): () => void;
  };
  settings: {
    view(): Promise<SettingsView>;
    setServer(origin: string): Promise<Outcome>;
    startLocal(input: LocalStartInput): Promise<Outcome>;
    stopLocal(): Promise<Outcome>;
    onUpdate(listener: (view: SettingsView) => void): () => void;
  };
}
