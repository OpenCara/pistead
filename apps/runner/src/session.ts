import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, Type, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, InboxDoc, type AgentChange, type Cursor, type Conversation, type ConversationId, type EntryRecord, type SubmissionId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalRecord, AuthorizationRequest, AuthorizationResult, ChatOptions, ModelDefinition, Operation, Permission, RunnerBinding, RunnerTicket, SessionView, SubmitInput, SubmitResult } from "../../../packages/shared/src/types.js";
import { accessModes, thinkingLevels } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { repositoryLimits, type SessionRepository } from "../../../packages/shared/src/repositories.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { assertId, requestKey, RunnerError, stableJson, validateOperation, validateRepositories } from "./protocol.js";
import { runnerModels } from "./provider.js";
import { HostWorkspace } from "./host-workspace.js";
import { Sandbox, SandboxProcessError } from "./sandbox.js";
import type { ResourceConfig } from "./resources.js";
import type { RestoreManifest } from "./restore.js";

type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "queued" | "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
  sequence?: number;
  started?: boolean;
  admissionId?: string;
  /** Worker-signed per-message choices, applied to the conversation when the run starts. */
  options?: ChatOptions;
};
type Branch = { id: number; mode: "write" | "ask"; actorId?: string };
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, ApprovalRecord>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string }>; usedTickets?: Record<string, number>; nextSequence?: number };
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }) });
/** Tools that never change files or run commands; the whole toolset of read-only access and side asks. */
const readOnlyTools = ["identity", "read_file", "list_files", "git_status"];
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
  resolveModels?: (model: ModelDefinition) => Promise<{ models: Models; provider: string; modelId: string }>;
  readBackup?: (restore: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
  readRepository?: (repository: SessionRepository, sessionId: string) => Promise<Uint8Array>;
  resources?: ResourceConfig;
  /** Owner-consented host mode: no isolation, so bash needs only per-command approval. */
  unsandboxed?: boolean;
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
    const storage = await openNodeSqliteStorage(this.sqlitePath);
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
    }
    if (mode === "ask") instructions += "\n\nThis is a read-only ask. Inspect isolated session files only; do not modify files, execute commands, or perform external effects.";
    if (mode === "read") instructions += "\n\nThis request is read-only. Inspect isolated session files only; do not modify files, execute commands, or perform external effects.";
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
    const storage = await openNodeSqliteStorage(this.sqlitePath);
    try { this.harness = await Harness.open(storage, { models, registry }, context); }
    catch (error) { await storage.close(context); throw error; }
    this.root = await this.harness.root(context, { agent: {
      model: this.modelRef, extensions: [extension],
      tools: this.tools.filter(tool => this.binding.agent.tools.includes(tool.name as never)), instructions: this.agentInstructions("write"),
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
      await submission.wait(context);
      // Placement is not completion: serialize through the last model/tool task.
      if (generation !== this.generation || this.closing) return;
      const state = await this.metadata();
      const conversation = await harness.conversation(state.runs[key]!.conversationId as ConversationId, context);
      await conversation?.waitForIdle(context);
      await this.exclusive(async () => {
        if (generation !== this.generation || this.closing) return;
        await this.mutate(meta => { meta.runs[key]!.status = "settled"; });
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
      // Every shared run states its toolset, so a read-only request never leaks into the next one.
      ...(run.mode === "write" ? {
        tools: this.tools.filter(tool => this.binding.agent.tools.includes(tool.name as never) && (access !== "read" || readOnlyTools.includes(tool.name))),
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
      const run: Run = { key, initiatedBy: ticket.actorId, ownerId: this.binding.owner.id, mode, conversationId: conversation.id, content: input.content, contentHash: hash, status: "queued", startEntry: transcript.entries.at(-1)?.id ?? 0, sequence: state.nextSequence ?? 0 };
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
    if (!run || !["admitting", "running"].includes(run.status) || run.ownerId !== this.binding.owner.id || (write && (run.mode !== "write" || run.options?.access === "read"))) throw new RunnerError(403, "Tool has no authorized writable submission");
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

  private requireShellCapability(operation: Operation): void {
    if (operation.kind === "bash" && !this.config.resources && !this.config.unsandboxed && !(this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true)) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash needs verified resources or explicitly enabled faux test sessions");
    }
  }

  private buildTools(): ToolRegistration[] {
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
    const approvalText = (approval: ApprovalRecord) => text({ ...approval, admissionId: undefined });
    return [
      defineTool({ name: "identity", description: "Return immutable session owner identity and sanitized session environment, not collaborator credentials.", parameters: Type.Object({}), execute: async (_args, api) => {
        const attribution = await this.toolActor(api, false); return text({ ...await this.sandbox.identity(() => this.recheckTool(attribution)), ...attribution });
      } }),
      defineTool({ name: "read_file", description: "Read a confined worktree file.", parameters: Type.Object({ path: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, false); return text({ ...attribution, content: await this.sandbox.readFile(args.path, () => this.recheckTool(attribution)) });
      } }),
      defineTool({ name: "list_files", description: "List confined worktree files.", parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, false); return text({ ...attribution, files: await this.sandbox.listFiles(args.path, () => this.recheckTool(attribution)) });
      } }),
      defineTool({ name: "write_file", description: "Write a confined worktree file. Unavailable in read-only asks.", parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); await this.sandbox.writeFile(args.path, args.content, () => this.recheckTool(attribution)); return text({ ...attribution, written: args.path });
      } }),
      defineTool({ name: "git_status", description: "Read local git status without mutation or network.", parameters: Type.Object({}), execute: async (_args, api) => {
        const attribution = await this.toolActor(api, false); return text({ ...attribution, status: await this.sandbox.gitStatus(() => this.recheckTool(attribution)) });
      } }),
      defineTool({ name: "git_commit", description: "Commit the session worktree as the owner. Waits for an exact human approval unless the owner enabled auto-approve for this request; the result says which.", parameters: Type.Object({ message: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "git.commit", message: args.message }, String(api.taskId)));
      } }),
      defineTool({ name: "bash", description: "Run an exact shell command in the session worktree. Waits for an exact human approval unless the owner enabled auto-approve for this request; then it runs at once and the result carries its output.", parameters: Type.Object({ command: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "bash", command: args.command }, String(api.taskId)));
      } }),
      defineTool({ name: "github_comment", description: "Request human approval of an exact GitHub comment through the owner's broker; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), issue: Type.Integer({ minimum: 1 }), body: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "github.comment", ...args }, String(api.taskId)));
      } }),
    ];
  }

  async createApproval(actorId: string, input: Operation, toolTaskId?: string): Promise<ApprovalRecord> {
    const operation = validateOperation(input);
    this.requireShellCapability(operation);
    const toolName = { "git.commit": "git_commit", bash: "bash", "github.comment": "github_comment" }[operation.kind];
    if (!this.binding.agent.tools.includes(toolName as never)) throw new RunnerError(403, "Operation not enabled by pinned agent version");
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
      // GitHub comments need a Worker-minted broker capability, so they always wait for a human decision.
      automatic = run.options?.access === "auto" && run.initiatedBy === this.binding.owner.id && operation.kind !== "github.comment";
    }
    const id = toolTaskId ? `tool-${toolTaskId}` : randomUUID();
    const approval: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)), createdAt: new Date().toISOString(),
      ...(automatic ? { status: "executing", decidedBy: this.binding.owner.id, automatic: true } : { status: "pending" }) };
    if (admissionId !== undefined) approval.admissionId = admissionId;
    let created = false;
    await this.mutate(meta => { if (!meta.approvals[id]) { meta.approvals[id] = approval; created = true; } });
    // A replayed tool task finds its record and never repeats the effect; reopening marks interrupted executions.
    if (automatic && created) return this.executeAutomatically(id, actorId);
    return (await this.metadata()).approvals[id]!;
  }

  private async executeAutomatically(id: string, actorId: string): Promise<ApprovalRecord> {
    const operation = (await this.metadata()).approvals[id]!.operation;
    let status: ApprovalRecord["status"];
    let result: string;
    try {
      result = await this.sandbox.execute(operation, false, async () => {
        this.requireShellCapability(operation);
        await this.authorize(actorId, "write");
      }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true });
      status = "executed";
    } catch (error) {
      // A non-zero exit is a definite outcome the agent can act on; anything else may have had partial effects.
      if (error instanceof SandboxProcessError) { status = "failed"; result = `${error.message}${error.stdout ? `\n${error.stdout}` : ""}`; }
      else { status = "interrupted"; result = "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited."; }
    }
    await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status, result: boundedResult(result) }); });
    return (await this.metadata()).approvals[id]!;
  }

  async decide(ticket: RunnerTicket, id: string, input: { decision: "approve" | "deny"; operation: Operation; brokerCapability?: string }): Promise<ApprovalRecord> {
    this.assertTicket(ticket);
    if (input.decision !== "approve" && input.decision !== "deny") throw new RunnerError(400, "Invalid approval decision");
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, "approve", ticket.policyVersion);
      const state = await this.metadata();
      const approval = state.approvals[id];
      if (!approval) throw new RunnerError(404, "Approval not found");
      if (stableJson(validateOperation(input.operation)) !== stableJson(approval.operation)) throw new RunnerError(409, "Approval operation mismatch");
      if (approval.status !== "pending") throw new RunnerError(409, "Approval has already been decided; unsafe effects are never retried");
      if (input.decision === "deny") {
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "denied", decidedBy: ticket.actorId }); });
        return (await this.metadata()).approvals[id]!;
      }
      this.requireShellCapability(approval.operation);
      await this.authorize(approval.requestedBy, "write");
      if (Object.values(state.runs).some(run => ["queued", "running", "admitting"].includes(run.status))) throw new RunnerError(409, "Wait for the session queue to finish before approval execution");
      if (approval.operation.kind === "github.comment" && !input.brokerCapability) throw new RunnerError(403, "Missing owner-bound single-use broker capability");
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executing", decidedBy: ticket.actorId }); });
      try {
        let result: string;
        if (approval.operation.kind === "github.comment") {
          const { repository, issue, body } = approval.operation;
          const request = { sessionId: this.binding.session.id, actorId: ticket.actorId, approvalId: id, capability: input.brokerCapability!, repository, issue, body };
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
          let responseBody: { id: number; url: string };
          if (this.config.githubComment) responseBody = await this.config.githubComment(request);
          else {
            const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/github/comment`, {
              method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
              body: JSON.stringify(request), signal: AbortSignal.timeout(30_000), redirect: "error",
            });
            if (!response.ok) throw new Error("Broker returned an error; external state must be reconciled");
            responseBody = await response.json() as { id: number; url: string };
          }
          result = JSON.stringify({ id: responseBody.id, url: responseBody.url });
        } else result = await this.sandbox.execute(approval.operation, false, async () => {
          this.requireShellCapability(approval.operation);
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
        }, { allowTestShell: this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true });
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result: boundedResult(result) }); });
      } catch {
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "interrupted", result: "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited." }); });
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
      for (const entry of snapshot.entries) {
        const run = Object.values(state.runs).filter(candidate => (candidate.started || candidate.submissionId !== undefined || candidate.status === "admitting") && candidate.conversationId === entry.conversationId && candidate.startEntry < entry.id).sort((a, b) => b.startEntry - a.startEntry)[0];
        entries.push(this.entryView(entry, snapshot.branch.id, run?.initiatedBy));
      }
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
      return (message.content ?? []).flatMap(block => block.type === "text" ? [block.text] : block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : []);
    }).join("\n");
    const failed = messages.find(message => message.role === "assistant" && message.stopReason === "error");
    // Provider error text can carry account or endpoint details; only the HTTP status leaves the host.
    const status = failed?.role === "assistant" ? Number(/^(\d{3})\b/.exec(failed.errorMessage ?? "")?.[1]) : NaN;
    const error = failed?.role === "assistant" ? {
      provider: String(failed.provider).slice(0, 128), modelId: String(failed.model).slice(0, 256), ...(status >= 100 && status <= 599 ? { status } : {}),
    } : undefined;
    return { id: `${branch}:${entry.id}`, kind: entry.kind, role: messages[0]?.role ?? "system", text, ...(actorId ? { actorId } : {}), conversationId: String(branch), ...(error ? { error } : {}) };
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

  async close(): Promise<void> {
    this.closing = true;
    this.generation++;
    await this.harness.close(context);
  }
}
