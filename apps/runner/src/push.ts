import { randomUUID } from "node:crypto";
import type { SessionRepository } from "../../../packages/shared/src/repositories.js";
import type { GitPushOperation, PushCredential } from "../../../packages/shared/src/types.js";
import { GitRemote, GitRemoteError, ZERO_OID } from "./git-remote.js";
import type { SandboxAuthorize } from "./sandbox.js";

/** Session commits rewritten onto the pinned upstream commit; `tip` is the last rewritten commit. */
export interface PushPreparation { tip: string; base: string; commits: { source: string; rewritten: string; subject: string }[] }

/** Implemented identically by the Linux sandbox and the unsandboxed host workspace. */
export interface PushWorkspace {
  head(authorize: SandboxAuthorize): Promise<string>;
  pushPrepare(id: string, input: { path: string; base: string; commit: string }, pack: AsyncIterable<Uint8Array>, authorize: SandboxAuthorize): Promise<PushPreparation>;
  pushPack(id: string, input: { tip: string; exclude: string[] }, authorize: SandboxAuthorize): Promise<AsyncIterable<Uint8Array>>;
  pushCleanup(id: string): Promise<void>;
}

/** A definite failure: no ref changed. Messages are fixed and credential-free. */
export class PushError extends Error {
  constructor(message: string) { super(message); this.name = "PushError"; }
}

export interface PushResult {
  outcome: "pushed" | "up-to-date";
  branch: string;
  tip: string;
  base: string;
  previous: string | null;
  commits: PushPreparation["commits"];
}

const OID = /^[0-9a-f]{40}$/;

/** Workspace failures carry fixed "sandbox: ..." reasons; anything else stays local. */
function workspaceReason(error: unknown): string {
  const reason = error instanceof Error ? /sandbox: ([a-z0-9 ,.'()-]{1,160})$/i.exec(error.message.trim())?.[1] : undefined;
  return reason ? `: ${reason}` : "";
}

/**
 * Rewrites the approved session commits onto the pinned commit and pushes them fast-forward only.
 * Throws PushError for definite failures; any other error happened during or after upload and is ambiguous.
 */
export async function performPush(options: {
  workspace: PushWorkspace; operation: GitPushOperation; repository: SessionRepository; credential: PushCredential;
  authorize: SandboxAuthorize; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<PushResult> {
  const { workspace, operation, repository, credential, authorize } = options;
  if (repository.path !== operation.repository || !OID.test(operation.commit) || !OID.test(repository.commit)) throw new PushError("Push target does not match the session repository");
  const ref = `refs/heads/${operation.branch}`;
  const id = randomUUID().replaceAll("-", "");
  let remote: GitRemote;
  try {
    remote = new GitRemote({ url: credential.remote, authorization: credential.authorization, fetch: options.fetch, signal: options.signal });
  } catch (error) {
    throw new PushError(error instanceof GitRemoteError ? error.message : "Git remote is invalid");
  }
  try {
    let advertised: { refs: Map<string, string>; capabilities: Set<string> };
    let prepared: PushPreparation;
    try {
      advertised = await remote.receivePackAdvertisement();
      const fetched = await remote.fetchCommit(repository.commit);
      try {
        prepared = await workspace.pushPrepare(id, { path: repository.path, base: repository.commit, commit: operation.commit }, fetched.pack, authorize);
      } catch (error) {
        if (error instanceof GitRemoteError) throw error;
        throw new PushError(`Session commits could not be prepared for push${workspaceReason(error)}`);
      }
    } catch (error) {
      if (error instanceof PushError) throw error;
      if (error instanceof GitRemoteError) throw new PushError(error.message);
      throw new PushError("Git remote request failed");
    }
    const old = advertised.refs.get(ref) ?? ZERO_OID;
    const result = { branch: operation.branch, tip: prepared.tip, base: prepared.base, previous: old === ZERO_OID ? null : old, commits: prepared.commits };
    if (old === prepared.tip) return { outcome: "up-to-date", ...result };
    if (old !== ZERO_OID && old !== prepared.base && !prepared.commits.some(commit => commit.rewritten === old))
      throw new PushError(`Remote branch ${operation.branch} has moved; pushes are fast-forward only`);
    let pack: AsyncIterable<Uint8Array>;
    try {
      pack = await workspace.pushPack(id, { tip: prepared.tip, exclude: old === ZERO_OID || old === prepared.base ? [prepared.base] : [prepared.base, old] }, authorize);
    } catch (error) {
      throw new PushError(`Push pack could not be created${workspaceReason(error)}`);
    }
    const report = await remote.push({ ref, old, new: prepared.tip }, pack, advertised.capabilities);
    if (report.status !== "ok") {
      // The forge's own verdict (e.g. a protected-branch rule) is shown, bounded and printable only.
      const reason = (report.reason ?? "").replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 200);
      throw new PushError(`Git remote rejected the push${reason ? ` (${reason})` : ""}`);
    }
    return { outcome: "pushed", ...result };
  } finally {
    await workspace.pushCleanup(id).catch(() => undefined);
  }
}

/** Human- and agent-readable outcome; never includes credentials. */
export function pushSummary(result: PushResult, pullRequest?: { url: string; number: number; created: boolean }): string {
  const lines = [result.outcome === "up-to-date"
    ? `Branch ${result.branch} is already up to date at ${result.tip}.`
    : `Pushed ${result.commits.length} commit${result.commits.length === 1 ? "" : "s"} to ${result.branch} (${result.previous ? `${result.previous.slice(0, 12)}..` : "new branch at "}${result.tip.slice(0, 12)}), based on ${result.base.slice(0, 12)}.`];
  for (const commit of result.commits) lines.push(`- ${commit.rewritten.slice(0, 12)} ${commit.subject}`);
  if (pullRequest) lines.push(`Pull request #${pullRequest.number} ${pullRequest.created ? "opened" : "already open"}: ${pullRequest.url}`);
  return lines.join("\n");
}
