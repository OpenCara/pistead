import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EgressProxy, parseEgressGrant, type RelayRequest } from "../apps/runner/src/egress.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { EgressGrant, EgressRepository } from "../packages/shared/src/network.js";

const repository = { bindingId: "binding-app", provider: "github", host: "github.com", repositoryId: "1701", fullName: "acme/app" } as const;
const lfsRepository = { ...repository, lfs: true } as const;
const oid = "a".repeat(64), missing = "b".repeat(64);
const batchPath = "/git/github.com/acme/app.git/info/lfs/objects/batch";

function grant(repositories: EgressRepository[]): EgressGrant {
  return { policy: { mode: "off", domains: [], packageRegistries: true }, repositories };
}

async function proxy(t: TestContext, options: { grant: () => Promise<EgressGrant>; relay?: (request: RelayRequest) => Promise<Response> }) {
  const directory = await mkdtemp(join(tmpdir(), "egress-lfs-"));
  const relayed: RelayRequest[] = [];
  const instance = new EgressProxy({
    socketPath: join(directory, "proxy.sock"),
    grant: options.grant,
    relay: async request => {
      relayed.push(request);
      if (options.relay) return options.relay(request);
      return new Response("advertisement", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await instance.start();
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { instance, relayed };
}

function send(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: init.method ?? "GET", headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

/** A git-lfs batch request, as git-lfs sends it. */
function batch(socketPath: string, path: string, body: unknown) {
  return send(socketPath, path, { method: "POST", headers: { "content-type": "application/vnd.git-lfs+json; charset=utf-8", accept: "application/vnd.git-lfs+json" }, body: JSON.stringify(body) });
}
function message(response: { body: string }): string {
  return (JSON.parse(response.body) as { message: string }).message;
}
function lfsQuery(socketPath: string, remote: string) {
  return send(socketPath, `/__pistead/lfs?remote=${encodeURIComponent(remote)}`).then(response => JSON.parse(response.body) as { lfs: boolean });
}
function relayedBody(request: RelayRequest): unknown {
  return JSON.parse(Buffer.from(request.body as Uint8Array).toString("utf8"));
}

test("grants carry each repository's Git LFS setting, as a boolean only", () => {
  const policy = { mode: "off", domains: [], packageRegistries: true } as const;
  assert.deepEqual(parseEgressGrant({ policy, repositories: [lfsRepository] }).repositories[0], lfsRepository);
  // Off, and a control plane from before the setting, are the same: no LFS.
  assert.equal(parseEgressGrant({ policy, repositories: [{ ...repository, lfs: false }] }).repositories[0]!.lfs, undefined);
  assert.equal(parseEgressGrant({ policy, repositories: [repository] }).repositories[0]!.lfs, undefined);
  assert.throws(() => parseEgressGrant({ policy, repositories: [{ ...repository, lfs: "yes" }] }), /Invalid repositories/);
});

test("Git LFS requests of a repository with LFS off are refused in git-lfs's own format, without reaching the relay", async t => {
  const { instance, relayed } = await proxy(t, { grant: async () => grant([repository]) });
  const refused = await batch(instance.socketPath, batchPath, { operation: "download", transfers: ["basic"], objects: [{ oid, size: 3 }] });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["content-type"], "application/vnd.git-lfs+json");
  assert.match(message(refused), /Git LFS is off for acme\/app/);
  assert.equal((await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=3`)).status, 403);
  assert.deepEqual(await lfsQuery(instance.socketPath, "https://github.com/acme/app.git"), { lfs: false });
  assert.equal(relayed.length, 0);
});

test("Git LFS downloads go through the relay, and git-lfs is pointed back at the proxy, never at the provider", async t => {
  const { instance, relayed } = await proxy(t, {
    grant: async () => grant([lfsRepository]),
    relay: async request => request.service === "lfs-batch"
      ? Response.json({ objects: [{ oid, size: 3, download: true }, { oid: missing, size: 5, download: false, error: { code: 404, message: "Object does not exist on the server" } }] })
      : new Response("big", { headers: { "content-type": "application/octet-stream" } }),
  });
  // The git shim asks before a clone, with the remote in whichever form the agent wrote it.
  for (const remote of ["https://github.com/acme/app.git", "git@github.com:acme/app.git", "http://127.0.0.1:41080/git/github.com/ACME/app"]) {
    assert.deepEqual(await lfsQuery(instance.socketPath, remote), { lfs: true }, remote);
  }
  assert.deepEqual(await lfsQuery(instance.socketPath, "https://github.com/acme/other.git"), { lfs: false });

  const answer = await batch(instance.socketPath, batchPath, {
    operation: "download", transfers: ["lfs-standalone-file", "basic", "ssh"], ref: { name: "refs/heads/main" }, hash_algo: "sha256",
    objects: [{ oid, size: 3 }, { oid: missing, size: 5 }],
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["content-type"], "application/vnd.git-lfs+json");
  assert.deepEqual(JSON.parse(answer.body), {
    transfer: "basic", hash_algo: "sha256",
    objects: [
      { oid, size: 3, authenticated: true, actions: { download: { href: `http://127.0.0.1:41080/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=3` } } },
      { oid: missing, size: 5, error: { code: 404, message: "Object does not exist on the server" } },
    ],
  });
  assert.deepEqual([relayed[0]!.bindingId, relayed[0]!.service, relayed[0]!.contentType], ["binding-app", "lfs-batch", "application/json"]);
  // Only what the relay checks goes on: each object's id and size, and the ref.
  assert.deepEqual(relayedBody(relayed[0]!), { objects: [{ oid, size: 3 }, { oid: missing, size: 5 }], ref: "refs/heads/main" });

  const object = await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=3`);
  assert.equal(object.status, 200);
  assert.equal(object.body, "big");
  assert.equal(object.headers["content-type"], "application/octet-stream");
  assert.deepEqual([relayed[1]!.service, relayedBody(relayed[1]!)], ["lfs-object", { oid, size: 3 }]);
  assert.equal(relayed.length, 2);
  const status = JSON.parse((await send(instance.socketPath, "/__pistead/status")).body) as { lfs: string[] };
  assert.deepEqual(status.lfs, ["https://github.com/acme/app.git"]);
});

test("Git LFS uploads, locks, other repositories and malformed requests are refused before the relay", async t => {
  const { instance, relayed } = await proxy(t, { grant: async () => grant([lfsRepository]) });
  const upload = await batch(instance.socketPath, batchPath, { operation: "upload", objects: [{ oid, size: 3 }] });
  assert.equal(upload.status, 403);
  assert.match(message(upload), /uploads are not supported/);
  const locks = await batch(instance.socketPath, "/git/github.com/acme/app.git/info/lfs/locks/verify", { ref: { name: "refs/heads/main" } });
  assert.equal(locks.status, 403);
  assert.match(message(locks), /uploads and locks are not supported/);
  const other = await batch(instance.socketPath, "/git/github.com/acme/other.git/info/lfs/objects/batch", { operation: "download", objects: [{ oid, size: 3 }] });
  assert.equal(other.status, 403);
  assert.match(message(other), /not one of this workspace's repositories/);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", transfers: ["ssh"], objects: [{ oid, size: 3 }] })).status, 422);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", hash_algo: "sha1", objects: [{ oid, size: 3 }] })).status, 422);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", objects: [{ oid: "not-a-sha256", size: 3 }] })).status, 422);
  assert.equal((await batch(instance.socketPath, batchPath, { operation: "download", objects: Array.from({ length: 101 }, () => ({ oid, size: 3 })) })).status, 413);
  assert.equal((await send(instance.socketPath, batchPath, { method: "POST", body: "{" })).status, 400);
  assert.equal((await send(instance.socketPath, batchPath)).status, 405);
  assert.equal((await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}?size=-1`)).status, 400);
  assert.equal((await send(instance.socketPath, `/git/github.com/acme/app.git/info/lfs/objects/${oid}`)).status, 400);
  assert.equal(relayed.length, 0);
});

