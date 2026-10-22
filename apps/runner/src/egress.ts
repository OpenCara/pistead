import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect as tcpConnect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { bindingRemote, gitProviders, validGitHost, validRepositoryName, type GitProvider } from "../../../packages/shared/src/repositories.js";
import { hostAllowed, parseNetworkPolicy, type EgressGitService, type EgressGrant, type EgressRepository } from "../../../packages/shared/src/network.js";
import { RunnerError } from "./protocol.js";

/** Where sandboxed commands reach the proxy: a loopback port the sandbox helper relays to this session's socket. */
export const EGRESS_PORT = 41080;
/** The proxy socket's path inside the sandbox. */
export const EGRESS_SOCKET = "/run/pistead/egress.sock";
/** Git remotes are rewritten to this base (`url.<base>.insteadOf`), followed by the host and path of the original URL. */
export const EGRESS_GIT_BASE = `http://127.0.0.1:${EGRESS_PORT}/git/`;
/** SSH remotes of these hosts are rewritten too; other hosts' SSH remotes fail, as the sandbox has no SSH. */
const SSH_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

const GRANT_TTL_MS = 60_000;
/** Each address of a tunnel's host gets this long to accept the connection before the next is tried. */
const CONNECT_TIMEOUT_MS = 10_000;
/** A grant the control plane can't refresh stays in use this long, so a brief outage doesn't cut running commands off. */
const GRANT_STALE_MS = 5 * 60_000;
const UPLOAD_REQUEST_BYTES = 64 * 1024 * 1024;
const LOG_ENTRIES = 200;

/** One Git read for the control plane's relay, which adds the session owner's credential. */
export interface RelayRequest {
  bindingId: string; service: EgressGitService;
  userAgent?: string; gitProtocol?: string; contentType?: string; contentEncoding?: string;
  body?: Uint8Array<ArrayBuffer>;
}
export interface EgressEntry { at: string; kind: "git" | "connect" | "http"; target: string; outcome: "allowed" | "refused"; reason?: string }
export interface EgressOptions {
  socketPath: string;
  /** The session's current grant from the control plane. */
  grant: () => Promise<EgressGrant>;
  /** Forwards one Git read to the control plane's relay; refusals throw a RunnerError with the control plane's reason. */
  relay: (request: RelayRequest) => Promise<Response>;
  /** Overridable for tests: DNS resolution and outbound TCP. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  connect?: (port: number, address: string) => Duplex;
}

/**
 * Environment for sandboxed shell commands: every HTTPS client goes through the proxy, and Git's https remotes (and
 * SSH remotes of the common hosts) go to its Git endpoint, which relays the workspace's repositories with the owner's
 * credential. None of this is a boundary: the sandbox has no other network, so bypassing it only fails.
 */
export function egressEnvironment(): Record<string, string> {
  const proxy = `http://127.0.0.1:${EGRESS_PORT}`;
  const rewrites: [string, string][] = [["https://", EGRESS_GIT_BASE],
    ...SSH_HOSTS.flatMap((host): [string, string][] => [[`git@${host}:`, `${EGRESS_GIT_BASE}${host}/`], [`ssh://git@${host}/`, `${EGRESS_GIT_BASE}${host}/`]])];
  const config: Record<string, string> = { GIT_CONFIG_COUNT: String(rewrites.length) };
  rewrites.forEach(([from, to], index) => {
    config[`GIT_CONFIG_KEY_${index}`] = `url.${to}.insteadOf`;
    config[`GIT_CONFIG_VALUE_${index}`] = from;
  });
  return {
    HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    PISTEAD_EGRESS_STATUS: `${proxy}/__pistead/status`,
    ...config,
  };
}

let directory: string | undefined;
/** Unix socket paths are limited to about 100 bytes, so sockets live in one short private directory per process. */
export function egressSocketPath(sessionId: string, dataDir: string): string {
  directory ??= mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : "/tmp", "pistead-egress-"));
  return join(directory, `${createHash("sha256").update(`${dataDir}\0${sessionId}`).digest("hex").slice(0, 24)}.sock`);
}

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(network, prefix, "ipv6");

