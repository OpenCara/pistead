import type { LocalModelSummary } from "../../../packages/shared/src/connector.js";

/** One binary or tool the chosen isolation mode needs, as connect-setup.ts checks it. */
export interface Prerequisite { name: string; ok: boolean }

// Messages between a desktop app and its connector host (desktop-host.ts), over the parent's IPC channel only. Pairing
// codes travel here and nowhere else: never argv, environment, files or logs. Types and patterns only, so the app's
// bundle imports nothing from the connector; the host validates every request against them.

export const pairingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const pairingCodePattern = /^[A-Za-z0-9_-]{8,256}$/;

/** Development only: the app sets these solely when it runs unpackaged or against a loopback server. */
interface DevelopmentOptions {
  allowFaux?: boolean;
  allowInsecureLoopback?: boolean;
}

export interface InspectRequest extends DevelopmentOptions { type: "inspect"; id: number }

export interface StartRequest extends DevelopmentOptions {
  type: "start";
  id: number;
  /** The app's configured origin; a saved pairing for another server is refused, never silently used. */
  server: string;
  pairing?: { id: string; code: string };
  /** With `pairing`, replace this machine's saved pairing. */
  replacePairing?: boolean;
  /** Set only after the owner accepted the unsandboxed warning in a native dialog. */
  unsandboxedConsent?: boolean;
  /** Explicit subset; without it Pi's enabledModels setting, else every authenticated model, is advertised. */
  models?: { provider: string; modelId: string }[];
}

export interface StopRequest { type: "stop"; id: number }

export type HostRequest = InspectRequest | StartRequest | StopRequest;

export type HostState = "stopped" | "starting" | "connecting" | "connected" | "disconnected" | "stopping";

/** What this machine would run, read without starting anything. */
export interface HostInspection {
  platform: string;
  stateDir: string;
  /** Why this machine cannot host at all (native Windows, an old Node.js). */
  unsupported?: string;
  /** Linux with bubblewrap and its companions runs sandboxed; everything else needs the owner's unsandboxed consent. */
  mode: "sandboxed" | "unsandboxed";
  /** Linux only: the isolated sandbox's prerequisites, present even when they are missing. */
  sandboxPrerequisites?: Prerequisite[];
  /** The chosen mode's prerequisites. */
  prerequisites: Prerequisite[];
  prerequisitesError?: string;
  pairedServer?: string;
  pairingError?: string;
  models: LocalModelSummary[];
  modelsError?: string;
  /** The CLI's exact --unsafe-no-sandbox warning, for the app's native consent dialog. */
  unsandboxedWarning?: string;
}

/** Stable reasons a front end may act on; the message is always shown as is. */
export type HostErrorCode = "invalid-request" | "unsupported" | "consent-required" | "not-paired" | "already-paired"
  | "server-mismatch" | "already-running" | "lease-busy" | "setup" | "failed";

export interface HostError { code: HostErrorCode; message: string }

export type HostEvent =
  | { type: "ready" }
  | { type: "result"; id: number; ok: true; inspection?: HostInspection }
  | { type: "result"; id: number; ok: false; error: HostError }
  | { type: "status"; state: HostState; server?: string; unsandboxed?: boolean }
  | { type: "log"; level: "info" | "warning" | "error"; message: string }
  /** A started connector failed or stopped without being asked to. */
  | { type: "failed"; error: HostError };
