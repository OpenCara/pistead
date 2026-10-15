import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, StringEnum, Type, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, InboxDoc, type AgentChange, type Cursor, type Conversation, type ConversationId, type EntryRecord, type Storage, type SubmissionId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalRecord, AuthorizationRequest, AuthorizationResult, ChatOptions, GitHubIssueView, GitHubMergeRequest, GitHubMergeResult, GitHubReadRequest, GitPushOperation, HostPushCredential, ModelDefinition, Operation, PermissionNeed, PermissionRequest, Permission, PushCompleteRequest, PushCompletionResult, PushCredential, PushCredentialRequest, PushOutcome, RunnerBinding, RunnerTicket, SessionView, SubmitInput, SubmitResult, ThinkingLevel, ToolName } from "../../../packages/shared/src/types.js";
import { accessModes, githubMergeMethods, thinkingLevels } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { repositoryLimits, type SessionRepository } from "../../../packages/shared/src/repositories.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { assertId, requestKey, RunnerError, stableJson, validateOperation, validateRepositories } from "./protocol.js";
import { runnerModels } from "./provider.js";
import { HostWorkspace } from "./host-workspace.js";
import { Sandbox, SandboxProcessError, type SandboxAuthorize } from "./sandbox.js";
import { prepareImage } from "./images.js";
import { performPush, PushError, pushSummary, type PushResult } from "./push.js";
import { HostCredentialError } from "./git-credentials.js";
import type { ResourceConfig } from "./resources.js";
import type { RestoreManifest } from "./restore.js";
import { applyEdits } from "./edits.js";

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
  /** Pi ended the run without an answer or any entry: its model was unavailable, or its context could not be compacted. */
  failure?: { reason: "model_error" | "no_model"; provider?: string; modelId?: string };
};
type Branch = { id: number; mode: "write" | "ask"; actorId?: string };
/** What the session owner allowed for the rest of the session, beyond the agent's tools and each message's access. */
type Grants = { tools: ToolName[]; write: boolean; unboundedShell: boolean };
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, ApprovalRecord>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string }>; usedTickets?: Record<string, number>; nextSequence?: number; grants?: Grants };
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }) });
/** Tools that never change files or run commands: the whole toolset of side asks. */
const readOnlyTools = ["identity", "read_file", "list_files", "git_status"];
/**
 * How long after a message is sent its tool calls can wait on the owner's permission. Deciding needs the message's write
 * admission, which lasts an hour from sending, so a card older than that can't be decided: the call fails instead of
 * holding the session.
 */