/** Whether an address is on the public internet: never the host itself, its networks, or link-local metadata services. */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return publicAddress(mapped[1]!);
  return !blocked.check(address, "ipv6");
}

/** `host[:port]` of a CONNECT request, with a lowercase host and IPv6 brackets removed. */
function authority(value: string | undefined): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(value ?? "");
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: match[1]!.replace(/^\[|\]$/g, "").toLowerCase(), port };
}

/** A repository's identity as a Git URL path names it: host/path, decoded, lowercase, without ".git". */
function repositoryKey(hostAndPath: string): string {
  let value = hostAndPath;
  try { value = decodeURIComponent(value); } catch { /* compared as written */ }
  return value.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

function gitRequest(path: string, search: string): { target: string; service: EgressGitService | "receive-pack" } | undefined {
  const service = new URLSearchParams(search).get("service");
  if (path.endsWith("/info/refs")) {
    if (service === "git-upload-pack") return { target: path.slice(0, -"/info/refs".length), service: "info-refs" };
    if (service === "git-receive-pack") return { target: path.slice(0, -"/info/refs".length), service: "receive-pack" };
    return undefined;
  }
  if (path.endsWith("/git-upload-pack")) return { target: path.slice(0, -"/git-upload-pack".length), service: "upload-pack" };
  if (path.endsWith("/git-receive-pack")) return { target: path.slice(0, -"/git-receive-pack".length), service: "receive-pack" };
  return undefined;
}

async function boundedBody(request: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new RunnerError(413, "The Git request is too large");
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

function refuse(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  // Git shows a text/plain error body to the user as "remote: …".
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
  response.end(`${message}\n`);
}

/**
 * One session's way out of its sandbox. It listens on a Unix socket that only that session's sandbox can reach, so every
 * request it serves is that session's, and it:
 * - relays Git reads of the workspace's repositories to the control plane, which adds the session owner's credential
 *   (the host never holds it) and re-checks the session's authority;
 * - opens HTTPS tunnels (CONNECT, port 443) to hosts the workspace's network policy allows, never to private,
 *   loopback or link-local addresses, without looking inside them;
 * - refuses everything else with a reason, and answers `/__pistead/status` with the policy and recent decisions.
 */
export class EgressProxy {
  readonly socketPath: string;
  readonly #options: EgressOptions;
  readonly #log: EgressEntry[] = [];
  readonly #sockets = new Set<Socket | Duplex>();
  #server: Server | undefined;
  #grant: { value: EgressGrant; at: number } | undefined;
  #refresh: Promise<EgressGrant> | undefined;

  constructor(options: EgressOptions) {
    this.socketPath = options.socketPath;
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await rm(this.socketPath, { force: true });
    const server = createServer((request, response) => { void this.#request(request, response); });
    server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => { void this.#tunnel(request, socket, head); });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
    });
    // Open connections keep the process alive while they last; an idle proxy never does.
    server.unref();
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(this.socketPath, { force: true });
  }

  /** The most recent decisions, newest last. */
  entries(): EgressEntry[] { return [...this.#log]; }

  #record(entry: Omit<EgressEntry, "at">): void {
    this.#log.push({ at: new Date().toISOString(), ...entry });
    if (this.#log.length > LOG_ENTRIES) this.#log.splice(0, this.#log.length - LOG_ENTRIES);
  }

  async #currentGrant(): Promise<EgressGrant> {
    const cached = this.#grant;
    if (cached && Date.now() - cached.at < GRANT_TTL_MS) return cached.value;
    this.#refresh ??= this.#options.grant().then(value => {
      this.#grant = { value, at: Date.now() };
      return value;
    }).finally(() => { this.#refresh = undefined; });
    try { return await this.#refresh; }
    catch (error) {
      // A refusal (the session was archived, the host lost the workspace) ends access at once; only an unreachable
      // control plane falls back to the last grant.
      const refused = error instanceof RunnerError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (refused) this.#grant = undefined;
      else if (cached && Date.now() - cached.at < GRANT_STALE_MS) return cached.value;
      throw error instanceof RunnerError ? error : new RunnerError(503, "The session's network policy is unavailable");
    }
  }

  async #addresses(host: string): Promise<string[]> {
    if (isIP(host)) return publicAddress(host) ? [host] : [];
    const results = await (this.#options.lookup ?? (name => dnsLookup(name, { all: true, verbatim: true })))(host);
    // Every address must be public: a name that also points inside the host's networks is refused outright.
    if (!results.length || results.some(result => !publicAddress(result.address))) return [];
    return results.map(result => result.address);
  }

  /** The first of `addresses` that accepts a connection in time; IPv6 first on an IPv4-only host just falls through. */
  async #open(port: number, addresses: string[]): Promise<Duplex> {
    let failure: unknown = new Error("No address");
    for (const address of addresses.slice(0, 8)) {
      const socket = (this.#options.connect ?? ((port, address) => tcpConnect({ port, host: address })))(port, address);
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: unknown) => { clearTimeout(timer); reject(error); };
          const timer = setTimeout(() => failed(new Error("Connection timed out")), CONNECT_TIMEOUT_MS);
          socket.once("error", failed);
          socket.once("connect", () => { clearTimeout(timer); socket.off("error", failed); resolve(); });
        });
        return socket;
      } catch (error) {
        socket.destroy();
        failure = error;
      }
    }
    throw failure;
  }

  async #tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    // Node hands the socket over without its own error handling: a client that drops while the tunnel is being set up
    // must not take the runner down.
    client.on("error", () => client.destroy());
    const target = authority(request.url);
    const name = request.url ?? "";
    const deny = (status: number, reason: string) => {
      this.#record({ kind: "connect", target: name.slice(0, 300), outcome: "refused", reason });
      if (!client.destroyed) client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`);
    };
    try {
      if (!target) return deny(403, "Invalid tunnel target");
      if (target.port !== 443) return deny(403, `Only HTTPS on port 443 is allowed, not port ${target.port}`);
      const grant = await this.#currentGrant();
      if (!hostAllowed(grant.policy, target.host)) {
        return deny(403, grant.policy.mode === "off"
          ? `${target.host} is not reachable: this workspace's network access is off`
          : `${target.host} is not allowed by this workspace's network policy`);
      }
      const addresses = await this.#addresses(target.host);
      if (!addresses.length) return deny(403, `${target.host} does not resolve to a public address`);
      if (client.destroyed) return;
      this.#sockets.add(client);
      let upstream: Duplex;
      try { upstream = await this.#open(target.port, addresses); }
      catch {
        this.#sockets.delete(client);
        return deny(502, `${target.host} could not be reached`);
      }
      this.#sockets.add(upstream);
      const cleanup = () => { upstream.destroy(); client.destroy(); this.#sockets.delete(upstream); this.#sockets.delete(client); };
      for (const socket of [upstream, client]) {
        socket.once("error", cleanup);
        socket.once("close", cleanup);
      }
      // The client may have left while the connection was being opened.
      if (client.destroyed) return cleanup();
      this.#record({ kind: "connect", target: `${target.host}:${target.port}`, outcome: "allowed" });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      deny(error instanceof RunnerError ? error.status === 503 ? 502 : 403 : 502, error instanceof RunnerError ? error.message : "The tunnel could not be opened");
    }
  }

  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
      catch { return refuse(response, 400, "Invalid request"); }
      // Absolute-form requests are plain-HTTP proxying, except to the proxy's own address (a client that ignored NO_PROXY).
      if (/^[a-z]+:/i.test(request.url ?? "") && url.host !== `127.0.0.1:${EGRESS_PORT}` && url.host !== `localhost:${EGRESS_PORT}`) {
        this.#record({ kind: "http", target: `${url.protocol}//${url.host}`.slice(0, 300), outcome: "refused", reason: "plain HTTP" });
        return refuse(response, 403, "Plain HTTP is not allowed through the Pistead egress proxy; use HTTPS");
      }
      if (url.pathname === "/__pistead/status" && request.method === "GET") return await this.#status(response);
      if (url.pathname.startsWith("/git/")) return await this.#git(request, response, url);
      return refuse(response, 404, "Unknown Pistead egress endpoint");
    } catch (error) {
      refuse(response, error instanceof RunnerError ? error.status : 502, error instanceof RunnerError ? error.message : "The request could not be completed");
    }
  }

  async #status(response: ServerResponse): Promise<void> {
    let grant: EgressGrant | undefined;
    let error: string | undefined;
    try { grant = await this.#currentGrant(); }
    catch (cause) { error = cause instanceof Error ? cause.message : "unavailable"; }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(`${JSON.stringify({
      network: grant?.policy ?? null,
      ...(error ? { error } : {}),
      repositories: grant?.repositories.map(repository => bindingRemote(repository)) ?? [],
      gitRemotes: `https:// remotes go through ${EGRESS_GIT_BASE}<host>/<path>; the workspace's repositories are read with the session owner's account`,
      recent: this.#log.slice(-50),
    }, null, 2)}\n`);
  }

  async #git(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const parsed = gitRequest(url.pathname.slice("/git/".length), url.search);
    if (!parsed) return refuse(response, 404, "Not a Git smart-HTTP request");
    // https://user@host/... remotes (as Azure DevOps and Bitbucket show them) name the same repository.
    const target = parsed.target.replace(/^[^@/]*@/, "");
    const key = repositoryKey(target);
    const label = key.slice(0, 300);
    if (parsed.service === "receive-pack") {
      this.#record({ kind: "git", target: label, outcome: "refused", reason: "push" });
      return refuse(response, 403, "Pushes don't go through the egress proxy yet: commit, then use the git_push tool");
    }
    const grant = await this.#currentGrant();
    const repository = grant.repositories.find(item => repositoryKey(bindingRemote(item).replace(/^https:\/\//, "")) === key);
    if (repository) return this.#relay(request, response, repository, parsed.service, label);
    // Any other repository is fetched directly, without credentials, if the network policy allows its host: the client
    // follows the redirect through its HTTPS proxy, where the tunnel enforces the policy again.
    const host = key.split("/")[0]!;
    if (parsed.service === "info-refs" && hostAllowed(grant.policy, host)) {
      this.#record({ kind: "git", target: label, outcome: "allowed", reason: "not a workspace repository: fetched directly, without credentials" });
      response.writeHead(302, { Location: `https://${target}/info/refs${url.search}`, "Cache-Control": "no-store" });
      return void response.end();
    }
    this.#record({ kind: "git", target: label, outcome: "refused", reason: "not a workspace repository" });
    return refuse(response, 403, hostAllowed(grant.policy, host)
      ? `${target.slice(0, 300)} is not one of this workspace's repositories; fetch it from https://${target.slice(0, 300)} directly`
      : `${target.slice(0, 300)} is not one of this workspace's repositories, and its network policy doesn't allow ${host.slice(0, 253)}`);
  }

  async #relay(request: IncomingMessage, response: ServerResponse, repository: EgressRepository, service: EgressGitService, label: string): Promise<void> {
    const header = (name: string) => { const value = request.headers[name]; return typeof value === "string" ? value : undefined; };
    if (service === "upload-pack" && request.method !== "POST") return refuse(response, 405, "Git fetches use POST");
    const body = service === "upload-pack" ? await boundedBody(request, UPLOAD_REQUEST_BYTES) : undefined;
    let upstream: Response;
    try {
      upstream = await this.#options.relay({
        bindingId: repository.bindingId, service,
        userAgent: header("user-agent"), gitProtocol: header("git-protocol"),
        contentType: header("content-type"), contentEncoding: header("content-encoding"), ...(body ? { body } : {}),
      });
    } catch (error) {
      const reason = error instanceof RunnerError ? error.message : "The control plane could not relay the request";
      this.#record({ kind: "git", target: label, outcome: "refused", reason });
      return refuse(response, error instanceof RunnerError && error.status >= 400 && error.status < 600 ? error.status : 502, reason);
    }
    this.#record({ kind: "git", target: label, outcome: "allowed", reason: service });
    response.writeHead(200, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "no-store" });
    if (!upstream.body) return void response.end();
    const reader = upstream.body.getReader();
    response.once("close", () => { void reader.cancel().catch(() => {}); });
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!response.write(part.value)) await new Promise<void>(resolve => {
          const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
          response.once("drain", done);
          response.once("close", done);
        });
        if (response.destroyed) break;
      }
      response.end();
    } catch {
      response.destroy();
    }
  }
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/** A grant as the control plane sends it; anything else is refused rather than half-applied. */
export function parseEgressGrant(value: unknown): EgressGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerError(502, "Invalid network policy from the control plane");
  const input = value as Record<string, unknown>;
  let policy;
  try { policy = parseNetworkPolicy(input.policy); }
  catch { throw new RunnerError(502, "Invalid network policy from the control plane"); }
  if (!Array.isArray(input.repositories) || input.repositories.length > 100) throw new RunnerError(502, "Invalid repositories from the control plane");
  const repositories = input.repositories.map((item: unknown): EgressRepository => {
    const repository = item as Partial<EgressRepository> | null;
    if (!repository || typeof repository.bindingId !== "string" || !IDENTIFIER.test(repository.bindingId)
      || !gitProviders.includes(repository.provider as GitProvider) || !validGitHost(repository.host)
      || !validRepositoryName(repository.provider!, repository.fullName)) throw new RunnerError(502, "Invalid repositories from the control plane");
    return { bindingId: repository.bindingId, provider: repository.provider!, host: repository.host, fullName: repository.fullName };
  });
  return { policy, repositories };
}

