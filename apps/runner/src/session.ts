import type { HostCommandOperation } from "../../../packages/shared/src/types.js";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { awaitWithContext, BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, StringEnum, Type, type ClientIdentity, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, InboxDoc, type AgentChange, type CompactionSettings, type Cursor, type Conversation, type ConversationId, type EntryRecord, type Storage, type SubmissionId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalRecord, AuthorizationRequest, AuthorizationResult, ChatOptions, GitHubCommentRequest, GitHubIssueRequest, GitHubIssueResult, GitHubIssueView, GitHubMergeRequest, GitHubMergeResult, GitHubReadRequest, GitPushOperation, HostPushCredential, ModelDefinition, Operation, PermissionNeed, PermissionRequest, Permission, PushCompleteRequest, PushCompletionResult, PushCredential, PushCredentialRequest, PushOutcome, HostCommandLevel, RunnerBinding, RunnerTicket, ScheduleToolRequest, ScheduleToolResult, SessionActivity, SessionBranch, SessionFiles, SessionView, SubmitInput, SubmitResult, ThinkingLevel, ToolName } from "../../../packages/shared/src/types.js";
import { GITHUB_ISSUE_BODY_LIMIT, GITHUB_ISSUE_TITLE_LIMIT, accessModes, githubMergeMethods, repositoryPreparationPhases, scheduleToolActions, thinkingLevels } from "../../../packages/shared/src/types.js";
import { scheduleToolTarget } from "../../../packages/shared/src/cron.js";
import { crossSessionLimits, sessionsToolActions, sessionsToolTarget, sessionsWriteActions, type SessionsToolRequest, type SessionsToolResult } from "../../../packages/shared/src/cross-session.js";
import type { CompactionFailure } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { bindingRemote, repositoryPath, validCloneDirectory, validPushTag } from "../../../packages/shared/src/repositories.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { messageHash, parseChatImages, type ChatImage } from "../../../packages/shared/src/chat-images.js";
import { requestKey, RunnerError, stableJson, validateOperation } from "./protocol.js";
import { runnerModels } from "./provider.js";
import { HostWorkspace } from "./host-workspace.js";
import { isolatedWorkspace, type SessionWorkspace } from "./workspace.js";
import type { SandboxBackendConfig } from "./sandbox-backend.js";
import { HelperWorkspace } from "./helper-workspace.js";
import { SeatbeltBackend } from "./seatbelt.js";
import { WindowsBackend } from "./windows-sandbox.js";
import { reportedBranches } from "./clone-branches.js";
import {
  hostGitLfs, MIRROR_ROOT, Sandbox, SandboxProcessError, type CloneBackup, type MirrorMount, type SandboxAuthorize, type SnapshotFile,
} from "./sandbox.js";
import { IMAGE_BUSY, IMAGE_ERROR, imageType, prepareImage } from "./images.js";
import { performClonePush, PushError, pushSummary, type PushResult } from "./push.js";
import { HostCredentialError, hostGitAuthorization } from "./git-credentials.js";
import { GitRemote, GitRemoteError } from "./git-remote.js";
import { mirrorPath, type MirrorRepository, type RepositoryCache } from "./repo-cache.js";
import type { RepositoryPreparationItem, RepositoryPreparationView } from "../../../packages/shared/src/types.js";
import type { ResourceConfig } from "./resources.js";
import type { RestoreManifest } from "./restore.js";
import { applyEdits } from "./edits.js";
import { compactionFailure, configuredCompaction, hostCompaction } from "./compaction.js";
import { ActivityReporter, sessionActivity, type ActivityEntry } from "./activity.js";
import { autoApprovedCalls, settled, viewApprovals, type StoredApproval } from "./approval-view.js";
import { EgressProxy, egressEnvironment, egressSocketPath, parseEgressGrant, relayFetch, relayGitRequest, relayPath, repositoryForRemote, type MirrorProgress, type RelayRequest } from "./egress.js";
import { DirectGit } from "./git-direct.js";
import { egressReadServices, type EgressGrant, type EgressRepository, type GitDirectRequest } from "../../../packages/shared/src/network.js";
import { sessionBranch } from "../../../packages/shared/src/git-push.js";
import { defaultHostConfig, type HostCompaction, type HostConfig } from "../../../packages/shared/src/host-config.js";
import { commandLimits, type CommandLimits } from "./host-config.js";

type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "queued" | "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
  sequence?: number;
  started?: boolean;
  admissionId?: string;
  /** When the runner accepted the message (epoch ms); its Worker write admission lasts an hour from about then. */
  submittedAt?: number;
  /** Worker-signed per-message choices, applied to the conversation when the run starts. */
  options?: ChatOptions;
  /**
   * The message carries images, prepared for the model: until it reaches Pi they wait in the session's inputs directory
   * (see writeInputs), never here, as every change rewrites this ledger whole. `bytes` is their base64 length.
   */
  images?: { count: number; bytes: number };
  /** Its images were gone or unreadable on the host when it was to run, so it ended without reaching Pi (see endLostInputs). */
  inputsLost?: true;
  /** Pi ended the run without an answer or any entry: its model was unavailable, or its context could not be compacted. */
  failure?: { reason: "model_error" | "no_model" | "compaction_failed"; provider?: string; modelId?: string; compaction?: CompactionFailure };
  /** Who stopped it (see stop); `pending` until its conversation's work has ended, which holds the queue. */
  stopped?: { by: string; pending?: true };
  /** Pi parked its work after host crashes cut it off again and again, so it ended (see endParkedRuns). */
  crashed?: true;
};
type Branch = { id: number; mode: "write" | "ask"; actorId?: string };
/**
 * What the session owner allowed for the rest of the session, beyond the agent's tools and each message's access.
 * `audience`: the sessions tool exchanges content with sessions whose readers aren't this session's.
 */
type Grants = { tools: ToolName[]; write: boolean; unboundedShell: boolean; audience?: boolean };
/** A session's backup (format pi-runner-backup-v1), as restore.ts reads it back. */
interface RunnerBackup {
  format: "pi-runner-backup-v1";
  binding: RunnerBinding;
  manifest: Metadata;
  /** Pi's SQLite, base64. */
  sqlite: string;
  files: SnapshotFile[];
  /** A clone session's clones, as bundles of their local work (Sandbox.cloneBackup). */
  clones?: CloneBackup[];
  /** Only the conversation: no files and no clones. */
  conversationOnly?: true;
  createdAt: string;
}
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, StoredApproval>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string; callId?: string }>; usedTickets?: Record<string, number>; nextSequence?: number; grants?: Grants;
  /** The session's latest restore was from a conversation-only backup: files and clones its history mentions weren't kept. */
  conversationOnlyRestore?: true };
/** One JSON string that every change replaces, so each change is stored whole: a delta would be as large and only lengthen replay. */
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }), checkpointWhen: () => true });
/** A message's image as the model gets it: prepared by `prepareImage`, base64. */
type InputImage = { mimeType: string; data: string };
/** Prepared images of queued messages that a session holds on disk at once, until their messages reach Pi. */
const MAX_QUEUED_IMAGE_BYTES = 16 * 1024 * 1024;
/** Tools that never change files or run commands: the whole toolset of side asks. */
const readOnlyTools = ["identity", "read_file", "list_files"];
/** How often a sessions tool wait reads its message's outcome. */
const WAIT_POLL_MS = 3000;
const SESSIONS_TOOL_DESCRIPTION = "Work with this workspace's other Pistead sessions, as the person whose message you are working on, with exactly their permissions in each session. "
  + "action list: the sessions they can see (id, title, status, activity, their permissions, parent) and the models create can use. "
  + "read {session, limit?, message_id?}: a session's latest shared-conversation entries and pending approvals; with message_id, also the outcome of a message this session sent it (status, done, reply). "
  + "ask {session, message, notify?}: a read-only side question to that session's agent. "
  + "send {session, message, access?, notify?}: a message to that session's agent, as if typed in its chat (access approval, the default: its commands wait for people there; read: inspect only; auto: only in a message the session owner sent with auto-approve, to a session they own); refused while it is busy. "
  + "wait {session, message_id, timeout_seconds?}: block until a message this session sent finishes (default 300 seconds), then return its outcome and reply. "
  + "create {message?, title?, model?, visibility?, access?, notify?}: start a new session for a sub-task, as the same person, on this session's model unless model names one list returns, and send it message. "
  + "stop {session}: stop that session's current work. archive {session}: archive a session they own. "
  + "With notify, Pistead sends this session the outcome as a new message once the other session finishes. Delivered messages start with a line naming this session and the sender; "
  + "chains of messages stop after 3 hops and never loop back to a session they came from; approvals in another session are decided only by people there. "
  + "Involve other sessions only when the user asked for it or clearly expects it.";
/**
 * How long after a message is sent its tool calls can wait on a card: the owner's permission or an operation's approval.
 * Deciding needs the message's write admission, which lasts an hour from sending, so a card older than that can't be
 * decided: the call fails instead of holding the session.
 */
const DECISION_WAIT_MS = 60 * 60 * 1000;
/** Why a command without the host's missing limits in a member's session waits for someone else (see grantedShell). */
const GRANTED_SHELL_DECIDERS = "This command runs without the resource limits its host lacks, on the strength of a host command grant: "
  + "only the host owner, or a member granted host commands on this host, can decide it";
/** Whether `run` keeps the session busy: it is queued or at work, or a stop of it is still ending its work. */
function holdsQueue(run: Run): boolean {
  return ["queued", "running", "admitting"].includes(run.status) || run.stopped?.pending === true;
}
/**
 * The control plane rejects approval results above 8192 characters, so the approval record keeps the start and the
 * (usually decisive) end of a longer one. The tool call waiting on it still returns the whole output to the agent
 * (see `RunnerSession.#wholeResults`).
 */
