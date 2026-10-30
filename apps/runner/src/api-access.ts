import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { API_CREDENTIAL_CACHE_SECONDS, API_TOKEN_PLACEHOLDER, hostAllowed, type ApiCredential, type ApiCredentialGrant, type EgressGrant }
  from "../../../packages/shared/src/network.js";
import { publicAddress } from "./egress.js";
import { interceptionAuthority, type InterceptionAuthority } from "./interception-ca.js";
import { RunnerError } from "./protocol.js";

/*
 * Credentialed APIs (see `credentialedApiHosts`): HTTPS to these hosts ends at the session's egress proxy, which answers
 * with a certificate from the connector's own authority (interception-ca.ts), checks each request, and makes it at the
 * API itself with the session's credential from the control plane. The sandbox holds only API_TOKEN_PLACEHOLDER.
 *
 * For api.github.com the credential is a GitHub App installation token that can only read the workspace's repositories
 * the session owner can read, so writes are refused here and would fail at GitHub anyway: comments, issues, merges and
 * pushes stay with Pistead's approved tools.
 */

/** A GraphQL request's body; GitHub's own limit on a query is far below this. */
const GRAPHQL_BYTES = 1024 * 1024;
const PATH_LENGTH = 8192;
/** An answer's headers must arrive within this; its body may then take as long as it streams. */
const UPSTREAM_TIMEOUT_MS = 60_000;
/** An unavailable credential is asked for again after this, not at every request. */
const UNAVAILABLE_CACHE_MS = 10_000;
/** A credential isn't used within this much of its expiry. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REDIRECTS = 3;
/**
 * Where GitHub's API sends downloads (Actions logs and artifacts, release assets, archives): the proxy follows its
 * redirects there itself, without the credential, so `gh run view --log` works whatever the network policy. Redirects
 * anywhere else reach the client as they are.
 */
const GITHUB_DOWNLOAD_HOSTS = [/^codeload\.github\.com$/, /\.githubusercontent\.com$/, /\.blob\.core\.windows\.net$/];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "authorization", "cookie", "content-length", "expect"]);

export interface ApiEntry { target: string; outcome: "allowed" | "refused"; reason?: string }
export interface UpstreamRequest { url: URL; method: string; headers: Record<string, string>; body?: Uint8Array }
export interface UpstreamResponse { status: number; headers: IncomingHttpHeaders; body: Readable }
export type ApiUpstream = (request: UpstreamRequest) => Promise<UpstreamResponse>;

export interface ApiAccessOptions {
  /** Asks the control plane for the session's credential for `host` (an ApiCredentialGrant); refusals throw. */
  credential: (host: string) => Promise<unknown>;
  /** The session's current grant, for its network policy. */
  grant: () => Promise<EgressGrant>;
  record: (entry: ApiEntry) => void;
  /** Overridable for tests: the authority, and requests to the API (by default, to its public addresses only). */
  authority?: InterceptionAuthority;
  upstream?: ApiUpstream;
}

/** A credential grant as the control plane sends it; anything else is refused rather than half-used. */
export function parseApiCredentialGrant(value: unknown): ApiCredentialGrant {
  const invalid = () => new RunnerError(502, "Invalid API credential from the control plane");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const cacheSeconds = input.cacheSeconds;
  if (!Number.isSafeInteger(cacheSeconds) || (cacheSeconds as number) < 0 || (cacheSeconds as number) > 3600) throw invalid();
  if (input.available === false) {
    if (typeof input.reason !== "string" || !/^[\x20-\x7e]{1,500}$/.test(input.reason)) throw invalid();
    return { available: false, reason: input.reason, cacheSeconds: cacheSeconds as number };
  }
  if (input.available !== true || !Array.isArray(input.credentials) || !input.credentials.length || input.credentials.length > 100) throw invalid();
  const credentials = input.credentials.map((item: unknown): ApiCredential => {
    const credential = item as Record<string, unknown> | null;
    if (!credential || typeof credential.account !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(credential.account)
      || typeof credential.authorization !== "string" || !/^[\x21-\x7e][\x20-\x7e]{0,16383}$/.test(credential.authorization)
      || !Array.isArray(credential.repositories) || credential.repositories.length > 100
      || credential.repositories.some(name => typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name))
      || typeof credential.expiresAt !== "string" || !Number.isFinite(Date.parse(credential.expiresAt))) throw invalid();
    return { account: credential.account, authorization: credential.authorization, repositories: [...credential.repositories as string[]], expiresAt: credential.expiresAt };
  });
  return { available: true, credentials, cacheSeconds: cacheSeconds as number };
}

