import { mkdir, readFile, open, link, unlink, chmod, realpath, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { RunnerAction, RunnerBinding, RunnerTicket, SubmitInput, Operation } from "../../../packages/shared/src/types.js";
import type { RestoreDescriptor, RestoreInput } from "../../../packages/shared/src/connector.js";
import { assertId, permissionFor, RunnerError, stableJson, validateBinding, verifyRunnerTicket } from "./protocol.js";
import { RunnerSession, type RunnerConfig } from "./session.js";
import { restoreSession } from "./restore.js";

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

export class RunnerService {
  private readonly sessions = new Map<string, Promise<RunnerSession>>();
  private closed = false;
  readonly dataDir: string;
  constructor(readonly config: RunnerConfig) {
    if (config.sharedSecret.length < 32) throw new Error("RUNNER_SHARED_SECRET must have at least 32 characters");
    const control = new URL(config.controlPlaneUrl);
    if (control.protocol !== "https:" && !(control.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(control.hostname))) throw new Error("Control plane must use HTTPS except loopback development");
    this.dataDir = resolve(config.dataDir);
  }

  assertConnector(ticket: RunnerTicket): void {
    if (ticket.connectorId !== this.config.connectorId) throw new RunnerError(403, "Ticket connector mismatch");
  }

  private binding(input: unknown, id: string): RunnerBinding {
    const binding = validateBinding(input, id, !!this.config.connectorId && !!this.config.resolveModels);
    if (binding.session.connectorId !== this.config.connectorId) throw new RunnerError(403, "Binding connector mismatch");
    if (binding.model.provider === "faux" && !this.config.allowFaux) throw new RunnerError(403, "Deterministic faux test provider disabled");
    return binding;
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.dataDir)).isSymbolicLink() || await realpath(this.dataDir) !== this.dataDir) throw new Error("DATA_DIR must be canonical and not symlinked");
    await chmod(this.dataDir, 0o700);
    await mkdir(join(this.dataDir, "sessions"), { recursive: true, mode: 0o700 });
  }

  async get(id: string): Promise<RunnerSession> {
    assertId(id);
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const opening = (async () => {
      const directory = join(this.dataDir, "sessions", id);
      let binding: RunnerBinding;
      try { binding = this.binding(JSON.parse(await readFile(join(directory, "binding.json"), "utf8")), id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunnerError(404, "Session not found"); throw error; }
      if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
      const session = new RunnerSession(immutable(binding), directory, this.config);
      try { await session.open(); }
      catch (error) {
        await session.close().catch(() => {});
        await session.sandbox.close().catch(() => {});
        throw error;
      }
      return session;
    })();
    this.sessions.set(id, opening);
    try { return await opening; } catch (error) { this.sessions.delete(id); throw error; }
  }

  async provision(input: unknown, ticket: RunnerTicket): Promise<RunnerSession> {
    const id = assertId(ticket.sessionId);
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    this.assertConnector(ticket);
    const binding = this.binding(input, id);
    if (binding.owner.id !== ticket.ownerId || binding.owner.id !== ticket.actorId || binding.session.policyVersion !== ticket.policyVersion) throw new RunnerError(403, "Provisioning owner mismatch");
    if (binding.model.provider === "faux" && !this.config.allowFaux) throw new RunnerError(403, "Deterministic faux test provider disabled");
    const directory = join(this.dataDir, "sessions", id);
    const session = new RunnerSession(immutable(binding), directory, this.config);
    await session.authorize(ticket.actorId, "write", ticket.policyVersion);
    // Publish a complete fsynced immutable binding with an atomic no-replace link.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new RunnerError(403, "Invalid session storage");
    const temporary = join(directory, `binding-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(binding));
      await handle.sync();
      try { await link(temporary, join(directory, "binding.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await handle.close(); await unlink(temporary); }
    const persisted = this.binding(JSON.parse(await readFile(join(directory, "binding.json"), "utf8")), id);
    if (stableJson(persisted) !== stableJson(binding)) throw new RunnerError(409, "Session already exists with a different immutable owner, agent, model, or binding");
    return this.get(id);
  }

  private async pullBackup(restore: RestoreDescriptor, targetSessionId: string): Promise<Uint8Array> {
    if (this.config.readBackup) return this.config.readBackup(restore, targetSessionId);
    if (this.config.connectorId) throw new RunnerError(503, "Connected restore requires its scoped download callback");
    const response = await (this.config.fetch ?? fetch)(`${this.config.controlPlaneUrl}/api/internal/restores/${assertId(restore.id)}/download`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.sharedSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ targetSessionId, sourceSessionId: restore.sourceSessionId, backupId: restore.backupId, downloadToken: restore.downloadToken }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok || response.headers.get("x-backup-sha256") !== restore.sha256
      || response.headers.get("content-length") !== String(restore.size) || !response.body) {
      await response.body?.cancel();
      throw new RunnerError(403, "Backup download denied or metadata mismatch");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > restore.size || size > 24 * 1024 * 1024) throw new RunnerError(413, "Backup download exceeds its bound");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (size !== restore.size) throw new RunnerError(400, "Truncated backup");
    return Buffer.concat(chunks, size);
  }

  async restore(input: RestoreInput, ticket: RunnerTicket): Promise<RunnerBinding> {
    if (this.closed) throw new RunnerError(503, "Runner service is closed");
    this.assertConnector(ticket);
    const id = assertId(ticket.sessionId);
    const binding = immutable(this.binding(input?.binding, id));
    if (ticket.actorId !== binding.owner.id || ticket.ownerId !== binding.owner.id)
      throw new RunnerError(403, "Only the immutable owner can restore a session");
    const authority = new RunnerSession(binding, join(this.dataDir, "sessions", id), this.config);
    await authority.authorize(ticket.actorId, "manage", ticket.policyVersion);
    await restoreSession({ dataDir: this.dataDir, readBackup: (descriptor, target) => this.pullBackup(descriptor, target) },
      binding, input.restore, async (stage, manifest) => {
        if (this.closed) throw new RunnerError(503, "Runner service is closed");
        await authority.authorize(ticket.actorId, "manage", ticket.policyVersion);
        const staged = new RunnerSession(binding, stage, this.config);
        try { await staged.prepareRestore(manifest); }
        finally { await staged.sandbox.close(); }
      });
    return binding;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.sessions.values()) {
      const session = await pending;
      await session.close();
      await session.sandbox.close();
    }
    this.sessions.clear();
  }
}

export function createRunnerApp(service: RunnerService): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "Request too large" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof RunnerError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    // Never send stack traces, host paths, provider errors, or credential material to clients.
    return c.json({ error: "Runner operation failed" }, 500);
  });
  app.get("/health", c => c.json({ ok: true, runtime: "node24", execution: "pi-durable", faux: service.config.allowFaux }));
  app.post("/v1/sessions", async c => {
    const body = await c.req.text();
    const input = JSON.parse(body) as RunnerBinding;
    const id = assertId(input?.session?.id ?? "");
    const token = c.req.header("authorization")?.match(/^Bearer ([^ ]+)$/)?.[1] ?? "";
    const ticket = await verifyRunnerTicket(token, service.config.sharedSecret, "create", id, body);
    service.assertConnector(ticket);
    const session = await service.provision(input, ticket);
    return c.json({ session: session.binding.session }, 201);
  });
  app.all("/v1/sessions/:id/*", async c => {
    const id = assertId(c.req.param("id"));
    const url = new URL(c.req.url);
    const prefix = `/v1/sessions/${id}/`;
    if (!url.pathname.startsWith(prefix) || url.search) throw new RunnerError(400, "Invalid path");
    const route = url.pathname.slice(prefix.length);
    const approval = /^approvals\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(route);
    const actions: Record<string, RunnerAction> = { submit: "submit", ask: "ask", view: "view", events: "events", operations: "operations", restart: "restart", backup: "backup", restore: "restore" };
    const action = approval ? "approve" : actions[route];
    if (!action) throw new RunnerError(404, "Unknown runner endpoint");
    if (c.req.method !== (action === "view" || action === "events" ? "GET" : "POST")) throw new RunnerError(405, "Method not allowed");
    const body = await c.req.text();
    const token = c.req.header("authorization")?.match(/^Bearer ([^ ]+)$/)?.[1] ?? "";
    const ticket = await verifyRunnerTicket(token, service.config.sharedSecret, action, id, body);
    service.assertConnector(ticket);
    if (action === "restore") {
      const input = JSON.parse(body) as RestoreInput;
      const binding = await service.restore(input, ticket);
      return c.json({ session: binding.session, restore: { id: input.restore.id, sha256: input.restore.sha256, targetSessionId: id } }, 201);
    }
    const session = await service.get(id);
    if (ticket.ownerId !== session.binding.owner.id) throw new RunnerError(403, "Ticket owner mismatch");
    await session.authorize(ticket.actorId, permissionFor(action), ticket.policyVersion);
    if (action === "operations" || action === "restart" || action === "backup") await session.consumeTicket(ticket);
    if (action === "view") return c.json({ view: await session.view() });
    if (action === "events") return streamSSE(c, async stream => {
      let last = "";
      let checking = false;
      // This watchdog is independent of response backpressure and never aborts the model run.
      const monitor = setInterval(() => {
        if (checking || stream.aborted) return;
        checking = true;
        void session.authorize(ticket.actorId, "read", ticket.policyVersion)
          .catch(() => stream.abort()).finally(() => { checking = false; });
      }, 1000);
      const expiry = setTimeout(() => stream.abort(), Math.max(0, ticket.exp * 1000 - Date.now()));
      try {
        while (!stream.aborted) {
          if (Date.now() >= ticket.exp * 1000) break;
          const view = JSON.stringify({ view: await session.view() });
          if (stream.aborted) break;
          if (view !== last) { await stream.writeSSE({ event: "view", data: view }); last = view; }
          else await stream.writeSSE({ event: "ping", data: "{}" });
          await delay(250);
        }
      } finally { clearInterval(monitor); clearTimeout(expiry); }
    });
    const input = body ? JSON.parse(body) : {};
    if (action === "submit" || action === "ask") return c.json(await session.submit(ticket, input as SubmitInput, action === "ask" ? "ask" : "write"));
    if (action === "operations") return c.json({ approval: await session.createApproval(ticket.actorId, input.operation as Operation) }, 201);
    if (action === "approve") {
      if (input.approvalId !== approval![1]) throw new RunnerError(403, "Approval ticket path mismatch");
      return c.json({ approval: await session.decide(ticket, approval![1]!, input) });
    }
    if (action === "restart") {
      if (ticket.actorId !== session.binding.owner.id) throw new RunnerError(403, "Only the owner can restart a session");
      await session.restart();
      return c.json({ ok: true, sessionId: id });
    }
    return c.json(await session.backup(ticket));
  });
  app.notFound(c => c.json({ error: "Not found" }, 404));
  return app;
}