function boundedResult(value: string): string {
  if (value.length <= 8000) return value;
  return `${value.slice(0, 2000)}\n… ${value.length - 7500} characters omitted …\n${value.slice(-5500)}`;
}
export type RunnerConfig = {
  dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch;
  connectorId?: string;
  authorize?: (request: AuthorizationRequest) => Promise<AuthorizationResult>;
  /** Posts one comment, human-approved (`capability`) or of the owner's Auto-approve message (`admissionId`). */
  githubComment?: (request: GitHubCommentRequest) => Promise<{ id: number; url: string }>;
  /** Reads an issue or pull request as the session owner, through the control plane. */
  githubRead?: (request: GitHubReadRequest) => Promise<GitHubIssueView>;
  /** Performs one merge, as githubComment; a refusal GitHub stated throws a RunnerError with status 422 and its reason. */
  githubMerge?: (request: GitHubMergeRequest) => Promise<GitHubMergeResult>;
  /** Opens one issue, as githubComment; a refusal GitHub stated throws a RunnerError with status 422 and its reason. */
  githubIssue?: (request: GitHubIssueRequest) => Promise<GitHubIssueResult>;
  /** Lists, creates, changes or deletes the session's scheduled prompts, as the schedule tool asks; the control plane's refusal throws a RunnerError with its reason. */
  schedules?: (request: ScheduleToolRequest) => Promise<ScheduleToolResult>;
  /** One sessions tool call (any action but wait, which is reads), through the control plane; its refusal throws a RunnerError with its reason. */
  crossSessions?: (request: SessionsToolRequest) => Promise<SessionsToolResult>;
  /** Issues the credential for one approved push; a token is held only in this process's memory. */
  pushCredential?: (request: PushCredentialRequest) => Promise<PushCredential | HostPushCredential>;
  /** Reports a finished push so its credential is revoked and any requested pull request is opened. */
  pushComplete?: (request: PushCompleteRequest) => Promise<PushCompletionResult>;
  /**
   * Reads this host's own Git credential for a push remote as an Authorization header. A connector sets it, and it refuses
   * (HostCredentialError) unless the host's owner has Git credentials on in its configuration (HostConfig.gitCredentials).
   */
  hostGitCredential?: (remote: string, signal?: AbortSignal) => Promise<string>;
  /** The host's models; `thinkingLevel` is the level its Pi starts the model at. */
  resolveModels?: (model: ModelDefinition) => Promise<{ models: Models; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>;
  readBackup?: (restore: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
  /** The host's Pi compaction settings, overall and per model; Pi's defaults without them, but for reasoning models' room (see hostCompaction). */
  compaction?: CompactionSettings;
  /** How the host's Pi identifies its requests to providers; pi-durable's default (attributed to pi) without it. */
  identity?: ClientIdentity;
  /**
   * This host's repository cache, when its configuration keeps one (HostConfig.repositoryCache): a mirror per repository,
   * filled straight from its provider with this host's own Git credentials (see cacheRemote), that clones borrow objects
   * from once the control plane's relay confirms their owner may read it. Fixed for a connection.
   */
  repositoryCache?: RepositoryCache;
  /**
   * How the repository cache reads a workspace repository: by default directly from its provider, with the credential Git
   * on this host would use (its credential helpers), or anonymously where it has none for the provider. Never through the
   * relay. Tests stand in their own remote.
   */
  cacheRemote?: (repository: EgressRepository) => Promise<GitRemote>;
  resources?: ResourceConfig;
  /** Owner-consented host mode: no isolation, so bash needs only per-command approval. */
  unsandboxed?: boolean;
  /** The sandbox of a macOS or native Windows host (see sandbox-backend.ts); Linux hosts use bubblewrap without it. */
  sandboxBackend?: SandboxBackendConfig;
  /** Opens a session's Pi storage; defaults to the SQLite file in its directory. */
  openStorage?: (path: string) => Promise<Storage>;
  /** Tells the control plane what a session's agent is doing (see SessionActivity) as it changes; connected runners only. */
  reportActivity?: (sessionId: string, activity: SessionActivity) => Promise<void>;
  /**
   * Tells the control plane which branches a session on the host has checked out in its clones of the workspace's
   * github.com repositories, so that it finds their pull requests (clone-branches.ts); connected runners only.
   */
  reportBranches?: (sessionId: string, branches: SessionBranch[]) => Promise<void>;
  /** A session's network grant and its Git relay, through the connector; without them, the control plane's internal routes. */
  egressGrant?: (sessionId: string) => Promise<EgressGrant>;
  gitRelay?: (sessionId: string, request: RelayRequest) => Promise<Response>;
  /**
   * A direct grant for one of a session's Git requests (GitDirectGrant), through the connector; without it, the control
   * plane's internal route. The host then makes the request at the forge itself, so it doesn't cross the control plane.
   */
  gitDirect?: (sessionId: string, request: Omit<GitDirectRequest, "sessionId">) => Promise<unknown>;
  /**
   * How the host runs its sessions, as its owner and admins set it in Pistead (the connector caches it briefly). Read for
   * each shell command: its time limit and GPU. Without it, the defaults.
   */
  hostConfig?: () => Promise<HostConfig>;
};

/** How long the relay's word that a session's owner may read a repository lets the session borrow from its mirror. */
const MIRROR_CONFIRM_MS = 10 * 60 * 1000;
/** How long a clone waits for the refresh of a mirror filled before; then it borrows the mirror as it is (see mirror). */
const MIRROR_REFRESH_WAIT_MS = 10_000;
/** Pauses before the relay is asked again for a repository's refs, after a quick failure another attempt may get past. */
const OWNER_REFS_RETRY_MS = [500, 2_000];
/** How long one listing of a repository's refs through the relay may take. */
const OWNER_REFS_TIMEOUT_MS = 30_000;

/**
 * A definite refusal from the control plane or the provider: a 4xx other than a timeout or rate limit, as a RunnerError
 * from the relay or a GitRemoteError status (relayFetch turns the relay's refusals into HTTP statuses).
 */
function refused(error: unknown): boolean {
  const status = error instanceof RunnerError ? error.status : error instanceof GitRemoteError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A grant's repository as the cache keys it; an older control plane that names no provider id offers no mirror. */
function mirrorRepository(repository: EgressRepository): MirrorRepository & { bindingId: string } {
  if (repository.repositoryId === undefined) throw new RunnerError(409, "Update the Pistead server to cache this repository on the host");
  return { bindingId: repository.bindingId, provider: repository.provider, host: repository.host, repositoryId: repository.repositoryId, fullName: repository.fullName };
}

/**
 * Why the host couldn't fill its mirror of `repository`, as the clone waiting for it is told (see GIT_SHIM): 503 for a
 * failure another attempt may get past, after the cache's own attempts, so the clone asks again or stops to be run again
 * rather than downloading the repository without the cache; any other status lets it go ahead without the cache.
 */
function cacheFailure(error: unknown, repository: EgressRepository): RunnerError {
  if (error instanceof RunnerError) return error;
  if (error instanceof GitRemoteError && error.status !== undefined && [401, 403, 404].includes(error.status)) {
    return new RunnerError(502, `This host's Git credentials can't read ${repository.fullName}; its owner can set one up for ${repository.host} on it, for example with gh auth setup-git`);
  }
  const reason = error instanceof Error && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "The repository could not be cached";
  return new RunnerError(error instanceof GitRemoteError && error.retryable ? 503 : 502, reason);
}

function preparationFailure(reason: string): string {
  return `${reason.replace(/\.$/, "")}. Restart the session to try again.`;
}

type RepositoryPreparation = { status: "ready" }
  | { status: "preparing"; done: Promise<void>; controller: AbortController; items: RepositoryPreparationItem[] }
  | { status: "failed"; reason: string; items: RepositoryPreparationItem[] };
type ProgressUpdate = (path: string, change: Partial<Omit<RepositoryPreparationItem, "path">>) => void;

/** What the transcript says after a run that the host's crashes ended (see endParkedRuns). */
const CRASHED_TEXT = "Stopped: the host crashed repeatedly while working on this message. Send it again to retry.";

/**
 * Beside a session's storage while its agent is working or waiting on a decision, and gone once it isn't: a runner that
 * starts again opens just these sessions, so their work goes on without someone opening them (RunnerService.resume).
 */
export const WORK_MARKER = "working";

/** Whether the model request behind a transcript entry failed, which the session view shows as a failed model turn. */
function modelFailed(entry: EntryRecord): boolean {
  return (entry.model ?? []).some(message => message.role === "assistant" && message.stopReason === "error");
}

/** The shared conversation's last entry, as `sessionActivity` reads it. */
function activityEntry(entry: EntryRecord | undefined): ActivityEntry | undefined {
  return entry && { id: Number(entry.id), failed: modelFailed(entry) };
}

export class RunnerSession {
  readonly sandbox: SessionWorkspace;
  readonly sqlitePath: string;
  private harness!: Harness;
  private root!: Conversation;
  private tools: ToolRegistration[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  private draining = false;
  private modelRef!: { provider: string; modelId: string };
  private models!: Models;
  /** Pushes (approved ones settle after decide() returns; automatic ones inline); close() aborts and awaits them. */
  private pushes = new Set<{ controller: AbortController; done: Promise<void> }>();
  /** Set when Pi closed the Session because its storage failed; the next request reopens it (see `recover`). */
  #failed = false;
  /** The reopen in progress, which every request waits for instead of reaching a half-open session. */
  #recovery: Promise<void> | undefined;
  /** Tool calls waiting on a card, by approval id, until it settles (see `settled`); `mutate` hands them the card. */
  #approvalWaiters = new Map<string, PromiseWithResolvers<ApprovalRecord>>();
  /**
   * The whole result of an operation whose record keeps only an excerpt, by approval id, until the tool call waiting
   * on it returns it to the agent. Held in memory only: backups, views and the control plane get the bounded record,
   * and a call that outlives its runner process is interrupted anyway.
   */
  #wholeResults = new Map<string, string>();
  /**
   * Cloning a restored session's clones again can take minutes, far longer than the control plane waits for `create`.
   * It runs in the background; runs are held until it is done (see drainQueue).
   */
  #repositories: RepositoryPreparation = { status: "ready" };
  /** Bumped by every preparation and by close(), so a superseded preparation never changes what came after it. */
  #preparations = 0;
  /** open() has finished; with #resumed, recovered and queued work resumes exactly once per open, and only when ready. */
  #opened = false;
  #resumed = false;
  /** Reports what the agent is doing while the session is open, when the runner has somewhere to report it. */
  readonly #activity: ActivityReporter | undefined;
  /** The sandbox's only way out (see EgressProxy); listening while the session is open. Host mode has no sandbox to confine. */
  readonly #egress: EgressProxy | undefined;
  /** Git requests this host makes at the forge itself, where the control plane grants it (see DirectGit). */
  readonly #direct: DirectGit | undefined;
  /** A clone session: no pins; the agent clones the workspace's repositories with plain Git through the egress proxy. */
  readonly #clone: boolean;
  /**
   * A session that pinned its repositories when it started: read-only now. It opens to show its history, and nothing
   * resumes or runs in it.
   */
  readonly #frozen: boolean;
  /**
   * The session runs directly on the host's own environment, with no sandbox: every session of an unsandboxed host, or
   * one started that way on a host that accepts it (`#hostSession`).
   */
  readonly #onHost: boolean;
  /**
   * A session started directly on the host (SessionRecord.hostEnvironment), on a host that otherwise sandboxes its
   * sessions, by its owner or by a member they granted that: it runs commands only while the host's configuration still
   * accepts that (HostConfig.hostSessions) and, for a member's, while their grant still includes it; deciding them
   * needs host command authority, as host commands do.
   */
  readonly #hostSession: boolean;
  /** The workspace's repositories as of this open, for a clone session's instructions. */
  #cloneRepositories: string[] = [];
  /** The workspace's repositories whose Git LFS objects the egress proxy downloads, as of the session's opening. */
  #lfsRepositories: string[] = [];
  /** A clone session on the host: the workspace's repositories, whose checked-out branches it reports (reportBranches). */
  #branchRepositories: EgressRepository[] = [];
  /** The branches last reported, as JSON, and whether a report runs or another is wanted after it. */
  #branchesSent: string | undefined;
  #branchesReporting = false;
  #branchesWanted = false;
  /** Clones a restore left to clone again that this open couldn't restore, for the agent's instructions. */
  #cloneFailures: { path: string; reason: string }[] = [];
  /** Restored from a conversation-only backup (Metadata.conversationOnlyRestore), for the agent's instructions. */
  #conversationOnlyRestore = false;
  /**
   * The compaction token counts of the host's configuration as last read (HostConfig.compaction), which the harness's
   * settings put over the host's Pi settings at each use: a change applies from the first message after the connector's
   * configuration refresh (HostConfigSource, 30 seconds).
   */
  #configuredCompaction: HostCompaction | undefined;
  /**
   * The host cache's mirrors this clone session may borrow from, by sandbox path, and when the relay last let its owner
   * read each (0: not yet in this open). Mounted only while confirmed in the last MIRROR_CONFIRM_MS (see mirrorMounts).
   */
  private readonly mirrors = new Map<string, { mount: MirrorMount; repository: MirrorRepository & { bindingId: string }; confirmedAt: number }>();

  constructor(readonly binding: RunnerBinding, readonly directory: string, readonly config: RunnerConfig) {
    if (binding.session.connectorId !== config.connectorId || binding.model.connectorId !== config.connectorId)
      throw new RunnerError(403, "Session connector mismatch");
    this.sqlitePath = join(directory, "session.sqlite");
    const cache = config.repositoryCache;
    this.#clone = binding.session.repositoryMode === "clone";
    this.#frozen = !this.#clone && (binding.session.repositories ?? []).length > 0;
    this.#hostSession = binding.session.hostEnvironment === true && config.unsandboxed !== true;
    this.#onHost = config.unsandboxed === true || this.#hostSession;
    // Only sessions of the host's owner, or of a member they granted that, run on the host itself: the control plane
    // admits no other, and the host checks a member's grant again before each of their commands
    // (requireHostEnvironment).
    if (this.#hostSession && !binding.session.connectorOwnerId) {
      throw new RunnerError(403, "Only sessions of the host's owner, or of members they granted that, run directly on the host");
    }
    // Grants come the way relayed requests go: through the connector, or the control plane's internal route. A runner
    // given a relay of its own and no way to ask for grants relays everything.
    const directGrant = config.gitDirect ? (request: Omit<GitDirectRequest, "sessionId">) => config.gitDirect!(binding.session.id, request)
      : config.gitRelay ? undefined
      : (request: Omit<GitDirectRequest, "sessionId">) => this.controlPlane("/api/internal/git/direct", { sessionId: binding.session.id, ...request });
    this.#direct = directGrant && new DirectGit({ grant: directGrant, onFallback: (request, reason) => this.#egress?.noteFallback(request.bindingId, reason) });
    if (this.#onHost) this.sandbox = new HostWorkspace(binding, join(directory, "sandbox"));
    else if (config.sandboxBackend) {
      // macOS and native Windows sandboxes share the host's network: the proxy listens on a loopback port that wants
      // this session's token. They keep no host repository cache.
      const egress = this.egressProxy(egressSocketPath(binding.session.id, directory), randomBytes(24).toString("base64url"));
      this.#egress = egress;
      const backend = config.sandboxBackend.kind === "seatbelt" ? new SeatbeltBackend()
        : new WindowsBackend({ runtime: config.sandboxBackend.runtime, limits: config.sandboxBackend.limits });
      const branch = this.#clone ? sessionBranch(binding.session) : undefined;
      const workspace: HelperWorkspace = new HelperWorkspace(binding, join(directory, "sandbox"), backend, {
        egressEnvironment: () => { const endpoint = egress.endpoint; return endpoint && egressEnvironment(branch, endpoint, workspace.layout.caBundle); },
      });
      this.sandbox = workspace;
    } else {
      this.#egress = this.egressProxy(egressSocketPath(binding.session.id, directory));
      this.sandbox = new Sandbox(binding, join(directory, "sandbox"), config.resources, { egressSocket: this.#egress.socketPath,
        ...(this.#clone ? { sessionBranch: sessionBranch(binding.session) } : {}),
        ...(this.#clone && cache ? { mirrors: () => this.mirrorMounts() } : {}) });
    }
    const report = config.reportActivity;
    // Once the agent stops working, its clones are as it left them: a session on the host reports their branches then.
    this.#activity = report && new ActivityReporter(() => this.activity(), async activity => {
      // Marked first: a report that fails (the host is reconnecting) is retried, and the mark must not wait for it. The mark
      // only saves someone opening the session after a restart, so failing to write it never holds the report up.
      await this.markWork(activity).catch(() => {});
      await report(binding.session.id, activity);
      if (activity !== "working") this.reportBranches();
    });
  }

  /** Keeps WORK_MARKER in step with `activity`. Only the host writes the session's directory, never its sandbox. */
  private async markWork(activity: SessionActivity): Promise<void> {
    const marker = join(this.directory, WORK_MARKER);
    if (activity !== "working" && activity !== "waiting") return rm(marker, { force: true });
    const file = await open(marker, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.close();
  }

  /** The session's network grant from the control plane: its workspace's repositories and network policy. */
  private async requestGrant(): Promise<EgressGrant> {
    const sessionId = this.binding.session.id;
    return parseEgressGrant(this.config.egressGrant ? await this.config.egressGrant(sessionId) : await this.controlPlane("/api/internal/network", { sessionId }));
  }

  private egressProxy(socketPath: string, token?: string): EgressProxy {
    return new EgressProxy({
      socketPath,
      ...(token ? { tcp: { token } } : {}),
      grant: () => this.requestGrant(),
      relay: request => this.relay(request),
      ...(this.#clone && this.config.repositoryCache ? { mirror: (repository: EgressRepository, onProgress: (progress: MirrorProgress) => void) => this.mirror(repository, onProgress) } : {}),
      ...(this.#clone ? { sessionBranch: sessionBranch(this.binding.session) } : {}),
    });
  }

  /**
   * One Git request: a read with the session owner's access, or a push of the session branch. It goes to the forge from
   * this host when the control plane grants a credential for it (DirectGit), else through the control plane's relay. A
   * refused read also stops this session borrowing from the host's mirror of that repository.
   */
  private async relay(request: RelayRequest): Promise<Response> {
    const sessionId = this.binding.session.id;
    try {
      const direct = await this.#direct?.forward(request);
      if (direct) return direct;
      return await (this.config.gitRelay ? this.config.gitRelay(sessionId, request)
        : relayGitRequest(this.config.fetch ?? fetch, `${this.config.controlPlaneUrl}${relayPath("/api/internal", sessionId, request)}`,
          { authorization: `Bearer ${this.config.sharedSecret}` }, request, AbortSignal.timeout(60 * 60 * 1000)));
    } catch (error) {
      // Only a refused Git read means the owner lost the repository: a push or a Git LFS download can be refused by policy alone.
      if (egressReadServices.includes(request.service) && refused(error)) for (const [target, entry] of this.mirrors) if (entry.repository.bindingId === request.bindingId) this.mirrors.delete(target);
      throw error;
    }
  }

  /**
   * A workspace repository read through the relay, where the relay itself adds the owner's credential: how this session
   * confirms that its owner may read a repository before it borrows the host's mirror of it. Mirrors are never filled so.
   */
  private relayRemote(repository: EgressRepository, signal?: AbortSignal): GitRemote {
    return new GitRemote({ url: bindingRemote(repository), authorization: "Bearer relay", fetch: relayFetch(repository.bindingId, request => this.relay(request)), signal });
  }

  /**
   * Makes the host's mirror of `repository` ready and lets this session's shell commands borrow from it. The relay first
   * lists the repository's branches and tags with the session owner's own account, which confirms they may read it; then
   * the mirror fetches those tips straight from the provider with this host's own Git credentials (cacheRemote), never
   * through the relay. A mirror no fill has completed yet is waited for, however long its first fill takes; a filled one
   * for at most MIRROR_REFRESH_WAIT_MS, then it is borrowed as it is while its refresh goes on.
   */
  private async mirror(value: EgressRepository, onProgress?: (progress: MirrorProgress) => void): Promise<string> {
    const repository = mirrorRepository(value);
    const refs = await this.ownerRefs(value);
    const confirmedAt = Date.now();
    try {
      const target = { repository, ownerId: this.binding.owner.id, sessionId: this.binding.session.id, remote: await this.cacheRemote(value), refs };
      await this.config.repositoryCache!.ready(target, { ...(onProgress ? { onProgress } : {}), wait: MIRROR_REFRESH_WAIT_MS });
    } catch (error) {
      throw cacheFailure(error, value);
    }
    return this.allowMirror(repository, confirmedAt);
  }

  /**
   * `repository`'s branches and tags as the session owner's own account lists them, through the relay (which checks the
   * repository's identity too): what confirms that the session may borrow its mirror, and what the mirror mirrors.
   * - A refusal is final (403).
   * - A failure another attempt may get past (the relay busy or failing, its connection failing or breaking off, or the
   *   listing running out of its time) ends in 503, which the clone asks again: a quick one only once the relay was asked
   *   again (OWNER_REFS_RETRY_MS), one that ran out of its time at once.
   * - Anything else will fail again just the same: 502, so the clone goes ahead without the cache, through the relay,
   *   where Git says what is wrong.
   */
  private async ownerRefs(value: EgressRepository): Promise<Map<string, string>> {
    for (let failures = 0; ; failures++) {
      const timeout = AbortSignal.timeout(OWNER_REFS_TIMEOUT_MS);
      try { return await this.relayRemote(value, timeout).listRefs(); }
      catch (error) {
        // A refused read already ended borrowing for this open (see relay).
        if (refused(error)) throw new RunnerError(403, `Pistead did not confirm that this session's owner can read ${value.fullName}`);
        // GitRemote calls a request its caller's signal aborted final; here that signal is the listing's own time limit.
        if (!timeout.aborted && !(error instanceof GitRemoteError && error.retryable)) {
          throw new RunnerError(502, `Pistead could not list ${value.fullName} for this session's owner`);
        }
        const pause = timeout.aborted ? undefined : OWNER_REFS_RETRY_MS[failures];
        if (pause === undefined) throw new RunnerError(503, `Pistead could not confirm right now that this session's owner can read ${value.fullName}`);
        await sleep(pause);
      }
    }
  }

  /** How the host's repository cache reads `repository` (see RunnerConfig.cacheRemote). */
  private async cacheRemote(repository: EgressRepository): Promise<GitRemote> {
    if (this.config.cacheRemote) return this.config.cacheRemote(repository);
    const url = bindingRemote(repository);
    let authorization: string | undefined;
    // A host with no credential for the provider still fills public repositories.
    try { authorization = await hostGitAuthorization(url); }
    catch (error) { if (!(error instanceof HostCredentialError)) throw error; }
    return new GitRemote({ url, ...(authorization ? { authorization } : {}) });
  }

  private allowMirror(repository: MirrorRepository & { bindingId: string }, confirmedAt: number): string {
    // The cache's own layout, at a path every session sees the same way.
    const mount = { source: this.config.repositoryCache!.mirrorDirectory(repository, this.binding.owner.id), target: `${MIRROR_ROOT}/${mirrorPath(repository)}` };
    this.mirrors.set(mount.target, { mount, repository, confirmedAt });
    return mount.target;
  }

  /**
   * The mirrors a step that runs Git in a clone gets: those of repositories still in the workspace's grant, each read
   * through the relay with the owner's access in the last MIRROR_CONFIRM_MS (older ones are confirmed again first, and
   * their keep refs marked used). A repository the grant or the relay no longer allows is dropped for this open.
   */
  private async mirrorMounts(): Promise<MirrorMount[]> {
    let repositories: EgressRepository[];
    try { repositories = (await this.#egress!.grant()).repositories; }
    catch (error) {
      if (refused(error)) this.mirrors.clear();
      return [];
    }
    const granted = new Set(repositories.map(repository => repository.bindingId));
    for (const [target, entry] of this.mirrors) if (!granted.has(entry.repository.bindingId)) this.mirrors.delete(target);
    const stale = [...this.mirrors.values()].filter(entry => Date.now() - entry.confirmedAt > MIRROR_CONFIRM_MS);
    await Promise.all(stale.map(async entry => {
      try {
        await this.relayRemote(entry.repository, AbortSignal.timeout(15_000)).listRefs();
        entry.confirmedAt = Date.now();
        await this.config.repositoryCache!.touch(entry.repository, this.binding.owner.id, this.binding.session.id).catch(() => {});
      } catch (error) {
        // A refusal ends borrowing for this open; anything else (a timeout, a rate limit, an outage) only skips this step,
        // and the next one asks again.
        if (refused(error)) this.mirrors.delete(entry.mount.target);
      }
    }));
    return [...this.mirrors.values()].filter(entry => Date.now() - entry.confirmedAt <= MIRROR_CONFIRM_MS).map(entry => entry.mount);
  }

  /**
   * Lists the mirror of every workspace repository for this open, creating the ones this host doesn't have yet, empty:
   * each is mounted only once the relay confirms the owner can read its repository (see mirrorMounts). Created before any
   * command runs, so the command that first clones a repository already mounts the mirror its clone waits to fill (see
   * GIT_SHIM), and clones made earlier still borrow from theirs after a reopen.
   */
  private async restoreMirrors(repositories: readonly EgressRepository[]): Promise<void> {
    const cache = this.config.repositoryCache;
    if (!this.#clone || !cache) return;
    this.mirrors.clear();
    for (const value of repositories) {
      if (value.repositoryId === undefined) continue;
      const repository = mirrorRepository(value);
      // A cache root that isn't private can't be used; the clone hears why when it asks for the mirror.
      try { await cache.prepare(repository, this.binding.owner.id); }
      catch { continue; }
      this.allowMirror(repository, 0);
    }
  }

  private assertTicket(ticket: RunnerTicket): void {
    if (ticket.sessionId !== this.binding.session.id || ticket.ownerId !== this.binding.owner.id || ticket.connectorId !== this.config.connectorId)
      throw new RunnerError(403, "Ticket session, owner, or connector mismatch");
  }

  /**
   * `host`: also ask for the actor's authority over host commands on this host (`hostCommands`); `hostSessions`, also
   * whether they may run their own sessions directly on it.
   */
  async authorize(actorId: string, permission: Permission, expectedPolicyVersion?: number, host = false, hostSessions = false): Promise<AuthorizationResult> {
    const body: AuthorizationRequest = { sessionId: this.binding.session.id, ownerId: this.binding.owner.id, actorId, permission,
      ...(host ? { host: true } : {}), ...(host && hostSessions ? { hostSessions: true } : {}) };
    let result: AuthorizationResult;
    try {
      if (this.config.authorize) result = await this.config.authorize(body);
      else {
        const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/authorize`, {
          method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500), redirect: "error",
        });
        if (!response.ok) throw new RunnerError(403, "Authorization denied");
        result = await response.json() as AuthorizationResult;
      }
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(503, "Authorization authority unavailable");
    }
    if (!result.allowed || result.ownerId !== this.binding.owner.id || !Number.isSafeInteger(result.policyVersion)
      || (expectedPolicyVersion !== undefined && result.policyVersion !== expectedPolicyVersion)) throw new RunnerError(403, "Authorization revoked or stale policy");
    return result;
  }

  /**
   * What `actorId` may do with host commands here: the host's owner holds `auto`; anyone else what the control plane
   * reports of the grants the host's owner or its admins gave them, checked with `permission` on this session. A control
   * plane that predates grants reports none, so only the owner decides host commands there.
   */
  private async hostCommandLevel(actorId: string, permission: Permission): Promise<HostCommandLevel | undefined> {
    if (this.binding.session.connectorOwnerId && actorId === this.binding.session.connectorOwnerId) return "auto";
    const result = await this.authorize(actorId, permission, undefined, true);
    return result.hostCommands === "approve" || result.hostCommands === "auto" ? result.hostCommands : undefined;
  }

  async prepareRestore(manifest: RestoreManifest, { conversationOnly = false }: { conversationOnly?: boolean } = {}): Promise<void> {
    await this.initializeRepositories();
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux) };
    const storage = await this.openStorage();
    let harness: Harness;
    try { harness = await Harness.open(storage, { models: resolved.models, registry: createRegistry() }, context); }
    catch (error) { await storage.close(context); throw error; }
    try {
      // Opening does not resume. Reject hidden pi work before committing any rebinding.
      const graph = await harness.taskGraph(context);
      try { if (Object.keys(graph.value.tasks).length) throw new RunnerError(409, "Snapshot contains incomplete durable tasks"); }
      finally { graph.dispose(); }
      const root = await harness.root(context);
      await root.commit(async tx => {
        const doc = await tx.doc(RunnerState);
        if (!doc.json) throw new RunnerError(400, "Snapshot lacks runner metadata");
        const state: Metadata = JSON.parse(doc.json);
        if (stableJson(state) !== stableJson(manifest)) throw new RunnerError(400, "Snapshot manifest and SQLite metadata disagree");
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations({}, 100, cursor);
          for (const conversation of page.items) {
            if ((await tx.doc(InboxDoc, conversation.id)).items.length) throw new RunnerError(409, "Snapshot contains queued pi input");
          }
          cursor = page.next;
        } while (cursor);
        if (Object.values(state.runs).some(run => !["settled", "interrupted"].includes(run.status))
          || Object.values(state.approvals).some(approval => approval.status === "executing"))
          throw new RunnerError(409, "Snapshot is not idle");
        state.binding = this.binding;
        state.usedTickets = {};
        state.toolActors = {};
        // What the owner allowed for the rest of a session covers that session only; the restored one asks again.
        delete state.grants;
        // The kind of the latest restore: after a conversation-only one its agent is told the files its history mentions
        // may be missing; a full restore brings back the files as they were at that backup, so the note goes.
        if (conversationOnly) state.conversationOnlyRestore = true;
        else delete state.conversationOnlyRestore;
        for (const run of Object.values(state.runs)) delete run.admissionId;
        for (const approval of Object.values(state.approvals)) {
          approval.sessionId = this.binding.session.id;
          delete approval.admissionId;
          delete approval.reviewHash;
          if (approval.status === "pending") {
            approval.status = "interrupted";
            approval.result = "Restored history only; fresh approval is required for any new operation.";
          }
        }
        doc.json = JSON.stringify(state);
      }, context);
    } finally { await harness.close(context); }
  }

  /**
   * The sandbox, ready for the session. Nothing is pinned or downloaded: a clone session's agent clones what it needs,
   * and a session that pinned its repositories (read-only now) keeps the files it has.
   */
  private async initializeRepositories(): Promise<void> {
    await this.sandbox.initialize();
  }

  /**
   * Makes `preparing` the session's repository preparation: runs wait for it, and once it is done the work it held
   * resumes; a failure leaves it all suspended until the session restarts.
   */
  private trackPreparation(epoch: number, preparing: Extract<RepositoryPreparation, { status: "preparing" }>): void {
    const { done, items } = preparing;
    this.#repositories = preparing;
    done.then(() => {
      if (this.#repositories !== preparing) return;
      this.#repositories = { status: "ready" };
      // What the session is doing follows its preparation (see activity()).
      this.#activity?.changed();
      // If open() is still running it resumes the work itself; otherwise resume it now, in turn with other requests.
      void this.exclusive(async () => {
        if (epoch !== this.#preparations || !this.#opened || this.closing || this.#resumed || this.#repositories.status !== "ready") return;
        await this.resumeWork();
      }).catch(() => {
        // As for a failed open: nothing more runs, and restarting the session tries again.
        if (epoch !== this.#preparations) return;
        this.#repositories = { status: "failed", reason: "This session could not resume its work after preparing its repositories", items };
        this.#activity?.changed();
      });
    }, (error: unknown) => {
      if (this.#repositories !== preparing) return;
      this.#repositories = { status: "failed", reason: error instanceof RunnerError ? error.message : "Repositories could not be prepared on this host", items };
      this.#activity?.changed();
    });
  }

  /**
   * Clones a restored clone session's clones again in the background, through the egress proxy with the owner's access
   * (borrowing from the host's mirror where there is one), and puts their backed-up work back. Runs wait for it, as for
   * prepared repositories. A clone that can't be restored stays pending for the next open, and the agent is told so.
   */
  private prepareClones(pending: { path: string; origin: string | null }[]): void {
    const epoch = ++this.#preparations;
    const controller = new AbortController();
    const authorize = async () => { controller.signal.throwIfAborted(); await this.authorize(this.binding.owner.id, "write"); };
    const items: RepositoryPreparationItem[] = pending.map(({ path }) => ({ path, phase: "queued", percent: null, done: null, total: null, bytes: 0 }));
    const update: ProgressUpdate = (path, change) => { const item = items.find(each => each.path === path); if (item) Object.assign(item, change); };
    const done = (async () => {
      const failures: { path: string; reason: string }[] = [];
      for (const entry of pending) {
        controller.signal.throwIfAborted();
        update(entry.path, { phase: "connecting" });
        try {
          const repository = repositoryForRemote((await this.#egress!.grant()).repositories, entry.origin ?? "");
          if (!repository) throw new RunnerError(409, "its origin is not one of this workspace's repositories");
          let reference: string | null = null;
          if (this.config.repositoryCache && repository.repositoryId !== undefined) {
            const progress = ({ phase, percent, done, total, bytes }: MirrorProgress) => {
              if (repositoryPreparationPhases.includes(phase as RepositoryPreparationItem["phase"])) update(entry.path, { phase: phase as RepositoryPreparationItem["phase"], percent, done, total, bytes });
            };
            try { reference = await this.mirror(repository, progress); } catch { /* cloned without borrowing */ }
          }
          update(entry.path, { phase: "receiving" });
          await isolatedWorkspace(this.sandbox).cloneRestore(entry.path, bindingRemote(repository), reference, authorize);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const reason = error instanceof RunnerError ? error.message
            : error instanceof Error ? /sandbox: ([a-z0-9 ,.'()-]{1,160})$/i.exec(error.message.trim())?.[1] ?? "it could not be cloned again" : "it could not be cloned again";
          failures.push({ path: entry.path, reason });
        }
        update(entry.path, { phase: "done" });
      }
      this.#cloneFailures = failures;
    })();
    this.trackPreparation(epoch, { status: "preparing", done, controller, items });
  }

  /** Sandbox work outside runs (approved operations, backups) waits for prepared repositories, and never runs after a failure. */
  private requireRepositoriesReady(): void {
    const preparation = this.#repositories;
    if (preparation.status === "preparing") throw new RunnerError(409, "This session's repositories are still being prepared on its host. Try again once they are ready.");
    if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
  }

  /** Repository preparation for the session view; absent once it is done, as on hosts without a cache. */
  private repositoryView(): RepositoryPreparationView | undefined {
    const preparation = this.#repositories;
    if (preparation.status === "ready") return undefined;
    return { status: preparation.status, items: preparation.items.map(item => ({ ...item })), ...(preparation.status === "failed" ? { error: preparation.reason } : {}) };
  }

  /** What a sandboxed clone session's agent needs to know about Git LFS, for the repositories the workspace turned it on for. */
  private lfsInstructions(): string {
    if (!this.#lfsRepositories.length) return "";
    const lfs = hostGitLfs();
    if (!lfs) return `\nGit LFS is on for ${this.#lfsRepositories.join(", ")}, but git-lfs is not installed on this host, so clones check out LFS pointer files.`;
    return `\nGit LFS is on for ${this.#lfsRepositories.join(", ")}: clones of them check out LFS files' content. In a clone made otherwise, or restored from a backup, `
      + `run ${lfs} install --local, then ${lfs} pull. Other repositories check out LFS pointer files. `
      + "LFS objects are never uploaded from this session, so don't add or change LFS-tracked files in commits you push.";
  }

  private agentInstructions(mode: "write" | "ask" | "read"): string {
    let instructions = this.binding.agent.instructions;
    if (this.#clone && !this.#egress) {
      // An unsandboxed host: commands run on its owner's machine, with its own Git, network and credentials.
      instructions += "\n\nTrusted runtime repository context:\n"
        + "The execution root is the session worktree, which starts empty; file-tool paths are relative to it. This host runs without a sandbox: "
        + "clone the repositories you need into the worktree with plain Git in bash (for example git clone https://github.com/<owner>/<name>), "
        + "and fetch, switch, commit and push as usual. Git uses this host's own network and credentials, and each command waits for approval."
        + (this.#cloneRepositories.length ? `\nThis workspace's repositories: ${this.#cloneRepositories.join(", ")}.` : "");
    } else if (this.#clone) {
      const branch = sessionBranch(this.binding.session);
      instructions += "\n\nTrusted runtime repository context:\n"
        + "The execution root is the isolated session worktree, which starts empty; file-tool paths are relative to it. "
        + "Clone the repositories you need into it with plain Git in bash (for example git clone https://github.com/<owner>/<name>), "
        + "and fetch, switch and create branches as usual. Git reaches this workspace's repositories through the session's egress proxy "
        + "with the session owner's own access; no credentials are needed or available. Commit with git in bash. "
        + `This session's own branch is ${branch} (also in $PISTEAD_SESSION_BRANCH): push your work to it with plain git, for example `
        + `git push origin HEAD:${branch}, in any of the workspace's repositories, without approval. Pushes of other branches are refused there.`
        + (this.#cloneRepositories.length ? `\nThis workspace's repositories: ${this.#cloneRepositories.join(", ")}.` : "")
        + this.lfsInstructions()
        + (this.#cloneFailures.length ? "\nThis session was restored from a backup or moved, and these clones could not be cloned again: "
          + this.#cloneFailures.map(failure => `${failure.path} (${failure.reason})`).join(", ")
          + ". Their backed-up work (branches, and the working tree as a commit) is in Git bundles under .git/pistead-clones, listed in its "
          + "manifest.json; Pistead tries again when the session next opens, as long as nothing else is at their paths." : "");
      if (this.binding.agent.tools.includes("git_push"))
        instructions += "\ngit_push publishes a clone's checked-out commit, as it is, to another branch of the workspace repository it was cloned from, "
          + "with approval: git_push {directory, branch}, where directory is the clone's path in the worktree. Pushes are fast-forward only (never forced); "
          + "if the branch moved, fetch and merge or rebase first. Optionally request a pull request with pull_request {title, body, base?}; "
          + `to open one from the session branch once you pushed it, call git_push with branch ${branch}. `
          + "To tag a commit that is already on a branch (a release tag on main, say), check it out in the clone and call "
          + "git_push {directory, branch, tag}: it creates that tag at the commit and moves no branch. Tags are never moved; "
          + "plain git push of tags is refused.";
    }
    if (this.#conversationOnlyRestore) instructions += "\n\nThis session was restored from a backup that kept only its conversation: "
      + "the files, clones and uncommitted work its messages from before that restore mention were not restored with it, so they may be "
      + "missing unless they were made again since. Clone the repositories you need again, and check that a file exists before relying on it.";
    if (mode === "ask") instructions += "\n\nThis is a read-only ask. Inspect isolated session files only; do not modify files, execute commands, or perform external effects.";
    if (mode === "read") instructions += "\n\nThis request is read-only. Inspect isolated session files; any change to files, command or other effect waits for the session owner to allow it.";
    return instructions;
  }

  async open(): Promise<void> {
    await this.#egress?.start();
    try { await this.openHarness(); }
    catch (error) {
      // A session that didn't open leaves nothing listening.
      await this.#egress?.close().catch(() => {});
      throw error;
    }
  }

  private async openHarness(): Promise<void> {
    await this.initializeRepositories();
    if (this.#clone && !this.#egress) {
      this.#branchRepositories = await this.requestGrant().then(grant => grant.repositories, () => []);
      this.#cloneRepositories = this.#branchRepositories.map(repository => bindingRemote(repository));
    } else if (this.#clone) {
      const repositories = await this.#egress!.grant().then(grant => grant.repositories, () => []);
      this.#cloneRepositories = repositories.map(repository => bindingRemote(repository));
      this.#lfsRepositories = repositories.filter(repository => repository.lfs).map(repository => bindingRemote(repository));
      await this.restoreMirrors(repositories);
      // A restored or moved session clones its clones again before its work resumes.
      this.#cloneFailures = [];
      // Only a restore writes the list (in the worktree's .git, which shell commands can't change), so a session that
      // has none needs no sandbox to tell.
      if (await lstat(join(this.directory, "sandbox", "git", "pistead-clones", "manifest.json")).then(() => true, () => false)) {
        const pending = await isolatedWorkspace(this.sandbox).clonePending(async () => {});
        if (pending.length) this.prepareClones(pending);
      }
    }
    const registry = createRegistry();
    this.tools = this.buildTools();
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools });
    registry.install(extension);
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux), provider: this.binding.model.provider, modelId: this.binding.model.modelId };
    this.modelRef = { provider: resolved.provider, modelId: resolved.modelId };
    this.models = resolved.models;
    const models = this.models;
    // Reasoning models keep more room for their compaction summary than Pi's default, unless the host's Pi or its
    // configuration in Pistead says otherwise. The configuration is read now and with each message, and the harness reads
    // the settings at each use.
    await this.hostConfig();
    const catalog = models.getModels();
    let current: { from: HostCompaction | undefined; settings: { compaction: CompactionSettings } | undefined } | undefined;
    const settings = () => {
      if (!current || current.from !== this.#configuredCompaction) {
        const compaction = hostCompaction(configuredCompaction(this.config.compaction, this.#configuredCompaction), catalog);
        current = { from: this.#configuredCompaction, settings: compaction ? { compaction } : undefined };
      }
      return current.settings;
    };
    const storage = await this.openStorage();
    try {
      this.harness = await Harness.open(storage, { models, registry, settings,
        ...(this.config.identity ? { identity: this.config.identity } : {}) }, context);
    }
    catch (error) { await storage.close(context); throw error; }
    this.#failed = false;
    const harness = this.harness;
    void harness.closed.then(end => { if (end.reason === "failed" && harness === this.harness) this.#failed = true; });
    this.root = await this.harness.root(context, { agent: {
      // A new conversation starts at the level the host's Pi gives this model, not pi-durable's "off".
      model: this.modelRef, ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}), extensions: [extension],
      // Every tool is offered; one the session doesn't allow asks the owner when called (see `permit`).
      tools: this.tools, instructions: this.agentInstructions("write"),
    } });
    await this.root.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      if (!doc.json) doc.json = JSON.stringify({ binding: this.binding, branches: [{ id: this.root.id, mode: "write" }], runs: {}, approvals: {}, toolActors: {} } satisfies Metadata);
      const state: Metadata = JSON.parse(doc.json);
      if (stableJson(state.binding) !== stableJson(this.binding)) throw new RunnerError(409, "Persisted binding mismatch");
      this.#conversationOnlyRestore = state.conversationOnlyRestore === true;
      for (const approval of Object.values(state.approvals)) {
        if (approval.status === "executing") {
          approval.status = "interrupted";
          approval.result = "Execution interrupted; external effect may have occurred. Reconcile manually; never automatically retry.";
        }
        // The tool call waiting on this card ended with the previous process.
        if (approval.status === "pending" && (approval.operation.kind === "permission" || approval.id.startsWith("tool-"))) {
          approval.status = "interrupted";
          approval.result = "The tool call stopped before a decision.";
        }
      }
      doc.json = JSON.stringify(state);
    }, context);
    this.closing = false;
    this.#opened = true;
    // Recovered and queued work waits for repositories prepared in the background: their preparation resumes it once
    // they are ready, and a failure leaves it all suspended, harness included, until the session restarts. Nothing
    // resumes in a read-only session.
    if (this.#repositories.status === "ready" && !this.#frozen) await this.resumeWork();
    // A read-only session never runs what it had queued or at work when it became read-only: that ends here, as a stop
    // would, so it doesn't stay busy forever.
    if (this.#frozen) {
      await this.mutate(meta => {
        for (const run of Object.values(meta.runs)) if (["queued", "admitting", "running"].includes(run.status)) run.status = "interrupted";
        for (const card of Object.values(meta.approvals)) {
          if (card.status === "pending") Object.assign(card, { status: "interrupted", result: "This session is read-only now; nothing in it runs." });
        }
      });
      await this.sweepInputs();
    }
    // Reported while its repositories are still being prepared too; reopening is also how a report lost with a previous
    // connection or process gets through.
    this.#activity?.start();
  }

  /** Recovered runs, then the harness and the queue: at most once per open, and only once the repositories are ready. */
  private async resumeWork(): Promise<void> {
    this.#resumed = true;
    await this.endParkedRuns();
    const state = await this.metadata();
    for (const run of Object.values(state.runs)) {
      if (run.status !== "running" && run.status !== "admitting") continue;
      try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
      catch {
        const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
        // Abort marks are committed before the scheduler can restart stale work.
        await conversation?.abort(context);
        await this.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
        continue;
      }
      const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
      if (!conversation) throw new Error("Persisted branch is missing");
      let submission;
      if (run.submissionId === undefined) {
        const content = await this.runInput(run);
        if (content === undefined) {
          await this.endLostInputs(run.key);
          continue;
        }
        await this.applyOptions(conversation, run);
        submission = await conversation.submit({ type: "input", content, requestId: run.key }, context);
      } else submission = await this.harness.submission(run.submissionId as SubmissionId, context);
      if (submission) {
        await this.mutate(meta => { const saved = meta.runs[run.key]!; saved.submissionId = submission.id; saved.status = "running"; });
        this.observeRun(run.key, submission.id);
      }
    }
    // A stop the previous open did not finish: its work is aborted before the scheduler can restart it.
    if (Object.values(state.runs).some(run => run.stopped?.pending)) await this.abortStopped();
    // Images of runs that reached Pi, ended or never committed before this open.
    await this.sweepInputs();
    this.harness.resume();
    this.drainQueue();
  }

  /**
   * Ends the work Pi parked: host crashes cut each of these tasks off `restartLimit` times in a row, so Pi stopped
   * running it rather than crash the host again. A parked task of a run's own work would hold the session for good:
   * that run ends as a stop would, and says why; sending it again runs it afresh. Background work, such as an automatic
   * compaction, belongs to no run and leaves the run alone. Every parked task is aborted, before the scheduler starts,
   * so none stays parked into later opens.
   */
  private async endParkedRuns(): Promise<void> {
    const tasks = (await this.harness.inspect(context)).tasks;
    const parked = tasks.filter(task => task.state.kind === "blocked" && task.state.reason === "restart_limit").map(task => task.record);
    if (!parked.length) return;
    // A child task is background work when the task that owns it, or one above that, is.
    const records = new Map(tasks.map(task => [String(task.record.id), task.record]));
    const background = (record: (typeof parked)[number] | undefined): boolean => !!record && (record.background || (record.owner !== undefined && background(records.get(String(record.owner)))));
    const conversations = new Set(parked.filter(record => !background(record)).map(record => Number(record.conversationId)));
    const runs = Object.values((await this.metadata()).runs).filter(run => (run.status === "running" || run.status === "admitting") && conversations.has(run.conversationId));
    for (const id of new Set(runs.map(run => run.conversationId))) await (await this.harness.conversation(id as ConversationId, context))?.abort(context);
    if (runs.length) await this.mutate(meta => { for (const run of runs) Object.assign(meta.runs[run.key]!, { status: "interrupted", crashed: true }); });
    // What those aborts did not end: background work, and work no running message holds. Its abort handler runs once
    // the scheduler starts.
    for (const record of parked) await this.harness.abortTask(record.id, context);
  }

  private openStorage(): Promise<Storage> {
    return (this.config.openStorage ?? openNodeSqliteStorage)(this.sqlitePath);
  }

  /** Pi closed the Session on a storage failure, or it is being reopened: call `recover()` before using it. */
  get failed(): boolean {
    return this.#failed || this.#recovery !== undefined;
  }

  /**
   * Pi closes a Session for good once a storage call fails, and every later call rejects with `SessionFailed`.
   * Reopen it from the same SQLite file, as Pi recommends. Concurrent callers share one attempt; while storage still
   * fails it throws and the session stays failed, so the next request tries again.
   */
  recover(): Promise<void> {
    this.#recovery ??= this.exclusive(async () => {
      if (!this.#failed) return;
      // Pushes need only the sandbox and the control plane, so they finish and report on their own; aborting them
      // would only make their outcome unknown. Their result cannot be recorded on the failed Session either way, and
      // reopening marks their approvals interrupted.
      await this.close({ abortPushes: false });
      try { await this.open(); }
      catch (error) {
        this.#failed = true;
        throw error;
      }
    }).finally(() => { this.#recovery = undefined; });
    return this.#recovery;
  }

  private async metadata(): Promise<Metadata> {
    const doc = await this.harness.snapshot(RunnerState, context);
    if (!doc?.json) throw new Error("Missing trusted runner metadata");
    return JSON.parse(doc.json) as Metadata;
  }

  private async mutate(change: (state: Metadata) => void): Promise<void> {
    let committed: Metadata | undefined;
    await this.root.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      const state = JSON.parse(doc.json) as Metadata;
      change(state);
      doc.json = JSON.stringify(state);
      committed = state;
    }, context);
    // Every run and approval status changes here, so this is where the activity can change and waiting calls go on.
    this.#activity?.changed();
    if (committed && this.#approvalWaiters.size) {
      for (const [id, waiter] of this.#approvalWaiters) {
        const approval = committed.approvals[id];
        if (!approval || !settled(approval)) continue;
        this.#approvalWaiters.delete(id);
        waiter.resolve(approval);
      }
    }
  }

  private waiter(id: string): PromiseWithResolvers<ApprovalRecord> {
    let waiter = this.#approvalWaiters.get(id);
    if (!waiter) this.#approvalWaiters.set(id, waiter = Promise.withResolvers<ApprovalRecord>());
    return waiter;
  }

  /**
   * Holds tool call `waiting` until card `id` settles, and returns it then. A card still undecided at `deadline` (when
   * its message's write admission ends) or when the call stops is marked interrupted, so no card outlives its call.
   */
  private async awaitCard(id: string, waiting: Context, deadline: number): Promise<ApprovalRecord> {
    const waiter = this.waiter(id);
    const current = (await this.metadata()).approvals[id];
    if (current && settled(current)) {
      this.#approvalWaiters.delete(id);
      return current;
    }
    // decide() records a decision only on a card still pending, so an interrupted card never runs.
    const interrupt = (result: string) => this.mutate(meta => {
      const pending = meta.approvals[id];
      if (pending?.status === "pending") Object.assign(pending, { status: "interrupted", result });
    });
    // Once decided, the effect settles the card itself, however late.
    const expiry = setTimeout(() => void interrupt("The session owner did not answer within an hour of the message.").catch(() => {}), Math.max(0, deadline - Date.now()));
    expiry.unref();
    try { return await awaitWithContext(waiter.promise, waiting); }
    catch (error) {
      this.#approvalWaiters.delete(id);
      await interrupt("The tool call stopped before a decision.").catch(() => {});
      throw error;
    } finally { clearTimeout(expiry); }
  }

  /** What an operation a tool call requested came to: the call waits until it is decided and has run. */
  private async operationOutcome(approval: ApprovalRecord, waiting: Context): Promise<ApprovalRecord> {
    if (settled(approval)) {
      this.#approvalWaiters.delete(approval.id);
      return this.whole(approval);
    }
    const state = await this.metadata();
    const actor = state.toolActors[approval.id.slice("tool-".length)];
    const run = actor && state.runs[actor.runKey];
    return this.whole(await this.awaitCard(approval.id, waiting, (run?.submittedAt ?? Date.now()) + DECISION_WAIT_MS));
  }

  /** `result` as the approval record keeps it; the whole of a longer one waits for the tool call (see `whole`). */
  private kept(id: string, result: string): string {
    const bounded = boundedResult(result);
    if (bounded === result) this.#wholeResults.delete(id);
    else this.#wholeResults.set(id, result);
    return bounded;
  }

  /** `approval` with its whole result, for the tool call returning it to the agent; the result is then let go. */
  private whole(approval: ApprovalRecord): ApprovalRecord {
    const result = this.#wholeResults.get(approval.id);
    if (result === undefined || !settled(approval)) return approval;
    this.#wholeResults.delete(approval.id);
    return { ...approval, result };
  }

  /**
   * Reports the branches a clone session on the host has checked out in its clones of the workspace's github.com
   * repositories, when they changed since the last report. A session on the host pushes and opens pull requests with
   * the host's own Git, so this is how the control plane learns which pull requests are its. A report that fails is
   * sent again the next time the agent stops.
   */
  private reportBranches(): void {
    const send = this.config.reportBranches;
    if (!send || !this.#onHost || !this.#clone || this.closing) return;
    if (this.#branchesReporting) { this.#branchesWanted = true; return; }
    this.#branchesReporting = true;
    void (async () => {
      try {
        do {
          this.#branchesWanted = false;
          // A grant that failed when the session opened is asked for again, rather than leaving the session unreported.
          if (!this.#branchRepositories.length) this.#branchRepositories = (await this.requestGrant()).repositories;
          if (!this.#branchRepositories.length) break;
          const clones = await (this.sandbox as HostWorkspace).cloneBranches(async () => {});
          const branches = reportedBranches(clones, this.#branchRepositories);
          const json = JSON.stringify(branches);
          if (json === this.#branchesSent) continue;
          await send(this.binding.session.id, branches);
          this.#branchesSent = json;
        } while (this.#branchesWanted && !this.closing);
      } catch (error) {
        // Sent again the next time the agent stops.
        console.warn(`Session ${this.binding.session.id}: could not report its clones' branches: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally { this.#branchesReporting = false; }
    })();
  }

  /** What the agent is doing now (see SessionActivity). */
  private async activity(): Promise<SessionActivity> {
    const preparation = this.#repositories.status;
    // Held work waits for the repositories, and a failed preparation holds it until the session restarts.
    if (preparation !== "ready") return preparation === "preparing" ? "working" : "failed";
    const state = await this.metadata();
    const runs = Object.values(state.runs);
    const approvals = Object.values(state.approvals);
    const activity = sessionActivity(runs, approvals);
    if (activity !== "done") return activity;
    // A message that settled can still have failed in its last entry, when its model request did.
    const watch = await this.root.watch(context);
    let last: EntryRecord | undefined;
    try { last = watch.value.entries.at(-1); }
    finally { await watch.stop(); }
    return sessionActivity(runs, approvals, activityEntry(last));
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lock.then(operation, operation);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private observeRun(key: string, submissionId: SubmissionId): void {
    const generation = this.generation;
    const harness = this.harness;
    void (async () => {
      const submission = await harness.submission(submissionId, context);
      if (!submission) throw new Error("Missing durable submission");
      const settled = await submission.wait(context);
      // Placement is not completion: serialize through the last model/tool task.
      if (generation !== this.generation || this.closing) return;
      const state = await this.metadata();
      const conversation = await harness.conversation(state.runs[key]!.conversationId as ConversationId, context);
      await conversation?.waitForIdle(context);
      const compaction = settled.status === "unanswered" && settled.reason === "model_error" ? compactionFailure(settled.detail) : undefined;
      const failure: Run["failure"] = settled.status === "unanswered" && (settled.reason === "model_error" || settled.reason === "no_model")
        ? { reason: compaction ? "compaction_failed" : settled.reason, ...(await conversation?.agent(context))?.model, ...(compaction ? { compaction } : {}) } : undefined;
      await this.exclusive(async () => {
        if (generation !== this.generation || this.closing) return;
        await this.mutate(meta => {
          const run = meta.runs[key]!;
          // A stopped run stays stopped, whatever its aborted submission came to.
          if (run.stopped) return;
          run.status = "settled";
          if (failure) run.failure = failure;
        });
      });
      if (generation === this.generation && !this.closing) this.drainQueue();
    })().catch(() => { /* Recovery reconciles the durable active record; never replay effects here. */ });
  }

  private drainQueue(): void {
    // Runs wait for repositories prepared in the background; their preparation drains the queue when it is done.
    if (this.draining || this.closing || this.#repositories.status !== "ready") return;
    this.draining = true;
    void this.exclusive(async () => {
      while (!this.closing) {
        const state = await this.metadata();
        if (Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting" || run.stopped?.pending)
          || Object.values(state.approvals).some(approval => approval.status === "executing")) return;
        const run = Object.values(state.runs).filter(candidate => candidate.status === "queued")
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0];
        if (!run) return;
        try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
        catch {
          // Its images go first, as in endLostInputs: once the ledger ends the run, nothing of it is left on the host.
          if (run.images) await this.discardInputs([run.key]);
          await this.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
          continue;
        }
        const content = await this.runInput(run);
        if (content === undefined) {
          await this.endLostInputs(run.key);
          continue;
        }
        const conversation = await this.harness.conversation(run.conversationId as ConversationId, context);
        if (!conversation) throw new Error("Persisted branch is missing");
        const transcript = await conversation.context(context);
        await this.mutate(meta => {
          meta.runs[run.key]!.status = "admitting";
          meta.runs[run.key]!.started = true;
          meta.runs[run.key]!.startEntry = transcript.entries.at(-1)?.id ?? 0;
        });
        await this.applyOptions(conversation, run);
        const submission = await conversation.submit({ type: "input", content, requestId: run.key }, context);
        await this.mutate(meta => {
          meta.runs[run.key]!.submissionId = submission.id;
          meta.runs[run.key]!.status = "running";
        });
        // Pi's transcript holds its images now.
        if (run.images) await this.discardInputs([run.key]);
        this.observeRun(run.key, submission.id);
        return;
      }
    }).catch(() => { /* Admission is durable even when activation fails; restart reconciles it. */ })
      .finally(() => { this.draining = false; });
  }

  /** Applies a run's model, reasoning and access before its input is admitted; the conversation is idle here. */
  private async applyOptions(conversation: Conversation, run: Run): Promise<void> {
    const options = run.options ?? {};
    const access = options.access ?? "approval";
    const change: AgentChange = {
      ...(options.model ? { model: { provider: options.model.provider, modelId: options.model.modelId } } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      // Every shared run states its toolset and instructions, so a read-only request never leaks into the next one. All
      // tools are offered: a call the session doesn't allow asks the owner instead of failing.
      ...(run.mode === "write" ? {
        tools: this.tools,
        instructions: this.agentInstructions(access === "read" ? "read" : "write"),
      } : {}),
    };
    if (Object.keys(change).length) await conversation.configure(change, context);
  }

  /** Validates per-message choices against this host's models and the actor's rights. */
  private async chatOptions(input: unknown, mode: "write" | "ask", actorId: string): Promise<ChatOptions | undefined> {
    if (input === undefined) return undefined;
    // 422 carries this fixed, runner-authored reason through the Worker to the person choosing.
    const invalid = (message = "Invalid chat options") => new RunnerError(422, message);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !["model", "thinkingLevel", "access", "autoMerge"].includes(key))) throw invalid();
    const options: ChatOptions = {};
    if (value.model !== undefined) {
      const model = value.model as Record<string, unknown>;
      if (!model || typeof model !== "object" || Object.keys(model).some(key => key !== "provider" && key !== "modelId")
        || typeof model.provider !== "string" || typeof model.modelId !== "string" || !model.provider || !model.modelId
        || model.provider.length > 128 || model.modelId.length > 256) throw invalid();
      const requested = { provider: model.provider, modelId: model.modelId };
      const binding = this.binding.model;
      if (this.config.resolveModels) {
        // The host decides availability and authentication; a model it cannot serve is refused here, not mid-run.
        const resolved = await this.config.resolveModels({ ...binding, provider: requested.provider, modelId: requested.modelId })
          .catch(() => { throw invalid("Model is not available on this host"); });
        if (resolved.provider !== requested.provider || resolved.modelId !== requested.modelId) throw invalid("Model is not available on this host");
        // Switching models without naming a level starts at that model's own level on this host.
        if (value.thinkingLevel === undefined && resolved.thinkingLevel) options.thinkingLevel = resolved.thinkingLevel;
      } else if (requested.provider !== binding.provider || requested.modelId !== binding.modelId) throw invalid("This runner serves only the session's pinned model");
      options.model = requested;
    }
    if (value.thinkingLevel !== undefined) {
      if (!thinkingLevels.includes(value.thinkingLevel as never)) throw invalid();
      const target = options.model ?? (await this.root.agent(context)).model ?? this.modelRef;
      const model = this.models.getModel(target.provider, target.modelId);
      if (!model || !getSupportedThinkingLevels(model).includes(value.thinkingLevel as never)) throw invalid("Reasoning level is not supported by the model");
      options.thinkingLevel = value.thinkingLevel as ChatOptions["thinkingLevel"];
    }
    if (value.access !== undefined) {
      if (!accessModes.includes(value.access as never) || mode !== "write") throw invalid();
      if (value.access === "auto" && actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner can auto-approve");
      options.access = value.access as ChatOptions["access"];
    }
    // Only an Auto-approve message merges without asking too, as the apps mark each one (see ChatOptions).
    if (value.autoMerge !== undefined) {
      if (typeof value.autoMerge !== "boolean" || (value.autoMerge && options.access !== "auto")) throw invalid("Auto-merge needs Auto-approve");
      if (value.autoMerge) options.autoMerge = true;
    }
    return Object.keys(options).length ? options : undefined;
  }

  /** Decodes a message's images and fits them to what the model gets of an image, as read_file does for image files. */
  private async prepareImages(images: readonly ChatImage[]): Promise<InputImage[]> {
    const prepared: InputImage[] = [];
    for (const image of images) {
      const bytes = Buffer.from(image.data, "base64");
      // The sender names the type, and an image passed through to a provider under another type than its bytes would
      // fail every later turn of the conversation: the bytes' signature must say the same.
      if (imageType(bytes) !== image.mimeType) throw new RunnerError(422, IMAGE_ERROR);
      const result = await prepareImage(bytes, image.mimeType);
      // 422 carries this fixed, runner-authored reason through the Worker to the sender.
      if ("error" in result) throw new RunnerError(422, result.error === IMAGE_BUSY ? "Too many images are being prepared at once. Send the message again shortly" : result.error);
      prepared.push({ mimeType: result.image.mimeType, data: result.image.data });
    }
    return prepared;
  }

  /** Images go only to a model that takes them; one that doesn't would answer the text without ever seeing them. */
  private async requireImageModel(options: ChatOptions | undefined): Promise<void> {
    const target = options?.model ?? (await this.root.agent(context)).model ?? this.modelRef;
    const model = this.models.getModel(target.provider, target.modelId);
    // A model that doesn't say what it takes is left to its provider.
    if (model && Array.isArray(model.input) && !model.input.includes("image")) throw new RunnerError(422, "The model doesn't accept images");
  }

  /** Where queued messages' prepared images wait, outside the sandbox and the backups, until their messages reach Pi. */
  private get inputsDirectory(): string {
    return join(this.directory, "inputs");
  }

  /** A run's images, by its key: the hash `requestKey` makes, so always a plain file name. */
  private inputPath(key: string): string {
    return join(this.inputsDirectory, `${key}.json`);
  }

  /** Keeps a queued run's prepared images, whole or not at all, until it reaches Pi. */
  private async writeInputs(key: string, images: readonly InputImage[]): Promise<void> {
    await mkdir(this.inputsDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(this.inputsDirectory, `.${key}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ images }));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.inputPath(key));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** A run's prepared images; undefined when they are gone or unreadable. */
  private async readInputs(key: string): Promise<InputImage[] | undefined> {
    try {
      const images = (JSON.parse(await readFile(this.inputPath(key), "utf8")) as { images?: unknown }).images;
      if (!Array.isArray(images) || !images.length
        || images.some(image => typeof image?.mimeType !== "string" || typeof image.data !== "string")) return undefined;
      return images as InputImage[];
    } catch { return undefined; }
  }

  private async discardInputs(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(key => rm(this.inputPath(key), { force: true }).catch(() => {})));
  }

  /**
   * Removes the images of every run that no longer waits to reach Pi, and those a run that never committed left. Called
   * only where no submission can be writing its images: in the session's turn, or while it opens.
   */
  private async sweepInputs(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.inputsDirectory); }
    catch { return; }
    const runs = (await this.metadata()).runs;
    const waiting = (name: string) => {
      const run = name.endsWith(".json") ? runs[name.slice(0, -".json".length)] : undefined;
      return run !== undefined && run.submissionId === undefined && ["queued", "admitting", "running"].includes(run.status);
    };
    await Promise.all(names.filter(name => !waiting(name)).map(name => rm(join(this.inputsDirectory, name), { force: true }).catch(() => {})));
  }

  /**
   * Ends a run whose images are gone or unreadable, saying so in the ledger, after removing whatever is left of them:
   * the ledger ending it is what makes the session idle, so nothing of the run is left on the host by then. A host
   * that stops in between finds the run still queued without its images when it reopens, and ends it here again.
   */
  private async endLostInputs(key: string): Promise<void> {
    await this.discardInputs([key]);
    await this.mutate(meta => { Object.assign(meta.runs[key]!, { status: "interrupted", inputsLost: true }); });
  }

  /**
   * What a run gives Pi: its text, then the images it was sent with. Undefined when its images are gone, and the run
   * then ends instead of running its text without them. Text of only whitespace is left out: providers refuse a text
   * block without any.
   */
  private async runInput(run: Run) {
    if (!run.images) return run.content;
    const images = await this.readInputs(run.key);
    if (!images) return undefined;
    return [
      ...(run.content.trim() ? [{ type: "text" as const, text: run.content }] : []),
      ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ];
  }

  /** A session that pinned its repositories is read-only: nothing new runs, is decided or backed up in it. */
  private requireUnfrozen(): void {
    if (this.#frozen) throw new RunnerError(409, "This session pinned its repositories when it started, which sessions no longer do; it is read-only");
  }

  async submit(ticket: RunnerTicket, input: SubmitInput, mode: "write" | "ask"): Promise<SubmitResult> {
    this.assertTicket(ticket);
    this.requireUnfrozen();
    const parsed: ReturnType<typeof parseChatImages> = input?.images === undefined ? { images: [] } : parseChatImages(input.images);
    if ("error" in parsed) throw new RunnerError(400, "Invalid submission images");
    const images = parsed.images;
    // A message of images alone has no text.
    if (typeof input?.content !== "string" || input.content.length > 100_000 || (!input.content.trim() && !images.length)
      || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new RunnerError(400, "Invalid submission");
    if ((input.admissionId !== undefined && (mode !== "write" || typeof input.admissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.admissionId)))
      || (this.config.connectorId && mode === "write" && input.admissionId === undefined))
      throw new RunnerError(400, "Invalid or missing Worker write admission");
    // Decoded and fitted before the session's turn, as that can take a while: what is queued is what the model gets.
    const prepared = images.length ? await this.prepareImages(images) : [];
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      // Messages queue while repositories are prepared; once that failed, say why instead of queueing forever.
      const preparation = this.#repositories;
      if (preparation.status === "failed") throw new RunnerError(502, preparationFailure(preparation.reason));
      await this.authorize(ticket.actorId, mode === "ask" ? "ask" : "write", ticket.policyVersion);
      // The message compacts its conversation, if it must, by the host's configuration as it is now.
      await this.hostConfig();
      const options = await this.chatOptions(input.options, mode, ticket.actorId);
      if (prepared.length) await this.requireImageModel(options);
      const key = await requestKey(ticket.actorId, mode, input.requestId);
      const hash = await messageHash(input.content, images);
      const state = await this.metadata();
      const existing = state.runs[key];
      if (existing) {
        if (existing.contentHash !== hash) throw new RunnerError(409, "requestId reused with different content");
        if (existing.admissionId !== input.admissionId) throw new RunnerError(409, "requestId reused with a different Worker admission");
        if (stableJson(existing.options ?? null) !== stableJson(options ?? null)) throw new RunnerError(409, "requestId reused with different chat options");
        return { submissionId: key, conversationId: String(existing.conversationId), status: existing.status };
      }
      if (Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status)).length >= 64)
        throw new RunnerError(429, "Session queue is full");
      const queuedBytes = Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status))
        .reduce((total, run) => total + Buffer.byteLength(run.content, "utf8"), 0);
      if (queuedBytes + Buffer.byteLength(input.content, "utf8") > 1024 * 1024) throw new RunnerError(429, "Session queued content limit exceeded");
      if (Object.values(state.runs).reduce((total, run) => total + Buffer.byteLength(run.content, "utf8"), 0) + Buffer.byteLength(input.content, "utf8") > 32 * 1024 * 1024)
        throw new RunnerError(429, "Session durable request content limit exceeded");
      if (Object.keys(state.runs).length >= 10_000) throw new RunnerError(429, "Session durable request ledger is full");
      const imageBytes = prepared.reduce((total, image) => total + image.data.length, 0);
      if (imageBytes && Object.values(state.runs).filter(run => run.submissionId === undefined && ["queued", "running", "admitting"].includes(run.status))
        .reduce((total, run) => total + (run.images?.bytes ?? 0), 0) + imageBytes > MAX_QUEUED_IMAGE_BYTES) throw new RunnerError(429, "Session queued image limit exceeded");
      // On disk before the run is committed, so a queued run with images always finds them; a run that never commits
      // leaves them for sweepInputs.
      if (prepared.length) await this.writeInputs(key, prepared);
      let conversation = this.root;
      if (mode === "ask") {
        const transcript = await this.root.context(context);
        const head = transcript.entries.at(-1);
        const fork = { ownership: { kind: "ownerless" as const }, agent: {
          // A side ask starts from the shared conversation's current model; its own choices apply when it runs.
          model: (await this.root.agent(context)).model ?? this.modelRef, instructions: this.agentInstructions("ask"),
          tools: this.tools.filter(tool => readOnlyTools.includes(tool.name) && this.binding.agent.tools.includes(tool.name as never)),
        } };
        conversation = head ? await this.root.fork(head.id, fork, context) : await this.harness.createConversation(fork, context);
      }
      const transcript = await conversation.context(context);
      const run: Run = { key, initiatedBy: ticket.actorId, ownerId: this.binding.owner.id, mode, conversationId: conversation.id, content: input.content, contentHash: hash, status: "queued", startEntry: transcript.entries.at(-1)?.id ?? 0, sequence: state.nextSequence ?? 0, submittedAt: Date.now() };
      if (input.admissionId !== undefined) run.admissionId = input.admissionId;
      if (options) run.options = options;
      if (prepared.length) run.images = { count: prepared.length, bytes: imageBytes };
      await this.mutate(meta => {
        meta.runs[key] = run;
        meta.nextSequence = (meta.nextSequence ?? 0) + 1;
        if (!meta.branches.some(branch => branch.id === conversation.id)) meta.branches.push({ id: conversation.id, mode, actorId: ticket.actorId });
      });
      this.drainQueue();
      return { submissionId: key, conversationId: String(conversation.id), status: "queued", queuePosition: Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status)).length + 1 };
    });
  }

  /**
   * Stops the session's work: the message running now and every message queued behind it, side asks included. They
   * show as stopped at once; the conversations still working are aborted in the background, and queued work waits
   * until that is done (see abortStopped). A call waiting on a card ends and the card is interrupted; an operation
   * already executing finishes and settles its card, as for any interrupted call. Messages sent afterwards run next.
   */
  async stop(ticket: RunnerTicket): Promise<{ stopped: number }> {
    this.assertTicket(ticket);
    const stopped = await this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(ticket.actorId, "write", ticket.policyVersion);
      const runs = Object.values((await this.metadata()).runs).filter(run => ["queued", "admitting", "running"].includes(run.status));
      // A queued message never reached Pi, so there is nothing to abort for it.
      await this.mutate(meta => {
        for (const run of runs) Object.assign(meta.runs[run.key]!, { status: "interrupted", stopped: { by: ticket.actorId, ...(run.status === "queued" ? {} : { pending: true }) } });
        // Cards of the stopped calls end with the stop, so no decision made before the abort lands can still run them.
        const keys = new Set(runs.map(run => run.key));
        for (const [taskId, actor] of Object.entries(meta.toolActors)) {
          if (!keys.has(actor.runKey)) continue;
          for (const card of [meta.approvals[`tool-${taskId}`], meta.approvals[`permission-${taskId}`], meta.approvals[`permission-${taskId}_audience`]]) {
            if (card?.status === "pending") Object.assign(card, { status: "interrupted", result: "The tool call stopped before a decision." });
          }
        }
      });
      // Stopped messages that never reached Pi never will.
      await this.discardInputs(runs.filter(run => run.images && run.submissionId === undefined).map(run => run.key));
      return runs;
    });
    if (stopped.some(run => run.status !== "queued")) void this.abortStopped().catch(() => { /* Reopening aborts what is left (see resumeWork). */ });
    return { stopped: stopped.length };
  }

  /** Aborts the conversations of runs whose stop is pending, then lets queued work run again. */
  private async abortStopped(): Promise<void> {
    const generation = this.generation;
    const runs = Object.values((await this.metadata()).runs).filter(run => run.stopped?.pending);
    // Pi withdraws the queued input and aborts every task of the conversation's current work, then waits for it to end.
    for (const id of new Set(runs.map(run => run.conversationId))) await (await this.harness.conversation(id as ConversationId, context))?.abort(context);
    if (generation !== this.generation) return;
    await this.mutate(meta => { for (const run of runs) delete meta.runs[run.key]!.stopped!.pending; });
    this.drainQueue();
  }

  private async toolActor(api: ToolExecutionApi, write: boolean) {
    const doc = await api.snapshot(RunnerState, context);
    const state: Metadata = JSON.parse(doc!.json);
    const saved = state.toolActors[String(api.taskId)];
    const run = saved ? state.runs[saved.runKey] : Object.values(state.runs).find(candidate => candidate.conversationId === api.conversationId && (candidate.status === "running" || candidate.status === "admitting"));
    // Side asks offer only read tools; in shared runs, `permit` decides whether a call needs the owner first.
    if (!run || !["admitting", "running"].includes(run.status) || run.ownerId !== this.binding.owner.id || (write && run.mode !== "write")) throw new RunnerError(403, "Tool has no authorized writable submission");
    await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write");
    await api.commit(async tx => {
      const current = await tx.doc(RunnerState);
      const meta: Metadata = JSON.parse(current.json);
      // The model's id of the call links its approval card to the transcript entry that made it.
      meta.toolActors[String(api.taskId)] ??= { initiatedBy: run.initiatedBy, ownerId: run.ownerId, runKey: run.key, callId: api.callId };
      current.json = JSON.stringify(meta);
    }, context);
    return { initiatedBy: run.initiatedBy, actingAs: run.ownerId, mode: run.mode };
  }

  private async recheckTool(attribution: { initiatedBy: string; mode: "write" | "ask" }): Promise<void> {
    await this.authorize(attribution.initiatedBy, attribution.mode === "ask" ? "ask" : "write");
  }

  /**
   * Whether shell commands may run here: within provisioned limits (Linux --resources, or the Windows sandbox's job
   * objects; macOS has none), on the host itself (an owner-consented unsandboxed host, or the owner's session on a host
   * that accepts it), or as a faux test shell.
   */
  private shellAllowed(): boolean {
    return (!!this.config.resources && !this.config.sandboxBackend) || (!this.#onHost && this.config.sandboxBackend?.kind === "windows") || this.#onHost || (this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true);
  }

  /**
   * A session started directly on the host runs commands only while the host's configuration still accepts that: its
   * owner turning it off stops the session's next command (within the configuration's 30-second refresh). A member's
   * session also needs their grant to still include sessions on the host, and a command that runs without anyone
   * approving it (`automatic`), automatic host commands too: a grant that ends or shrinks stops their next command.
   */
  private async requireHostEnvironment(automatic = false): Promise<void> {
    if (!this.#hostSession) return;
    if (!(await this.hostConfig()).hostSessions) {
      throw new RunnerError(403, "This host no longer runs sessions directly on it: its owner turned that off in Pistead (Settings → Hosts → the host → Configuration). "
        + "Nothing ran. Start a new session to work in the sandbox.");
    }
    if (this.binding.session.connectorOwnerId === this.binding.owner.id) return;
    const result = await this.authorize(this.binding.owner.id, "write", undefined, true, true);
    if (result.hostSessions !== true) {
      throw new RunnerError(403, "The session's owner may no longer run sessions directly on this host: the grant that let them has ended. "
        + "Nothing ran. Start a new session to work in the sandbox.");
    }
    if (automatic && result.hostCommands !== "auto") {
      throw new RunnerError(403, "This session runs directly on its host, and its owner no longer holds automatic host commands there: commands need approval. Nothing ran.");
    }
  }

  /** The host's configuration, as Pistead reports it to the connector; the defaults on a runner without one. */
  private async hostConfig(): Promise<HostConfig> {
    const config = this.config.hostConfig ? await this.config.hostConfig() : { ...defaultHostConfig };
    this.#configuredCompaction = config.compaction;
    return config;
  }

  /** How the next shell command runs, as the host's owner and admins configured it: its time limit and its GPU. */
  private async commandOptions(): Promise<{ limits: CommandLimits; gpu: boolean }> {
    const config = await this.hostConfig();
    return { limits: commandLimits(config.commandTimeoutSeconds), gpu: config.gpu };
  }

  /**
   * `unbounded`: the command may run without the limits this host lacks, as the host's owner allowed for their own
   * session, or a member they granted host commands for theirs (see grantedShell).
   */
  private requireShellCapability(operation: Operation, unbounded = false): void {
    if (operation.kind === "bash" && !unbounded && !this.shellAllowed()) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash needs verified resources or explicitly enabled faux test sessions");
    }
  }

  /**
   * Whether a command without the limits this host lacks (`unbounded`) runs on the strength of a host command grant: in
   * a session whose owner isn't the host's owner. A member the host's owner granted host commands can already run any
   * command on the host itself, so their commands may run in the sandbox without limits too, as host commands do: decided
   * only by someone with host command authority, without approval only for a member holding automatic host commands, and
   * only while their grant lasts (requireShellGrant).
   */
  private grantedShell(unbounded: boolean): boolean {
    return unbounded && this.binding.session.connectorOwnerId !== this.binding.owner.id;
  }

  /**
   * Refuses a command `grantedShell` covers unless the session's owner holds host command authority on this host now:
   * either level for a command someone decides, automatic host commands for one that runs without approval
   * (`automatic`). A grant that ends or shrinks stops their next command.
   */
  private async requireShellGrant(automatic = false): Promise<void> {
    const level = this.binding.session.connectorOwnerId ? await this.hostCommandLevel(this.binding.owner.id, "write") : undefined;
    if (!level) {
      throw new RunnerError(403, "This host has no resource limits for commands, so it runs them only in sessions of its owner and of members they granted "
        + "host commands (Settings → Hosts → the host → Host command access). Nothing ran.");
    }
    if (automatic && level !== "auto") {
      throw new RunnerError(403, "This host has no resource limits for commands, and the session's owner no longer holds automatic host commands there: "
        + "commands need approval. Nothing ran.");
    }
  }

  /**
   * Lets a tool call go ahead, first asking the session owner when the session doesn't allow it yet: a tool outside the
   * agent's, a change in a Read-only message, or a shell command on a host without resource limits. The call waits on
   * the owner's card, which allows it once or for the rest of the session, or denies it. `unbounded`: the command runs
   * without limits, which the host's owner can allow in their own session, and a member they granted host commands in
   * theirs (see grantedShell).
   */
  private async permit(api: ToolExecutionApi, waiting: Context, tool: ToolName, target: string, effect: { write?: boolean; shell?: boolean; audience?: boolean } = {}): Promise<{ unbounded: boolean }> {
    const state = await this.metadata();
    const actor = state.toolActors[String(api.taskId)];
    const run = actor && state.runs[actor.runKey];
    if (!run) throw new RunnerError(403, "Tool has no authorized writable submission");
    const grants = state.grants;
    const needs: PermissionNeed[] = [];
    // The sessions tool's second card, once the control plane said what a call it let through would share: the call
    // already has its tool, so that card asks only for this, under an id of its own.
    if (effect.audience) {
      if (!grants?.audience) needs.push("audience");
    } else {
      if (!this.binding.agent.tools.includes(tool) && !(tool !== "host_bash" && grants?.tools.includes(tool))) needs.push("tool");
      if (effect.write && run.options?.access === "read" && !grants?.write) needs.push("write");
    }
    const unbounded = effect.shell === true && !this.shellAllowed();
    if (unbounded) {
      // In another member's session, only while they hold host command authority here, checked before any card asks.
      if (this.grantedShell(true)) await this.requireShellGrant();
      if (!grants?.unboundedShell) needs.push("unbounded-shell");
    }
    if (!needs.length) return { unbounded };
    // The owner's auto-approve access answers these cards for them: they chose to let the agent act without asking.
    // Only the owner can pick it, and a command without limits got this far only on their own host, or with a host
    // command grant there (checked above), which still decides whether it then runs without approval (createApproval).
    if (run.options?.access === "auto" && run.mode === "write" && run.initiatedBy === this.binding.owner.id) return { unbounded };
    if (this.config.connectorId && !run.admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
    const deadline = (run.submittedAt ?? Date.now()) + DECISION_WAIT_MS;
    if (deadline <= Date.now()) throw new Error("This message is over an hour old, so the session owner can no longer allow this call. Ask them to send a new message.");
    const id = `permission-${api.taskId}${effect.audience ? "_audience" : ""}`;
    // The target only shows the owner what the call touches; keep it within what the control plane accepts.
    const shown = target.replaceAll("\0", "");
    const operation = validateOperation({ kind: "permission", tool, target: shown.length > 8192 ? `${shown.slice(0, 8191)}…` : shown, needs });
    const request: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: run.initiatedBy, createdAt: new Date().toISOString(), status: "pending", operation,
      ...(run.admissionId !== undefined ? { admissionId: run.admissionId } : {}) };
    await this.mutate(meta => { meta.approvals[id] ??= request; });
    const decided = await this.awaitCard(id, waiting, deadline);
    if (decided.status === "denied") throw new Error(`The session owner did not allow ${tool}${target ? ` on ${target}` : ""}.`);
    if (decided.status !== "approved") throw new Error(decided.result ?? "The permission request ended before the session owner answered.");
    return { unbounded };
  }

  /** Whether what the owner allowed for the rest of the session covers every need of `request`. */
  private coveredBy(request: PermissionRequest, grants: Grants): boolean {
    return request.needs.every(need => need === "tool" ? this.binding.agent.tools.includes(request.tool) || (request.tool !== "host_bash" && grants.tools.includes(request.tool))
      : need === "write" ? grants.write : need === "audience" ? grants.audience === true : grants.unboundedShell);
  }

  private buildTools(): ToolRegistration[] {
    // Sessions commit and switch branches with Git itself, and push a clone's directory with git_push; on an unsandboxed
    // host they push with Git itself too, with the host's own credentials.
    const tools = this.sessionTools();
    return this.#clone && this.#egress ? [...tools, this.clonePushTool()] : tools;
  }

  private clonePushTool(): ToolRegistration {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    return defineTool({ name: "git_push", description: "Push the checked-out commit of a clone in the worktree (its directory, such as app) as it is to a branch of the workspace repository it was cloned from, fast-forward only, optionally opening a pull request as the owner. With tag, push no branch: create that tag at the checked-out commit, which must already be on the remote's branch (such as a release tag on main); tags are never moved. Commit with git first. Waits for an exact human approval unless the owner enabled auto-approve for this request.", parameters: Type.Object({
      directory: Type.String(), branch: Type.String(), tag: Type.Optional(Type.String()),
      pull_request: Type.Optional(Type.Object({ title: Type.String(), body: Type.String(), base: Type.Optional(Type.String()) })),
    }), execute: async (args, api, call) => {
      const attribution = await this.toolActor(api, true);
      await this.permit(api, call, "git_push", args.tag === undefined ? `${args.directory} → ${args.branch}` : `${args.directory} → tag ${args.tag} on ${args.branch}`, { write: true });
      if (!validCloneDirectory(args.directory)) throw new RunnerError(400, "directory must be a clone's path in the worktree, such as app or src/app");
      if (args.tag !== undefined && !validPushTag(args.tag)) throw new RunnerError(400, "tag must be a plain tag name, such as v1.2.3, not refs/tags/v1.2.3");
      if (args.tag !== undefined && args.pull_request) throw new RunnerError(400, "a tag push opens no pull request");
      const head = await isolatedWorkspace(this.sandbox).cloneHead(args.directory, () => this.recheckTool(attribution));
      if (!head.origin) throw new RunnerError(400, `${args.directory} has no origin remote; push only clones of this workspace's repositories`);
      const repository = repositoryForRemote((await this.#egress!.grant()).repositories, head.origin);
      if (!repository) throw new RunnerError(403, `${args.directory} was cloned from ${head.origin.slice(0, 200)}, which is not one of this workspace's repositories`);
      const request = args.pull_request;
      const operation: GitPushOperation = { kind: "git.push", repository: repositoryPath(repository), directory: args.directory, branch: args.branch,
        ...(args.tag !== undefined ? { tag: args.tag } : {}), commit: head.commit,
        ...(request ? { pullRequest: { title: request.title, body: request.body, ...(request.base !== undefined ? { base: request.base } : {}) } } : {}) };
      const approval = await this.operationOutcome(await this.createApproval(attribution.initiatedBy, operation, String(api.taskId), { permitted: true }), call);
      return text({ ...approval, admissionId: undefined });
    } });
  }

  private sessionTools(): ToolRegistration[] {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    const approvalText = (approval: StoredApproval) => text({ ...approval, admissionId: undefined, callId: undefined });
    return [
      defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: Type.Object({}), execute: async (_args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "identity", "");
        const config = await this.hostConfig();
        // How shell commands run here, as the host's owner and admins configured it.
        // On the host itself there is no sandbox to lend the GPU to: commands have it already, with everything else there.
        const commands = { timeoutSeconds: commandLimits(config.commandTimeoutSeconds).seconds, gpu: config.gpu && !this.#onHost,
          ...(this.#onHost ? { onHost: true } : {}) };
        return text({ ...await this.sandbox.identity(() => this.recheckTool(attribution)), commands, ...attribution });
      } }),
      defineTool({ name: "read_file", description: "Read a confined worktree file. PNG, JPEG, GIF and WebP images are returned as images, scaled to fit.", parameters: Type.Object({ path: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "read_file", args.path);
        const file = await this.sandbox.readContent(args.path, () => this.recheckTool(attribution));
        if ("text" in file) return text({ ...attribution, content: file.text });
        const prepared = await prepareImage(file.image, file.mimeType);
        if ("error" in prepared) return { output: [], isError: true, diagnostics: [{ severity: "error" as const, code: "image", message: prepared.error }] };
        const { image } = prepared;
        return { output: [
          { type: "text" as const, text: JSON.stringify({ ...attribution, path: args.path, mimeType: image.mimeType, width: image.width, height: image.height }) },
          { type: "image" as const, data: image.data, mimeType: image.mimeType },
        ] };
      } }),
      defineTool({ name: "list_files", description: "List confined worktree files.", parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "list_files", args.path ?? "");
        return text({ ...attribution, files: await this.sandbox.listFiles(args.path, () => this.recheckTool(attribution)) });
      } }),
      // Writes run one at a time: a round with a write is sequential, so an edit never reads a file another call changes.
      defineTool({ name: "write_file", description: "Write a confined worktree file. In a read-only request it waits for the session owner to allow it.", executionMode: "sequential", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "write_file", args.path, { write: true });
        await this.sandbox.writeFile(args.path, args.content, () => this.recheckTool(attribution));
        return text({ ...attribution, written: args.path });
      } }),
      defineTool({ name: "edit_file", executionMode: "sequential",
        description: "Edit a confined worktree text file by exact replacement, without rewriting it. Each edits[].oldText must occur exactly once in the file, including whitespace and line breaks; edits are matched against the file as it was, must not overlap, and apply together. In a read-only request it waits for the session owner to allow it.",
        parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }) }),
        execute: async (args, api, call) => {
          const attribution = await this.toolActor(api, true);
          await this.permit(api, call, "edit_file", args.path, { write: true });
          const recheck = () => this.recheckTool(attribution);
          await this.sandbox.writeFile(args.path, applyEdits(await this.sandbox.readFile(args.path, recheck), args.edits, args.path), recheck);
          return text({ ...attribution, edited: args.path, edits: args.edits.length });
        } }),
      defineTool({ name: "bash", description: "Run an exact shell command in the session worktree. Waits for an exact human approval unless the owner enabled auto-approve for this request; then it runs at once and the result carries its output. It stops at the host's command time limit, which identity reports (commands.timeoutSeconds).", parameters: Type.Object({ command: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        // Before any card: a session on a host that no longer accepts that asks nobody for anything.
        await this.requireHostEnvironment();
        const { unbounded } = await this.permit(api, call, "bash", args.command, { write: true, shell: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "bash", command: args.command }, String(api.taskId), { permitted: true, unbounded }, call.abortSignal), call));
      } }),
      defineTool({ name: "github_read", description: "Read a GitHub issue or pull request of one of the workspace's github.com repositories (owner/name) as the session owner, through Pistead: its description and comments and, for a pull request, its merge state, head commit, reviews, review comments and checks. Long threads keep their newest items. The sandbox has no network, so use this instead of gh or curl. Read-only; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), issue: Type.Integer({ minimum: 1 }) }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, false);
        const repository = this.githubRepository(args.repository);
        await this.permit(api, call, "github_read", `${repository}#${args.issue}`);
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        // The control plane reads only within a message's write admission.
        if (!run.admissionId) throw new RunnerError(403, "GitHub reads need a write message");
        const request: GitHubReadRequest = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId), repository, issue: args.issue };
        await this.authorize(run.initiatedBy, "write");
        const view = this.config.githubRead ? await this.config.githubRead(request) : await this.internalGitHub("read", request) as GitHubIssueView;
        return text({ ...attribution, ...view });
      } }),
      defineTool({ name: "github_comment", description: "Post an exact GitHub comment as the session owner through the owner's broker, once a human approves it, or at once under the owner's auto-approve. The result carries the outcome; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), issue: Type.Integer({ minimum: 1 }), body: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "github_comment", `${args.repository}#${args.issue}`, { write: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "github.comment", ...args }, String(api.taskId), { permitted: true }), call));
      } }),
      defineTool({ name: "github_merge", description: "Merge a pull request of one of the workspace's github.com repositories (owner/name) as the session owner, through the owner's broker: only while its head is still commit sha, as github_read reports it, with method merge, squash or rebase, once a human approves it, or at once under the owner's auto-approve. The result carries the outcome; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), pull: Type.Integer({ minimum: 1 }), sha: Type.String(), method: StringEnum(githubMergeMethods) }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        const repository = this.githubRepository(args.repository);
        if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new RunnerError(400, "sha must be the pull request's full 40-character head commit, as github_read reports it");
        await this.permit(api, call, "github_merge", `${repository}#${args.pull}`, { write: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "github.merge", repository, pull: args.pull, sha: args.sha, method: args.method }, String(api.taskId), { permitted: true }), call));
      } }),
      defineTool({ name: "github_issue", description: "Open a GitHub issue with exactly this title (one line) and body (Markdown) in one of the workspace's github.com repositories (owner/name), as the session owner, through the owner's broker once a human approves it, or at once under the owner's auto-approve. Use this instead of gh issue create: the sandbox holds no GitHub credentials. The result carries the new issue's number and URL; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), title: Type.String(), body: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        const repository = this.githubRepository(args.repository);
        if (!args.title.trim() || /[\r\n]/.test(args.title) || args.title.length > GITHUB_ISSUE_TITLE_LIMIT) throw new RunnerError(400, `title must be one non-empty line of at most ${GITHUB_ISSUE_TITLE_LIMIT} characters`);
        if (args.body.length > GITHUB_ISSUE_BODY_LIMIT) throw new RunnerError(400, `body must be at most ${GITHUB_ISSUE_BODY_LIMIT} characters`);
        if (args.title.includes("\0") || args.body.includes("\0")) throw new RunnerError(400, "title and body must not contain NUL characters");
        await this.permit(api, call, "github_issue", `${repository}: ${args.title}`, { write: true });
        return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy, { kind: "github.issue", repository, title: args.title, body: args.body }, String(api.taskId), { permitted: true }), call));
      } }),
      defineTool({ name: "schedule", description: "Manage this session's scheduled prompts: messages Pistead sends this session's agent on a cron schedule, as the session owner, so the session wakes up and works on its own (a nightly check, a weekly report). Use it when the user asks to do something every hour, day or week, or at a later time. action list takes nothing; create takes message (what the agent is told each time) and cron (five fields: minute hour day-of-month month day-of-week, such as '0 9 * * 1-5'; runs at least 5 minutes apart), and optionally name, time_zone (IANA, such as Europe/Berlin; UTC otherwise, so ask the user for theirs when the time of day matters), access (approval, the default: commands wait for a human; read; auto, only in a message the owner sent with auto-approve) and enabled; update takes id and only the fields to change (an auto-approved schedule is changed, other than paused or lowered in access, only in a message the owner sent with auto-approve); delete takes id. Only the session owner's messages can use it. A run due while the agent is busy is skipped. The owner sees and edits them in the session panel's Schedules tab.", parameters: Type.Object({
        action: StringEnum(scheduleToolActions), id: Type.Optional(Type.String()), message: Type.Optional(Type.String()), cron: Type.Optional(Type.String()),
        time_zone: Type.Optional(Type.String()), name: Type.Optional(Type.String()), access: Type.Optional(StringEnum(accessModes)), enabled: Type.Optional(Type.Boolean()),
      }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        const fields = Object.fromEntries(Object.entries({ scheduleId: args.id, name: args.name, cron: args.cron, timeZone: args.time_zone, content: args.message,
          access: args.access, enabled: args.enabled }).filter(([, value]) => value !== undefined)) as Omit<ScheduleToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
        if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Schedule fields must not contain NUL characters");
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        // A schedule runs as the session owner, with nobody watching: only the owner's own messages make one, and only a
        // message with their Auto-approve an auto-approved one (the control plane checks both, and changes to one).
        if (run.initiatedBy !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner's messages schedule prompts. Ask the owner to send this request, or to add it in the Schedules tab.");
        if (args.access === "auto" && run.options?.access !== "auto") {
          throw new RunnerError(403, "Only a message the session owner sent with auto-approve schedules an auto-approved prompt. Use access approval, or ask the owner to set it in the Schedules tab.");
        }
        if (!run.admissionId) throw new RunnerError(403, "Scheduling needs a write message");
        await this.permit(api, call, "schedule", scheduleToolTarget({ action: args.action, ...fields }), { write: args.action !== "list" });
        await this.authorize(run.initiatedBy, "write");
        const request: ScheduleToolRequest = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId),
          action: args.action, ...fields };
        const result = this.config.schedules ? await this.config.schedules(request) : await this.internalBroker("schedules", request) as ScheduleToolResult;
        return text({ ...attribution, ...result });
      } }),
      defineTool({ name: "sessions", description: SESSIONS_TOOL_DESCRIPTION,
        // One call at a time: each counts against its message's sends and its session's new sessions.
        executionMode: "sequential", parameters: Type.Object({
        action: StringEnum(sessionsToolActions), session: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
        access: Type.Optional(StringEnum(accessModes)), notify: Type.Optional(Type.Boolean()), title: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
        visibility: Type.Optional(StringEnum(["private", "workspace"] as const)), message_id: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: crossSessionLimits.readEntries })),
        timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: crossSessionLimits.waitSeconds })),
      }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        const fields = Object.fromEntries(Object.entries({ targetSessionId: args.session, message: args.message, access: args.access, notify: args.notify, title: args.title,
          modelId: args.model, visibility: args.visibility, messageId: args.message_id, limit: args.limit }).filter(([, value]) => value !== undefined)) as
          Omit<SessionsToolRequest, "sessionId" | "actorId" | "admissionId" | "callId" | "action">;
        if (Object.values(fields).some(value => typeof value === "string" && value.includes("\0"))) throw new RunnerError(400, "Sessions tool fields must not contain NUL characters");
        const wait = args.action === "wait";
        if (wait && (fields.targetSessionId === undefined || fields.messageId === undefined)) throw new RunnerError(400, "wait takes session and message_id, as ask, send or create returned them");
        if (!wait && args.timeout_seconds !== undefined) throw new RunnerError(400, "Only wait takes timeout_seconds");
        const state = await this.metadata();
        const run = state.runs[state.toolActors[String(api.taskId)]!.runKey]!;
        if (!run.admissionId) throw new RunnerError(403, "The sessions tool needs a write message");
        // What it sends elsewhere never has more access than this message (the control plane checks this too).
        if (args.access === "auto" && (run.options?.access !== "auto" || run.initiatedBy !== this.binding.owner.id)) {
          throw new RunnerError(403, "Only a message the session owner sent with auto-approve sends an auto-approved message. Use access approval, which leaves the other session's commands to its people.");
        }
        // A wait is a series of reads of one message, and its card shows it as that read.
        const request = { action: wait ? "read" as const : args.action as Exclude<typeof args.action, "wait">, ...(wait ? { targetSessionId: fields.targetSessionId, messageId: fields.messageId, limit: 1 } : fields) };
        await this.permit(api, call, "sessions", sessionsToolTarget(request), { write: sessionsWriteActions.includes(args.action) });
        await this.authorize(run.initiatedBy, "write");
        const base = { sessionId: this.binding.session.id, actorId: run.initiatedBy, admissionId: run.admissionId, callId: String(api.taskId) };
        const broker = async (): Promise<SessionsToolResult> => {
          const result = this.config.crossSessions ? await this.config.crossSessions({ ...base, ...request }) : await this.internalBroker("sessions", { ...base, ...request }) as SessionsToolResult;
          if (!("consent" in result)) return result;
          // The other session's readers aren't this one's: the owner decides, on a card naming that session, and the
          // control plane then sees their decision for this call.
          await this.permit(api, call, "sessions", result.target, { audience: true });
          await this.authorize(run.initiatedBy, "write");
          const retried = this.config.crossSessions ? await this.config.crossSessions({ ...base, ...request }) : await this.internalBroker("sessions", { ...base, ...request }) as SessionsToolResult;
          if ("consent" in retried) throw new RunnerError(409, "The control plane did not see the session owner's decision yet; call again.");
          return retried;
        };
        if (!wait) return text({ ...attribution, ...await broker() });
        const deadline = Date.now() + (args.timeout_seconds ?? crossSessionLimits.defaultWaitSeconds) * 1000;
        for (;;) {
          const result = await broker();
          const done = "outcome" in result && result.outcome?.done === true;
          if (done || Date.now() + WAIT_POLL_MS > deadline) {
            const { entries: _entries, ...shown } = result as Extract<SessionsToolResult, { entries: unknown }>;
            return text({ ...attribution, ...shown, ...(done ? {} : { timedOut: true }) });
          }
          await sleep(WAIT_POLL_MS, undefined, { signal: call.abortSignal });
        }
      } }),
      defineTool({ name: "host_bash", executionMode: "sequential",
        description: "Run any command OUTSIDE the sandbox on the host, with its tools, files, credentials and network. Uses the session worktree as cwd and the host home/PATH. Requires exact approval by the host owner or a member they granted host commands; auto-approve skips it only in the session of the host owner or of a member granted automatic host commands. No CPU/memory/disk quotas. Default 300 seconds, maximum 3600. Never use as an implicit fallback.",
        parameters: Type.Object({ command: Type.String(), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })) }),
        execute: async (args, api, call) => {
          const attribution = await this.toolActor(api, true);
          await this.permit(api, call, "host_bash", args.command, { write: true });
          return approvalText(await this.operationOutcome(await this.createApproval(attribution.initiatedBy,
            { kind: "host.bash", command: args.command, timeoutSeconds: args.timeout_seconds ?? 300 }, String(api.taskId), { permitted: true }), call));
        } }),
    ];
  }

  /** Tracked through shutdown, and never replayed after an ambiguous failure. */
  private startHostOperation(id: string, operation: HostCommandOperation,
    auth: { actorId: string; capability?: string; admissionId?: string }, recheck: SandboxAuthorize): Promise<void> {
    const entry = { controller: new AbortController(), done: Promise.resolve() };
    const generation = this.generation;
    entry.done = (async () => {
      let status: "executed" | "failed" | "interrupted" = "executed";
      let result: string;
      try {
        await recheck();
        entry.controller.signal.throwIfAborted();
        // Run under the owner's Auto-approve (an admission), it needs their automatic host commands; otherwise the
        // approver's authority to decide host commands, either one still held now.
        const automatic = auth.capability === undefined && auth.admissionId !== undefined;
        const level = await this.hostCommandLevel(auth.actorId, automatic ? "write" : "approve");
        if (!level || (automatic && level !== "auto")) throw new RunnerError(403, "Only the host owner, or a member granted host commands on this host, can execute host commands");
        result = await this.sandbox.executeHost(operation, recheck, entry.controller.signal);
      } catch (error) {
        const refused = error instanceof RunnerError && error.status < 500;
        status = error instanceof SandboxProcessError || refused ? "failed" : "interrupted";
        result = error instanceof SandboxProcessError ? `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`
          : refused ? (error as RunnerError).message : "Effect interrupted or outcome unknown. Inspect the session list or host before requesting another operation.";
      }
      if (generation === this.generation) await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.kept(id, result) }); });
    })().catch(() => { /* Durable executing records become interrupted on reopen. */ }).finally(() => {
      this.pushes.delete(entry);
      if (generation === this.generation && !this.closing) this.drainQueue();
    });
    this.pushes.add(entry);
    return entry.done;
  }

  /**
   * An approved shell command, run in the background for as long as the host's time limit allows and tracked through
   * shutdown like host commands: closing the session stops it. A refusal or a non-zero exit is a definite outcome the
   * agent can act on; anything else may have had partial effects.
   */
  private startShellOperation(id: string, operation: Extract<Operation, { kind: "bash" }>, unbounded: boolean, recheck: SandboxAuthorize): Promise<void> {
    const entry = { controller: new AbortController(), done: Promise.resolve() };
    const generation = this.generation;
    entry.done = (async () => {
      let status: "executed" | "failed" | "interrupted";
      let result: string;
      try {
        result = await this.sandbox.execute(operation, false, recheck, {
          allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded,
          ...await this.commandOptions(), signal: entry.controller.signal,
        });
        status = "executed";
      } catch (error) {
        const refused = error instanceof RunnerError && error.status < 500;
        status = error instanceof SandboxProcessError || refused ? "failed" : "interrupted";
        result = error instanceof SandboxProcessError ? `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`
          : refused ? (error as RunnerError).message : "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited.";
      }
      if (generation === this.generation) await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.kept(id, result) }); });
    })().catch(() => { /* Durable executing records become interrupted on reopen. */ }).finally(() => {
      this.pushes.delete(entry);
      if (generation === this.generation && !this.closing) this.drainQueue();
    });
    this.pushes.add(entry);
    return entry.done;
  }

  /** A github.com owner/name: a session reads and merges in any github.com repository of its workspace, as the control plane checks. */
  private githubRepository(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new RunnerError(400, "repository must be a github.com owner/name");
    return name;
  }

  /**
   * Posts the comment, merges or opens the issue through the control plane's broker, authorized by a human approval's
   * capability or the owner's Auto-approve admission, and says what happened.
   */
  private async githubEffect(operation: Extract<Operation, { kind: "github.comment" | "github.merge" | "github.issue" }>,
    authority: { sessionId: string; actorId: string; approvalId: string } & ({ capability: string } | { admissionId: string })): Promise<string> {
    if (operation.kind === "github.comment") {
      const { repository, issue, body } = operation;
      const request: GitHubCommentRequest = { ...authority, repository, issue, body };
      const comment = this.config.githubComment ? await this.config.githubComment(request) : await this.internalGitHub("comment", request) as { id: number; url: string };
      return JSON.stringify({ id: comment.id, url: comment.url });
    }
    if (operation.kind === "github.merge") {
      const { repository, pull, sha, method } = operation;
      const request: GitHubMergeRequest = { ...authority, repository, pull, sha, method };
      const merged = this.config.githubMerge ? await this.config.githubMerge(request) : await this.internalGitHub("merge", request) as GitHubMergeResult;
      return JSON.stringify({ merged: true, sha: merged.sha, url: merged.url });
    }
    const { repository, title, body } = operation;
    const request: GitHubIssueRequest = { ...authority, repository, title, body };
    const opened = this.config.githubIssue ? await this.config.githubIssue(request) : await this.internalGitHub("issue", request) as GitHubIssueResult;
    return JSON.stringify({ number: opened.number, url: opened.url });
  }

  /** The control plane's GitHub broker for runners without a connector, with the shared secret; refusals keep their status and reason. */
  private async internalGitHub(action: "comment" | "read" | "merge" | "issue", request: object): Promise<unknown> {
    return this.internalBroker(`github/${action}`, request);
  }

  /** One of the control plane's internal broker routes, as internalGitHub. */
  private async internalBroker(path: "schedules" | "sessions" | `github/${string}`, request: object): Promise<unknown> {
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/${path}`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Broker returned an error; external state must be reconciled";
      throw new RunnerError(response.status, error);
    }
    return value;
  }

  /**
   * `consent.permitted`: a tool call `permit` already let through. `consent.unbounded`: this command may run without the
   * resource limits this host lacks, as the host's owner allowed in their own session, or on the strength of a host
   * command grant in a member's (see grantedShell).
   */
  async createApproval(actorId: string, input: Operation, toolTaskId?: string, consent: { permitted?: boolean; unbounded?: boolean } = {}, signal?: AbortSignal): Promise<ApprovalRecord> {
    this.requireUnfrozen();
    const operation = validateOperation(input);
    if (operation.kind === "permission") throw new RunnerError(400, "Permission requests come only from tool calls");
    // Sessions commit and switch branches with Git itself, and push a clone's directory.
    if (operation.kind === "git.commit" || operation.kind === "git.repin" || (operation.kind === "git.push" && operation.directory === undefined)) {
      throw new RunnerError(400, "Commit and switch branches with git in bash; a push names a clone's directory");
    }
    this.requireShellCapability(operation, consent.unbounded);
    if (operation.kind === "host.bash" && (!this.config.connectorId || !this.binding.session.connectorOwnerId)) {
      throw new RunnerError(403, "Host commands require a connected host with a known owner");
    }
    if (operation.kind === "git.push" && !this.#clone) throw new RunnerError(400, "Only clone sessions push a clone's directory");
    // On a host without the sandbox the agent pushes with the host's own Git: an approved push would only fail.
    if (operation.kind === "git.push" && !this.#egress) throw new RunnerError(400, "On a host without the sandbox, push with git in bash");
    const toolName = ({ "git.commit": "git_commit", bash: "bash", "github.comment": "github_comment", "github.merge": "github_merge", "github.issue": "github_issue", "git.push": "git_push", "git.repin": "git_repin", "host.bash": "host_bash" } as const)[operation.kind];
    // Host commands never take a session grant (see `permit`), so a session-wide one left from before doesn't enable them.
    if (!consent.permitted && !this.binding.agent.tools.includes(toolName)
      && !(toolName !== "host_bash" && (await this.metadata()).grants?.tools.includes(toolName))) {
      throw new RunnerError(403, "Operation not enabled by pinned agent version");
    }
    await this.authorize(actorId, "write");
    let admissionId: string | undefined;
    let callId: string | undefined;
    let automatic = false;
    if (toolTaskId !== undefined) {
      const state = await this.metadata();
      const attribution = state.toolActors[toolTaskId];
      callId = attribution?.callId;
      const run = attribution && state.runs[attribution.runKey];
      if (!run || run.initiatedBy !== actorId || run.ownerId !== this.binding.owner.id || run.mode !== "write"
        || !["admitting", "running"].includes(run.status)) throw new RunnerError(403, "Approval has no active originating write");
      admissionId = run.admissionId;
      if (this.config.connectorId && !admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
      // Automatic pushes and GitHub effects are authorized by the control plane from the run's owner admission, so they
      // need one. GitHub comments, issues and merges run automatically only under the owner's Auto-approve itself, never
      // a session grant, and merges only in a message marked `autoMerge`, as the apps mark Auto-approve messages: the
      // control plane refuses an automatic merge of any other, even in a session's view.
      // A tool the owner allowed for the rest of the session runs their calls of it as Auto-approve would; host commands
      // never take a session grant, so each one still asks unless the owner holds automatic host commands on this host.
      const github = operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue";
      const sessionGranted = operation.kind !== "host.bash" && !github && state.grants?.tools.includes(toolName) === true;
      automatic = (run.options?.access === "auto" || sessionGranted) && run.initiatedBy === this.binding.owner.id
        && (!github || (admissionId !== undefined && (operation.kind !== "github.merge" || run.options?.autoMerge === true)))
        && (operation.kind !== "git.push" || admissionId !== undefined)
        && (operation.kind !== "host.bash" || await this.hostCommandLevel(this.binding.owner.id, "write") === "auto")
        // A command of a session on its host runs there as a host command does: without approval only for an owner who
        // holds automatic host commands on it.
        && (operation.kind !== "bash" || !this.#hostSession || await this.hostCommandLevel(this.binding.owner.id, "write") === "auto")
        // So does a command without the host's missing limits in a member's session (see grantedShell).
        && (operation.kind !== "bash" || !this.grantedShell(consent.unbounded === true) || await this.hostCommandLevel(this.binding.owner.id, "write") === "auto");
    }
    const id = toolTaskId ? `tool-${toolTaskId}` : randomUUID();
    const approval: StoredApproval = { id, sessionId: this.binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)), createdAt: new Date().toISOString(),
      ...(automatic ? { status: "executing", decidedBy: this.binding.owner.id, automatic: true } : { status: "pending" }),
      ...(consent.unbounded && operation.kind === "bash" ? { unbounded: true } : {}), ...(callId ? { callId } : {}) };
    if (admissionId !== undefined) approval.admissionId = admissionId;
    let created = false;
    // The tool call waits on its card: registered first, so a decision never finds the card without its call.
    if (toolTaskId !== undefined && !automatic) this.waiter(id);
    try { await this.mutate(meta => { if (!meta.approvals[id]) { meta.approvals[id] = approval; created = true; } }); }
    catch (error) {
      this.#approvalWaiters.delete(id);
      throw error;
    }
    // A replayed tool task finds its record and never repeats the effect; reopening marks interrupted executions.
    // `signal`: the tool call's, so stopping its message stops a long command it runs.
    if (automatic && created) return this.executeAutomatically(id, actorId, signal);
    return (await this.metadata()).approvals[id]!;
  }

  private async executeAutomatically(id: string, actorId: string, signal?: AbortSignal): Promise<ApprovalRecord> {
    const approval = (await this.metadata()).approvals[id]!;
    const operation = approval.operation;
    let status: ApprovalRecord["status"];
    let result: string;
    if (operation.kind === "host.bash") {
      await this.startHostOperation(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.authorize(actorId, "write"); });
      return (await this.metadata()).approvals[id]!;
    }
    if (operation.kind === "github.comment" || operation.kind === "github.merge" || operation.kind === "github.issue") {
      // Under the owner's Auto-approve the control plane authorizes the effect from the run's admission and consumes the
      // call's one attempt, so a replay never repeats it.
      try {
        await this.authorize(actorId, "write");
        result = await this.githubEffect(operation, { sessionId: this.binding.session.id, actorId, approvalId: id, admissionId: approval.admissionId! });
        status = "executed";
      } catch (error) {
        // GitHub said why it didn't merge or open the issue: nothing changed, so the agent can act on the reason.
        if (error instanceof RunnerError && error.status === 422 && operation.kind !== "github.comment") { status = "failed"; result = error.message; }
        else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
      }
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.kept(id, result) }); });
      return (await this.metadata()).approvals[id]!;
    }
    if (operation.kind === "git.push") {
      // Tracked like approved pushes so close() aborts it and awaits its settlement before the harness closes.
      const entry = { controller: new AbortController(), done: Promise.resolve() };
      const settled = (async () => {
        const outcome = await this.runPush(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.authorize(actorId, "write"); }, entry.controller.signal);
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: this.kept(id, outcome.result) }); });
      })();
      entry.done = settled.then(() => undefined, () => undefined);
      this.pushes.add(entry);
      try { await settled; }
      finally { this.pushes.delete(entry); }
      return (await this.metadata()).approvals[id]!;
    }
    try {
      result = await this.sandbox.execute(operation, false, async () => {
        this.requireShellCapability(operation, approval.unbounded === true);
        await this.requireHostEnvironment(true);
        if (this.grantedShell(approval.unbounded === true)) await this.requireShellGrant(true);
        await this.authorize(actorId, "write");
      }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded: approval.unbounded === true,
        ...await this.commandOptions(), signal });
      status = "executed";
    } catch (error) {
      // A non-zero exit is a definite outcome the agent can act on; anything else may have had partial effects.
      if (error instanceof SandboxProcessError) { status = "failed"; result = `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`; }
      else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
    }
    await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: this.kept(id, result) }); });
    return (await this.metadata()).approvals[id]!;
  }

  /**
   * The permission `actorId` needs on the session to decide an approval of `operation`: approve, except that the host's
   * owner decides its host commands (host_bash), which run as the host's OS user, with any access to the session.
   * Whether they may decide host commands at all is checked with the card (see hostCommandLevel).
   */
  private decisionPermission(actorId: string, operation: Pick<Operation, "kind"> | undefined): Permission {
    const hostOwner = this.binding.session.connectorOwnerId;
    return operation?.kind === "host.bash" && !!hostOwner && actorId === hostOwner ? "read" : "approve";
  }

  /** `scope` applies to permission requests: allow the one call (default), or the same need for the rest of the session. */
  async decide(ticket: RunnerTicket, id: string, input: { decision: "approve" | "deny"; operation: Operation; brokerCapability?: string; scope?: "call" | "session" }): Promise<ApprovalRecord> {
    this.requireUnfrozen();
    this.assertTicket(ticket);
    if (input.decision !== "approve" && input.decision !== "deny") throw new RunnerError(400, "Invalid approval decision");
    if (input.scope !== undefined && input.scope !== "call" && input.scope !== "session") throw new RunnerError(400, "Invalid approval scope");
    return this.exclusive(async () => {
      // The operation the caller names must be the card's (checked below), so it says what deciding it needs.
      const permission = this.decisionPermission(ticket.actorId, input.operation);
      await this.authorize(ticket.actorId, permission, ticket.policyVersion);
      const state = await this.metadata();
      const approval = state.approvals[id];
      if (!approval) throw new RunnerError(404, "Approval not found");
      if (stableJson(validateOperation(input.operation)) !== stableJson(approval.operation)) throw new RunnerError(409, "Approval operation mismatch");
      const decided = () => new RunnerError(409, "Approval has already been decided; unsafe effects are never retried");
      if (approval.status !== "pending") throw decided();
      // Its tool call may stop meanwhile and interrupt the card, so each decision is recorded only on a card still pending.
      const record = (meta: Metadata, decision: Partial<ApprovalRecord>) => {
        const card = meta.approvals[id]!;
        if (card.status !== "pending") throw decided();
        Object.assign(card, decision);
      };
      if (approval.operation.kind === "host.bash" && !await this.hostCommandLevel(ticket.actorId, "approve")) {
        throw new RunnerError(403, "Only the host owner, or a member granted host commands on this host, can decide a host command");
      }
      // A command of a session that runs directly on the host runs there, as a host command does: so is it decided.
      if (approval.operation.kind === "bash" && this.#hostSession && !await this.hostCommandLevel(ticket.actorId, "approve")) {
        throw new RunnerError(403, "This session runs directly on its host: only the host owner, or a member granted host commands on this host, can decide its commands");
      }
      // So is a command that runs without the host's missing limits in a member's session, on the strength of their grant.
      const granted = approval.operation.kind === "bash" && this.grantedShell(approval.unbounded === true);
      if (granted && !await this.hostCommandLevel(ticket.actorId, "approve")) throw new RunnerError(403, GRANTED_SHELL_DECIDERS);
      if (approval.operation.kind === "git.repin" && ticket.actorId !== this.binding.owner.id) {
        throw new RunnerError(403, "Only the session owner can decide a repin");
      }
      // A tool call is waiting on this request inside a running turn, so it is decided at once rather than after the queue.
      if (approval.operation.kind === "permission") {
        const request = approval.operation;
        if (ticket.actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner can allow more than the session allows");
        // On someone else's host, only with host command authority there (see grantedShell).
        if (request.needs.includes("unbounded-shell") && this.binding.session.connectorOwnerId !== this.binding.owner.id
          && !await this.hostCommandLevel(ticket.actorId, "approve")) {
          throw new RunnerError(403, "Only the host's owner, or a member granted host commands on this host, can allow a shell without resource limits");
        }
        const scope = input.scope ?? "call";
        // Each host command runs outside the sandbox, so its permission covers that one call only.
        if (scope === "session" && request.tool === "host_bash") throw new RunnerError(400, "Host commands can only be allowed once");
        await this.mutate(meta => {
          record(meta, input.decision === "approve" ? { status: "approved", decidedBy: ticket.actorId, scope } : { status: "denied", decidedBy: ticket.actorId });
          if (input.decision !== "approve" || scope !== "session") return;
          const grants = meta.grants ??= { tools: [], write: false, unboundedShell: false };
          if (request.needs.includes("tool") && !grants.tools.includes(request.tool)) grants.tools.push(request.tool);
          if (request.needs.includes("write")) grants.write = true;
          if (request.needs.includes("unbounded-shell")) grants.unboundedShell = true;
          if (request.needs.includes("audience")) grants.audience = true;
          // Parallel calls of the same round that wait on what the session now allows go ahead too.
          for (const other of Object.values(meta.approvals)) {
            if (other.id === id || other.status !== "pending" || other.operation.kind !== "permission" || !this.coveredBy(other.operation, grants)) continue;
            Object.assign(other, { status: "approved", decidedBy: ticket.actorId, scope });
          }
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (input.decision === "deny") {
        await this.mutate(meta => { record(meta, { status: "denied", decidedBy: ticket.actorId }); });
        return (await this.metadata()).approvals[id]!;
      }
      // Approved operations run in the sandbox, so they wait for the repositories like runs do.
      this.requireRepositoriesReady();
      this.requireShellCapability(approval.operation, approval.unbounded === true);
      await this.authorize(approval.requestedBy, "write");
      // A tool call waiting on this card holds its message, so the operation runs now and the call gets its outcome. Any
      // other card (one requested outside a message) waits for the queue, so it never runs beside the agent.
      if (!this.#approvalWaiters.has(id) && Object.values(state.runs).some(holdsQueue))
        throw new RunnerError(409, "Wait for the session queue to finish before approval execution");
      if (["github.comment", "github.merge", "github.issue", "git.push"].includes(approval.operation.kind) && !input.brokerCapability) throw new RunnerError(403, "Missing owner-bound single-use broker capability");
      await this.mutate(meta => { record(meta, { status: "executing", decidedBy: ticket.actorId }); });
      if (approval.operation.kind === "host.bash") {
        // Long host builds must not hold the connector's 30-second RPC queue.
        void this.startHostOperation(id, approval.operation, { actorId: ticket.actorId, capability: input.brokerCapability }, async () => {
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, permission);
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "bash") {
        // A command may run for the host's whole time limit, far past the connector's 30-second RPC deadline: report
        // executing now and settle in the background, as host commands do. The call waiting on the card gets its outcome.
        const operation = approval.operation;
        void this.startShellOperation(id, operation, approval.unbounded === true, async () => {
          this.requireShellCapability(operation, approval.unbounded === true);
          await this.requireHostEnvironment();
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          // Its decider's host command authority, as it stands when the command starts.
          if (this.#hostSession && !await this.hostCommandLevel(ticket.actorId, "approve")) {
            throw new RunnerError(403, "This session runs directly on its host: only the host owner, or a member granted host commands on this host, can decide its commands");
          }
          // And, without the host's missing limits in a member's session, their grant and its decider's, as they stand now.
          if (granted) {
            await this.requireShellGrant();
            if (!await this.hostCommandLevel(ticket.actorId, "approve")) throw new RunnerError(403, GRANTED_SHELL_DECIDERS);
          }
        });
        return (await this.metadata()).approvals[id]!;
      }
      if (approval.operation.kind === "git.push") {
        // Pushes can outlast the connector RPC deadline: report executing now and settle in the background.
        const operation = approval.operation;
        const controller = new AbortController();
        const generation = this.generation;
        const entry = { controller, done: Promise.resolve() };
        entry.done = (async () => {
          const outcome = await this.runPush(id, operation, { actorId: ticket.actorId, capability: input.brokerCapability! }, async () => {
            await this.authorize(approval.requestedBy, "write");
            await this.authorize(ticket.actorId, "approve");
          }, controller.signal);
          if (generation !== this.generation) return;
          await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: this.kept(id, outcome.result) }); });
        })().catch(() => { /* Reopening marks a still-executing approval interrupted; never retry the push. */ })
          .finally(() => {
            this.pushes.delete(entry);
            if (generation === this.generation && !this.closing) this.drainQueue();
          });
        this.pushes.add(entry);
        return (await this.metadata()).approvals[id]!;
      }
      try {
        let result: string;
        if (approval.operation.kind === "github.comment" || approval.operation.kind === "github.merge" || approval.operation.kind === "github.issue") {
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          result = await this.githubEffect(approval.operation, { sessionId: this.binding.session.id, actorId: ticket.actorId, approvalId: id, capability: input.brokerCapability! });
        } else throw new RunnerError(400, "Unsupported approval operation");
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result: this.kept(id, result) }); });
      } catch (error) {
        // GitHub said why it didn't merge or open the issue: nothing changed, so the agent can act on the reason.
        const outcome = error instanceof RunnerError && error.status === 422 && (approval.operation.kind === "github.merge" || approval.operation.kind === "github.issue")
          ? { status: "failed" as const, result: this.kept(id, error.message) }
          : { status: "interrupted" as const, result: "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited." };
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, outcome); });
      }
      return (await this.metadata()).approvals[id]!;
    });
  }

  async consumeTicket(ticket: RunnerTicket): Promise<void> {
    this.assertTicket(ticket);
    if (ticket.exp * 1000 <= Date.now()) throw new RunnerError(401, "Ticket expired");
    const key = await sha256(ticket.jti);
    await this.mutate(meta => {
      meta.usedTickets ??= {};
      const now = Math.floor(Date.now() / 1000);
      for (const [id, expires] of Object.entries(meta.usedTickets)) if (expires <= now) delete meta.usedTickets[id];
      if (meta.usedTickets[key]) throw new RunnerError(409, "Ticket has already been consumed");
      meta.usedTickets[key] = ticket.exp;
    });
  }

  async view(): Promise<SessionView> {
    const initial = await this.metadata();
    const snapshots: { branch: Branch; entries: readonly EntryRecord[] }[] = [];
    for (const branch of initial.branches) {
      const conversation = await this.harness.conversation(branch.id as ConversationId, context);
      if (!conversation) continue;
      const watch = await conversation.watch(context);
      try { snapshots.push({ branch, entries: watch.value.entries }); }
      finally { await watch.stop(); }
    }
    // Every admission is committed before its entries: read attribution after transcript snapshots.
    const state = await this.metadata();
    const stored = Object.values(state.approvals);
    const autoApproved = autoApprovedCalls(stored);
    const entries: SessionView["entries"] = [];
    for (const snapshot of snapshots) {
      let previous: Run | undefined;
      for (const entry of snapshot.entries) {
        const run = Object.values(state.runs).filter(candidate => (candidate.started || candidate.submissionId !== undefined || candidate.status === "admitting") && candidate.conversationId === entry.conversationId && candidate.startEntry < entry.id).sort((a, b) => b.startEntry - a.startEntry)[0];
        const ending = run !== previous && previous && this.endView(previous, snapshot.branch.id);
        if (ending) entries.push(ending);
        previous = run;
        entries.push(this.entryView(entry, snapshot.branch.id, run?.initiatedBy, autoApproved));
      }
      const ending = previous && this.endView(previous, snapshot.branch.id);
      if (ending) entries.push(ending);
    }
    const agent = await this.root.agent(context);
    const latestWrite = Object.values(state.runs).filter(run => run.mode === "write").sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
    // Every shared message ran at some access ("approval" when it named none), so the view says which; only a session
    // without one leaves it out, and the owner's chat box then starts on Auto-approve.
    const access = latestWrite && (latestWrite.options?.access ?? "approval");
    const repositories = this.repositoryView();
    const { id, displayName, gitName, gitEmail, githubLogin } = this.binding.owner;
    const { approvals, olderApprovals } = viewApprovals(stored);
    return { sessionId: this.binding.session.id, owner: { id, displayName, gitName, gitEmail, githubLogin }, entries,
      approvals, ...(olderApprovals ? { olderApprovals } : {}), conversations: state.branches.map(branch => ({ ...branch, id: String(branch.id) })),
      busy: Object.values(state.runs).some(holdsQueue)
        || Object.values(state.approvals).some(approval => approval.status === "executing") || repositories?.status === "preparing",
      queue: Object.values(state.runs).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map(run => ({ submissionId: run.key, actorId: run.initiatedBy, mode: run.mode, status: run.stopped ? (run.stopped.pending ? "stopping" : "stopped") : run.inputsLost ? "images lost" : run.status })),
      stoppable: true,
      ...(agent.model ? { agent: { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel } } : {}),
      ...(access ? { access } : {}),
      ...(repositories ? { repositories } : {}),
      activity: repositories ? (repositories.status === "preparing" ? "working" : "failed")
        : sessionActivity(Object.values(state.runs), Object.values(state.approvals),
          activityEntry(snapshots.find(snapshot => snapshot.branch.mode === "write")?.entries.at(-1))),
    };
  }

  private entryView(entry: EntryRecord, branch: number, actorId?: string, autoApproved?: ReturnType<typeof autoApprovedCalls>): SessionView["entries"][number] {
    const messages = entry.model ?? [];
    // Commands auto-approve ran have no card in the view: their calls say so instead.
    const marks = messages.flatMap(message => message.role !== "assistant" ? [] : message.content.flatMap(block => {
      const mark = block.type === "toolCall" ? autoApproved?.get(block.id) : undefined;
      return mark && block.type === "toolCall" ? [{ tool: block.name, ...mark }] : [];
    }));
    const text = messages.flatMap(message => {
      if (typeof message.content === "string") return [message.content];
      // Image data stays on the host; the transcript only notes that the model saw one.
      return (message.content ?? []).flatMap(block => block.type === "text" ? [block.text] : block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : block.type === "image" ? [`[image ${block.mimeType}]`] : []);
    }).join("\n");
    const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
    // Provider error text can carry account or endpoint details; only the HTTP status leaves the host.
    const status = failed?.role === "assistant" ? Number(/^(\d{3})\b/.exec(failed.errorMessage ?? "")?.[1]) : NaN;
    const error = failed?.role === "assistant" ? {
      provider: String(failed.provider).slice(0, 128), modelId: String(failed.model).slice(0, 256), ...(status >= 100 && status <= 599 ? { status } : {}),
    } : undefined;
    // Pi measures the model's response for assistant messages and each tool run for tool results.
    const durations = messages.flatMap(message => (message.role === "assistant" || message.role === "toolResult") && message.durationMs !== undefined ? [message.durationMs] : []);
    const durationMs = durations.length ? durations.reduce((total, value) => total + value, 0) : undefined;
    return { id: `${branch}:${entry.id}`, kind: entry.kind, role: messages[0]?.role ?? "system", text, ...(actorId ? { actorId } : {}), conversationId: String(branch),
      ...(error ? { error } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(marks.length ? { autoApproved: marks } : {}) };
  }

  /** What follows a run's entries: its failed model turn, who stopped it, or that its host's crashes ended it. */
  private endView(run: Run, branch: number): SessionView["entries"][number] | undefined {
    if (run.failure) return this.failureView(run, branch);
    if (run.stopped) return { id: `${branch}:stopped:${run.key}`, kind: "workspace.run-stopped", role: "system", text: "Stopped", actorId: run.stopped.by, conversationId: String(branch) };
    if (run.crashed) return { id: `${branch}:crashed:${run.key}`, kind: "workspace.run-crashed", role: "system", text: CRASHED_TEXT, conversationId: String(branch) };
    return undefined;
  }

  /**
   * A run Pi settled without an answer, shown as a failed model turn after its entries: provider and model, and which
   * fixed compaction failure it was, never Pi's detail.
   */
  private failureView(run: Run, branch: number): SessionView["entries"][number] {
    const { provider, modelId, compaction } = run.failure!;
    return { id: `${branch}:failure:${run.key}`, kind: "workspace.run-failure", role: "assistant", text: "", actorId: run.initiatedBy, conversationId: String(branch),
      error: { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(compaction ? { compaction } : {}) } };
  }

  async restart(): Promise<void> {
    await this.exclusive(async () => { await this.close(); await this.open(); });
  }

  /**
   * The session's idle, checkpointed snapshot. `conversationOnly` keeps just Pi's SQLite and the runner state: no files,
   * no clones, so a restore starts with an empty worktree.
   */
  async backup(ticket: RunnerTicket, { conversationOnly = false }: { conversationOnly?: boolean } = {}): Promise<RunnerBackup> {
    this.assertTicket(ticket);
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, "manage");
      const state = await this.metadata();
      if (Object.values(state.runs).some(holdsQueue)
        || Object.values(state.approvals).some(approval => approval.status === "executing")) throw new RunnerError(409, "Backup requires an idle session including queued work");
      this.requireRepositoriesReady();
      this.requireUnfrozen();
      await this.close();
      try {
        const sqlite = await readFile(this.sqlitePath, "base64");
        if (conversationOnly) {
          return { format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files: [], conversationOnly: true,
            createdAt: new Date().toISOString() };
        }
        const authorize = async () => { await this.authorize(ticket.actorId, "manage"); };
        // A clone session's clones go into the backup as bundles of their local work, not as files: a restore clones them
        // again from their origin.
        // On an unsandboxed host the worktree is kept as files, and a session with a clone in it can't be backed up.
        const sandboxed = this.#clone && this.#egress;
        const { clones, found } = sandboxed ? await isolatedWorkspace(this.sandbox).cloneBackup(authorize) : { clones: [], found: [] };
        const files = sandboxed ? await isolatedWorkspace(this.sandbox).snapshot(authorize, found) : await this.sandbox.snapshot(authorize);
        return { format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files, ...(clones.length ? { clones } : {}),
          createdAt: new Date().toISOString() };
      } finally { await this.open(); }
    });
  }

  /**
   * The session panel's file browser: one worktree path, read-only, as `write` sees it, since a collaborator could already
   * have the agent read any file. Not exclusive with runs: it waits only for the sandbox's own queue, like a file tool.
   */
  async browse(ticket: RunnerTicket, path: string): Promise<SessionFiles> {
    this.assertTicket(ticket);
    await this.authorize(ticket.actorId, "write", ticket.policyVersion);
    const authorize = async () => { await this.authorize(ticket.actorId, "write", ticket.policyVersion); };
    try {
      return { path, ...await this.sandbox.browse(path, authorize) };
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      // Fixed reasons only (the control plane shows a 422's): never a host path or raw sandbox output.
      const message = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}`.toLowerCase() : "";
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR" || /no such file or directory|not a directory/.test(message)) throw new RunnerError(422, "That path is not in the worktree");
      if (/path escapes the worktree/.test(message)) throw new RunnerError(422, "That path leads outside the worktree");
      if (/invalid relative path|absolute paths|path traversal|path component is not a real directory/.test(message)) throw new RunnerError(422, "Invalid worktree path");
      if (/too many entries/.test(message)) throw new RunnerError(422, "That directory has too many entries to list");
      if (code === "EACCES" || code === "ELOOP" || /permission denied|symlinks are not followed|too many levels of symbolic links/.test(message)) throw new RunnerError(422, "That path can't be read");
      throw error;
    }
  }

  async close({ abortPushes = true }: { abortPushes?: boolean } = {}): Promise<void> {
    this.closing = true;
    this.#wholeResults.clear();
    // A long fetch stops at once; a checkout already under way finishes in the sandbox and the next open finds it ready.
    const preparation = this.#repositories;
    if (preparation.status === "preparing") preparation.controller.abort();
    this.#repositories = { status: "ready" };
    this.#preparations++;
    this.#opened = false;
    this.#resumed = false;
    this.#activity?.stop();
    if (abortPushes) {
      // Aborted pushes still settle their approval (interrupted) and report completion before the harness closes.
      for (const push of this.pushes) push.controller.abort();
      await Promise.allSettled([...this.pushes].map(push => push.done));
    }
    this.generation++;
    // Calls still waiting on a card end with the harness; their cards are marked interrupted on reopen.
    this.#approvalWaiters.clear();
    // A Session that already failed on a storage error has closed itself, and closing again only repeats that error.
    // Read the flag first: a close that fails now also marks the session failed, and its error must still surface.
    const failed = this.#failed;
    await this.#egress?.close();
    await this.harness.close(context).catch((error: unknown) => { if (!failed) throw error; });
  }

  /** Credential → push → completion. The credential stays in this frame; results carry only fixed, credential-free text. */
  private async runPush(id: string, operation: GitPushOperation, auth: { actorId: string; capability?: string; admissionId?: string }, recheck: SandboxAuthorize, signal?: AbortSignal): Promise<{ status: "executed" | "failed" | "interrupted"; result: string }> {
    if (!this.#clone || operation.directory === undefined) return { status: "failed", result: "Push failed: a push names a clone's directory. Nothing was pushed." };
    if (!this.#egress) return { status: "failed", result: "Push failed: on a host without the sandbox, push with git in bash. Nothing was pushed." };
    const request: PushCredentialRequest = { sessionId: this.binding.session.id, approvalId: id, actorId: auth.actorId, operation,
      ...(auth.capability !== undefined ? { capability: auth.capability } : {}), ...(auth.admissionId !== undefined ? { admissionId: auth.admissionId } : {}) };
    let credential: PushCredential | HostPushCredential;
    try {
      await recheck();
      credential = this.config.pushCredential ? await this.config.pushCredential(request) : await this.controlPlane<PushCredential | HostPushCredential>("/api/internal/git/push/credential", request);
      if (!credential || typeof credential.credentialId !== "string" || typeof credential.remote !== "string"
        || ("hostCredentials" in credential ? credential.hostCredentials !== true : typeof credential.authorization !== "string"))
        throw new RunnerError(502, "Invalid push credential");
    } catch (error) {
      const reason = error instanceof RunnerError ? `: ${error.message}` : "";
      return { status: "failed", result: `Push credential was refused${reason}. Nothing was pushed.` };
    }
    let pushed: PushResult | undefined;
    let failure: { status: "failed" | "interrupted"; result: string } | undefined;
    try {
      const authorization = "hostCredentials" in credential ? await this.hostAuthorization(credential.remote, signal) : credential.authorization;
      pushed = await performClonePush({ workspace: isolatedWorkspace(this.sandbox), operation, credential: { remote: credential.remote, authorization }, authorize: recheck, signal });
    } catch (error) {
      failure = error instanceof PushError && !signal?.aborted
        ? { status: "failed", result: `Push failed: ${error.message}. Nothing was pushed.` }
        : { status: "interrupted", result: "Push was interrupted; the remote branch may or may not have changed. Inspect it; automatic retry is prohibited." };
    }
    const outcome: PushOutcome = pushed?.outcome ?? (failure?.status === "failed" ? "failed" : "unknown");
    const complete: PushCompleteRequest = { sessionId: this.binding.session.id, approvalId: id, credentialId: credential.credentialId, outcome, ...(pushed ? { tip: pushed.tip } : {}) };
    let completion: PushCompletionResult | undefined;
    let completionFailure = "";
    try {
      completion = this.config.pushComplete ? await this.config.pushComplete(complete) : await this.controlPlane<PushCompletionResult>("/api/internal/git/push/complete", complete);
    } catch (error) {
      completionFailure = error instanceof RunnerError ? `: ${error.message}` : "";
    }
    if (!pushed) return failure!;
    const confirmation = completion ? "" : operation.pullRequest
      ? `\nThe pull request was not opened${completionFailure || "; the control plane did not confirm completion"}.`
      : "\nThe control plane did not confirm completion.";
    return { status: "executed", result: pushSummary(pushed, completion?.pullRequest) + confirmation };
  }

  /** This host's own Git credential for `remote`: only its owner's sessions use it, and only while the owner has it on. */
  private async hostAuthorization(remote: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.hostGitCredential) throw new PushError("This host does not push with its Git credentials; its owner can turn them on in Pistead (Settings → Hosts → the host → Configuration)");
    if (this.binding.session.connectorOwnerId !== this.binding.owner.id) throw new PushError("Only the host's owner can push with its Git credentials");
    try {
      return await this.config.hostGitCredential(remote, signal);
    } catch (error) {
      throw new PushError(error instanceof HostCredentialError ? error.message : "The host's Git credentials could not be read");
    }
  }

  /** Shared-secret internal control-plane call; Worker errors carry fixed, credential-free messages. */
  private async controlPlane<T>(path: string, body: unknown): Promise<T> {
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    const text = await response.text();
    if (text.length > 65536) throw new RunnerError(502, "Control-plane response is too large");
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
    if (!response.ok) {
      const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error.slice(0, 1000) : `HTTP ${response.status}`;
      throw new RunnerError(response.status, message);
    }
    return value as T;
  }
}
