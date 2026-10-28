import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SERVER, parseServerOrigin } from "./origin.js";
import { isRecord } from "./requests.js";

export interface Bounds { x: number; y: number; width: number; height: number }

export interface Settings {
  server: string;
  windowBounds?: Bounds;
  /**
   * Present while the owner wants the host running: set when they start it, cleared when they stop it. The app resumes
   * hosting when it opens, with the unsandboxed consent they gave in the dialog at that start.
   */
  resumeHost?: { unsandboxedConsent: boolean };
  /**
   * Present while the owner wants Pistead running on this computer (local-server.ts): the Pistead window then shows it
   * instead of `server`, and it starts again at launch with the unsandboxed consent given at its start.
   */
  localServer?: { unsandboxedConsent: boolean };
}

const isBounds = (value: unknown): value is Bounds => isRecord(value)
  && [value.x, value.y, value.width, value.height].every(item => typeof item === "number" && Number.isSafeInteger(item))
  && Number(value.width) >= 200 && Number(value.height) >= 200;

/**
 * Unknown or invalid fields fall back to defaults: a damaged file never stops the app from opening. A `gitCredentials`
 * left by older versions is dropped: the host's owner turns Git credentials on in Pistead now.
 */
export function parseSettings(value: unknown): Settings {
  const source = isRecord(value) ? value : {};
  const server = typeof source.server === "string" ? parseServerOrigin(source.server) : undefined;
  const settings: Settings = { server: server?.ok ? server.origin : DEFAULT_SERVER };
  if (isBounds(source.windowBounds)) settings.windowBounds = source.windowBounds;
  const resume = source.resumeHost;
  if (isRecord(resume) && typeof resume.unsandboxedConsent === "boolean") settings.resumeHost = { unsandboxedConsent: resume.unsandboxedConsent };
  const local = source.localServer;
  if (isRecord(local) && typeof local.unsandboxedConsent === "boolean") settings.localServer = { unsandboxedConsent: local.unsandboxedConsent };
  return settings;
}

/** settings.json under userData, replaced atomically on every change. */
export class SettingsStore {
  private current: Settings;

  constructor(private readonly path: string) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { raw = undefined; }
    this.current = parseSettings(raw);
  }

  get(): Readonly<Settings> { return this.current; }

  update(patch: Partial<Settings>): void {
    const next: Settings = { ...this.current, ...patch };
    for (const key of Object.keys(patch) as (keyof Settings)[]) if (patch[key] === undefined) delete next[key];
    this.current = next;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.settings-${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
