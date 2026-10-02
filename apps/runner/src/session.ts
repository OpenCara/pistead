import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, type Conversation, type ConversationId, type EntryRecord, type SubmissionId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalRecord, AuthorizationRequest, AuthorizationResult, Operation, Permission, RunnerBinding, RunnerTicket, SessionView, SubmitInput, SubmitResult } from "../../../packages/shared/src/types.js";
import { sha256 } from "../../../packages/shared/src/crypto.js";
import { requestKey, RunnerError, stableJson, validateOperation } from "./protocol.js";
import { runnerModels } from "./provider.js";
import { Sandbox } from "./sandbox.js";

type Run = {
  key: string; initiatedBy: string; ownerId: string; mode: "write" | "ask";
  conversationId: number; content: string; contentHash: string; submissionId?: number;
  status: "admitting" | "running" | "settled" | "interrupted"; startEntry: number;
};
type Branch = { id: number; mode: "write" | "ask"; actorId?: string };
type Metadata = { binding: RunnerBinding; branches: Branch[]; runs: Record<string, Run>; approvals: Record<string, ApprovalRecord>; toolActors: Record<string, { initiatedBy: string; ownerId: string; runKey: string }>; usedTickets?: Record<string, number> };
const RunnerState = defineDoc<{ json: string }>({ kind: "workspace.runner", version: 1, scope: "session", initial: () => ({ json: "" }) });
export type RunnerConfig = { dataDir: string; controlPlaneUrl: string; sharedSecret: string; allowFaux: boolean; allowTestShell?: boolean; fetch?: typeof fetch };