const READ_ONLY = "sandboxed commands only read through the GitHub API. Comments, issues, merges and pushes go through Pistead's approved tools "
  + "(github_comment, github_issue, github_merge, git_push)";

/** What a request to api.github.com may do from a sandbox: read (GET, HEAD, GraphQL queries), never write. */
export function githubApiRule(method: string, pathname: string): { kind: "read" | "graphql" } | { refused: string } {
  if (method === "GET" || method === "HEAD") return { kind: "read" };
  if (method === "POST" && pathname === "/graphql") return { kind: "graphql" };
  return { refused: `${method} ${pathname.slice(0, 200)}: ${READ_ONLY}` };
}

/**
 * Whether a GraphQL document defines a mutation or subscription: strings and comments are set aside, then an operation
 * definition starts the document or follows the end of another. The token's read-only scope is what refuses writes;
 * this only says so clearly before GitHub does.
 */
export function graphqlWrites(query: string): boolean {
  const text = query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n\r]*/g, " ");
  return /(?:^|\})\s*(?:mutation|subscription)\b/.test(text);
}

/** The owner/name a REST path is about, as `/repos/{owner}/{name}/...` names it. */
export function restRepository(pathname: string): string | undefined {
  const parts = pathname.split("/");
  if (parts[1] !== "repos" || !parts[2] || !parts[3]) return undefined;
  try { return `${decodeURIComponent(parts[2])}/${decodeURIComponent(parts[3])}`; } catch { return undefined; }
}

