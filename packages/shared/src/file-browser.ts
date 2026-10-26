import { fileBrowserLimits, type FileEntry, type SessionFiles } from "./types.js";

/**
 * The checks every file browser answer passes, on the runner that reads it and again on the control plane that relays it
 * from a host it doesn't trust: the shape, the limits in fileBrowserLimits, and a listing that agrees with itself.
 */
export type BrowseResult = { [K in SessionFiles["type"]]: Omit<Extract<SessionFiles, { type: K }>, "path" | "redacted"> }[SessionFiles["type"]];

export const fileImageTypes: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const entryTypes: readonly FileEntry["type"][] = ["directory", "file", "symlink", "other"];
const encoder = new TextEncoder();
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export class InvalidBrowseResult extends Error {
  constructor() { super("Invalid file browser response"); }
}

function invalid(): never { throw new InvalidBrowseResult(); }

/** A directory entry's name: one path component, as a directory listing can hold it. */
export function validEntryName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 1024 && name !== "." && name !== ".."
    && !name.includes("/") && !name.includes("\0");
}

/** `value` as a browse result, or InvalidBrowseResult. Unknown keys are dropped. */
export function checkBrowseResult(value: unknown): BrowseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (result.type === "directory") {
    const { entries, total, truncated } = result;
    if (!Array.isArray(entries) || entries.length > fileBrowserLimits.entries || !count(total) || total < entries.length
      || typeof truncated !== "boolean" || truncated !== total > entries.length) invalid();
    return { type: "directory", total, truncated, entries: entries.map((item: unknown) => {
      const entry = item as Record<string, unknown> | null;
      if (!entry || typeof entry !== "object" || !validEntryName(entry.name) || !entryTypes.includes(entry.type as FileEntry["type"])
        || (entry.size !== undefined && (entry.type !== "file" || !count(entry.size)))) invalid();
      return { name: entry.name as string, type: entry.type as FileEntry["type"], ...(entry.size !== undefined ? { size: entry.size as number } : {}) };
    }) };
  }
  if (result.type !== "file" || !count(result.size) || typeof result.truncated !== "boolean") invalid();
  const base = { type: "file" as const, size: result.size, truncated: result.truncated };
  if ([result.text, result.image, result.binary].filter(part => part !== undefined).length !== 1) invalid();
  if (result.binary !== undefined) {
    if (result.binary !== true) invalid();
    return { ...base, binary: true };
  }
  if (result.text !== undefined) {
    // Checked before any redaction: the limit is what the host may send.
    if (typeof result.text !== "string" || result.text.length > fileBrowserLimits.textBytes
      || encoder.encode(result.text).length > fileBrowserLimits.textBytes) invalid();
    return { ...base, text: result.text };
  }
  const image = result.image as Record<string, unknown> | null;
  if (!image || typeof image !== "object" || typeof image.mimeType !== "string" || !fileImageTypes.includes(image.mimeType)
    || typeof image.data !== "string" || image.data.length > Math.ceil(fileBrowserLimits.imageBytes / 3) * 4
    || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || result.truncated !== false) invalid();
  return { ...base, image: { mimeType: image.mimeType, data: image.data } };
}
