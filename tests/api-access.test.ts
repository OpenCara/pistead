import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { githubApiRule, graphqlWrites, parseApiCredentialGrant, restRepository, type UpstreamRequest, type UpstreamResponse } from "../apps/runner/src/api-access.js";
import { EgressProxy, egressEnvironment, parseEgressGrant, type EgressEntry } from "../apps/runner/src/egress.js";
import { InterceptionAuthority } from "../apps/runner/src/interception-ca.js";
import { API_TOKEN_PLACEHOLDER, type ApiCredentialGrant, type EgressGrant, type NetworkPolicy } from "../packages/shared/src/network.js";

const authority = new InterceptionAuthority(["api.github.com"]);
const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
const credentials: ApiCredentialGrant = { available: true, cacheSeconds: 60, credentials: [
  { account: "acme", authorization: "Bearer ghs_acme", repositories: ["acme/app"], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  { account: "tools", authorization: "Bearer ghs_tools", repositories: ["tools/cli"], expiresAt: new Date(Date.now() + 3600_000).toISOString() },
] };

interface Answer { status: number; headers?: Record<string, string>; body?: string }
async function proxy(t: TestContext, options: { policy?: Partial<NetworkPolicy>; apis?: boolean; credential?: () => Promise<unknown>;
  answer?: (request: UpstreamRequest) => Answer } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "api-"));
  const upstream: UpstreamRequest[] = [];
  const asked: string[] = [];
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    grant: async (): Promise<EgressGrant> => ({ policy: { mode: "off", domains: [], packageRegistries: false, ...options.policy }, repositories: [repository],
      ...(options.apis === false ? {} : { apis: [{ host: "api.github.com", provider: "github" }] }) }),
    relay: async () => new Response("unused"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: () => { throw new Error("A credentialed API is never tunnelled"); },
    apiCredential: async host => { asked.push(host); return options.credential ? options.credential() : credentials; },
    apiAuthority: authority,
    apiUpstream: async (request): Promise<UpstreamResponse> => {
      upstream.push(request);
      const answer = options.answer?.(request) ?? { status: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}" };
      return { status: answer.status, headers: answer.headers ?? {}, body: Readable.from([Buffer.from(answer.body ?? "")]) };
    },
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const log = () => instance.entries().filter((entry: EgressEntry) => entry.kind === "api");
  return { instance, upstream, asked, log, socketPath: instance.socketPath };
}

/** A CONNECT through the proxy's socket, then TLS that trusts only the proxy's authority, as a sandboxed client does. */
function connect(socketPath: string, host = "api.github.com"): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method: "CONNECT", path: `${host}:443` });
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) return reject(new Error(`CONNECT ${response.statusCode}`));
      const secure = tlsConnect({ socket, servername: host, ca: authority.certificate, ALPNProtocols: ["h2", "http/1.1"] }, () => resolve(secure));
      secure.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function call(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {})
  : Promise<{ status: number; headers: IncomingHttpHeaders; body: string; protocol: string | false }> {
  const socket = await connect(socketPath);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ createConnection: () => socket, method: init.method ?? "GET", path,
      headers: { host: "api.github.com", authorization: `token ${API_TOKEN_PLACEHOLDER}`, "user-agent": "GitHub CLI 2.80.0", ...init.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => { resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), protocol: socket.alpnProtocol ?? false }); socket.destroy(); });
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

test("the proxy's authority vouches only for the credentialed API hosts, for strict clients too", async t => {
  const ca = new X509Certificate(authority.certificate);
  assert.equal(ca.ca, true);
  const leaf = authority.issue("api.github.com");
  const certificate = new X509Certificate(leaf.certificate);
  assert.ok(certificate.verify(ca.publicKey));
  assert.equal(certificate.checkHost("api.github.com"), "api.github.com");
  assert.equal(certificate.checkHost("github.com"), undefined);
  assert.equal(certificate.ca, false);
  assert.throws(() => authority.context("example.com"), /doesn't answer for example\.com/);

  // OpenSSL's strict checks (as Python 3.13 applies them) accept it, and the name constraint refuses any other host
  // even with a certificate the authority itself signed.
  const openssl = spawnSync("openssl", ["version"]).status === 0;
  if (!openssl) return t.diagnostic("openssl is not installed: strict verification not checked");
  const directory = await mkdtemp(join(tmpdir(), "ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "ca.pem"), authority.certificate);
  await writeFile(join(directory, "leaf.pem"), leaf.certificate);
  await writeFile(join(directory, "other.pem"), authority.issue("evil.example").certificate);
  const verify = (file: string) => spawnSync("openssl", ["verify", "-x509_strict", "-CAfile", join(directory, "ca.pem"), join(directory, file)], { encoding: "utf8" });
  assert.equal(verify("leaf.pem").status, 0, verify("leaf.pem").stderr);
  const other = verify("other.pem");
  assert.notEqual(other.status, 0);
  assert.match(`${other.stdout}${other.stderr}`, /permitted subtree violation/);
});

test("sandboxed commands get a placeholder GitHub token, never a real one", () => {
  const environment = egressEnvironment();
  assert.equal(environment.GH_TOKEN, API_TOKEN_PLACEHOLDER);
  assert.equal(environment.GITHUB_TOKEN, API_TOKEN_PLACEHOLDER);
});

test("GitHub API reads get the session's read-only token at the proxy, whatever the network policy", async t => {
  const { socketPath, upstream, asked, log } = await proxy(t);
  const answer = await call(socketPath, "/repos/acme/app/actions/runs/40860931084?per_page=1");
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "{\"ok\":true}");
  // HTTP/1.1 even for a client that offers h2, such as gh.
  assert.equal(answer.protocol, "http/1.1");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0]!.url.href, "https://api.github.com/repos/acme/app/actions/runs/40860931084?per_page=1");
  assert.equal(upstream[0]!.method, "GET");
  assert.equal(upstream[0]!.headers.authorization, "Bearer ghs_acme");
  assert.equal(upstream[0]!.headers.host, "api.github.com");
  assert.equal(upstream[0]!.headers["user-agent"], "GitHub CLI 2.80.0");
  assert.doesNotMatch(JSON.stringify(upstream[0]!.headers), new RegExp(API_TOKEN_PLACEHOLDER));
  assert.deepEqual(asked, ["api.github.com"]);
  assert.deepEqual(log().map(entry => [entry.target, entry.outcome, entry.reason]),
    [["GET api.github.com/repos/acme/app/actions/runs/40860931084", "allowed", "read-only token for acme (200)"]]);

  // Another installation's repository gets its own token, and the credential is reused for a minute.
  await call(socketPath, "/repos/Tools/CLI/pulls");
  assert.equal(upstream[1]!.headers.authorization, "Bearer ghs_tools");
  assert.deepEqual(asked, ["api.github.com"]);
});

