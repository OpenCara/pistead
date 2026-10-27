import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { mkdir, realpath, lstat, open, link, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket as CompressingSocket } from "ws";
import { z } from "zod";
import type { ConnectorCapabilities, ConnectorCredentials, ConnectorRpcRequest, ConnectorRpcResponse, LocalModelSummary, RestoreDescriptor } from "../../../packages/shared/src/connector.js";
import { connectorLimits } from "../../../packages/shared/src/connector.js";
import { sha256, signToken } from "../../../packages/shared/src/crypto.js";
import type { AuthorizationRequest, AuthorizationResult, GitHubEffectAuthority, GitHubIssueView, RunnerAction, RunnerBinding, ScheduleToolResult, SessionActivity } from "../../../packages/shared/src/types.js";
import { sessionActivities } from "../../../packages/shared/src/types.js";
import { acquireRunnerLease } from "./lease.js";
import type { LocalModels } from "./local-pi.js";
import { modelSummary } from "./local-pi.js";
import { assertId, ConnectorSetupError, RunnerError, verifyRunnerTicket } from "./protocol.js";
import { parseEgressGrant, relayGitRequest, relayPath } from "./egress.js";
import { withHostToolCapabilities } from "./host-capabilities.js";
import { HostCredentialError, hostGitAuthorization } from "./git-credentials.js";
import { detectGpu, HostConfigSource } from "./host-config.js";
import type { GpuKind, RepositoryCacheMode } from "../../../packages/shared/src/host-config.js";
import { recoverResourceOrphans } from "./resources.js";
import { RepositoryCache } from "./repo-cache.js";
import { RunnerService, createRunnerApp } from "./server.js";
import type { RunnerConfig } from "./session.js";

const STATE_FILE = "connector.json";
const CALLBACK_LIMIT = 64 * 1024;
/** A github_read result; the control plane keeps its view within 96 KiB of JSON. */
const GITHUB_READ_LIMIT = 128 * 1024;
/**
 * The host's configuration, as large as the control plane saves it: compaction counts for 200 models with the longest
 * names take about 67 KB (the save takes 128 KiB).
 */
const HOST_CONFIG_LIMIT = 128 * 1024;
/** A schedule tool result: up to every schedule of the session, each with its message (MAX_SCHEDULES_PER_SESSION, server). */
const SCHEDULES_LIMIT = 4 * 1024 * 1024;
const RPC_TIMEOUT = 30_000;
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const encoder = new TextEncoder();
const credentialsSchema = z.object({
  connectorId: z.string().regex(IDENTIFIER), token: z.string().regex(TOKEN), controlPlaneUrl: z.string(),
}).strict();
const welcomeSchema = z.object({
  type: z.literal("welcome"), connectorId: z.string().regex(IDENTIFIER), connectionToken: z.string().regex(TOKEN),
}).strict();
const actorSchema = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const ticketSchema = z.object({
  aud: z.literal("runner"), sessionId: z.string().regex(IDENTIFIER), actorId: actorSchema, ownerId: actorSchema,
  action: z.enum(["create", "view", "events", "submit", "ask", "operations", "approve", "backup", "restart", "restore", "stop", "files"]),
  policyVersion: z.number().int().positive(), iat: z.number().int(), exp: z.number().int(),
  jti: z.string().regex(IDENTIFIER), bodyHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), connectorId: z.string().regex(IDENTIFIER),
}).strict();
const requestSchema = z.object({
  type: z.literal("request"), id: z.string().regex(IDENTIFIER), method: z.enum(["GET", "POST"]),
  path: z.string().max(512), body: z.string().max(connectorLimits.requestBytes), ticket: ticketSchema,
}).strict();

export function controlPlaneOrigin(value: string, allowInsecureLoopback = false): string {
  if (typeof value !== "string" || /[\s\\\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid control-plane origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid control-plane origin"); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (value !== url.origin && value !== `${url.origin}/`)
    || (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:"))) {
    throw new Error("Use an HTTPS origin; HTTP requires explicit loopback development opt-in");
  }
  return url.origin;
}

function credentials(value: unknown, origin?: string, allowInsecureLoopback = false): ConnectorCredentials {
  const c = credentialsSchema.parse(value);
  const controlPlaneUrl = controlPlaneOrigin(c.controlPlaneUrl, allowInsecureLoopback);
  if (origin && controlPlaneUrl !== origin) throw new ConnectorSetupError("Connector state is bound to a different control-plane origin; use its saved server or a separate --state-dir");
  return { connectorId: c.connectorId, token: c.token, controlPlaneUrl };
}

async function privateDirectory(directory: string): Promise<string> {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== path) {
    throw new ConnectorSetupError("Connector state directory must be an owned, non-symlink mode0700 directory");
  }
  return path;
}

export async function readConnectorState(directory: string, origin?: string, allowInsecureLoopback = false): Promise<ConnectorCredentials | undefined> {
  const path = join(await privateDirectory(directory), STATE_FILE);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cannot safely open connector state"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096
      || (process.getuid && stat.uid !== process.getuid())) throw new Error("Connector state must be an owned mode0600 regular file");
    const state = JSON.parse(await file.readFile("utf8"));
    if (state.version !== 1) throw new Error("Unsupported connector state version");
    return credentials(state.credentials, origin, allowInsecureLoopback);
  } finally { await file.close(); }
}

