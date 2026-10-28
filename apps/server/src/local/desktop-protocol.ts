// Messages between a desktop app and its local server process (desktop.ts), over the parent's IPC channel only. The
// GitHub OAuth app's secret travels here and nowhere else: never argv, environment or logs. Types only, so the app's
// bundle imports nothing from the server; the process validates every request.

export interface LocalInspectRequest { type: "inspect"; id: number }

export interface LocalStartRequest {
  type: "start";
  id: number;
  /** A GitHub OAuth app to save first; without one, the saved app (the first start needs one). */
  github?: { clientId: string; clientSecret: string };
  /** Set only after the owner accepted the unsandboxed warning in a native dialog; without it, no host on this computer. */
  unsandboxedConsent?: boolean;
  /** Development builds only: the fixture model, and test sign-ins for 24 hours. */
  testMode?: boolean;
}

export interface LocalStopRequest { type: "stop"; id: number }

export type LocalServerRequest = LocalInspectRequest | LocalStartRequest | LocalStopRequest;

/** What starting would do, read without starting anything. */
export interface LocalInspection {
  stateDir: string;
  port: number;
  /** The saved GitHub OAuth app's client ID; its secret never leaves the process. */
  githubClientId?: string;
  /** How this computer would run sessions as the local server's host. */
  hostMode: "sandboxed" | "unsandboxed";
  unsandboxedWarning?: string;
  /** Why this computer can't be the host (prerequisites, Pi's models); the server still runs without it. */
  hostProblem?: string;
}

export type LocalServerState = "stopped" | "starting" | "running" | "stopping";
/** This computer as the local server's host: waiting until the owner has signed in, then the connector's own states. */
export type LocalHostState = "off" | "waiting" | "connecting" | "connected" | "disconnected" | "stopped" | "failed";

export interface LocalStatus {
  state: LocalServerState;
  origin?: string;
  /** The owner's sign-in link while nobody has claimed the server. */
  claimUrl?: string;
  host: LocalHostState;
}

export type LocalServerEvent =
  | { type: "ready" }
  | { type: "result"; id: number; ok: true; inspection?: LocalInspection }
  | { type: "result"; id: number; ok: false; error: { message: string } }
  | ({ type: "status" } & LocalStatus)
  | { type: "log"; level: "info" | "warning" | "error"; message: string };