test("writes are refused at the proxy and never reach GitHub", async t => {
  const { socketPath, upstream, log } = await proxy(t, { policy: { mode: "open" } });
  for (const [method, path] of [["POST", "/repos/acme/app/issues/1/comments"], ["PATCH", "/repos/acme/app/pulls/2"], ["DELETE", "/repos/acme/app/git/refs/heads/main"],
    ["PUT", "/repos/acme/app/pulls/2/merge"]] as const) {
    const answer = await call(socketPath, path, { method, body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(answer.status, 403, `${method} ${path}`);
    assert.match(JSON.parse(answer.body).message, /only read through the GitHub API.*github_comment/);
  }
  const mutation = await call(socketPath, "/graphql", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "# merge it\nmutation Merge($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", variables: { id: "x" } }) });
  assert.equal(mutation.status, 403);
  assert.match(JSON.parse(mutation.body).message, /^GraphQL mutations: /);
  assert.equal(upstream.length, 0);
  assert.equal(log().every(entry => entry.outcome === "refused"), true);
});

test("GraphQL queries are read with the token of the owner they name", async t => {
  const { socketPath, upstream } = await proxy(t);
  const query = "query PullRequest($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { pullRequest(number: 1) { title } } }";
  const body = JSON.stringify({ query, variables: { owner: "tools", repo: "cli" } });
  const answer = await call(socketPath, "/graphql", { method: "POST", body, headers: { "content-type": "application/json" } });
  assert.equal(answer.status, 200);
  assert.equal(upstream[0]!.headers.authorization, "Bearer ghs_tools");
  assert.equal(Buffer.from(upstream[0]!.body!).toString("utf8"), body);
  // A query naming no owner gets the first installation's.
  await call(socketPath, "/graphql", { method: "POST", body: JSON.stringify({ query: "{ viewer { login } }" }), headers: { "content-type": "application/json" } });
  assert.equal(upstream[1]!.headers.authorization, "Bearer ghs_acme");
  assert.equal((await call(socketPath, "/graphql", { method: "POST", body: "not json" })).status, 400);
});