export class RunnerSession {
  readonly sandbox: Sandbox;
  readonly sqlitePath: string;
  private harness!: Harness;
  private root!: Conversation;
  private tools: ToolRegistration[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;

  constructor(readonly binding: RunnerBinding, readonly directory: string, readonly config: RunnerConfig) {
    this.sqlitePath = join(directory, "session.sqlite");
    this.sandbox = new Sandbox(binding, join(directory, "sandbox"));
  }

  async authorize(actorId: string, permission: Permission, expectedPolicyVersion?: number): Promise<AuthorizationResult> {
    const body: AuthorizationRequest = { sessionId: this.binding.session.id, ownerId: this.binding.owner.id, actorId, permission };
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/authorize`, {
        method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500), redirect: "error",
      });
    } catch { throw new RunnerError(503, "Authorization authority unavailable"); }
    if (!response.ok) throw new RunnerError(403, "Authorization denied");
    const result = await response.json() as AuthorizationResult;
    if (!result.allowed || result.ownerId !== this.binding.owner.id || !Number.isSafeInteger(result.policyVersion)
      || (expectedPolicyVersion !== undefined && result.policyVersion !== expectedPolicyVersion)) throw new RunnerError(403, "Authorization revoked or stale policy");
    return result;
  }

  async open(): Promise<void> {
    await this.sandbox.initialize();
    const registry = createRegistry();
    this.tools = this.buildTools();
    const extension = defineExtension({ name: "workspace-tools", tools: this.tools });
    registry.install(extension);
    const models = runnerModels(this.binding.model, this.config.allowFaux);
    const storage = await openNodeSqliteStorage(this.sqlitePath);
    try { this.harness = await Harness.open(storage, { models, registry }, context); }
    catch (error) { await storage.close(context); throw error; }
    this.root = await this.harness.root(context, { agent: {
      model: { provider: this.binding.model.provider, modelId: this.binding.model.modelId }, extensions: [extension],
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
      if (!submission) return;
      await submission.wait(context);
      // Placement is not completion: wait for the generation and its tools too.
      const state = await this.metadata();
      const conversation = await harness.conversation(state.runs[key]!.conversationId as ConversationId, context);
      await conversation?.waitForIdle(context);
      if (generation === this.generation && !this.closing) await this.mutate(meta => { meta.runs[key]!.status = "settled"; });
    })().catch(() => { /* Close leaves the durable run available for recovery. */ });
  }

  async submit(ticket: RunnerTicket, input: SubmitInput, mode: "write" | "ask"): Promise<SubmitResult> {
    if (typeof input?.content !== "string" || input.content.length > 100_000 || !input.content.trim()
      || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new RunnerError(400, "Invalid submission");
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, mode === "ask" ? "ask" : "write", ticket.policyVersion);
      const key = await requestKey(ticket.actorId, mode, input.requestId);
      const hash = await sha256(input.content);
      const state = await this.metadata();
      const existing = state.runs[key];
      if (existing) {
        if (existing.contentHash !== hash) throw new RunnerError(409, "requestId reused with different content");
        return { submissionId: String(existing.submissionId ?? key), conversationId: String(existing.conversationId), status: existing.status };
      }
      if (Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting")
        || Object.values(state.approvals).some(approval => approval.status === "executing")) throw new RunnerError(409, "Session is busy; retry after completion");
      let conversation = this.root;
      if (mode === "ask") {
        const transcript = await this.root.context(context);
        const head = transcript.entries.at(-1);
        const options = { ownership: { kind: "ownerless" as const }, agent: { tools: this.tools.filter(tool => ["identity", "read_file", "list_files", "git_status"].includes(tool.name) && this.binding.agent.tools.includes(tool.name as never)) } };
        conversation = head ? await this.root.fork(head.id, options, context) : await this.harness.createConversation({ ...options, agent: { ...options.agent, model: { provider: this.binding.model.provider, modelId: this.binding.model.modelId }, instructions: this.binding.agent.instructions } }, context);
      }
      const transcript = await conversation.context(context);
      const run: Run = { key, initiatedBy: ticket.actorId, ownerId: this.binding.owner.id, mode, conversationId: conversation.id, content: input.content, contentHash: hash, status: "admitting", startEntry: transcript.entries.at(-1)?.id ?? 0 };
      await this.mutate(meta => {
        meta.runs[key] = run;
        if (!meta.branches.some(branch => branch.id === conversation.id)) meta.branches.push({ id: conversation.id, mode, actorId: ticket.actorId });
      });
      const submission = await conversation.submit({ type: "input", content: input.content, requestId: key }, context);
      await this.mutate(meta => { meta.runs[key]!.submissionId = submission.id; meta.runs[key]!.status = "running"; });
      this.observeRun(key, submission.id);
      return { submissionId: String(submission.id), conversationId: String(conversation.id), status: "running" };
    });
  }

  private async toolActor(api: ToolExecutionApi, write: boolean) {
    const doc = await api.snapshot(RunnerState, context);
    const state: Metadata = JSON.parse(doc!.json);
    const saved = state.toolActors[String(api.taskId)];
    const run = saved ? state.runs[saved.runKey] : Object.values(state.runs).find(candidate => candidate.conversationId === api.conversationId && (candidate.status === "running" || candidate.status === "admitting"));
    if (!run || run.ownerId !== this.binding.owner.id || (write && run.mode !== "write")) throw new RunnerError(403, "Tool has no authorized writable submission");
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
    if (operation.kind === "bash" && !(this.binding.model.provider === "faux" && this.config.allowFaux && this.config.allowTestShell === true)) {
      throw new RunnerError(403, "Production shell requires a quota-backed runner; bash is available only to explicitly enabled faux test sessions");
    }
  }

  private buildTools(): ToolRegistration[] {
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
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
        const attribution = await this.toolActor(api, true); return text(await this.createApproval(attribution.initiatedBy, { kind: "git.commit", message: args.message }, String(api.taskId)));
      } }),
      defineTool({ name: "bash", description: "Request human approval of an exact sandboxed shell command, network disabled.", parameters: Type.Object({ command: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); return text(await this.createApproval(attribution.initiatedBy, { kind: "bash", command: args.command }, String(api.taskId)));
      } }),
      defineTool({ name: "github_comment", description: "Request human approval of an exact GitHub comment through the owner's broker; no credentials enter tools.", parameters: Type.Object({ repository: Type.String(), issue: Type.Integer({ minimum: 1 }), body: Type.String() }), execute: async (args, api) => {
        const attribution = await this.toolActor(api, true); return text(await this.createApproval(attribution.initiatedBy, { kind: "github.comment", ...args }, String(api.taskId)));
      } }),
    ];
  }

  async createApproval(actorId: string, input: Operation, toolTaskId?: string): Promise<ApprovalRecord> {
    const operation = validateOperation(input);
    this.requireShellCapability(operation);
    const toolName = { "git.commit": "git_commit", bash: "bash", "github.comment": "github_comment" }[operation.kind];
    if (!this.binding.agent.tools.includes(toolName as never)) throw new RunnerError(403, "Operation not enabled by pinned agent version");
    await this.authorize(actorId, "write");
    const id = toolTaskId ? `tool-${toolTaskId}` : randomUUID();
    const approval: ApprovalRecord = { id, sessionId: this.binding.session.id, requestedBy: actorId, operation: JSON.parse(JSON.stringify(operation)), status: "pending", createdAt: new Date().toISOString() };
    await this.mutate(meta => { meta.approvals[id] ??= approval; });
    return (await this.metadata()).approvals[id]!;
  }

  async decide(ticket: RunnerTicket, id: string, input: { decision: "approve" | "deny"; operation: Operation; brokerCapability?: string }): Promise<ApprovalRecord> {
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
      if (Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting")) throw new RunnerError(409, "Wait for the model run to finish before approval execution");
      if (approval.operation.kind === "github.comment" && !input.brokerCapability) throw new RunnerError(403, "Missing owner-bound single-use broker capability");
      await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executing", decidedBy: ticket.actorId }); });
      try {
        let result: string;
        if (approval.operation.kind === "github.comment") {
          const { repository, issue, body } = approval.operation;
          const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/github/comment`, {
            method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
            body: JSON.stringify({ sessionId: this.binding.session.id, actorId: ticket.actorId, approvalId: id, capability: input.brokerCapability, repository, issue, body }), signal: AbortSignal.timeout(30_000), redirect: "error",
          });
          if (!response.ok) throw new Error("Broker returned an error; external state must be reconciled");
          const responseBody = await response.json() as { id: number; url: string };
          result = JSON.stringify({ id: responseBody.id, url: responseBody.url });
        } else result = await this.sandbox.execute(approval.operation, false, async () => {
          this.requireShellCapability(approval.operation);
          await this.authorize(approval.requestedBy, "write");
          await this.authorize(ticket.actorId, "approve");
        });
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "executed", result }); });
      } catch {
        await this.mutate(meta => { Object.assign(meta.approvals[id]!, { status: "interrupted", result: "Effect failed or outcome is ambiguous. Inspect external state; automatic retry is prohibited." }); });
      }
      return (await this.metadata()).approvals[id]!;
    });
  }

  async consumeTicket(ticket: RunnerTicket): Promise<void> {
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
        const run = Object.values(state.runs).filter(candidate => candidate.conversationId === entry.conversationId && candidate.startEntry < entry.id).sort((a, b) => b.startEntry - a.startEntry)[0];
        entries.push(this.entryView(entry, snapshot.branch.id, run?.initiatedBy));
      }
    }
    const { id, displayName, gitName, gitEmail, githubLogin } = this.binding.owner;
    return { sessionId: this.binding.session.id, owner: { id, displayName, gitName, gitEmail, githubLogin }, entries,
      approvals: Object.values(state.approvals), conversations: state.branches.map(branch => ({ ...branch, id: String(branch.id) })),
      busy: Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting") || Object.values(state.approvals).some(approval => approval.status === "executing"),
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
    return this.exclusive(async () => {
      await this.authorize(ticket.actorId, "manage");
      const state = await this.metadata();
      if (Object.values(state.runs).some(run => run.status === "running" || run.status === "admitting") || Object.values(state.approvals).some(approval => approval.status === "executing")) throw new RunnerError(409, "Backup requires an idle session");
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