function json(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  // GitHub's own error shape, which gh and Octokit show as they are.
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify({ message, documentation_url: "https://github.com/OpenCara/pistead#network-access" })}\n`);
}

async function body(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new RunnerError(413, "The API request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A request to `url` at its public addresses only, connected to exactly the addresses checked, without redirects. */
export const publicUpstream: ApiUpstream = async ({ url, method, headers, body }) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await dnsLookup(host, { all: true, verbatim: true }); }
  catch { addresses = []; }
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new RunnerError(502, `${host.slice(0, 253)} does not resolve to a public address`);
  const checked = addresses.slice(0, 8);
  const lookup: LookupFunction = (_name, options, callback) => {
    if (options.all) (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, checked);
    else callback(null, checked[0]!.address, checked[0]!.family);
  };
  return new Promise((resolve, reject) => {
    // Its own agent: never a proxy from the connector's environment, which would resolve the name itself.
    const request = httpsRequest(url, { method, headers: body ? { ...headers, "content-length": String(body.byteLength) } : headers,
      lookup, agent: new HttpsAgent({ keepAlive: false, lookup }) }, response => {
      request.setTimeout(0);
      resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response });
    });
    request.setTimeout(UPSTREAM_TIMEOUT_MS, () => request.destroy(new Error("The API did not answer in time")));
    request.on("error", reject);
    request.end(body);
  });
};

/** The credential that reads `repository` (owner/name), or for a request about no one repository, `owner`'s or the first. */
function credentialFor(credentials: ApiCredential[], repository: string | undefined, owner: string | undefined): ApiCredential | undefined {
  if (repository) {
    const name = repository.toLowerCase();
    return credentials.find(credential => credential.repositories.some(item => item.toLowerCase() === name));
  }
  const account = owner?.toLowerCase();
  return credentials.find(credential => credential.account.toLowerCase() === account) ?? credentials[0];
}

/** One session's credentialed APIs, inside its egress proxy (see EgressProxy's tunnels). */
export class ApiAccess {
  readonly #options: ApiAccessOptions;
  readonly #authority: InterceptionAuthority;
  readonly #upstream: ApiUpstream;
  readonly #server: Server;
  readonly #hosts = new WeakMap<object, string>();
  readonly #credentials = new Map<string, { grant: ApiCredentialGrant; until: number }>();
  readonly #pending = new Map<string, Promise<ApiCredentialGrant>>();

  constructor(options: ApiAccessOptions) {
    this.#options = options;
    this.#authority = options.authority ?? interceptionAuthority();
    this.#upstream = options.upstream ?? publicUpstream;
    this.#server = createServer((request, response) => void this.#request(request, response).catch(() => json(response, 502, "The API request could not be completed")));
    this.#server.on("clientError", (_error, socket) => socket.destroy());
  }

  /** Whether the proxy answers for `host` itself. */
  handles(host: string): boolean { return this.#authority.hosts.includes(host); }

  /** Takes over a tunnel to `host` the client asked for, answered by the proxy itself over TLS. */
  intercept(client: Duplex, head: Buffer, host: string): void {
    if (head.length) client.unshift(head);
    const socket = new TLSSocket(client, { isServer: true, secureContext: this.#authority.context(host), ALPNProtocols: ["http/1.1"] });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => client.destroy());
    this.#hosts.set(socket, host);
    this.#server.emit("connection", socket);
  }

  async #credential(host: string): Promise<ApiCredentialGrant> {
    const cached = this.#credentials.get(host);
    if (cached && cached.until > Date.now()) return cached.grant;
    let pending = this.#pending.get(host);
    if (!pending) {
      pending = (async () => {
        let grant: ApiCredentialGrant;
        try { grant = parseApiCredentialGrant(await this.#options.credential(host)); }
        catch (error) {
          const reason = error instanceof RunnerError && /^[\x20-\x7e]{1,300}$/.test(error.message) ? error.message : "Pistead gave no credential for this API";
          const unavailable: ApiCredentialGrant = { available: false, reason, cacheSeconds: 0 };
          this.#credentials.set(host, { grant: unavailable, until: Date.now() + UNAVAILABLE_CACHE_MS });
          return unavailable;
        }
        const expiry = grant.available ? Math.min(...grant.credentials.map(item => Date.parse(item.expiresAt))) - EXPIRY_MARGIN_MS : Infinity;
        const seconds = Math.min(grant.cacheSeconds, API_CREDENTIAL_CACHE_SECONDS);
        const until = Math.min(Date.now() + (grant.available ? seconds * 1000 : Math.max(seconds * 1000, UNAVAILABLE_CACHE_MS)), expiry);
        if (until > Date.now()) this.#credentials.set(host, { grant, until });
        return grant;
      })().finally(() => this.#pending.delete(host));
      this.#pending.set(host, pending);
    }
    return pending;
  }

  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = this.#hosts.get(request.socket);
    const method = request.method ?? "GET";
    const path = request.url ?? "";
    if (!host) return json(response, 421, "Unknown API connection");
    const pathname = path.split("?")[0]!;
    const target = `${method} ${host}${pathname}`.slice(0, 300);
    const refuse = (status: number, reason: string) => {
      this.#options.record({ target, outcome: "refused", reason });
      request.resume();
      json(response, status, reason);
    };
    const named = (request.headers.host ?? "").toLowerCase().replace(/:443$/, "");
    if (named !== host) return refuse(421, `This connection is for ${host}, not ${named.slice(0, 253) || "no host"}`);
    if (!path.startsWith("/") || path.length > PATH_LENGTH) return refuse(400, "Invalid API request path");
    const rule = githubApiRule(method, pathname);
    if ("refused" in rule) return refuse(403, rule.refused);

    let payload: Uint8Array | undefined;
    let owner: string | undefined;
    if (rule.kind === "graphql") {
      try { payload = await body(request, GRAPHQL_BYTES); }
      catch (error) { return refuse(error instanceof RunnerError ? error.status : 400, error instanceof RunnerError ? error.message : "Invalid GraphQL request"); }
      let document: { query?: unknown; variables?: unknown };
      try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as typeof document; }
      catch { return refuse(400, "A GraphQL request is a JSON object with a query"); }
      if (!document || typeof document !== "object" || typeof document.query !== "string") return refuse(400, "A GraphQL request is a JSON object with a query");
      if (graphqlWrites(document.query)) return refuse(403, `GraphQL mutations: ${READ_ONLY}`);
      const variables = document.variables as Record<string, unknown> | null | undefined;
      if (variables && typeof variables === "object" && typeof variables.owner === "string") owner = variables.owner;
    } else request.resume();

    const grant = await this.#options.grant();
    const open = hostAllowed(grant.policy, host);
    const supplied = request.headers.authorization;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_BY_HOP.has(name) && !name.startsWith("proxy-") && value !== undefined) headers[name] = [value].flat().join(", ");
    }
    headers.host = host;
    let reason: string;
    let credential: ApiCredential | undefined;
    if (supplied && !supplied.includes(API_TOKEN_PLACEHOLDER)) {
      // A credential the command brought itself, as it could have sent through a tunnel the policy allows.
      if (!open) return refuse(403, `This request carries its own credential, and this workspace's network policy doesn't allow ${host}; leave GH_TOKEN as Pistead sets it`);
      headers.authorization = supplied;
      reason = "the command's own credential";
    } else {
      const repository = restRepository(pathname);
      // Only a grant that names the API comes with a credential for it; the placeholder goes no further either way.
      const available: ApiCredentialGrant = grant.apis?.some(api => api.host === host) ? await this.#credential(host)
        : { available: false, reason: "Pistead gives this session no credential for the GitHub API (only sessions that clone their repositories get one)", cacheSeconds: 0 };
      credential = available.available ? credentialFor(available.credentials, repository, owner) : undefined;
      if (credential) {
        headers.authorization = credential.authorization;
        reason = `read-only token for ${credential.account}`;
      } else if (open) reason = "without a credential";
      else if (!available.available) return refuse(403, `${available.reason}; ${host} is reachable only with that credential under this workspace's network policy`);
      else return refuse(403, `${repository} is not one of this workspace's repositories that the session owner can read`);
    }

    let upstream: UpstreamResponse;
    try {
      upstream = await this.#upstream({ url: new URL(`https://${host}${path}`), method, headers, ...(payload ? { body: payload } : {}) });
      // Downloads GitHub points elsewhere are fetched here, without the credential.
      // Each hop's Location is relative to the URL that answered it.
      let current = new URL(`https://${host}${path}`);
      for (let hop = 0; method === "GET" && hop < REDIRECTS && [301, 302, 303, 307, 308].includes(upstream.status); hop++) {
        let location: URL;
        try { location = new URL(String(upstream.headers.location ?? ""), current); } catch { break; }
        if (location.protocol !== "https:" || location.username || location.password || !GITHUB_DOWNLOAD_HOSTS.some(pattern => pattern.test(location.hostname))) break;
        upstream.body.resume();
        const follow: Record<string, string> = {};
        for (const name of ["accept", "user-agent", "range"]) if (headers[name]) follow[name] = headers[name]!;
        upstream = await this.#upstream({ url: location, method: "GET", headers: { ...follow, host: location.host } });
        reason += `, then ${location.hostname.slice(0, 100)}`;
        current = location;
      }
    } catch (error) {
      return refuse(502, error instanceof RunnerError ? error.message : `${host} could not be reached`);
    }
    // A credential GitHub no longer takes is asked for again at the next request.
    if (upstream.status === 401 && credential) this.#credentials.delete(host);
    this.#options.record({ target, outcome: "allowed", reason: `${reason} (${upstream.status})` });
    const answer: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && (!HOP_BY_HOP.has(name) || name === "content-length")) answer[name] = value;
    }
    response.writeHead(upstream.status, answer);
    response.once("close", () => upstream.body.destroy());
    upstream.body.on("error", () => response.destroy());
    upstream.body.pipe(response);
  }
}
