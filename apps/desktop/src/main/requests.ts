import { pairingCodePattern, pairingIdPattern } from "../../../runner/src/desktop-protocol.js";
import type { StartInput } from "../shared/bridge.js";

// Validation of every payload a local page sends the main process; pure, so tests run it without Electron.

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The package's one plain-object guard, for IPC payloads and the settings file; fields stay `unknown`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function parseStartInput(value: unknown): Parsed<StartInput> {
  if (!isRecord(value) || !onlyKeys(value, ["pairing", "replacePairing"]) || typeof value.replacePairing !== "boolean") {
    return { ok: false, error: "Invalid start request." };
  }
  if (value.pairing === undefined) {
    return value.replacePairing ? { ok: false, error: "Enter a new pairing ID and code to replace this computer's pairing." } : { ok: true, value: { replacePairing: false } };
  }
  const pairing = value.pairing;
  if (!isRecord(pairing) || !onlyKeys(pairing, ["id", "code"]) || typeof pairing.id !== "string" || typeof pairing.code !== "string") {
    return { ok: false, error: "Invalid start request." };
  }
  const id = pairing.id.trim();
  const code = pairing.code.trim();
  if (!pairingIdPattern.test(id)) {
    // Same guard as the CLI: a pasted code in the ID field is no longer private.
    return { ok: false, error: /^[A-Za-z0-9_-]{43}$/.test(id)
      ? "That looks like the single-use pairing code, not the pairing ID. Create a new code in Pistead (this one is no longer private) and enter its pairing ID, which looks like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed."
      : "The pairing ID is shown in Pistead next to the code and looks like 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed." };
  }
  if (!code) return { ok: false, error: "Enter the single-use pairing code shown in Pistead." };
  if (!pairingCodePattern.test(code)) return { ok: false, error: "That pairing code is not valid. Copy the single-use code shown in Pistead." };
  return { ok: true, value: { pairing: { id, code }, replacePairing: value.replacePairing } };
}

export function parseBoolean(value: unknown): Parsed<boolean> {
  return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Invalid request." };
}

export function parseString(value: unknown, maximum: number): Parsed<string> {
  return typeof value === "string" && value.length <= maximum ? { ok: true, value } : { ok: false, error: "Invalid request." };
}

/** Local pages are served by the app's own protocol; anything else (remote content, a navigated frame) is refused. */
export function isLocalPage(url: string, page: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST && parsed.pathname === `/${page}`;
}

export const APP_SCHEME = "pistead-app";
export const APP_HOST = "local";