test("other repositories, and requests carrying their own credential, follow the network policy", async t => {
  const closed = await proxy(t);
  const other = await call(closed.socketPath, "/repos/someone/else/issues");
  assert.equal(other.status, 403);
  assert.match(JSON.parse(other.body).message, /someone\/else is not one of this workspace's repositories/);
  const own = await call(closed.socketPath, "/repos/acme/app", { headers: { authorization: "token ghp_their_own" } });
  assert.equal(own.status, 403);
  assert.match(JSON.parse(own.body).message, /carries its own credential/);
  assert.equal(closed.upstream.length, 0);

  const open = await proxy(t, { policy: { mode: "allowlist", domains: ["api.github.com"] } });
  await call(open.socketPath, "/repos/someone/else/issues");
  assert.equal(open.upstream[0]!.headers.authorization, undefined, "other repositories are read without a credential");
  await call(open.socketPath, "/repos/acme/app", { headers: { authorization: "token ghp_their_own" } });
  assert.equal(open.upstream[1]!.headers.authorization, "token ghp_their_own");
  assert.deepEqual(open.log().map(entry => entry.reason), ["without a credential (200)", "the command's own credential (200)"]);
});

test("without a credential from Pistead, the proxy says why", async t => {
  const reason = "Reading the GitHub API from sessions needs a GitHub App";
  const { socketPath, upstream } = await proxy(t, { credential: async () => ({ available: false, reason, cacheSeconds: 60 }) });
  const answer = await call(socketPath, "/repos/acme/app/actions/runs");
  assert.equal(answer.status, 403);
  assert.match(JSON.parse(answer.body).message, new RegExp(`^${reason}; api\\.github\\.com is reachable only with that credential`));
  assert.equal(upstream.length, 0);

  // An unreachable control plane is the same, briefly cached.
  const failing = await proxy(t, { credential: async () => { throw new Error("offline"); } });
  assert.equal((await call(failing.socketPath, "/repos/acme/app")).status, 403);
});

test("downloads GitHub redirects to its storage are fetched by the proxy without the credential; other redirects pass", async t => {
  const { socketPath, upstream } = await proxy(t, { answer: (request): Answer => {
    if (request.url.pathname.endsWith("/logs")) return { status: 302, headers: { location: "https://results-receiver.actions.githubusercontent.com/logs/1?sig=abc" } };
    if (request.url.pathname.endsWith("/elsewhere")) return { status: 302, headers: { location: "https://evil.example/collect" } };
    if (request.url.hostname !== "api.github.com") return { status: 200, headers: { "content-type": "text/plain" }, body: "2026-10-29T11:09:42Z Unable to resolve \"./types.js\"" };
    return { status: 200 };
  } });
  const logs = await call(socketPath, "/repos/acme/app/actions/jobs/123405325811/logs");
  assert.equal(logs.status, 200);
  assert.match(logs.body, /Unable to resolve/);
  assert.equal(upstream[1]!.url.href, "https://results-receiver.actions.githubusercontent.com/logs/1?sig=abc");
  assert.equal(upstream[1]!.headers.authorization, undefined);
  const elsewhere = await call(socketPath, "/repos/acme/app/elsewhere");
  assert.equal(elsewhere.status, 302);
  assert.equal(elsewhere.headers.location, "https://evil.example/collect");
  assert.equal(upstream.length, 3);
});

test("without the API in its grant (a pinned session, an older control plane), the placeholder never reaches GitHub", async t => {
  const closed = await proxy(t, { apis: false });
  const refused = await call(closed.socketPath, "/repos/acme/app/releases/latest");
  assert.equal(refused.status, 403);
  assert.match(JSON.parse(refused.body).message, /^Pistead gives this session no credential for the GitHub API/);
  assert.deepEqual(closed.asked, [], "no credential is asked for");
  assert.equal(closed.upstream.length, 0);

  // Where the policy allows api.github.com, requests go on as they did through a tunnel, without the placeholder.
  const open = await proxy(t, { apis: false, policy: { mode: "open" } });
  assert.equal((await call(open.socketPath, "/repos/acme/app/releases/latest")).status, 200);
  assert.equal(open.upstream[0]!.headers.authorization, undefined);
  assert.deepEqual(open.asked, []);
});

test("grants keep only the credentialed APIs this connector knows; credentials parse strictly", () => {
  const policy = { mode: "off", domains: [], packageRegistries: false };
  assert.deepEqual(parseEgressGrant({ policy, repositories: [], apis: [{ host: "api.github.com", provider: "github" }, { host: "management.azure.com", provider: "azure" }] }).apis,
    [{ host: "api.github.com", provider: "github" }]);
  assert.equal(parseEgressGrant({ policy, repositories: [] }).apis, undefined);
  assert.throws(() => parseEgressGrant({ policy, repositories: [], apis: "api.github.com" }), /Invalid APIs/);
  assert.deepEqual(parseApiCredentialGrant(credentials), credentials);
  assert.throws(() => parseApiCredentialGrant({ ...credentials, credentials: [{ ...credentials.credentials[0], authorization: "Bearer a\nb" }] }), /Invalid API credential/);
  assert.throws(() => parseApiCredentialGrant({ available: true, cacheSeconds: 60, credentials: [] }), /Invalid API credential/);
});

test("the GitHub rules: reads and GraphQL queries pass, writes and mutations don't", () => {
  assert.deepEqual(githubApiRule("GET", "/repos/a/b"), { kind: "read" });
  assert.deepEqual(githubApiRule("HEAD", "/"), { kind: "read" });
  assert.deepEqual(githubApiRule("POST", "/graphql"), { kind: "graphql" });
  assert.ok("refused" in githubApiRule("POST", "/repos/a/b/issues"));
  assert.equal(graphqlWrites("query { viewer { login } }"), false);
  assert.equal(graphqlWrites("{ repository(owner: \"a\", name: \"mutation\") { id } }"), false);
  assert.equal(graphqlWrites("# mutation in a comment\nquery { viewer { login } }"), false);
  assert.equal(graphqlWrites("mutation { addComment(input: {}) { clientMutationId } }"), true);
  assert.equal(graphqlWrites("query A { viewer { login } }\nmutation B { x }"), true);
  assert.equal(graphqlWrites("  subscription S { x }"), true);
  assert.equal(restRepository("/repos/acme/app/actions/runs"), "acme/app");
  assert.equal(restRepository("/repos/acme"), undefined);
  assert.equal(restRepository("/user"), undefined);
});