/**
 * Sends one Git read to the control plane's relay at `url` (connector or internal route) and returns its streaming
 * answer; a refusal throws a RunnerError carrying the control plane's credential-free reason.
 */
export async function relayGitRequest(fetchImpl: typeof fetch, url: string, authorization: Record<string, string>, request: RelayRequest, signal: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { ...authorization };
  if (request.userAgent) headers["user-agent"] = request.userAgent;
  if (request.gitProtocol) headers["git-protocol"] = request.gitProtocol;
  if (request.contentType) headers["content-type"] = request.contentType;
  if (request.contentEncoding) headers["content-encoding"] = request.contentEncoding;
  const response = await fetchImpl(url, { method: "POST", redirect: "error", credentials: "omit", headers, body: request.body ?? new Uint8Array(), signal });
  if (response.ok) return response;
  const text = (await response.text().catch(() => "")).slice(0, 4096);
  let error: unknown;
  try { error = (JSON.parse(text) as { error?: unknown }).error; } catch { error = undefined; }
  throw new RunnerError(response.status, typeof error === "string" && /^[\x20-\x7e -￿]{1,500}$/.test(error) ? error : "The control plane refused the Git request");
}

/** The relay route for one Git read, below the connector or internal prefix. */
export function relayPath(prefix: string, sessionId: string, request: RelayRequest): string {
  return `${prefix}/git/relay/${encodeURIComponent(request.bindingId)}/${request.service}?sessionId=${encodeURIComponent(sessionId)}`;
}