export async function writeConnectorState(directory: string, value: ConnectorCredentials, allowInsecureLoopback = false, replace = false): Promise<void> {
  const path = await privateDirectory(directory);
  const saved = credentials(value, undefined, allowInsecureLoopback);
  const temporary = join(path, `.connector-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify({ version: 1, credentials: saved }));
    await file.sync();
  } finally { await file.close(); }
  if (replace) {
    // Only a forced re-pairing replaces, under the runner lease. Rename swaps the entry itself (a symlink is never
    // followed) and atomically, so a crash leaves the old token or the new one, never neither.
    try { await rename(temporary, join(path, STATE_FILE)); } catch (error) { await unlink(temporary); throw error; }
  } else {
    try {
      // No replacement: racing companions cannot silently replace another token.
      await link(temporary, join(path, STATE_FILE));
    } finally { await unlink(temporary); }
  }
  const directoryHandle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

async function boundedBody(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new Error("Response exceeds connector limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Response exceeds connector limit");
      chunks.push(value);
    }
    signal?.throwIfAborted();
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid control-plane response"); }
}

export async function connectorManifest(localModels: LocalModels, allowFaux = false): Promise<LocalModelSummary[]> {
  const models = (await localModels.manifest()).map(modelSummary);
  if (models.length > connectorLimits.models) throw new Error("Too many local models");
  const seen = new Set<string>();
  for (const model of models) {
    const key = JSON.stringify([model.provider, model.modelId]);
    if (seen.has(key) || (model.provider === "faux" && !allowFaux)) throw new Error("Invalid or disabled local model");
    seen.add(key);
  }
  return models;
}

function capabilities(value?: ConnectorCapabilities, mode: { unsandboxed?: boolean; repositoryCache?: boolean; gpu?: GpuKind } = {}): ConnectorCapabilities {
  const result = value ?? { platform: process.platform, sandbox: false, productionShell: false };
  if (typeof result.platform !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(result.platform)
    || typeof result.sandbox !== "boolean" || typeof result.productionShell !== "boolean"
    || (result.productionShell && !result.sandbox)) throw new Error("Invalid connector capabilities");
  // The owner's consent, not caller-supplied metadata, decides whether isolation is disclosed as absent. Every connector
  // of this version applies per-message choices, gives the model a message's pasted images, pushes, and reads, merges
  // and opens issues on GitHub through the control plane, and takes its configuration from Pistead (`hostConfig`), where
  // its owner decides whether pushes may use this host's Git credentials, compaction token counts included
  // (`compactionConfig`). It says whether this connection keeps a repository cache, and which GPU device sandboxed
  // commands could get. Every session clones its repositories with plain Git: in the sandbox through its egress proxy
  // (verified per session, like all isolation, so this doesn't wait for `sandbox`), or with the host's own Git where its
  // owner runs it unsandboxed.
  const cache = mode.repositoryCache ? { repositoryCache: true } : {};
  if (mode.unsandboxed) return { platform: result.platform, sandbox: false, productionShell: false, unsandboxed: true, chatOptions: true, chatImages: true, gitProviders: true, gitPush: true,
    github: true, githubIssues: true, schedules: true, plainGit: true, sessionBranches: true, conversationBackups: true, hostConfig: true, compactionConfig: true, ...cache };
  return { platform: result.platform, sandbox: result.sandbox, productionShell: result.productionShell, chatOptions: true, chatImages: true, gitProviders: true, gitPush: true,
    github: true, githubIssues: true, schedules: true, plainGit: true, cloneBackups: true, sessionBranches: true, conversationBackups: true, hostConfig: true, compactionConfig: true, ...cache,
    ...(mode.gpu ? { gpu: mode.gpu } : {}) };
}

export async function claimConnectorPairing(options: {
  server: string; pairing: { id: string; code: string }; localModels: LocalModels;
  capabilities?: ConnectorCapabilities; unsandboxed?: boolean; gpu?: GpuKind; allowFaux?: boolean; allowInsecureLoopback?: boolean; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<ConnectorCredentials> {
  const origin = controlPlaneOrigin(options.server, options.allowInsecureLoopback);
  const { id, code } = options.pairing;
  assertId(id);
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(code)) throw new Error("Invalid pairing code");
  const response = await (options.fetch ?? fetch)(`${origin}/api/connectors/pairings/${id}/claim`, {
    method: "POST", redirect: "error", credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, models: await connectorManifest(options.localModels, options.allowFaux), capabilities: withHostToolCapabilities(capabilities(options.capabilities, options)) }),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new ConnectorSetupError("Pairing rejected or unavailable: the code may be wrong, expired (codes last 10 minutes) or already used. Create a new pairing code and try again."); }
  const bytes = await boundedBody(response, CALLBACK_LIMIT, AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]));
  const value = z.object({ credentials: credentialsSchema }).strict().parse(decodeJson(bytes));
  return credentials(value.credentials, origin, options.allowInsecureLoopback);
}

/** Validates the TLS-delivered claims before making a LOCAL-only signed request. */
export async function validateRelayRequest(value: unknown, connectorId: string, verifierSecret: string): Promise<{ rpc: ConnectorRpcRequest; authorization: string }> {
  const rpc = requestSchema.parse(value);
  if (encoder.encode(rpc.body).length > connectorLimits.requestBytes) throw new Error("Invalid relay request");
  let action: RunnerAction;
  let sessionId: string;
  if (rpc.path === "/v1/sessions" && rpc.method === "POST") {
    action = "create";
    let binding: RunnerBinding;
    try { binding = JSON.parse(rpc.body); } catch { throw new Error("Invalid create binding"); }
    sessionId = assertId(binding?.session?.id ?? "");
    if (binding.session.connectorId !== connectorId || binding.model?.connectorId !== connectorId
      || binding.owner?.id !== rpc.ticket?.ownerId || binding.session.ownerId !== rpc.ticket?.ownerId) throw new Error("Foreign connector binding");
  } else {
    const match = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(view|view\/[0-9a-f]{32}|submit|ask|operations|restart|backup|restore|stop|files|approvals\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(rpc.path);
    if (!match) throw new Error("Relay path is not allowed");
    sessionId = match[1]!;
    action = match[2]!.startsWith("approvals/") ? "approve" : match[2]!.startsWith("view/") ? "view" : match[2] as RunnerAction;
    if (rpc.method !== (action === "view" ? "GET" : "POST")) throw new Error("Relay method is not allowed");
    if (action === "restore") {
      const input = decodeJson(encoder.encode(rpc.body)) as { binding?: RunnerBinding };
      if (input.binding?.session?.id !== sessionId || input.binding.session.connectorId !== connectorId
        || input.binding.model?.connectorId !== connectorId || input.binding.owner?.id !== rpc.ticket?.ownerId
        || input.binding.session.ownerId !== rpc.ticket?.ownerId) throw new Error("Foreign restore binding");
    }
  }
  const ticket = rpc.ticket;
  if (ticket.connectorId !== connectorId
    || (rpc.method === "GET" && rpc.body !== "")
    || (["create", "restore", "restart"].includes(action) && ticket.actorId !== ticket.ownerId)) throw new Error("Invalid relay ticket");
  const authorization = await signToken(ticket, verifierSecret);
  await verifyRunnerTicket(authorization, verifierSecret, action, sessionId, rpc.body);
  return { rpc, authorization };
}

export interface ConnectorSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectorRuntime {
  fetch(request: Request): Response | Promise<Response>;
  close(): Promise<void>;
}

export interface ConnectorOptions {
  dataDir: string;
  server?: string;
  pairing?: { id: string; code: string };
  /** With `pairing`, claim it and replace any saved credentials instead of refusing an already paired state directory. */
  replacePairing?: boolean;
  localModels: LocalModels;
  allowInsecureLoopback?: boolean;
  allowFaux?: boolean;
  allowTestShell?: boolean;
  capabilities?: ConnectorCapabilities;
  resources?: RunnerConfig["resources"];
  /** Run session work directly on the host without isolation; requires explicit owner consent. */
  unsandboxed?: boolean;
  /**
   * The GPU device this host can lend sandboxed commands, where its configuration turns that on; detected on the host
   * unless given (null for none). Everything else the host's owner and admins configure in Pistead (HostConfig): the
   * command time limit, the GPU, whether pushes may use this host's Git credentials, and its repository cache.
   */
  gpu?: GpuKind | null;
  fetch?: typeof fetch;
  createSocket?: (url: string, protocols: string[]) => ConnectorSocket;
  runtimeFactory?: (config: RunnerConfig) => Promise<ConnectorRuntime>;
  acquireLease?: typeof acquireRunnerLease;
  reconnectDelayMs?: number;
  /** With "disconnected", why the last connection ended, in fixed connector text, when it is known. */
  onStatus?: (status: "connecting" | "connected" | "disconnected" | "stopped", reason?: string) => void;
  onWarning?: (warning: "resources-unavailable") => void;
}

type Generation = {
  socket: ConnectorSocket;
  abort: AbortController;
  done: PromiseWithResolvers<void>;
  welcome: PromiseWithResolvers<string>;
  connectionToken?: string;
  runtime?: ConnectorRuntime;
  active: Set<Promise<void>>;
  tail: Promise<void>;
  waiting: Set<PromiseWithResolvers<never>>;
  incomingBytes: number;
  /** The first reason this connection was ended for. */
  reason?: string;
  runtimeReady: PromiseWithResolvers<void>;
};

/** A GitHub effect's authority as the control plane takes it: the approval's capability or the owner's Auto-approve admission. */
function effectAuthority(request: GitHubEffectAuthority): { capability: string } | { admissionId: string } {
  return request.capability !== undefined ? { capability: request.capability } : { admissionId: request.admissionId! };
}

export class LocalConnector {
  readonly ready: Promise<void>;
  private readonly readiness = Promise.withResolvers<void>();
  private readonly lifetime = new AbortController();
  private readonly secret = Buffer.from(randomBytes(48)).toString("base64url");
  private readonly seen = new Map<string, number>();
  private generation?: Generation;
  private lastReason?: string;
  private loop?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private releaseLease?: () => Promise<void>;
  private state?: ConnectorCredentials;
  private directory = "";
  /** This host's repository caches, one per scope its configuration has chosen, each opened once and kept. */
  private readonly repositoryCaches = new Map<Exclude<RepositoryCacheMode, "off">, RepositoryCache>();
  private readonly gpu?: GpuKind;

  constructor(private readonly options: ConnectorOptions) {
    this.ready = this.readiness.promise;
    // Unsandboxed commands run on the host itself: there is nothing to lend them.
    const gpu = options.unsandboxed ? undefined : options.gpu === undefined ? detectGpu() : options.gpu;
    if (gpu) this.gpu = gpu;
    // Consumers may await start() instead of separately attaching to ready.
    void this.ready.catch(() => {});
    if (options.allowTestShell && !options.allowFaux) throw new Error("Test shell requires explicit faux test mode");
    if (options.reconnectDelayMs !== undefined && (!Number.isFinite(options.reconnectDelayMs) || options.reconnectDelayMs < 1 || options.reconnectDelayMs > 30_000)) throw new Error("Invalid reconnect delay");
  }

  start(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("Connector has stopped"));
    this.starting ??= this.initialize().catch(async (error: unknown) => {
      // Setup errors carry fixed connector text; anything else may contain SDK or HTTP detail.
      const failure = error instanceof ConnectorSetupError ? error
        : new Error("Connector initialization failed; verify private state, pairing, local models and lease prerequisites");
      this.readiness.reject(failure);
      await this.releaseLease?.();
      this.releaseLease = undefined;
      throw failure;
    });
    return this.starting.then(() => this.ready);
  }

  private async initialize(): Promise<void> {
    if (process.platform !== "linux" && !this.options.runtimeFactory && !(this.options.unsandboxed && process.platform === "darwin")) throw new Error("Connected runner requires a Linux sandbox and kernel lease; no host-shell fallback");
    this.directory = await privateDirectory(this.options.dataDir);
    this.releaseLease = await (this.options.acquireLease ?? acquireRunnerLease)(this.directory, () => {
      this.lifetime.abort();
      this.disconnect(this.generation, "Runner lease lost");
      void this.stop().catch(() => {});
    });
    this.lifetime.signal.throwIfAborted();
    if (this.options.resources) {
      try { await recoverResourceOrphans(this.options.resources); }
      catch { this.options.onWarning?.("resources-unavailable"); }
    }
    const origin = this.options.server === undefined ? undefined : controlPlaneOrigin(this.options.server, this.options.allowInsecureLoopback);
    const replace = this.options.pairing !== undefined && this.options.replacePairing === true;
    // Replacing never reads the saved token: it may be revoked, unreadable or bound to another server.
    this.state = replace ? undefined : await readConnectorState(this.directory, origin, this.options.allowInsecureLoopback);
    if (this.state && this.options.pairing) throw new ConnectorSetupError("This machine is already paired; run without --pairing-id, add --force to replace the saved pairing, or use a separate --state-dir for another connection");
    if (!this.state) {
      if (!origin || !this.options.pairing) throw new ConnectorSetupError("First connection requires --server and --pairing-id");
      // Claimed before anything is written: a wrong, expired or used code keeps the saved pairing.
      this.state = await claimConnectorPairing({ ...this.options, gpu: this.gpu, server: origin, pairing: this.options.pairing, signal: this.lifetime.signal });
      await writeConnectorState(this.directory, this.state, this.options.allowInsecureLoopback, replace);
    }
    this.lifetime.signal.throwIfAborted();
    this.loop = this.connectLoop();
    void this.loop.catch(() => { this.readiness.reject(new Error("Connector stopped before becoming ready")); });
  }

  private disconnect(generation?: Generation, reason = "Connection ended"): void {
    if (!generation || generation.abort.signal.aborted) return;
    generation.reason ??= reason;
    generation.abort.abort();
    for (const waiting of generation.waiting) waiting.reject(new Error("Connector connection lost"));
    generation.waiting.clear();
    generation.welcome.reject(new Error("Connector connection lost"));
    generation.runtimeReady.reject(new Error("Connector connection lost"));
    generation.done.resolve();
    try { generation.socket.close(1000, "Connection ended"); } catch { /* Already closed. */ }
  }

  private async connectLoop(): Promise<void> {
    let failures = 0;
    while (!this.lifetime.signal.aborted) {
      this.lastReason = undefined;
      try { await this.connectOnce(); failures = 0; }
      catch { failures++; }
      if (this.lifetime.signal.aborted) break;
      this.options.onStatus?.("disconnected", this.lastReason);
      const wait = this.options.reconnectDelayMs ?? Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 250);
      try { await delay(wait, undefined, { signal: this.lifetime.signal }); } catch { break; }
    }
  }

  private async connectOnce(): Promise<void> {
    const state = this.state!;
    this.options.onStatus?.("connecting");
    const url = new URL("/api/connectors/socket", state.controlPlaneUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.options.createSocket ?? defaultSocket)(url.href, ["opencara-pi-v1", `bearer.${state.token}`]);
    const generation: Generation = { socket, abort: new AbortController(), done: Promise.withResolvers<void>(), welcome: Promise.withResolvers<string>(), active: new Set(), tail: Promise.resolve(), waiting: new Set(), incomingBytes: 0, runtimeReady: Promise.withResolvers<void>() };
    void generation.runtimeReady.promise.catch(() => {});
    this.generation = generation;
    const timeout = setTimeout(() => this.disconnect(generation, "Relay did not welcome the connection within 15s"), 15_000);
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 65_000) return this.disconnect(generation, "No pong from the relay for 65s");
      // Skipped while output is backed up: a ping would only queue behind it.
      if (socket.readyState === 1 && socket.bufferedAmount + 4 <= connectorLimits.bufferedBytes) {
        try { socket.send("ping"); } catch { this.disconnect(generation, "Ping could not be sent"); }
      }
    }, 20_000);
    socket.addEventListener("error", () => this.disconnect(generation, "Socket error"));
    socket.addEventListener("close", event => {
      const { code, reason } = event as Partial<CloseEvent>;
      // The relay's close reason is short fixed text (connector-hub.ts); keep it to one bounded line.
      const detail = typeof reason === "string" ? reason.replace(/[^\x20-\x7e]/g, "").slice(0, 120) : "";
      this.disconnect(generation, `Relay closed the connection${typeof code === "number" ? ` (${code}${detail ? ` ${detail}` : ""})` : ""}`);
    });
    socket.addEventListener("message", event => {
      if (generation.abort.signal.aborted) return;
      const data: unknown = "data" in event ? event.data : undefined;
      if (data === "pong") { lastPong = Date.now(); return; }
      if (typeof data !== "string" || encoder.encode(data).length > connectorLimits.frameBytes) return this.disconnect(generation, "Invalid relay frame");
      let value: unknown;
      try { value = JSON.parse(data); } catch { return this.disconnect(generation, "Invalid relay frame"); }
      if (!generation.connectionToken) {
        const welcome = welcomeSchema.safeParse(value);
        if (!welcome.success || welcome.data.connectorId !== state.connectorId
          || socket.protocol !== "opencara-pi-v1") return this.disconnect(generation, "Invalid relay welcome");
        generation.connectionToken = welcome.data.connectionToken;
        generation.welcome.resolve(welcome.data.connectionToken);
        return;
      }
      this.dispatch(generation, value, encoder.encode(data).length);
    });
    try {
      await generation.welcome.promise;
      clearTimeout(timeout);
      // How the host runs its sessions, as its owner and admins set it in Pistead: asked for now, for the repository cache
      // this connection keeps, and again within a minute of each change for every command and push. Without an answer
      // (a control plane that predates it), the defaults.
      const hostConfig = new HostConfigSource(async () => (await this.callback(generation, "/api/connectors/self/config", {}, HOST_CONFIG_LIMIT) as { config?: unknown } | undefined)?.config);
      const configured = await hostConfig.current();
      this.requireGeneration(generation);
      const repositoryCache = configured.repositoryCache === "off" ? undefined : this.repositoryCacheFor(configured.repositoryCache);
      const config: RunnerConfig = {
        dataDir: join(this.directory, "runner"), controlPlaneUrl: state.controlPlaneUrl,
        sharedSecret: this.secret, connectorId: state.connectorId,
        allowFaux: this.options.allowFaux === true, allowTestShell: this.options.allowTestShell === true,
        resources: this.options.resources, unsandboxed: this.options.unsandboxed === true,
        resolveModels: model => { this.requireGeneration(generation); return this.options.localModels.resolve(model); },
        compaction: this.options.localModels.compaction, identity: this.options.localModels.identity,
        authorize: request => this.authorize(generation, request),
        reportActivity: (sessionId, activity) => this.reportActivity(generation, sessionId, activity),
        githubComment: async request => {
          const payload = {
            sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
            repository: request.repository, issue: request.issue, body: request.body,
          };
          return z.object({
            id: z.number().int().positive(), url: z.string().max(2048).regex(/^https:\/\/github\.com\//),
          }).strict().parse(await this.callback(generation, "/api/connectors/self/github/comment", payload));
        },
        // Reads and merges pass the control plane's refusal on (a repository not pinned, GitHub's reason not to merge).
        githubRead: async request => {
          const payload = { sessionId: request.sessionId, actorId: request.actorId, admissionId: request.admissionId, callId: request.callId, repository: request.repository, issue: request.issue };
          const view = await this.brokerCallback(generation, "/api/connectors/self/github/read", payload, GITHUB_READ_LIMIT);
          z.looseObject({ repository: z.string(), number: z.number().int().positive(), title: z.string(), comments: z.array(z.unknown()) }).parse(view);
          return view as GitHubIssueView;
        },
        githubMerge: async request => {
          const payload = {
            sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
            repository: request.repository, pull: request.pull, sha: request.sha, method: request.method,
          };
          return z.object({
            sha: z.string().regex(/^[0-9a-f]{40}$/), url: z.string().max(2048).regex(/^https:\/\/github\.com\//),
          }).strict().parse(await this.brokerCallback(generation, "/api/connectors/self/github/merge", payload));
        },
        // Like merges, an issue GitHub refused comes back with its reason.
        githubIssue: async request => {
          const payload = {
            sessionId: request.sessionId, actorId: request.actorId, approvalId: request.approvalId, ...effectAuthority(request),
            repository: request.repository, title: request.title, body: request.body,
          };
          return z.object({
            number: z.number().int().positive(), url: z.string().max(2048).regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/),
          }).strict().parse(await this.brokerCallback(generation, "/api/connectors/self/github/issue", payload));
        },
        // The control plane's refusal (not the owner's message, an invalid cron expression) comes back with its reason.
        schedules: async request => {
          const result = await this.brokerCallback(generation, "/api/connectors/self/schedules", request, SCHEDULES_LIMIT);
          z.union([z.looseObject({ schedules: z.array(z.looseObject({ id: z.string() })) }), z.looseObject({ schedule: z.looseObject({ id: z.string() }) }),
            z.object({ deleted: z.string() }).strict()]).parse(result);
          return result as ScheduleToolResult;
        },
        // Minting can take several upstream calls, so push callbacks get the full RPC budget.
        pushCredential: async request => {
          const payload = {
            sessionId: request.sessionId, approvalId: request.approvalId, actorId: request.actorId, operation: request.operation,
            ...(request.capability !== undefined ? { capability: request.capability } : {}),
            ...(request.admissionId !== undefined ? { admissionId: request.admissionId } : {}),
          };
          const issued = {
            credentialId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), remote: z.string().max(2048).regex(/^https:\/\/[^/@\s]+\/\S*$/), expiresAt: z.string().datetime(),
          };
          return z.union([
            z.object({ ...issued, authorization: z.string().regex(/^(Basic|Bearer) [A-Za-z0-9+/=._~-]{1,8000}$/) }).strict(),
            // Push access with the host's own Git credentials: the session reads them here, so none comes from the control plane.
            z.object({ ...issued, hostCredentials: z.literal(true) }).strict(),
          ]).parse(await this.brokerCallback(generation, "/api/connectors/self/git/push/credential", payload));
        },
        hostConfig: () => hostConfig.current(),
        // Only while the host's owner has them on in Pistead; the control plane checks that too before it names them.
        hostGitCredential: async (remote: string, signal?: AbortSignal) => {
          if (!(await hostConfig.current()).gitCredentials) throw new HostCredentialError("This host's owner hasn't turned on its Git credentials in Pistead (Settings → Hosts → the host → Configuration)");
          return hostGitAuthorization(remote, { signal });
        },
        pushComplete: async request => {
          const payload = {
            sessionId: request.sessionId, approvalId: request.approvalId, credentialId: request.credentialId, outcome: request.outcome,
            ...(request.tip !== undefined ? { tip: request.tip } : {}),
          };
          return z.object({
            pullRequest: z.object({
              url: z.string().max(2048).regex(/^https:\/\/\S+$/), number: z.number().int().positive(), created: z.boolean(),
            }).strict().optional(),
          }).strict().parse(await this.brokerCallback(generation, "/api/connectors/self/git/push/complete", payload));
        },
        egressGrant: async sessionId => parseEgressGrant(await this.brokerCallback(generation, "/api/connectors/self/network", { sessionId })),
        // The relay streams a whole pack, so it gets the length of the longest command rather than the RPC budget. A push
        // outlives a replaced connection: once its pack is under way, the forge's answer must reach Git.
        gitRelay: async (sessionId, request) => {
          this.requireGeneration(generation);
          const push = request.service === "receive-pack";
          const response = await relayGitRequest(this.options.fetch ?? fetch, `${this.state!.controlPlaneUrl}${relayPath("/api/connectors/self", sessionId, request)}`,
            { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken! }, request,
            AbortSignal.any([...(push ? [] : [generation.abort.signal]), this.lifetime.signal, AbortSignal.timeout(60 * 60 * 1000)]));
          // Like every callback, an answer to a connection that has since been replaced is not used, except a push's: the
          // forge has taken it by then, and Git must hear how it went.
          if (push) return response;
          try { this.requireGeneration(generation); }
          catch (error) { await response.body?.cancel(); throw error; }
          return response;
        },
        readBackup: (restore, target) => this.readBackup(generation, restore, target),
        ...(repositoryCache ? { repositoryCache } : {}),
      };
      generation.runtime = await (this.options.runtimeFactory ?? defaultRuntime)(config);
      this.requireGeneration(generation);
      const advertised = capabilities(this.options.capabilities, { unsandboxed: this.options.unsandboxed, repositoryCache: repositoryCache !== undefined, gpu: this.gpu });
      await this.callback(generation, "/api/connectors/self/manifest", { models: await connectorManifest(this.options.localModels, this.options.allowFaux), capabilities: withHostToolCapabilities(advertised) });
      this.requireGeneration(generation);
      generation.runtimeReady.resolve();
      this.options.onStatus?.("connected");
      this.readiness.resolve();
      await generation.done.promise;
    } catch (error) {
      // A callback, the runtime or the manifest failed before or while connecting.
      this.disconnect(generation, "Connection setup failed");
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.disconnect(generation);
      this.lastReason = generation.reason;
      // Retire the old harness before a new generation can open the same SQLite files.
      await Promise.allSettled([...generation.active]);
      try { await generation.runtime?.close(); }
      catch {
        // An uncertain SQLite/runtime shutdown cannot safely be reopened.
        this.lifetime.abort();
        this.readiness.reject(new Error("Connector runtime could not be safely retired"));
        throw new Error("Connector runtime could not be safely retired");
      }
      if (this.generation === generation) this.generation = undefined;
    }
  }

  /** The cache of `scope`, beside the runner's session storage in the same private state directory; it keeps its own locks. */
  private repositoryCacheFor(scope: Exclude<RepositoryCacheMode, "off">): RepositoryCache {
    let cache = this.repositoryCaches.get(scope);
    if (!cache) this.repositoryCaches.set(scope, cache = new RepositoryCache({ root: join(this.directory, "repo-cache"), scope }));
    return cache;
  }

  private requireGeneration(generation: Generation): void {
    if (this.lifetime.signal.aborted || generation.abort.signal.aborted || this.generation !== generation || !generation.connectionToken) throw new Error("Connector generation is no longer authorized");
  }

  private async callbackResponse(generation: Generation, path: string, body: unknown, signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(15_000)])): Promise<Response> {
    this.requireGeneration(generation);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}${path}`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    try {
      this.requireGeneration(generation);
      signal.throwIfAborted();
      if (!response.ok) throw new Error("Scoped connector callback denied or unavailable");
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  }

  private async callback(generation: Generation, path: string, body: unknown, limit = CALLBACK_LIMIT): Promise<unknown> {
    const response = await this.callbackResponse(generation, path, body);
    const bytes = await boundedBody(response, limit, AbortSignal.any([generation.abort.signal, AbortSignal.timeout(15_000)]));
    this.requireGeneration(generation);
    return bytes.length ? decodeJson(bytes) : undefined;
  }

  /**
   * Push and GitHub broker callbacks pass the control plane's refusal on: its messages are fixed, credential-free and
   * actionable (e.g. which push identity to set up, why GitHub didn't merge). Minting and GitHub reads can take several
   * upstream calls, so they get the full RPC budget.
   */
  private async brokerCallback(generation: Generation, path: string, body: unknown, limit = CALLBACK_LIMIT): Promise<unknown> {
    this.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(RPC_TIMEOUT)]);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}${path}`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    const bytes = await boundedBody(response, limit, signal);
    this.requireGeneration(generation);
    const value = bytes.length ? decodeJson(bytes) : undefined;
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
      throw new RunnerError(response.status, typeof error === "string" && /^[\x20-\x7e\u00a0-\uffff]{1,500}$/.test(error) ? error : "Scoped connector callback denied or unavailable");
    }
    return value;
  }

  private async authorize(generation: Generation, request: AuthorizationRequest): Promise<AuthorizationResult> {
    const payload = { sessionId: request.sessionId, actorId: request.actorId, ownerId: request.ownerId, permission: request.permission, ...(request.host ? { host: true } : {}) };
    const result = z.object({
      allowed: z.boolean(), ownerId: actorSchema, policyVersion: z.number().int().positive(), hostCommands: z.enum(["approve", "auto"]).optional(),
    }).strict().parse(await this.callback(generation, "/api/connectors/self/authorize", payload));
    if (result.ownerId !== request.ownerId) throw new Error("Invalid authorization response");
    return result;
  }

  /**
   * Tells the control plane what a session's agent is doing. A refusal is final for that report: a control plane that
   * predates activity reports refuses them all, and one that no longer lets this host serve the session refuses its own.
   * Anything else throws, so the session retries it.
   */
  private async reportActivity(generation: Generation, sessionId: string, activity: SessionActivity): Promise<void> {
    if (!IDENTIFIER.test(sessionId) || !sessionActivities.includes(activity)) throw new Error("Invalid activity report");
    this.requireGeneration(generation);
    const signal = AbortSignal.any([generation.abort.signal, this.lifetime.signal, AbortSignal.timeout(15_000)]);
    const response = await (this.options.fetch ?? fetch)(`${this.state!.controlPlaneUrl}/api/connectors/self/activity`, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${this.state!.token}`, "x-connection-token": generation.connectionToken!, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, activity }), signal,
    });
    await response.body?.cancel();
    this.requireGeneration(generation);
    if (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429)) throw new Error("Activity report unavailable");
  }

  private async readBackup(generation: Generation, restore: RestoreDescriptor, targetSessionId: string): Promise<Uint8Array> {
    const ids = [restore.id, restore.sourceSessionId, restore.backupId, targetSessionId];
    if (ids.some(id => typeof id !== "string" || !IDENTIFIER.test(id))
      || typeof restore.downloadToken !== "string" || !TOKEN.test(restore.downloadToken)
      || typeof restore.sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(restore.sha256)
      || !Number.isSafeInteger(restore.size) || restore.size < 1 || restore.size > connectorLimits.responseBytes) throw new Error("Invalid restore descriptor");
    const response = await this.callbackResponse(generation, `/api/connectors/self/restores/${restore.id}/download`, {
      targetSessionId, sourceSessionId: restore.sourceSessionId, backupId: restore.backupId, downloadToken: restore.downloadToken,
    });
    const bytes = await boundedBody(response, restore.size, AbortSignal.any([generation.abort.signal, AbortSignal.timeout(15_000)]));
    this.requireGeneration(generation);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length !== restore.size || response.headers.get("x-backup-sha256") !== restore.sha256 || await sha256(text) !== restore.sha256) throw new Error("Backup integrity mismatch");
    return bytes;
  }

  private dispatch(generation: Generation, value: unknown, frameSize: number): void {
    // Only what the relay itself bounds ends the connection here: its pending count and the request bytes it has charged
    // (connector-hub.ts). This host's own response output is not the relay's to know; requests wait for it in execute().
    if (generation.active.size >= connectorLimits.pendingRequests) return this.disconnect(generation, "Relay exceeded the pending request limit");
    if (generation.incomingBytes + frameSize > connectorLimits.bufferedBytes) return this.disconnect(generation, "Relay exceeded the queued request byte limit");
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) return this.disconnect(generation, "Invalid relay request");
    const rpc = parsed.data;
    const now = Date.now();
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    const keys = [`request:${rpc.id}`, `ticket:${rpc.ticket.jti}`];
    if (keys.some(key => this.seen.has(key)) || this.seen.size > 8192) return this.disconnect(generation, "Replayed relay request");
    // Claim queued IDs too: reconnect must not turn an admitted ticket into a retry.
    // Bound provisional claims to the 60s ticket lifetime, 5s clock skew and 5s replay grace.
    const replayExpiry = Math.min((rpc.ticket.exp + 5) * 1000, now + 70_000);
    for (const key of keys) this.seen.set(key, replayExpiry);
    generation.incomingBytes += frameSize;
    const previous = generation.tail;
    const task = this.execute(generation, rpc, previous).catch((error: unknown) => {
      // Validation, ordering or a lost generation; runtime failures became error replies instead. Only plain fixed
      // connector text is shown: a parser's message could quote the request.
      const message = error instanceof Error && /^[A-Za-z][A-Za-z ]{0,119}$/.test(error.message) ? error.message : "";
      this.disconnect(generation, message ? `Relay request failed: ${message}` : "Relay request failed");
    }).finally(() => {
      generation.active.delete(task);
      generation.incomingBytes -= frameSize;
    });
    generation.tail = task;
    generation.active.add(task);
  }

  private async execute(generation: Generation, value: ConnectorRpcRequest, previous: Promise<void>): Promise<void> {
    const timeout = setTimeout(() => this.disconnect(generation, "Relay request timed out"), RPC_TIMEOUT);
    try {
      const { rpc, authorization } = await validateRelayRequest(value, this.state!.connectorId, this.secret);
      this.requireGeneration(generation);
      const canceled = Promise.withResolvers<never>();
      generation.waiting.add(canceled);
      try {
        // Validate promptly, but effects and replies follow arrival order.
        await Promise.race([Promise.all([previous, generation.runtimeReady.promise]), canceled.promise]);
      } finally {
        generation.waiting.delete(canceled);
      }
      this.requireGeneration(generation);
      // A ticket validated on arrival may have expired while queued.
      if (rpc.ticket.exp * 1000 <= Date.now()) throw new Error("Relay ticket expired while queued");
      const { payload, payloadSize } = await this.reply(generation, rpc, authorization);
      // The reply waits for socket output to drain to its own size, not to a worst-case reservation. Any reply fits once
      // output drains (frameBytes < bufferedBytes), and later requests stay queued behind it, so output stays bounded by
      // bufferedBytes and queued requests by the relay's own budget. The wait shares RPC_TIMEOUT with the queue, as the
      // relay's own deadline does: an uplink that cannot drain the backlog in time still ends the connection.
      while (generation.socket.bufferedAmount + payloadSize > connectorLimits.bufferedBytes) {
        await delay(10, undefined, { signal: generation.abort.signal });
        this.requireGeneration(generation);
      }
      generation.socket.send(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The reply frame for an admitted request. What goes wrong with this one request (the runtime failing, a body over
   * the limit or not UTF-8, a frame too large once escaped) is answered as an error for it, not by ending the connection
   * and every other request with it. Only a lost connection still throws.
   */
  private async reply(generation: Generation, rpc: ConnectorRpcRequest, authorization: string): Promise<{ payload: string; payloadSize: number }> {
    // Measured without encoding: a reply can be tens of MiB while output is already backed up.
    const frame = (payload: string) => ({ payload, payloadSize: Buffer.byteLength(payload, "utf8") });
    const failed = (status: number, error: string) => frame(JSON.stringify({
      type: "response", id: rpc.id, status, body: JSON.stringify({ error, code: "connector_reply_error" }),
    } satisfies ConnectorRpcResponse));
    let result: ConnectorRpcResponse;
    try {
      const response = await generation.runtime!.fetch(new Request(`http://local.invalid${rpc.path}`, {
        method: rpc.method, headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        ...(rpc.method === "POST" ? { body: rpc.body } : {}), signal: generation.abort.signal,
      }));
      let bytes: Uint8Array;
      try { bytes = await boundedBody(response, connectorLimits.responseBytes, generation.abort.signal); }
      catch (error) {
        this.requireGeneration(generation);
        if (error instanceof Error && error.message === "Response exceeds connector limit") return failed(502, "The host's reply is too large to relay.");
        throw error;
      }
      result = { type: "response", id: rpc.id, status: response.status, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      this.requireGeneration(generation);
      return failed(502, "The host could not complete the request.");
    }
    this.requireGeneration(generation);
    const reply = frame(JSON.stringify(result));
    // Escaping can make a body under responseBytes a frame over frameBytes.
    if (reply.payloadSize > connectorLimits.frameBytes) return failed(502, "The host's reply is too large to relay.");
    return reply;
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort();
    this.disconnect(this.generation);
    this.readiness.reject(new Error("Connector stopped before becoming ready"));
    try { await this.starting?.catch(() => {}); await this.loop; }
    finally { await this.releaseLease?.(); this.releaseLease = undefined; this.options.onStatus?.("stopped"); }
  }
}

/**
 * The relay socket, compressed both ways where the server offers it (Node's built-in WebSocket compresses nothing it
 * sends, and session views are most of what a host sends). Each message is compressed on its own, so no message's
 * content shapes another's size, and none may inflate past the frame limit.
 */
export const relaySocketOptions = {
  maxPayload: connectorLimits.frameBytes,
  perMessageDeflate: { threshold: 1024, clientNoContextTakeover: true, serverNoContextTakeover: true },
};

function defaultSocket(url: string, protocols: string[]): ConnectorSocket {
  return new CompressingSocket(url, protocols, relaySocketOptions) as unknown as ConnectorSocket;
}

async function defaultRuntime(config: RunnerConfig): Promise<ConnectorRuntime> {
  const service = new RunnerService(config);
  await service.initialize();
  const app = createRunnerApp(service);
  return { fetch: request => app.fetch(request), close: () => service.close() };
}

export function createConnector(options: ConnectorOptions): LocalConnector { return new LocalConnector(options); }