const PERMISSION_WAIT_MS = 60 * 60 * 1000;
/** The Worker rejects approval results above 8192 characters; keep the start and the (usually decisive) end. */
function boundedResult(value: string): string {
  if (value.length <= 8000) return value;
  return `${value.slice(0, 2000)}\n… ${value.length - 7500} characters omitted …\n${value.slice(-5500)}`;
}
export type RunnerConfig = {
  dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch;
  connectorId?: string;
  authorize?: (request: AuthorizationRequest) => Promise<AuthorizationResult>;
  githubComment?: (request: { sessionId: string; actorId: string; approvalId: string; capability: string; repository: string; issue: number; body: string }) => Promise<{ id: number; url: string }>;
  /** Reads an issue or pull request as the session owner, through the control plane. */
  githubRead?: (request: GitHubReadRequest) => Promise<GitHubIssueView>;
  /** Performs one human-approved merge; a refusal GitHub stated throws a RunnerError with status 422 and its reason. */
  githubMerge?: (request: GitHubMergeRequest) => Promise<GitHubMergeResult>;
  /** Issues the credential for one approved push; a token is held only in this process's memory. */
  pushCredential?: (request: PushCredentialRequest) => Promise<PushCredential | HostPushCredential>;
  /** Reports a finished push so its credential is revoked and any requested pull request is opened. */
  pushComplete?: (request: PushCompleteRequest) => Promise<PushCompletionResult>;
  /** Reads this host's own Git credential for a push remote as an Authorization header; set only when its owner opted in (connect --git-credentials). */
  hostGitCredential?: (remote: string, signal?: AbortSignal) => Promise<string>;
  /** The host's models; `thinkingLevel` is the level its Pi starts the model at. */
  resolveModels?: (model: ModelDefinition) => Promise<{ models: Models; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }>;
  readBackup?: (restore: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
  readRepository?: (repository: SessionRepository, sessionId: string) => Promise<Uint8Array>;
  resources?: ResourceConfig;
  /** Owner-consented host mode: no isolation, so bash needs only per-command approval. */
  unsandboxed?: boolean;
  /** Opens a session's Pi storage; defaults to the SQLite file in its directory. */
  openStorage?: (path: string) => Promise<Storage>;
};

export class RunnerSession {
  readonly sandbox: Sandbox | HostWorkspace;
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
  /** Tool calls waiting on the owner's decision about a permission request, by request id. */
  #permissionWaiters = new Map<string, PromiseWithResolvers<ApprovalRecord>>();

  constructor(readonly binding: RunnerBinding, readonly directory: string, readonly config: RunnerConfig) {
    if (binding.session.connectorId !== config.connectorId || binding.model.connectorId !== config.connectorId)
      throw new RunnerError(403, "Session connector mismatch");
    this.sqlitePath = join(directory, "session.sqlite");
    this.sandbox = config.unsandboxed
      ? new HostWorkspace(binding, join(directory, "sandbox"))
      : new Sandbox(binding, join(directory, "sandbox"), config.resources);
  }

  private assertTicket(ticket: RunnerTicket): void {
    if (ticket.sessionId !== this.binding.session.id || ticket.ownerId !== this.binding.owner.id || ticket.connectorId !== this.config.connectorId)
      throw new RunnerError(403, "Ticket session, owner, or connector mismatch");
  }

  async authorize(actorId: string, permission: Permission, expectedPolicyVersion?: number): Promise<AuthorizationResult> {
    const body: AuthorizationRequest = { sessionId: this.binding.session.id, ownerId: this.binding.owner.id, actorId, permission };
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

  async prepareRestore(manifest: RestoreManifest): Promise<void> {
    await this.initializeRepositories(true);
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

  private async pullRepository(repository: SessionRepository): Promise<Uint8Array> {
    if (this.config.readRepository) return this.config.readRepository({ ...repository }, this.binding.session.id);
    if (this.config.connectorId) throw new RunnerError(503, "Connected repository download requires its scoped callback");
    const origin = new URL(this.config.controlPlaneUrl);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))))
      throw new RunnerError(503, "Invalid repository control-plane origin");
    const signal = AbortSignal.timeout(30_000);
    const response = await (this.config.fetch ?? fetch)(`${origin.origin}/api/internal/repositories/${assertId(repository.bindingId)}/download`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.binding.session.id, commit: repository.commit }), signal, redirect: "error",
    });
    const checksum = response.headers.get("x-archive-sha256");
    const length = response.headers.get("content-length");
    if (!response.ok || response.headers.get("x-repository-commit") !== repository.commit || !checksum
      || !/^[A-Za-z0-9_-]{43}$/.test(checksum) || Buffer.from(checksum, "base64url").toString("base64url") !== checksum
      || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > repositoryLimits.archiveBytes)) || !response.body) {
      await response.body?.cancel();
      throw new RunnerError(403, "Repository download denied or metadata mismatch");
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > repositoryLimits.archiveBytes) throw new RunnerError(413, "Repository archive exceeds its bound");
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    if (!size || (length !== null && Number(length) !== size)
      || createHash("sha256").update(bytes).digest("base64url") !== checksum) throw new RunnerError(400, "Repository archive checksum or size mismatch");
    return bytes;
  }

  private async initializeRepositories(restoring = false): Promise<void> {
    const repositories = validateRepositories(this.binding.session.repositories);
    const authorize = async () => { await this.authorize(this.binding.owner.id, restoring ? "manage" : "write"); };
    if (repositories.length) await authorize();
    await this.sandbox.initialize();
    if (!repositories.length) return;
    if (await this.sandbox.repositoryCachesReady(repositories, authorize)) return;
    // A restored cache is authoritative: never replace its files with a fresh download.
    if (restoring) throw new RunnerError(409, "Restored repository cache is not ready");
    const archives: Uint8Array[] = [];
    for (const repository of repositories) {
      await authorize();
      const bytes = await this.pullRepository(repository);
      await authorize();
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > repositoryLimits.archiveBytes)
        throw new RunnerError(413, "Repository archive exceeds its bound");
      archives.push(bytes);
    }
    try {
      await this.sandbox.materializeRepositories(repositories, archives, authorize);
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      // Helper reasons are fixed "sandbox: ..." phrases; anything carrying paths or other detail stays local.
      const reason = error instanceof Error ? /sandbox: ([a-z0-9 ,.'()-]{1,160})$/i.exec(error.message.trim())?.[1] : undefined;
      throw new RunnerError(422, `Repository snapshot could not be prepared${reason ? `: ${reason}` : ""}`);
    }
    if (!await this.sandbox.repositoryCachesReady(repositories, authorize)) throw new RunnerError(409, "Repository cache initialization did not complete");
  }

  private agentInstructions(mode: "write" | "ask" | "read"): string {
    let instructions = this.binding.agent.instructions;
    const repositories = this.binding.session.repositories ?? [];
    if (repositories.length) {
      instructions += "\n\nTrusted runtime repository context:\n"
        + "The execution root is the isolated session worktree. File-tool paths are relative to that worktree, not to a repository root.\n"
        + repositories.map(repository => `- Source snapshot: worktree/${repository.path}; file-tool path prefix: ${repository.path}/; pinned commit: ${repository.commit}.`).join("\n")
        + "\nOperate only on isolated session files. These are pinned source snapshots, not full upstream Git histories.";
      if (this.binding.agent.tools.includes("git_push"))
        instructions += "\ngit_push publishes one repository's committed session changes to a branch on its Git provider: commit first with git_commit; "
          + "the session commits that touch that repository path are replayed onto its pinned commit, so the branch contains only your changes. "
          + "Pushes are fast-forward only (never forced); a branch that moved elsewhere is refused. Optionally request a pull request with pull_request {title, body, base?}.";
    }
    if (mode === "ask") instructions += "\n\nThis is a read-only ask. Inspect isolated session files only; do not modify files, execute commands, or perform external effects.";
    if (mode === "read") instructions += "\n\nThis request is read-only. Inspect isolated session files; any change to files, command or other effect waits for the session owner to allow it.";
    return instructions;
  }

  async open(): Promise<void> {
    await this.initializeRepositories();
    const registry = createRegistry();
    this.tools = this.buildTools();
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools });
    registry.install(extension);
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux), provider: this.binding.model.provider, modelId: this.binding.model.modelId };
    this.modelRef = { provider: resolved.provider, modelId: resolved.modelId };
    this.models = resolved.models;
    const models = this.models;
    const storage = await this.openStorage();
    try { this.harness = await Harness.open(storage, { models, registry }, context); }
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
      for (const approval of Object.values(state.approvals)) {
        if (approval.status === "executing") {
          approval.status = "interrupted";
          approval.result = "Execution interrupted; external effect may have occurred. Reconcile manually; never automatically retry.";
        }
        // The tool call waiting on this request ended with the previous process.
        if (approval.status === "pending" && approval.operation.kind === "permission") {
          approval.status = "interrupted";
          approval.result = "The tool call stopped before a decision.";
        }
      }
      doc.json = JSON.stringify(state);
    }, context);
    this.closing = false;
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
        await this.applyOptions(conversation, run);
        submission = await conversation.submit({ type: "input", content: run.content, requestId: run.key }, context);
      } else submission = await this.harness.submission(run.submissionId as SubmissionId, context);
      if (submission) {
        await this.mutate(meta => { const saved = meta.runs[run.key]!; saved.submissionId = submission.id; saved.status = "running"; });
        this.observeRun(run.key, submission.id);
      }
    }
    this.harness.resume();
    this.drainQueue();
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
    await this.root.commit(async tx => {
      const doc = await tx.doc(RunnerState);
      const state = JSON.parse(doc.json) as Metadata;
      change(state);
      doc.json = JSON.stringify(state);
    }, context);
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
      const failure: Run["failure"] = settled.status === "unanswered" && (settled.reason === "model_error" || settled.reason === "no_model")
        ? { reason: settled.reason, ...(await conversation?.agent(context))?.model } : undefined;
      await this.exclusive(async () => {
        if (generation !== this.generation || this.closing) return;
        await this.mutate(meta => {
          meta.runs[key]!.status = "settled";
          if (failure) meta.runs[key]!.failure = failure;
        });
      });
      if (generation === this.generation && !this.closing) this.drainQueue();
    })().catch(() => { /* Recovery reconciles the durable active record; never replay effects here. */ });
  }

  private drainQueue(): void {
    if (this.draining || this.closing) return;
    this.draining = true;
    void this.exclusive(async () => {
      while (!this.closing) {
        const state = await this.metadata();
        if (Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting")
          || Object.values(state.approvals).some(approval => approval.status === "executing")) return;
        const run = Object.values(state.runs).filter(candidate => candidate.status === "queued")
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0];
        if (!run) return;
        try { await this.authorize(run.initiatedBy, run.mode === "ask" ? "ask" : "write"); }
        catch {
          await this.mutate(meta => { meta.runs[run.key]!.status = "interrupted"; });
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
        const submission = await conversation.submit({ type: "input", content: run.content, requestId: run.key }, context);
        await this.mutate(meta => {
          meta.runs[run.key]!.submissionId = submission.id;
          meta.runs[run.key]!.status = "running";
        });
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
    if (Object.keys(value).some(key => !["model", "thinkingLevel", "access"].includes(key))) throw invalid();
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
    return Object.keys(options).length ? options : undefined;
  }

  async submit(ticket: RunnerTicket, input: SubmitInput, mode: "write" | "ask"): Promise<SubmitResult> {
    this.assertTicket(ticket);
    if (typeof input?.content !== "string" || input.content.length > 100_000 || !input.content.trim()
      || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new RunnerError(400, "Invalid submission");
    if ((input.admissionId !== undefined && (mode !== "write" || typeof input.admissionId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.admissionId)))
      || (this.config.connectorId && mode === "write" && input.admissionId === undefined))
      throw new RunnerError(400, "Invalid or missing Worker write admission");
    return this.exclusive(async () => {
      if (this.closing) throw new RunnerError(503, "Session is closing");
      await this.authorize(ticket.actorId, mode === "ask" ? "ask" : "write", ticket.policyVersion);
      const options = await this.chatOptions(input.options, mode, ticket.actorId);
      const key = await requestKey(ticket.actorId, mode, input.requestId);
      const hash = await sha256(input.content);
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
      await this.mutate(meta => {
        meta.runs[key] = run;
        meta.nextSequence = (meta.nextSequence ?? 0) + 1;
        if (!meta.branches.some(branch => branch.id === conversation.id)) meta.branches.push({ id: conversation.id, mode, actorId: ticket.actorId });
      });
      this.drainQueue();
      return { submissionId: key, conversationId: String(conversation.id), status: "queued", queuePosition: Object.values(state.runs).filter(run => ["queued", "running", "admitting"].includes(run.status)).length + 1 };
    });
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
      meta.toolActors[String(api.taskId)] ??= { initiatedBy: run.initiatedBy, ownerId: run.ownerId, runKey: run.key };
      current.json = JSON.stringify(meta);
    }, context);
    return { initiatedBy: run.initiatedBy, actingAs: run.ownerId, mode: run.mode };
  }

  private async recheckTool(attribution: { initiatedBy: string; mode: "write" | "ask" }): Promise<void> {
    await this.authorize(attribution.initiatedBy, attribution.mode === "ask" ? "ask" : "write");
  }

  /** Whether shell commands may run here: within provisioned limits, on an owner-consented unsandboxed host, or as a faux test shell. */
  private shellAllowed(): boolean {
    return !!this.config.resources || this.config.unsandboxed === true || (this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true);
  }

  /** `unbounded`: the host's owner allowed this command to run without the limits this host lacks. */
  private requireShellCapability(operation: Operation, unbounded = false): void {
    if (operation.kind === "bash" && !unbounded && !this.shellAllowed()) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash needs verified resources or explicitly enabled faux test sessions");
    }
  }

  /**
   * Lets a tool call go ahead, first asking the session owner when the session doesn't allow it yet: a tool outside the
   * agent's, a change in a Read-only message, or a shell command on a host without resource limits. The call waits on
   * the owner's card, which allows it once or for the rest of the session, or denies it. `unbounded`: the command runs
   * without limits, which only the host's owner can allow, and only in their own session.
   */
  private async permit(api: ToolExecutionApi, waiting: Context, tool: ToolName, target: string, effect: { write?: boolean; shell?: boolean } = {}): Promise<{ unbounded: boolean }> {
    const state = await this.metadata();
    const actor = state.toolActors[String(api.taskId)];
    const run = actor && state.runs[actor.runKey];
    if (!run) throw new RunnerError(403, "Tool has no authorized writable submission");
    const grants = state.grants;
    const needs: PermissionNeed[] = [];
    if (!this.binding.agent.tools.includes(tool) && !grants?.tools.includes(tool)) needs.push("tool");
    if (effect.write && run.options?.access === "read" && !grants?.write) needs.push("write");
    const unbounded = effect.shell === true && !this.shellAllowed();
    if (unbounded) {
      if (this.binding.session.connectorOwnerId !== this.binding.owner.id) this.requireShellCapability({ kind: "bash", command: target });
      if (!grants?.unboundedShell) needs.push("unbounded-shell");
    }
    if (!needs.length) return { unbounded };
    if (this.config.connectorId && !run.admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
    const deadline = (run.submittedAt ?? Date.now()) + PERMISSION_WAIT_MS;
    if (deadline <= Date.now()) throw new Error("This message is over an hour old, so the session owner can no longer allow this call. Ask them to send a new message.");
    const id = `permission-${api.taskId}`;
    // The target only shows the owner what the call touches; keep it within what the control plane accepts.
    const shown = target.replaceAll("\0", "");
    const operation = validateOperation({ kind: "permission", tool, target: shown.length > 8192 ? `${shown.slice(0, 8191)}…` : shown, needs });
    const request: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: run.initiatedBy, createdAt: new Date().toISOString(), status: "pending", operation,
      ...(run.admissionId !== undefined ? { admissionId: run.admissionId } : {}) };
    await this.mutate(meta => { meta.approvals[id] ??= request; });
    let decided: ApprovalRecord;
    let expiry: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      expiry = setTimeout(() => reject(new Error("The session owner did not answer within an hour of the message.")), deadline - Date.now());
      expiry.unref();
    });
    try { decided = await awaitWithContext(Promise.race([this.permissionDecision(id), expired]), waiting); }
    catch (error) {
      // A stopped run takes its card with it.
      this.#permissionWaiters.delete(id);
      await this.mutate(meta => {
        const pending = meta.approvals[id];
        if (pending?.status === "pending") Object.assign(pending, { status: "interrupted", result: "The tool call stopped before a decision." });
      }).catch(() => {});
      throw error;
    } finally { clearTimeout(expiry); }
    if (decided.status === "denied") throw new Error(`The session owner did not allow ${tool}${target ? ` on ${target}` : ""}.`);
    if (decided.status !== "approved") throw new Error("The permission request ended before the session owner answered.");
    return { unbounded };
  }

  /** Settles when the owner decides permission request `id`, at once if they already have. */
  private async permissionDecision(id: string): Promise<ApprovalRecord> {
    let waiter = this.#permissionWaiters.get(id);
    if (!waiter) this.#permissionWaiters.set(id, waiter = Promise.withResolvers<ApprovalRecord>());
    const current = (await this.metadata()).approvals[id];
    if (current && current.status !== "pending") {
      this.#permissionWaiters.delete(id);
      return current;
    }
    return waiter.promise;
  }

  /** Whether what the owner allowed for the rest of the session covers every need of `request`. */
  private coveredBy(request: PermissionRequest, grants: Grants): boolean {
    return request.needs.every(need => need === "tool" ? this.binding.agent.tools.includes(request.tool) || grants.tools.includes(request.tool)
      : need === "write" ? grants.write : grants.unboundedShell);
  }

  private buildTools(): ToolRegistration[] {
    const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    const approvalText = (approval: ApprovalRecord) => text({ ...approval, admissionId: undefined });
    return [
      defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: Type.Object({}), execute: async (_args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "identity", "");
        return text({ ...await this.sandbox.identity(() => this.recheckTool(attribution)), ...attribution });
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
      defineTool({ name: "git_status", description: "Read local git status without mutation or network.", parameters: Type.Object({}), execute: async (_args, api, call) => {
        const attribution = await this.toolActor(api, false);
        await this.permit(api, call, "git_status", "");
        return text({ ...attribution, status: await this.sandbox.gitStatus(() => this.recheckTool(attribution)) });
      } }),
      defineTool({ name: "git_commit", description: "Commit the session worktree as the owner. Waits for an exact human approval unless the owner enabled auto-approve for this request; the result says which.", parameters: Type.Object({ message: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "git_commit", args.message, { write: true });
        return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "git.commit", message: args.message }, String(api.taskId), { permitted: true }));
      } }),
      defineTool({ name: "bash", description: "Run an exact shell command in the session worktree. Waits for an exact human approval unless the owner enabled auto-approve for this request; then it runs at once and the result carries its output.", parameters: Type.Object({ command: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        const { unbounded } = await this.permit(api, call, "bash", args.command, { write: true, shell: true });
        return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "bash", command: args.command }, String(api.taskId), { permitted: true, unbounded }));
      } }),
      defineTool({ name: "github_read", description: "Read a GitHub issue or pull request of a pinned github.com repository (owner/name) as the session owner, through Pistead: its description and comments and, for a pull request, its merge state, head commit, reviews, review comments and checks. Long threads keep their newest items. The sandbox has no network, so use this instead of gh or curl. Read-only; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), issue: Type.Integer({ minimum: 1 }) }), execute: async (args, api, call) => {
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
      defineTool({ name: "github_comment", description: "Request human approval of an exact GitHub comment through the owner's broker; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), issue: Type.Integer({ minimum: 1 }), body: Type.String() }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "github_comment", `${args.repository}#${args.issue}`, { write: true });
        return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "github.comment", ...args }, String(api.taskId), { permitted: true }));
      } }),
      defineTool({ name: "github_merge", description: "Request human approval to merge a pull request of a pinned github.com repository (owner/name) as the session owner, through the owner's broker: only while its head is still commit sha, as github_read reports it, with method merge, squash or rebase. Always waits for a human decision, even under auto-approve; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), pull: Type.Integer({ minimum: 1 }), sha: Type.String(), method: StringEnum(githubMergeMethods) }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        const repository = this.githubRepository(args.repository);
        if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new RunnerError(400, "sha must be the pull request's full 40-character head commit, as github_read reports it");
        await this.permit(api, call, "github_merge", `${repository}#${args.pull}`, { write: true });
        return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "github.merge", repository, pull: args.pull, sha: args.sha, method: args.method }, String(api.taskId), { permitted: true }));
      } }),
      defineTool({ name: "git_push", description: "Push the committed session changes of one pinned repository (its worktree path) to a branch on its Git provider, fast-forward only, optionally opening a pull request as the owner. Commit first. Waits for an exact human approval unless the owner enabled auto-approve for this request.", parameters: Type.Object({
        repository: Type.String(), branch: Type.String(),
        pull_request: Type.Optional(Type.Object({ title: Type.String(), body: Type.String(), base: Type.Optional(Type.String()) })),
      }), execute: async (args, api, call) => {
        const attribution = await this.toolActor(api, true);
        await this.permit(api, call, "git_push", `${args.repository} → ${args.branch}`, { write: true });
        const commit = await this.sandbox.head(() => this.recheckTool(attribution));
        const request = args.pull_request;
        const operation: GitPushOperation = { kind: "git.push", repository: args.repository, branch: args.branch, commit,
          ...(request ? { pullRequest: { title: request.title, body: request.body, ...(request.base !== undefined ? { base: request.base } : {}) } } : {}) };
        return approvalText(await this.createApproval(attribution.initiatedBy, operation, String(api.taskId), { permitted: true }));
      } }),
    ];
  }

  /** The canonical owner/name of the session's pinned github.com repository `name`, in any case. */
  private githubRepository(name: string): string {
    const pinned = (this.binding.session.repositories ?? []).filter(pin => !("provider" in pin)).map(pin => pin.fullName);
    const match = pinned.find(fullName => fullName.toLowerCase() === name.toLowerCase());
    if (!match) throw new RunnerError(403, pinned.length ? `${name} is not pinned in this session; GitHub reads and merges cover ${pinned.join(", ")}.`
      : "This session pins no github.com repository, so it can't read or merge on GitHub.");
    return match;
  }

  /** The control plane's GitHub broker for runners without a connector, with the shared secret; refusals keep their status and reason. */
  private async internalGitHub(action: "comment" | "read" | "merge", request: object): Promise<unknown> {
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/github/${action}`, {
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
   * `consent.permitted`: a tool call `permit` already let through. `consent.unbounded`: the host's owner allowed this
   * command to run without the resource limits this host lacks.
   */
  async createApproval(actorId: string, input: Operation, toolTaskId?: string, consent: { permitted?: boolean; unbounded?: boolean } = {}): Promise<ApprovalRecord> {
    const operation = validateOperation(input);
    if (operation.kind === "permission") throw new RunnerError(400, "Permission requests come only from tool calls");
    this.requireShellCapability(operation, consent.unbounded);
    const toolName = ({ "git.commit": "git_commit", bash: "bash", "github.comment": "github_comment", "github.merge": "github_merge", "git.push": "git_push" } as const)[operation.kind];
    if (!consent.permitted && !this.binding.agent.tools.includes(toolName) && !(await this.metadata()).grants?.tools.includes(toolName)) {
      throw new RunnerError(403, "Operation not enabled by pinned agent version");
    }
    await this.authorize(actorId, "write");
    let admissionId: string | undefined;
    let automatic = false;
    if (toolTaskId !== undefined) {
      const state = await this.metadata();
      const attribution = state.toolActors[toolTaskId];
      const run = attribution && state.runs[attribution.runKey];
      if (!run || run.initiatedBy !== actorId || run.ownerId !== this.binding.owner.id || run.mode !== "write"
        || !["admitting", "running"].includes(run.status)) throw new RunnerError(403, "Approval has no active originating write");
      admissionId = run.admissionId;
      if (this.config.connectorId && !admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
      // GitHub comments and merges need a Worker-minted broker capability, so they always wait for a human decision;
      // automatic pushes mint their credential from the run's owner admission instead.
      automatic = run.options?.access === "auto" && run.initiatedBy === this.binding.owner.id && operation.kind !== "github.comment"
        && operation.kind !== "github.merge" && (operation.kind !== "git.push" || admissionId !== undefined);
    }
    const id = toolTaskId ? `tool-${toolTaskId}` : randomUUID();
    const approval: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)), createdAt: new Date().toISOString(),
      ...(automatic ? { status: "executing", decidedBy: this.binding.owner.id, automatic: true } : { status: "pending" }),
      ...(consent.unbounded && operation.kind === "bash" ? { unbounded: true } : {}) };
    if (admissionId !== undefined) approval.admissionId = admissionId;
    let created = false;
    await this.mutate(meta => { if (!meta.approvals[id]) { meta.approvals[id] = approval; created = true; } });
    // A replayed tool task finds its record and never repeats the effect; reopening marks interrupted executions.
    if (automatic && created) return this.executeAutomatically(id, actorId);
    return (await this.metadata()).approvals[id]!;
  }

  private async executeAutomatically(id: string, actorId: string): Promise<ApprovalRecord> {
    const approval = (await this.metadata()).approvals[id]!;
    const operation = approval.operation;
    let status: ApprovalRecord["status"];
    let result: string;
    if (operation.kind === "git.push") {
      // Tracked like approved pushes so close() aborts it and awaits its settlement before the harness closes.
      const entry = { controller: new AbortController(), done: Promise.resolve() };
      const settled = (async () => {
        const outcome = await this.runPush(id, operation, { actorId, admissionId: approval.admissionId }, async () => { await this.authorize(actorId, "write"); }, entry.controller.signal);
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: boundedResult(outcome.result) }); });
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
        await this.authorize(actorId, "write");
      }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded: approval.unbounded === true });
      status = "executed";
    } catch (error) {
      // A non-zero exit is a definite outcome the agent can act on; anything else may have had partial effects.
      if (error instanceof SandboxProcessError) { status = "failed"; result = `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`; }
      else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
    }
    await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: boundedResult(result) }); });
    return (await this.metadata()).approvals[id]!;
  }

  /** `scope` applies to permission requests: allow the one call (default), or the same need for the rest of the session. */
  async decide(ticket: RunnerTicket, id: string, input: { decision: "approve" | "deny"; operation: Operation; brokerCapability?: string; scope?: "call" | "session" }): Promise<ApprovalRecord> {
    this.assertTicket(ticket);
    if (input.decision !== "approve" && input.decision !== "deny") throw new RunnerError(400, "Invalid approval decision");
    if (input.scope !== undefined && input.scope !== "call" && input.scope !== "session") throw new RunnerError(400, "Invalid approval scope");
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, "approve", ticket.policyVersion);
      const state = await this.metadata();
      const approval = state.approvals[id];
      if (!approval) throw new RunnerError(404, "Approval not found");
      if (stableJson(validateOperation(input.operation)) !== stableJson(approval.operation)) throw new RunnerError(409, "Approval operation mismatch");
      if (approval.status !== "pending") throw new RunnerError(409, "Approval has already been decided; unsafe effects are never retried");
      // A tool call is waiting on this request inside a running turn, so it is decided at once rather than after the queue.
      if (approval.operation.kind === "permission") {
        const request = approval.operation;
        if (ticket.actorId !== this.binding.owner.id) throw new RunnerError(403, "Only the session owner can allow more than the session allows");
        if (request.needs.includes("unbounded-shell") && this.binding.session.connectorOwnerId !== this.binding.owner.id) {
          throw new RunnerError(403, "Only the host's owner can allow a shell without resource limits");
        }
        const scope = input.scope ?? "call";
        let settled: string[] = [];
        await this.mutate(meta => {
          settled = [id];
          Object.assign(meta.approvals[id]!, input.decision === "approve" ? { status: "approved", decidedBy: ticket.actorId, scope } : { status: "denied", decidedBy: ticket.actorId });
          if (input.decision !== "approve" || scope !== "session") return;
          const grants = meta.grants ??= { tools: [], write: false, unboundedShell: false };
          if (request.needs.includes("tool") && !grants.tools.includes(request.tool)) grants.tools.push(request.tool);
          if (request.needs.includes("write")) grants.write = true;
          if (request.needs.includes("unbounded-shell")) grants.unboundedShell = true;
          // Parallel calls of the same round that wait on what the session now allows go ahead too.
          for (const other of Object.values(meta.approvals)) {
            if (other.id === id || other.status !== "pending" || other.operation.kind !== "permission" || !this.coveredBy(other.operation, grants)) continue;
            Object.assign(other, { status: "approved", decidedBy: ticket.actorId, scope });
            settled.push(other.id);
          }
        });
        const approvals = (await this.metadata()).approvals;
        for (const decided of settled) {
          this.#permissionWaiters.get(decided)?.resolve(approvals[decided]!);
          this.#permissionWaiters.delete(decided);
        }
        return approvals[id]!;
      }
      if (input.decision === "deny") {
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "denied", decidedBy: ticket.actorId }); });
        return (await this.metadata()).approvals[id]!;
      }
      this.requireShellCapability(approval.operation, approval.unbounded === true);
      await this.authorize(approval.requestedBy, "write");
      if (Object.values(state.runs).some(run => ["queued", "running", "admitting"].includes(run.status))) throw new RunnerError(409, "Wait for the session queue to finish before approval execution");
      if (["github.comment", "github.merge", "git.push"].includes(approval.operation.kind) && !input.brokerCapability) throw new RunnerError(403, "Missing owner-bound single-use broker capability");
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executing", decidedBy: ticket.actorId }); });
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
          await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: outcome.status, result: boundedResult(outcome.result) }); });
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
        if (approval.operation.kind === "github.comment") {
          const { repository, issue, body } = approval.operation;
          const request = { sessionId: this.binding.session.id, actorId: ticket.actorId, approvalId: id, capability: input.brokerCapability!, repository, issue, body };
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          const comment = this.config.githubComment ? await this.config.githubComment(request) : await this.internalGitHub("comment", request) as { id: number; url: string };
          result = JSON.stringify({ id: comment.id, url: comment.url });
        } else if (approval.operation.kind === "github.merge") {
          const { repository, pull, sha, method } = approval.operation;
          const request: GitHubMergeRequest = { sessionId: this.binding.session.id, actorId: ticket.actorId, approvalId: id, capability: input.brokerCapability!, repository, pull, sha, method };
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          const merged = this.config.githubMerge ? await this.config.githubMerge(request) : await this.internalGitHub("merge", request) as GitHubMergeResult;
          result = JSON.stringify({ merged: true, sha: merged.sha, url: merged.url });
        } else result = await this.sandbox.execute(approval.operation, false, async () => {
          this.requireShellCapability(approval.operation, approval.unbounded === true);
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
        }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true, unbounded: approval.unbounded === true });
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result: boundedResult(result) }); });
      } catch (error) {
        // GitHub said why it didn't merge: nothing changed, so the agent can act on the reason.
        const outcome = error instanceof RunnerError && error.status === 422 && approval.operation.kind === "github.merge"
          ? { status: "failed" as const, result: boundedResult(error.message) }
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
    const entries: SessionView["entries"] = [];
    for (const snapshot of snapshots) {
      let previous: Run | undefined;
      for (const entry of snapshot.entries) {
        const run = Object.values(state.runs).filter(candidate => (candidate.started || candidate.submissionId !== undefined || candidate.status === "admitting") && candidate.conversationId === entry.conversationId && candidate.startEntry < entry.id).sort((a, b) => b.startEntry - a.startEntry)[0];
        if (previous?.failure && run !== previous) entries.push(this.failureView(previous, snapshot.branch.id));
        previous = run;
        entries.push(this.entryView(entry, snapshot.branch.id, run?.initiatedBy));
      }
      if (previous?.failure) entries.push(this.failureView(previous, snapshot.branch.id));
    }
    const agent = await this.root.agent(context);
    const latestWrite = Object.values(state.runs).filter(run => run.mode === "write").sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
    const access = latestWrite?.options?.access;
    const { id, displayName, gitName, gitEmail, githubLogin } = this.binding.owner;
    return { sessionId: this.binding.session.id, owner: { id, displayName, gitName, gitEmail, githubLogin }, entries,
      approvals: Object.values(state.approvals), conversations: state.branches.map(branch => ({ ...branch, id: String(branch.id) })),
      busy: Object.values(state.runs).some(run => ["queued", "running", "admitting"].includes(run.status)) || Object.values(state.approvals).some(approval => approval.status === "executing"),
      queue: Object.values(state.runs).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map(run => ({ submissionId: run.key, actorId: run.initiatedBy, mode: run.mode, status: run.status })),
      ...(agent.model ? { agent: { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel } } : {}),
      ...(access && access !== "approval" ? { access } : {}),
    };
  }

  private entryView(entry: EntryRecord, branch: number, actorId?: string): SessionView["entries"][number] {
    const messages = entry.model ?? [];
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
      ...(error ? { error } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
  }

  /** A run Pi settled without an answer, shown as a failed model turn after its entries: provider and model, never Pi's detail. */
  private failureView(run: Run, branch: number): SessionView["entries"][number] {
    const { provider, modelId } = run.failure!;
    return { id: `${branch}:failure:${run.key}`, kind: "workspace.run-failure", role: "assistant", text: "", actorId: run.initiatedBy, conversationId: String(branch),
      error: { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}) } };
  }

  async restart(): Promise<void> {
    await this.exclusive(async () => { await this.close(); await this.open(); });
  }

  async backup(ticket: RunnerTicket) {
    this.assertTicket(ticket);
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, "manage");
      const state = await this.metadata();
      if (Object.values(state.runs).some(run => ["queued", "running", "admitting"].includes(run.status)) || Object.values(state.approvals).some(approval => approval.status === "executing")) throw new RunnerError(409, "Backup requires an idle session including queued work");
      await this.close();
      try {
        const sqlite = await readFile(this.sqlitePath, "base64");
        const files = await this.sandbox.snapshot(async () => { await this.authorize(ticket.actorId, "manage"); });
        return { format: "pi-runner-backup-v1", binding: this.binding, manifest: state, sqlite, files, createdAt: new Date().toISOString() };
      } finally { await this.open(); }
    });
  }

  async close({ abortPushes = true }: { abortPushes?: boolean } = {}): Promise<void> {
    this.closing = true;
    if (abortPushes) {
      // Aborted pushes still settle their approval (interrupted) and report completion before the harness closes.
      for (const push of this.pushes) push.controller.abort();
      await Promise.allSettled([...this.pushes].map(push => push.done));
    }
    this.generation++;
    // Calls still waiting on a permission end with the harness; their requests are marked interrupted on reopen.
    this.#permissionWaiters.clear();
    // A Session that already failed on a storage error has closed itself, and closing again only repeats that error.
    // Read the flag first: a close that fails now also marks the session failed, and its error must still surface.
    const failed = this.#failed;
    await this.harness.close(context).catch((error: unknown) => { if (!failed) throw error; });
  }

  /** Credential → push → completion. The credential stays in this frame; results carry only fixed, credential-free text. */
  private async runPush(id: string, operation: GitPushOperation, auth: { actorId: string; capability?: string; admissionId?: string }, recheck: SandboxAuthorize, signal?: AbortSignal): Promise<{ status: "executed" | "failed" | "interrupted"; result: string }> {
    const repository = validateRepositories(this.binding.session.repositories).find(pin => pin.path === operation.repository);
    if (!repository) return { status: "failed", result: "Push failed: the repository is not pinned in this session. Nothing was pushed." };
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
      pushed = await performPush({ workspace: this.sandbox, operation, repository, credential: { remote: credential.remote, authorization }, authorize: recheck, signal });
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

  /** This host's own Git credential for `remote`: only its owner's sessions use it, and only after the owner opted in on the host. */
  private async hostAuthorization(remote: string, signal?: AbortSignal): Promise<string> {
    if (!this.config.hostGitCredential) throw new PushError("This host does not push with its Git credentials; its owner can restart the connector with --git-credentials");
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
