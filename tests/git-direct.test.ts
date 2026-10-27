import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EgressProxy, type RelayRequest } from "../apps/runner/src/egress.js";
import { DirectGit, parseGitDirectGrant, pinnedFetch, type ResolvedAddress } from "../apps/runner/src/git-direct.js";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { EgressGrant, GitDirectGrant, GitDirectRequest } from "../packages/shared/src/network.js";

const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app", lfs: true } as const;
const remote = "https://github.com/acme/app.git";
const later = () => new Date(Date.now() + 3600_000).toISOString();
const oid = "a".repeat(64);
const tip = "c".repeat(40);

function readGrant(extra: Partial<Extract<GitDirectGrant, { direct: true }>> = {}): GitDirectGrant {
  return { direct: true, remote, authorization: "Basic cmVwbw==", kind: "repository-token", expiresAt: later(), cacheSeconds: 60, ...extra };
}

/** A forge answering Git smart HTTP and Git LFS, recording what it was asked. */
function forge(handler?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  const calls: { url: string; method: string; authorization: string | null; protocol: string | null; signature: string | null; body: string }[] = [];
  const forgeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = init.body ? Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()).toString("latin1") : "";
    calls.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization"), protocol: headers.get("git-protocol"), signature: headers.get("x-signature"), body });
    const answer = await handler?.(url, { ...init, body });
    if (answer) return answer;
    if (url === `${remote}/info/refs?service=git-upload-pack`) return new Response("advertisement", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    if (url === `${remote}/git-upload-pack`) return new Response("PACK", { headers: { "content-type": "application/x-git-upload-pack-result" } });
    if (url === `${remote}/info/refs?service=git-receive-pack`) return new Response("refs", { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
    if (url === `${remote}/git-receive-pack`) return new Response("report", { headers: { "content-type": "application/x-git-receive-pack-result" } });
    if (url === `${remote}/info/lfs/objects/batch`) {
      const request = JSON.parse(body) as { objects: { oid: string; size: number }[] };
      return Response.json({ transfer: "basic", objects: request.objects.map(object => ({ oid: object.oid, size: 3,
        actions: { download: { href: `https://media.example.com/${object.oid}`, header: { "X-Signature": "signed" } } } })) });
    }
    if (url === `https://media.example.com/${oid}`) return new Response("big", { headers: { "content-length": "3" } });
    if (url === "https://api.github.com/installation/token") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  return { calls, fetch: forgeFetch };
}

/** Names the tests' forge points downloads at: public ones, and one inside the host's own network. */
const addresses: Record<string, string> = { "media.example.com": "93.184.216.34", "internal.example.com": "10.0.0.5" };

function directGit(grant: (request: Omit<GitDirectRequest, "sessionId">) => Promise<unknown>, fetch: typeof globalThis.fetch, fallbacks: string[] = [],
  pinned: { url: string; addresses: ResolvedAddress[] }[] = []) {
  const asked: Omit<GitDirectRequest, "sessionId">[] = [];
  const direct = new DirectGit({ grant: async request => { asked.push(request); return grant(request); }, fetch, onFallback: (_request, reason) => fallbacks.push(reason),
    lookup: async host => addresses[host] ? [{ address: addresses[host], family: 4 }] : [],
    // Downloads off the provider's origin connect only to the addresses checked; the tests' forge stands in for them.
    pinnedFetch: async (url, init, checked) => { pinned.push({ url: url.href, addresses: checked }); return fetch(url, init); } });
  return { direct, asked };
}

test("a direct read goes to the forge with the granted credential, and one grant serves a minute of reads", async () => {
  const upstream = forge();
  const { direct, asked } = directGit(async () => readGrant(), upstream.fetch);
  const refs = await direct.forward({ bindingId: "binding-app", service: "info-refs", userAgent: "git/2.43.0", gitProtocol: "version=2" });
  assert.ok(refs);
  assert.equal(await refs.text(), "advertisement");
  assert.equal(refs.headers.get("content-type"), "application/x-git-upload-pack-advertisement");
  assert.equal(refs.headers.get("x-pistead-transport"), "direct repository-token");
  const pack = await direct.forward({ bindingId: "binding-app", service: "upload-pack", contentType: "application/x-git-upload-pack-request",
    body: new Uint8Array(Buffer.from("0000")) });
  assert.equal(await pack!.text(), "PACK");
  assert.deepEqual(upstream.calls.map(call => [call.method, call.url, call.authorization, call.body]), [
    ["GET", `${remote}/info/refs?service=git-upload-pack`, "Basic cmVwbw==", ""],
    ["POST", `${remote}/git-upload-pack`, "Basic cmVwbw==", "0000"],
  ]);
  assert.equal(upstream.calls[0]!.protocol, "version=2");
  assert.deepEqual(asked, [{ bindingId: "binding-app", access: "read" }]);
  // A public repository is read without any credential.
  const open = directGit(async () => readGrant({ authorization: null, kind: "public" }), upstream.fetch);
  await (await open.direct.forward({ bindingId: "binding-app", service: "info-refs" }))!.text();
  assert.equal(upstream.calls.at(-1)!.authorization, null);
  // A request the forge would refuse anyway is refused before it leaves the host.
  await assert.rejects(direct.forward({ bindingId: "binding-app", service: "upload-pack", contentType: "text/plain", body: new Uint8Array() }),
    (error: unknown) => error instanceof RunnerError && error.status === 415);
});

test("the relay takes the request when the control plane says so or has no grants, and when the forge fails a read from this host", async () => {
  const upstream = forge();
  const relayed = directGit(async () => ({ direct: false, reason: "No credential limited to reading acme/app", cacheSeconds: 60 }), upstream.fetch);
  assert.equal(await relayed.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.equal(await relayed.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.equal(relayed.asked.length, 1, "the word to relay is kept as long as the control plane says");
  // An older control plane has no direct grants: it is asked once a minute, not for every request.
  const older = directGit(async () => { throw new RunnerError(404, "Not found"); }, upstream.fetch);
  assert.equal(await older.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.equal(await older.direct.forward({ bindingId: "binding-app", service: "receive-refs" }), undefined);
  assert.equal(older.asked.length, 2, "reads and pushes are asked about separately");
  assert.equal(upstream.calls.length, 0);

  // A host that reaches the control plane but not the forge relays that repository's requests for a while.
  const fallbacks: string[] = [];
  const unreachable = directGit(async () => readGrant(), (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, fallbacks);
  assert.equal(await unreachable.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.equal(await unreachable.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.deepEqual(fallbacks, ["github.com could not be reached."]);
  assert.equal(unreachable.asked.length, 1);
  // A forge that refuses the granted credential: the relay, with the owner's own account, gives the answer.
  const denied = forge(url => url.includes("info/refs") ? new Response("denied", { status: 403 }) : undefined);
  const refused = directGit(async () => readGrant(), denied.fetch, fallbacks);
  assert.equal(await refused.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.match(fallbacks.at(-1)!, /did not let the session owner's account read acme\/app/);
  // A malformed or expired grant is never used.
  const expired = directGit(async () => readGrant({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), upstream.fetch);
  assert.equal(await expired.direct.forward({ bindingId: "binding-app", service: "info-refs" }), undefined);
  assert.equal(upstream.calls.length, 0);
});

test("a direct push streams its pack to the forge, asks for each request, and revokes its token once the answer is read", async () => {
  const upstream = forge();
  const pushGrant = (): GitDirectGrant => ({ direct: true, remote, authorization: "Basic cHVzaA==", kind: "push-identity", expiresAt: later(), cacheSeconds: 0,
    revoke: { url: "https://api.github.com/installation/token", authorization: "Bearer ghs_push" } });
  const { direct, asked } = directGit(async () => pushGrant(), upstream.fetch);
  const refs = await direct.forward({ bindingId: "binding-app", service: "receive-refs", userAgent: "git/2.43.0" });
  assert.equal(await refs!.text(), "refs");
  const command = { old: "0".repeat(40), new: tip, ref: "refs/heads/pistead/session" };
  const pack = new Blob(["0000PACK-DATA"]).stream();
  const pushed = await direct.forward({ bindingId: "binding-app", service: "receive-pack", contentType: "application/x-git-receive-pack-request", body: pack, command });
  assert.equal(await pushed!.text(), "report");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(asked, [{ bindingId: "binding-app", access: "push" }, { bindingId: "binding-app", access: "push", command }]);
  assert.deepEqual(upstream.calls.map(call => [call.method, call.url, call.authorization, call.body]), [
    ["GET", `${remote}/info/refs?service=git-receive-pack`, "Basic cHVzaA==", ""],
    ["DELETE", "https://api.github.com/installation/token", "Bearer ghs_push", ""],
    ["POST", `${remote}/git-receive-pack`, "Basic cHVzaA==", "0000PACK-DATA"],
    ["DELETE", "https://api.github.com/installation/token", "Bearer ghs_push", ""],
  ]);

  // A push the forge refuses is not made again through the relay: its pack has been sent. Its token is revoked anyway.
  const denied = forge(url => url.endsWith("/git-receive-pack") ? new Response("denied", { status: 403 }) : undefined);
  const refused = directGit(async () => pushGrant(), denied.fetch);
  await assert.rejects(refused.direct.forward({ bindingId: "binding-app", service: "receive-pack", contentType: "application/x-git-receive-pack-request",
    body: new Blob(["0000"]).stream(), command }), (error: unknown) => error instanceof RunnerError && error.status === 403
    && /did not let the workspace's push identity push to acme\/app/.test(error.message));
  assert.equal(denied.calls.filter(call => call.method === "DELETE").length, 1);
});

test("direct Git LFS downloads answer in the relay's own form; the provider's URLs and headers stay on the host", async () => {
  const upstream = forge();
  const pinned: { url: string; addresses: ResolvedAddress[] }[] = [];
  const { direct, asked } = directGit(async () => readGrant(), upstream.fetch, [], pinned);
  const json = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));
  const batch = await direct.forward({ bindingId: "binding-app", service: "lfs-batch", contentType: "application/json", body: json({ objects: [{ oid, size: 3 }], ref: "refs/heads/main" }) });
  assert.deepEqual(await batch!.json(), { objects: [{ oid, size: 3, download: true }] });
  const object = await direct.forward({ bindingId: "binding-app", service: "lfs-object", contentType: "application/json", body: json({ oid, size: 3 }) });
  assert.equal(await object!.text(), "big");
  assert.deepEqual(asked, [{ bindingId: "binding-app", access: "lfs" }]);
  const batches = upstream.calls.filter(call => call.url === `${remote}/info/lfs/objects/batch`);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.authorization, "Basic cmVwbw==");
  assert.deepEqual(JSON.parse(batches[0]!.body).ref, { name: "refs/heads/main" });
  // The action's own headers go to its storage; the granted credential never leaves the provider's origin.
  assert.deepEqual(upstream.calls.filter(call => call.url.startsWith("https://media.example.com/")).map(call => [call.authorization, call.signature]), [[null, "signed"]]);
  // Its storage is reached at the address that was checked, never by resolving the name again.
  assert.deepEqual(pinned, [{ url: `https://media.example.com/${oid}`, addresses: [{ address: "93.184.216.34", family: 4 }] }]);

  // A forge can't make the host download from its own networks: such an object is left to the relay.
  const inward = forge(url => url.endsWith("/info/lfs/objects/batch")
    ? Response.json({ objects: [{ oid, size: 3, actions: { download: { href: `https://internal.example.com/${oid}` } } }] }) : undefined);
  const fallbacks: string[] = [];
  const guarded = directGit(async () => readGrant(), inward.fetch, fallbacks);
  assert.equal(await guarded.direct.forward({ bindingId: "binding-app", service: "lfs-object", contentType: "application/json", body: json({ oid, size: 3 }) }), undefined);
  assert.ok(!inward.calls.some(call => call.url.startsWith("https://internal.example.com/")));
  // The refusal says why, rather than that the provider couldn't be reached.
  assert.deepEqual(fallbacks, ["internal.example.com does not resolve to a public address; Git LFS objects are downloaded only from public addresses"]);
});

test("a pinned download connects to the address that was checked and never resolves the name again", async t => {
  const connections: string[] = [];
  const server = createTcpServer(socket => { connections.push(socket.remoteAddress ?? ""); socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  // A name that resolves nowhere: only the pinned address can be reached. The TLS handshake fails against this server.
  await assert.rejects(pinnedFetch(new URL(`https://lfs.example.invalid:${port}/object`), undefined, [{ address: "127.0.0.1", family: 4 }]));
  assert.equal(connections.length, 1);
  await assert.rejects(pinnedFetch(new URL("http://lfs.example.invalid/object"), undefined, [{ address: "127.0.0.1", family: 4 }]), TypeError);
  await assert.rejects(pinnedFetch(new URL("https://lfs.example.invalid/object"), undefined, []), TypeError);
});

test("grants from the control plane are parsed strictly", () => {
  const good = readGrant();
  assert.deepEqual(parseGitDirectGrant(good), good);
  assert.deepEqual(parseGitDirectGrant({ direct: false, reason: "relay", cacheSeconds: 0 }), { direct: false, reason: "relay", cacheSeconds: 0 });
  for (const bad of [null, [], { ...good, remote: "http://github.com/acme/app.git" }, { ...good, remote: "https://user:secret@github.com/acme/app.git" },
    { ...good, kind: "admin" }, { ...good, cacheSeconds: -1 }, { ...good, authorization: "Basic x\n" }, { ...good, expiresAt: "soon" },
    { ...good, revoke: { url: "https://api.github.com/installation/token" } }, { direct: false, cacheSeconds: 60 }, { direct: "yes", cacheSeconds: 0 }]) {
    assert.throws(() => parseGitDirectGrant(bad), RunnerError, JSON.stringify(bad));
  }
});

function get(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: init.method ?? "GET", headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

/** One pkt-line of `text`. */
function pkt(text: string): string { return (Buffer.byteLength(text, "latin1") + 4).toString(16).padStart(4, "0") + text; }

async function proxyWithDirect(t: TestContext, grant: (request: Omit<GitDirectRequest, "sessionId">) => Promise<unknown>, fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), "git-direct-"));
  const relayed: RelayRequest[] = [];
  const { direct, asked } = directGit(grant, fetch);
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    grant: async (): Promise<EgressGrant> => ({ policy: { mode: "off", domains: [], packageRegistries: true }, repositories: [repository] }),
    // As a session does: the forge directly where granted, else the relay.
    relay: async request => (await direct.forward(request)) ?? (relayed.push(request), new Response("relayed", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } })),
    sessionBranch: "pistead/session",
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { instance, relayed, asked };
}

test("the egress proxy serves the sandbox from the forge directly where granted, and logs which way each request went", async t => {
  const upstream = forge();
  const { instance, relayed, asked } = await proxyWithDirect(t, async request => request.access === "push"
    ? { direct: true, remote, authorization: "Basic cHVzaA==", kind: "push-identity", expiresAt: later(), cacheSeconds: 0 }
    : readGrant(), upstream.fetch);
  const refs = await get(instance.socketPath, "/git/github.com/acme/app.git/info/refs?service=git-upload-pack", { headers: { "user-agent": "git/2.43.0" } });
  assert.deepEqual([refs.status, refs.body], [200, "advertisement"]);
  assert.equal(relayed.length, 0);
  // A push's one command, read by the proxy, goes with its grant request, for the control plane's checks and audit.
  const command = pkt(`${"0".repeat(40)} ${tip} refs/heads/pistead/session\0report-status\n`) + "0000";
  const pushed = await get(instance.socketPath, "/git/github.com/acme/app.git/git-receive-pack",
    { method: "POST", headers: { "content-type": "application/x-git-receive-pack-request" }, body: `${command}PACK` });
  assert.deepEqual([pushed.status, pushed.body], [200, "report"]);
  assert.deepEqual(asked.at(-1), { bindingId: "binding-app", access: "push", command: { old: "0".repeat(40), new: tip, ref: "refs/heads/pistead/session" } });
  assert.equal(upstream.calls.at(-1)!.body, `${command}PACK`);
  const status = JSON.parse((await get(instance.socketPath, "/__pistead/status")).body) as { recent: { reason?: string }[]; gitRemotes: string };
  assert.deepEqual(status.recent.map(entry => entry.reason), ["info-refs (direct repository-token)", "push pistead/session (direct push-identity)"]);
  assert.match(status.gitRemotes, /fetches them from the forge itself/);
  // The sandbox never sees how the answer was carried.
  const raw = await new Promise<string>((resolve, reject) => {
    const request = httpRequest({ socketPath: instance.socketPath, path: "/git/github.com/acme/app.git/info/refs?service=git-upload-pack" }, response => {
      resolve(JSON.stringify(response.headers));
      response.resume();
    });
    request.on("error", reject);
    request.end();
  });
  assert.doesNotMatch(raw, /x-pistead-transport|direct/);
});
