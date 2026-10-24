import type { GitPushOperation, PushCredential } from "../../../packages/shared/src/types.js";
import { GitRemote, GitRemoteError, ZERO_OID } from "./git-remote.js";
import type { SandboxAuthorize } from "./sandbox.js";

/** A clone's side of a push: the advertised tips it has, whether the branch fast-forwards, and the commits that are new. */
export interface ClonePushPreparation {
  present: string[]; ancestor: boolean | null;
  /** The newest of the commits the remote lacks, at most 100; `total` counts them all. */
  commits: { source: string; subject: string }[]; total: number;
}

/** Clone pushes run only in the sandbox: unsandboxed sessions push with their own Git. */
export interface ClonePushWorkspace {
  clonePushPrepare(path: string, input: { commit: string; old: string | null; tips: string[] }, authorize: SandboxAuthorize): Promise<ClonePushPreparation>;
  clonePushPack(path: string, input: { commit: string; exclude: string[] }, authorize: SandboxAuthorize): Promise<AsyncIterable<Uint8Array>>;
}

/** A definite failure: no ref changed. Messages are fixed and credential-free. */
export class PushError extends Error {
  constructor(message: string) { super(message); this.name = "PushError"; }
}

export interface PushResult {
  outcome: "pushed" | "up-to-date";
  branch: string;
  /** Tag pushes: the tag created at `tip`, a commit on `branch`. */
  tag?: string;
  tip: string;
  base: string;
  previous: string | null;
  commits: { source: string; rewritten: string; subject: string }[];
  /** How many commits the push carries, when `commits` lists only the newest of them. */
  total?: number;
}

const OID = /^[0-9a-f]{40}$/;

