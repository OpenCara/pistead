import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, InboxDoc, type Cursor, type Conversation, type ConversationId, type EntryRecord, type SubmissionId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalRecord, AuthorizationRequest, AuthorizationResult, ModelDefinition, Operation, Permission, RunnerBinding, RunnerTicket, SessionView, SubmitInput, SubmitResult } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { requestKey, RunnerError, stableJson, validateOperation } from "./protocol.js";
import { runnerModels } from "./provider.js";
import { Sandbox } from "./sandbox.js";
import type { ResourceConfig } from "./resources.js";
import type { RestoreManifest } from "./restore.js";

type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "queued" | "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
  sequence?: number;
  started?: boolean;
  admissionId?: string;
};
type Branch = { id: number; mode: "write" | "ask"; actorId?: string };
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, ApprovalRecord>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string }>; usedTickets?: Record<string, number>; nextSequence?: number };
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }) });
export type RunnerConfig = {
  dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch;
  connectorId?: string;
  authorize?: (request: AuthorizationRequest) => Promise<AuthorizationResult>;
  githubComment?: (request: { sessionId: string; actorId: string; approvalId: string; capability: string; repository: string; issue: number; body: string }) => Promise<{ id: number; url: string }>;
  resolveModels?: (model: ModelDefinition) => Promise<{ models: Models; provider: string; modelId: string }>;
  readBackup?: (restore: RestoreDescriptor, targetSessionId: string) => Promise<Uint8Array>;
  resources?: ResourceConfig;
};

export class RunnerSession {
  readonly sandbox: Sandbox;
  readonly sqlitePath: string;
  private harness!: Harness;
  private root!: Conversation;
  private tools: ToolRegistration[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  private draining = false;
  private modelRef!: { provider: string; modelId: string };

  constructor(readonly binding: RunnerBinding, readonly directory: string, readonly config: RunnerConfig) {
    if (binding.session.connectorId !== config.connectorId || binding.model.connectorId !== config.connectorId)
      throw new RunnerError(403, "Session connector mismatch");
    this.sqlitePath = join(directory, "session.sqlite");
    this.sandbox = new Sandbox(binding, join(directory, "sandbox"), config.resources);
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

  async open(): Promise<void> {
    await this.sandbox.initialize();
    const registry = createRegistry();
    this.tools = this.buildTools();
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools });
    registry.install(extension);
    const resolved = this.config.resolveModels ? await this.config.resolveModels(this.binding.model)
      : { models: runnerModels(this.binding.model, this.config.allowFaux), provider: this.binding.model.provider, modelId: this.binding.model.modelId };
    this.modelRef = { provider: resolved.provider, modelId: resolved.modelId };
    const models = resolved.models;
    const storage = await openNodeSqliteStorage(this.sqlitePath);
    try { this.harness = await Harness.open(storage, { models, registry }, context); }
    catch (error) { await storage.close(context); throw error; }
    this.root = await this.harness.root(context, { agent: {
      model: this.modelRef, extensions: [extension],
      tools: this.tools.filter(tool => this.binding.agent.tools.includes(tool.name as never)), instructions: this.binding.agent.instructions,
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
      const submission = run.submissionId === undefined
        ? await conversation.submit({ type: "input", content: run.content, requestId: run.key }, context)
        : await this.harness.submission(run.submissionId as SubmissionId, context);
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
      const key = await requestKey(ticket.actorId, mode, input.requestId);
      const hash = await sha256(input.content);
      const state = await this.metadata();
      const existing = state.runs[key];
      if (existing) {
        if (existing.contentHash !== hash) throw new RunnerError(409, "requestId reused with different content");
        if (existing.admissionId !== input.admissionId) throw new RunnerError(409, "requestId reused with a different Worker admission");
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
        const options = { ownership: { kind: "ownerless" as const }, agent: { model: this.modelRef, tools: this.tools.filter(tool => ["identity", "read_file", "list_files", "git_status"].includes(tool.name) && this.binding.agent.tools.includes(tool.name as never)) } };
        conversation = head ? await this.root.fork(head.id, options, context) : await this.harness.createConversation({ ...options, agent: { ...options.agent, instructions: this.binding.agent.instructions } }, context);
      }
      const transcript = await conversation.context(context);
      const run: Run = { key, initiatedBy: ticket.actorId, ownerId: this.binding.owner.id, mode, conversationId: conversation.id, content: input.content, contentHash: hash, status: "queued", startEntry: transcript.entries.at(-1)?.id ?? 0, sequence: state.nextSequence ?? 0 };
      if (input.admissionId !== undefined) run.admissionId = input.admissionId;
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

  private requireShellCapability(operation: Operation): void {
    if (operation.kind === "bash" && !this.config.resources && !(this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true)) {
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
      defineTool({ name: "git_commit", description: "Request human approval of an exact owner-attributed local commit; never executes automatically.", parameters: Type.Object({ message: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); return approvalText(await this.createApproval(attribution.initiatedBy, { kind: "git.commit", message: args.message }, String(api.taskId)));
      } }),
      defineTool({ name: "bash", description: "Request human approval of an exact sandboxed shell command, network disabled.", parameters: Type.Object({ command: Type.String() }), execute: async (args, api) => {
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
    if (toolTaskId !== undefined) {
      const state = await this.metadata();
      const attribution = state.toolActors[toolTaskId];
      const run = attribution && state.runs[attribution.runKey];
      if (!run || run.initiatedBy !== actorId || run.ownerId !== this.binding.owner.id || run.mode !== "write"
        || !["admitting", "running"].includes(run.status)) throw new RunnerError(403, "Approval has no active originating write");
      admissionId = run.admissionId;
      if (this.config.connectorId && !admissionId) throw new RunnerError(403, "Approval lacks Worker write admission");
    }
    const id = toolTaskId ? `tool-${toolTaskId}` : randomUUID();
    const approval: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)), status: "pending", createdAt: new Date().toISOString() };
    if (admissionId !== undefined) approval.admissionId = admissionId;
    await this.mutate(meta => { meta.approvals[id] ??= approval; });
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
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result }); });
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
    const { id, displayName, gitName, gitEmail, githubLogin } = this.binding.owner;
    return { sessionId: this.binding.session.id, owner: { id, displayName, gitName, gitEmail, githubLogin }, entries,
      approvals: Object.values(state.approvals), conversations: state.branches.map(branch => ({ ...branch, id: String(branch.id) })),
      busy: Object.values(state.runs).some(run => ["queued", "running", "admitting"].includes(run.status)) || Object.values(state.approvals).some(approval => approval.status === "executing"),
      queue: Object.values(state.runs).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map(run => ({ submissionId: run.key, actorId: run.initiatedBy, mode: run.mode, status: run.status })),
    };
  }

  private entryView(entry: EntryRecord, branch: number, actorId?: string): SessionView["entries"][number] {
    const messages = entry.model ?? [];
    const text = messages.flatMap(message => {
      if (typeof message.content === "string") return [message.content];
      return (message.content ?? []).flatMap(block => block.type === "text" ? [block.text] : block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : []);
    }).join("\n");
    return { id: `${branch}:${entry.id}`, kind: entry.kind, role: messages[0]?.role ?? "system", text, ...(actorId ? { actorId } : {}), conversationId: String(branch) };
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
