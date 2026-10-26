import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileBrowserLimits, type FileEntry, type SessionFiles } from "../../../packages/shared/src/types.js";
import { imageType } from "./images.js";

/**
 * The session panel's read-only file browser (the `files` runner action). The sandbox helper (`browse` in sandbox.ts)
 * and the unsandboxed host workspace (below) read the same thing, within fileBrowserLimits: a directory's entries,
 * lstat-ed and never followed, or a preview of a file. Whatever comes back is checked again here.
 */
export type BrowseResult = { [K in SessionFiles["type"]]: Omit<Extract<SessionFiles, { type: K }>, "path"> }[SessionFiles["type"]];

const entryTypes: readonly FileEntry["type"][] = ["directory", "file", "symlink", "other"];
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** More entries than this in one directory are refused rather than listed in part: listing them would take too long. */
const MAX_LISTED = 100_000;

function invalid(): never { throw new Error("Invalid file browser response"); }

const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Sorts directories first, then by name in code-unit order, as the sandbox helper does. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => Number(a.type !== "directory") - Number(b.type !== "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Checks a browse result from the sandbox helper or the host workspace before it leaves the runner. */
export function checkedBrowse(value: unknown): BrowseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (result.type === "directory") {
    const { entries, total, truncated } = result;
    if (!Array.isArray(entries) || entries.length > fileBrowserLimits.entries || !nonNegative(total) || total < entries.length
      || typeof truncated !== "boolean" || truncated !== total > entries.length) invalid();
    return { type: "directory", total, truncated, entries: entries.map((item: unknown) => {
      const entry = item as Record<string, unknown> | null;
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name || entry.name.length > 1024
        || entry.name.includes("/") || entry.name === "." || entry.name === ".." || !entryTypes.includes(entry.type as FileEntry["type"])
        || (entry.size !== undefined && (entry.type !== "file" || !nonNegative(entry.size)))) invalid();
      return { name: entry.name, type: entry.type as FileEntry["type"], ...(entry.size !== undefined ? { size: entry.size as number } : {}) };
    }) };
  }
  if (result.type !== "file" || !nonNegative(result.size) || typeof result.truncated !== "boolean") invalid();
  const base = { type: "file" as const, size: result.size, truncated: result.truncated };
  const kinds = [result.text !== undefined, result.image !== undefined, result.binary !== undefined].filter(Boolean).length;
  if (kinds !== 1) invalid();
  if (result.binary !== undefined) {
    if (result.binary !== true) invalid();
    return { ...base, binary: true };
  }
  if (result.text !== undefined) {
    if (typeof result.text !== "string" || Buffer.byteLength(result.text) > fileBrowserLimits.textBytes) invalid();
    return { ...base, text: result.text };
  }
  const image = result.image as Record<string, unknown> | null;
  if (!image || typeof image !== "object" || typeof image.data !== "string" || typeof image.mimeType !== "string") invalid();
  const bytes = Buffer.from(image.data, "base64");
  // The signature is checked again here, like every image read_file returns.
  if (bytes.length > fileBrowserLimits.imageBytes || bytes.toString("base64") !== image.data || imageType(bytes) !== image.mimeType) invalid();
  return { ...base, image: { mimeType: image.mimeType, data: image.data } };
}

/** The entries of `directory`, a real directory the caller confined to the worktree. */
export async function browseDirectory(directory: string): Promise<BrowseResult> {
  const names = await readdir(directory);
  if (names.length > MAX_LISTED) throw new Error("directory has too many entries");
  const entries: FileEntry[] = [];
  for (const name of names) {
    let info;
    try { info = await lstat(join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const type: FileEntry["type"] = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
    entries.push({ name, type, ...(type === "file" ? { size: info.size } : {}) });
  }
  sortEntries(entries);
  return { type: "directory", entries: entries.slice(0, fileBrowserLimits.entries), total: entries.length, truncated: entries.length > fileBrowserLimits.entries };
}

/** A preview of `file`, which the caller confined to the worktree; opened without following a symlink. */
export async function browseFile(file: string): Promise<BrowseResult> {
  const handle = await open(file, FILE_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { type: "file", size: 0, truncated: false, binary: true };
    const size = info.size;
    const read = async (limit: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(limit);
      let length = 0;
      while (length < limit) {
        const { bytesRead } = await handle.read(buffer, length, limit - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    };
    const head = await read(16);
    const mimeType = imageType(head);
    if (mimeType) {
      if (size > fileBrowserLimits.imageBytes) return { type: "file", size, truncated: true, binary: true };
      const data = await read(fileBrowserLimits.imageBytes + 1);
      if (data.length > fileBrowserLimits.imageBytes) return { type: "file", size, truncated: true, binary: true };
      return { type: "file", size, truncated: false, image: { mimeType, data: data.toString("base64") } };
    }
    const prefix = await read(fileBrowserLimits.textBytes + 1);
    const truncated = prefix.length > fileBrowserLimits.textBytes || size > fileBrowserLimits.textBytes;
    return { type: "file", size, truncated, ...textPreview(prefix.subarray(0, fileBrowserLimits.textBytes), truncated) };
  } finally {
    await handle.close();
  }
}

/** UTF-8 text, or binary for anything with a NUL or invalid UTF-8; a preview cut inside a character ends before it. */
export function textPreview(data: Uint8Array, truncated: boolean): { text: string } | { binary: true } {
  if (data.includes(0)) return { binary: true };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= data.length; cut++) {
    try { return { text: decoder.decode(data.subarray(0, data.length - cut)) }; } catch { /* try a shorter cut */ }
  }
  return { binary: true };
}