/** Workspace failures carry fixed "sandbox: ..." reasons; anything else stays local. */
function workspaceReason(error: unknown): string {
  const reason = error instanceof Error ? /sandbox: ([a-z0-9 ,.'()-]{1,160})$/i.exec(error.message.trim())?.[1] : undefined;
  return reason ? `: ${reason}` : "";
}

/**
 * Pushes a clone's commit, as it is, to a branch of the repository the clone came from: fast-forward only, sending the
 * objects the remote's advertised tips don't already reach. Throws PushError for definite failures; any other error
 * happened during or after upload and is ambiguous.
 */
export async function performClonePush(options: {
  workspace: ClonePushWorkspace; operation: GitPushOperation; credential: Pick<PushCredential, "remote" | "authorization">;
  authorize: SandboxAuthorize; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<PushResult> {
  const { workspace, operation, credential, authorize } = options;
  const directory = operation.directory;
  if (directory === undefined || !OID.test(operation.commit)) throw new PushError("Push target does not name a clone");
  let remote: GitRemote;
  try {
    remote = new GitRemote({ url: credential.remote, authorization: credential.authorization, fetch: options.fetch, signal: options.signal });
  } catch (error) {
    throw new PushError(error instanceof GitRemoteError ? error.message : "Git remote is invalid");
  }
  if (operation.tag !== undefined) return performTagPush({ ...options, remote, directory, tag: operation.tag });
  const ref = `refs/heads/${operation.branch}`;
  let advertised: { refs: Map<string, string>; capabilities: Set<string> };
  let prepared: ClonePushPreparation;
  let previous = ZERO_OID;
  try {
    advertised = await remote.receivePackAdvertisement();
    previous = advertised.refs.get(ref) ?? ZERO_OID;
    // The branch's tip first, then the others: the clone needs no objects that any of them reaches.
    const tips = [...new Set([previous, ...advertised.refs.values()])].filter(tip => tip !== ZERO_OID && OID.test(tip)).slice(0, 1024);
    try {
      prepared = await workspace.clonePushPrepare(directory, { commit: operation.commit, old: previous === ZERO_OID ? null : previous, tips }, authorize);
    } catch (error) {
      throw new PushError(`The clone could not be prepared for push${workspaceReason(error)}`);
    }
  } catch (error) {
    if (error instanceof PushError) throw error;
    if (error instanceof GitRemoteError) throw new PushError(error.message);
    throw new PushError("Git remote request failed");
  }
  const result = { branch: operation.branch, tip: operation.commit, base: previous === ZERO_OID ? "" : previous, previous: previous === ZERO_OID ? null : previous,
    commits: prepared.commits.map(commit => ({ source: commit.source, rewritten: commit.source, subject: commit.subject })), total: prepared.total };
  if (previous === operation.commit) return { outcome: "up-to-date", ...result };
  if (previous !== ZERO_OID && !prepared.ancestor) {
    throw new PushError(`Remote branch ${operation.branch} has commits the clone doesn't have; fetch and merge or rebase first, as pushes are fast-forward only`);
  }
  let pack: AsyncIterable<Uint8Array>;
  try {
    pack = await workspace.clonePushPack(directory, { commit: operation.commit, exclude: prepared.present }, authorize);
  } catch (error) {
    throw new PushError(`Push pack could not be created${workspaceReason(error)}`);
  }
  const report = await remote.push({ ref, old: previous, new: operation.commit }, pack, advertised.capabilities);
  if (report.status !== "ok") {
    const reason = (report.reason ?? "").replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 200);
    throw new PushError(`Git remote rejected the push${reason ? ` (${reason})` : ""}`);
  }
  return { outcome: "pushed", ...result };
}

/**
 * Creates refs/tags/<tag> at the operation's commit, which the remote's branch must already reach, so no branch moves and
 * the pack carries no objects. A tag is never moved: one at another object is refused, one at this commit is up to date.
 */
async function performTagPush(options: {
  workspace: ClonePushWorkspace; operation: GitPushOperation; authorize: SandboxAuthorize; remote: GitRemote; directory: string; tag: string;
}): Promise<PushResult> {
  const { workspace, operation, authorize, remote, directory, tag } = options;
  const ref = `refs/tags/${tag}`;
  let advertised: { refs: Map<string, string>; capabilities: Set<string> };
  let base: string;
  let existing: string | undefined;
  let prepared: ClonePushPreparation;
  try {
    advertised = await remote.receivePackAdvertisement();
    const tip = advertised.refs.get(`refs/heads/${operation.branch}`);
    if (!tip || tip === ZERO_OID || !OID.test(tip)) throw new PushError(`Remote branch ${operation.branch} does not exist; a tag is pushed only for a commit already on it`);
    base = tip;
    existing = advertised.refs.get(ref);
    if (existing !== undefined && existing !== operation.commit) {
      throw new PushError(`Tag ${tag} already exists at ${existing.slice(0, 12)}; tags are never moved or replaced`);
    }
    // Only the branch's tip as a tip: the commits the clone counts are then exactly those the branch doesn't reach.
    try {
      prepared = await workspace.clonePushPrepare(directory, { commit: operation.commit, old: null, tips: [base] }, authorize);
    } catch (error) {
      throw new PushError(`The clone could not be prepared for push${workspaceReason(error)}`);
    }
  } catch (error) {
    if (error instanceof PushError) throw error;
    if (error instanceof GitRemoteError) throw new PushError(error.message);
    throw new PushError("Git remote request failed");
  }
  const result = { branch: operation.branch, tag, tip: operation.commit, base, previous: null, commits: [], total: 0 };
  if (existing === operation.commit) return { outcome: "up-to-date", ...result };
  if (!prepared.present.includes(base)) {
    throw new PushError(`The clone doesn't have the tip of ${operation.branch} (${base.slice(0, 12)}); fetch it first`);
  }
  if (prepared.total !== 0) {
    throw new PushError(`Commit ${operation.commit.slice(0, 12)} is not on ${operation.branch}; push or merge it there first, as a tag is pushed only for a commit already on its branch`);
  }
  let pack: AsyncIterable<Uint8Array>;
  try {
    // Everything the tag names is already on the remote: the pack is empty.
    pack = await workspace.clonePushPack(directory, { commit: operation.commit, exclude: [base] }, authorize);
  } catch (error) {
    throw new PushError(`Push pack could not be created${workspaceReason(error)}`);
  }
  const report = await remote.push({ ref, old: ZERO_OID, new: operation.commit }, pack, advertised.capabilities);
  if (report.status !== "ok") {
    const reason = (report.reason ?? "").replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 200);
    throw new PushError(`Git remote rejected the tag${reason ? ` (${reason})` : ""}`);
  }
  return { outcome: "pushed", ...result };
}

/** Human- and agent-readable outcome; never includes credentials. */
export function pushSummary(result: PushResult, pullRequest?: { url: string; number: number; created: boolean }): string {
  if (result.tag !== undefined) {
    return result.outcome === "up-to-date"
      ? `Tag ${result.tag} already exists at ${result.tip}.`
      : `Created tag ${result.tag} at ${result.tip.slice(0, 12)}, on ${result.branch} (at ${result.base.slice(0, 12)}).`;
  }
  const lines = [result.outcome === "up-to-date"
    ? `Branch ${result.branch} is already up to date at ${result.tip}.`
    : `Pushed ${result.total ?? result.commits.length} commit${(result.total ?? result.commits.length) === 1 ? "" : "s"} to ${result.branch} (${result.previous ? `${result.previous.slice(0, 12)}..` : "new branch at "}${result.tip.slice(0, 12)})${result.base ? `, based on ${result.base.slice(0, 12)}` : ""}.`];
  for (const commit of result.commits) lines.push(`- ${commit.rewritten.slice(0, 12)} ${commit.subject}`);
  if (result.total !== undefined && result.total > result.commits.length) lines.push(`- … and ${result.total - result.commits.length} older`);
  if (pullRequest) lines.push(`Pull request #${pullRequest.number} ${pullRequest.created ? "opened" : "already open"}: ${pullRequest.url}`);
  return lines.join("\n");
}