test("a repository whose path looks like an LFS endpoint is still fetched with Git", async t => {
  const named = { bindingId: "binding-info", provider: "github", host: "github.com", repositoryId: "1702", fullName: "info/lfs" } as const;
  const { instance, relayed } = await proxy(t, { grant: async () => grant([named]) });
  assert.equal((await send(instance.socketPath, "/git/github.com/info/lfs/info/refs?service=git-upload-pack")).status, 200);
  assert.deepEqual(relayed.map(request => [request.bindingId, request.service]), [["binding-info", "info-refs"]]);
});

test("the relay's refusal of an LFS request reaches git-lfs as its message", async t => {
  const { instance } = await proxy(t, {
    grant: async () => grant([lfsRepository]),
    relay: async () => { throw new RunnerError(403, "Git LFS is off for acme/app in this workspace"); },
  });
  const refused = await batch(instance.socketPath, batchPath, { operation: "download", objects: [{ oid, size: 3 }] });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["content-type"], "application/vnd.git-lfs+json");
  assert.match(message(refused), /Git LFS is off/);
});

test("an invalid answer from the control plane is refused rather than passed to git-lfs", async t => {
  const { instance } = await proxy(t, {
    grant: async () => grant([lfsRepository]),
    // One object asked for, two answered: never trusted.
    relay: async () => Response.json({ objects: [{ oid, size: 3, download: true }, { oid: missing, size: 5, download: true }] }),
  });
  const refused = await batch(instance.socketPath, batchPath, { operation: "download", objects: [{ oid, size: 3 }] });
  assert.equal(refused.status, 502);
  assert.match(message(refused), /invalid Git LFS answer/);
});
