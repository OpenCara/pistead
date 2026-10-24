import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { trustForwardedHeaders } from "../apps/server/src/forwarded.js";

type AdaptorFetch = Parameters<typeof createAdaptorServer>[0]["fetch"];

/** Serves `fetch` through the node adaptor as main.ts does, so requests are its lightweight stand-ins. */
async function serve(fetch: AdaptorFetch): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createAdaptorServer({ overrideGlobalObjects: false, fetch });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(done => { server.close(() => done()); }),
  };
}

const echo = trustForwardedHeaders(async request => Response.json({
  url: request.url,
  method: request.method,
  header: request.headers.get("x-test"),
  body: request.method === "GET" ? null : await request.text(),
}));

/**
 * Node 26.12's undici brand-checks the `duplex` getter (older releases return "half" for any `this`), which is what
 * broke `new Request(url, adaptorRequest)` (#71). The test runs on the repository's Node, so it installs the stricter
 * getter: `url` has always been brand-checked.
 */
async function withBrandCheckedDuplex(run: () => Promise<void>): Promise<void> {
  const duplex = Object.getOwnPropertyDescriptor(Request.prototype, "duplex");
  const url = Object.getOwnPropertyDescriptor(Request.prototype, "url")!.get!;
  Object.defineProperty(Request.prototype, "duplex", {
    configurable: true,
    enumerable: duplex?.enumerable ?? true,
    get(this: Request) { url.call(this); return duplex?.get?.call(this) ?? "half"; },
  });
  try { await run(); } finally {
    if (duplex) Object.defineProperty(Request.prototype, "duplex", duplex);
    else delete (Request.prototype as { duplex?: unknown }).duplex;
  }
}

test("a request forwarded over https reaches the app at its https URL, on Node 26's stricter Request", async () => {
  await withBrandCheckedDuplex(async () => {
    // The simulation reproduces the bug: passing the adaptor's request as a RequestInit fails.
    const old = await serve((request, bindings) => {
      const incoming = bindings.incoming as { url: string };
      return Response.json(new Request(`https://example.test${incoming.url}`, request).url);
    });
    try {
      assert.equal((await fetch(`${old.origin}/x`, { headers: { "x-forwarded-proto": "https" } })).status, 500);
    } finally { await old.close(); }

    const server = await serve(echo);
    try {
      const plain = await fetch(`${server.origin}/api/health?a=1`, { headers: { "x-test": "plain" } });
      assert.equal(plain.status, 200);
      assert.deepEqual(await plain.json(), { url: `${server.origin}/api/health?a=1`, method: "GET", header: "plain", body: null });

      const proxied = await fetch(`${server.origin}/api/health?a=1`, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "pistead.example", "x-test": "proxied" } });
      assert.equal(proxied.status, 200);
      assert.deepEqual(await proxied.json(), { url: "https://pistead.example/api/health?a=1", method: "GET", header: "proxied", body: null });

      const posted = await fetch(`${server.origin}/api/things`, { method: "POST", body: "payload ".repeat(10_000), headers: { "x-forwarded-proto": "https, http", "x-test": "posted" } });
      assert.equal(posted.status, 200);
      assert.deepEqual(await posted.json(), { url: `${server.origin.replace("http:", "https:")}/api/things`, method: "POST", header: "posted", body: "payload ".repeat(10_000) });

      const head = await fetch(`${server.origin}/`, { method: "HEAD", headers: { "x-forwarded-proto": "https" } });
      assert.equal(head.status, 200);
    } finally { await server.close(); }
  });
});

test("the forwarded request still aborts when the client goes away", async () => {
  const { promise: aborted, resolve: abort } = Promise.withResolvers<void>();
  const { promise: received, resolve: receive } = Promise.withResolvers<void>();
  const server = await serve(trustForwardedHeaders(request => {
    request.signal.addEventListener("abort", () => abort(), { once: true });
    receive();
    return new Response(new ReadableStream({ start() {} }));
  }));
  try {
    const client = new AbortController();
    const response = fetch(`${server.origin}/api/stream`, { headers: { "x-forwarded-proto": "https" }, signal: client.signal });
    await received;
    client.abort();
    await assert.rejects(response.then(r => r.text()));
    await aborted;
  } finally { await server.close(); }
});

test("a malformed forwarded host is a 400, not a bare 500", async () => {
  const server = await serve(echo);
  try {
    const response = await fetch(`${server.origin}/`, { headers: { "x-forwarded-host": "bad host[" } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid request.", code: "invalid_request" });
  } finally { await server.close(); }
});
