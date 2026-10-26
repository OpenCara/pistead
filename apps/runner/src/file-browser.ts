import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { checkBrowseResult, type BrowseResult } from "../../../packages/shared/src/file-browser.js";
import { fileBrowserLimits, type FileEntry } from "../../../packages/shared/src/types.js";
import { imageType } from "./images.js";

/**
 * The session panel's read-only file browser (the `files` runner action). The sandbox helper (`browse` in sandbox.ts)
 * and the unsandboxed host workspace (below) read the same thing, within fileBrowserLimits: a directory's entries,
 * lstat-ed and never followed, or a preview of a file. Whatever comes back is checked again here.
 */
export type { BrowseResult };

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** More entries than this in one directory are refused rather than listed in part: listing them would take too long. */
const MAX_LISTED = 100_000;

/** Sorts directories first, then by name in code-unit order, as the sandbox helper does. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => Number(a.type !== "directory") - Number(b.type !== "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Checks a browse result from the sandbox helper or the host workspace before it leaves the runner. */
export function checkedBrowse(value: unknown): BrowseResult {
  const result = checkBrowseResult(value);
  // The signature is checked again here, like every image read_file returns.
  if (result.type === "file" && result.image && imageType(Buffer.from(result.image.data, "base64")) !== result.image.mimeType) {
    throw new Error("Invalid file browser response");
  }
  return result;
}

/**
 * Where to read an open directory from. On Linux, the descriptor's own /proc path: what is read is what was opened,
 * whatever the path names by then. Elsewhere (macOS hosts), the path itself, once it is checked to still name the
 * directory that was opened.
 */
async function readablePath(directory: string, handle: FileHandle): Promise<{ path: string; check(): Promise<void> }> {
  if (process.platform === "linux") return { path: `/proc/self/fd/${handle.fd}`, check: async () => {} };
  const opened = await handle.stat({ bigint: true });
  const check = async () => {
    const now = await lstat(directory, { bigint: true });
    if (!now.isDirectory() || now.dev !== opened.dev || now.ino !== opened.ino) throw new Error("directory changed while being read; retry the operation");
  };
  await check();
  return { path: directory, check };
}

/**
 * The entries of `directory`, which the caller confined to the worktree. It is opened once without following a symlink,
 * and listed through that descriptor: a symlink swapped in after the caller's checks can't redirect the listing.
 */
export async function browseDirectory(directory: string): Promise<BrowseResult> {
  const handle = await open(directory, DIRECTORY_FLAGS);
  try {
    const { path: opened, check } = await readablePath(directory, handle);
    const names = await readdir(opened);
    if (names.length > MAX_LISTED) throw new Error("directory has too many entries");
    const entries: FileEntry[] = [];
    for (const name of names) {
      let info;
      try { info = await lstat(`${opened}/${name}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const type: FileEntry["type"] = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
      entries.push({ name, type, ...(type === "file" ? { size: info.size } : {}) });
    }
    await check();
    sortEntries(entries);
    return { type: "directory", entries: entries.slice(0, fileBrowserLimits.entries), total: entries.length, truncated: entries.length > fileBrowserLimits.entries };
  } finally {
    await handle.close();
  }
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
