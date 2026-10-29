import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { validPushBranch } from "../../../packages/shared/src/repositories.js";
import type { EgressRepository } from "../../../packages/shared/src/network.js";
import { repositoryForRemote } from "./egress.js";

/*
 * A session on a host pushes and opens pull requests with the host's own Git and credentials, so Pistead never sees
 * them. Its host reports the branches its clones have checked out instead, and the control plane finds their pull
 * requests on GitHub (apps/server/src/session-branches.ts). This reads those branches from the clones' Git metadata
 * as files, running no Git, so nothing in a clone's configuration runs.
 */

/** Clones are looked for this many directories deep in the worktree (app, src/app, work/src/app). */
const MAX_DEPTH = 3;
/** Directories looked into, at most, and clones reported. */
const MAX_DIRECTORIES = 2000;
export const MAX_CLONE_BRANCHES = 20;
const MAX_METADATA_BYTES = 64 * 1024;
/** Directories that hold no clone of the session's own: dependencies and build output. */
const SKIPPED = new Set(["node_modules", "vendor", "target", "dist", "build"]);

/** A clone's checked-out branch: its directory in the worktree, its origin remote's URL, and the branch. */
export interface CloneBranch { directory: string; origin: string; branch: string }

/** A small regular file's text, read without following a symlink; undefined when it isn't one. */
async function readSmall(path: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return undefined; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) return undefined;
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, info.size, 0);
    return data.subarray(0, bytesRead).toString("utf8");
  } catch { return undefined; } finally { await handle.close(); }
}

/** The branch a HEAD file names (ref: refs/heads/<branch>), or undefined for a detached HEAD or anything else. */
export function headBranch(head: string | undefined, prefix = "refs/heads/"): string | undefined {
  const match = /^ref: (\S+)\s*$/.exec(head ?? "");
  if (!match || !match[1]!.startsWith(prefix)) return undefined;
  const branch = match[1]!.slice(prefix.length);
  return validPushBranch(branch) ? branch : undefined;
}

/** The url of [remote "origin"] in a Git config file's text, or undefined. Includes and URL rewrites aren't followed. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  let url: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    // A later url of the same remote is another push or fetch URL; the first is the one Git fetches from.
    if (entry && url === undefined) url = configValue(entry[1]!);
  }
  return url || undefined;
}

/**
 * A Git config value as Git reads it: quotes kept together, `\\`, `\"`, `\n`, `\t` and `\b` unescaped, and a `#` or `;`
 * outside quotes starting a comment. Git for Windows writes a local path's backslashes as `\\`.
 */
function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  let pending = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[++index];
      value += pending + (next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next ?? "");
      pending = "";
    } else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "#" || char === ";")) break;
    // Whitespace outside quotes counts only between other characters.
    else if (!quoted && /\s/.test(char)) pending += char;
    else { value += pending + char; pending = ""; }
  }
  return value.trim();
}

/**
 * The checked-out branches of the clones in `worktree`, in directory order: directories up to MAX_DEPTH deep with a
 * .git directory of their own (the worktree's own .git is Pistead's), not followed through symlinks. A directory with a
 * .git file (a linked worktree or submodule) is neither reported nor looked into. A clone on a
 * detached HEAD, without an origin, or on its origin's default branch (refs/remotes/origin/HEAD, which git clone
 * records; main or master when it didn't) is left out: such work has no pull request of its own.
 */
export async function readCloneBranches(worktree: string): Promise<CloneBranch[]> {
  const found: CloneBranch[] = [];
  let visited = 0;
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited++ >= MAX_DIRECTORIES || found.length >= MAX_CLONE_BRANCHES) return;
    let names: string[];
    try { names = (await readdir(directory)).sort(); } catch { return; }
    const metadata = relative && names.includes(".git") ? await lstat(join(directory, ".git")).catch(() => undefined) : undefined;
    // A .git file is a linked worktree or a submodule: its metadata lives elsewhere, so it isn't read, but its directory
    // is still a repository's work, not a place for more clones.
    if (metadata && !metadata.isDirectory()) return;
    if (metadata) {
      const git = join(directory, ".git");
      const branch = headBranch(await readSmall(join(git, "HEAD")));
      const origin = originUrl(await readSmall(join(git, "config")) ?? "");
      const defaultBranch = headBranch(await readSmall(join(git, "refs", "remotes", "origin", "HEAD")), "refs/remotes/origin/");
      if (branch && origin && (defaultBranch ? branch !== defaultBranch : !["main", "master"].includes(branch))) {
        found.push({ directory: relative, origin, branch });
      }
      // A clone's own directories are its work, not more clones.
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      const path = join(directory, name);
      if (!(await lstat(path).catch(() => undefined))?.isDirectory()) continue;
      await visit(path, relative ? `${relative}/${name}` : name, depth + 1);
    }
  };
  await visit(worktree, "", 0);
  return found;
}

/**
 * The branches to report, from `clones`: those of the workspace's github.com repositories, as { repository: owner/name,
 * branch }, without repeats, sorted so that an unchanged set reports the same.
 */
export function reportedBranches(clones: readonly CloneBranch[], repositories: readonly EgressRepository[]): { repository: string; branch: string }[] {
  const branches = new Map<string, { repository: string; branch: string }>();
  for (const clone of clones) {
    const repository = repositoryForRemote(repositories, clone.origin);
    if (!repository || repository.provider !== "github" || repository.host !== "github.com") continue;
    branches.set(`${repository.fullName}\n${clone.branch}`, { repository: repository.fullName, branch: clone.branch });
  }
  return [...branches.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value).slice(0, MAX_CLONE_BRANCHES);
}
