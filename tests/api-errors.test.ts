import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi } from "../packages/client/src/api.js";

function answering(response: () => Response) {
  return createApi({ auth: () => null, fetch: async () => response() });
}

async function failure(response: () => Response): Promise<ApiError> {
  try {
    await answering(response)("/api/test");
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error;
  }
  throw new Error("expected the request to fail");
}

test("Pistead's own errors keep their message and code", async () => {
  const error = await failure(() => Response.json({ error: "The move target is archived.", code: "session_archived" }, { status: 409 }));
  assert.equal(error.message, "The move target is archived.");
  assert.equal(error.code, "session_archived");
  assert.equal(error.status, 409);
  const nested = await failure(() => Response.json({ error: { code: "x", message: "Nested message." } }, { status: 400 }));
  assert.equal(nested.message, "Nested message.");
  assert.equal(nested.code, "x");
});

test("a proxy's JSON 502 names the status and what the proxy said", async () => {
  const error = await failure(() => Response.json({ status: "error", code: 502, message: "Application failed to respond", request_id: "abc" }, { status: 502 }));
  assert.equal(error.status, 502);
  assert.equal(error.code, "BACKEND_UNAVAILABLE");
  assert.match(error.message, /HTTP 502 Bad Gateway: "Application failed to respond"/);
  assert.match(error.message, /proxy in front of Pistead/);
  assert.match(error.message, /check the result before retrying/);
  assert.doesNotMatch(error.message, /Request failed \(502\)/);
});

test("a proxy's HTML timeout page is reduced to its title", async () => {
  const page = "<!DOCTYPE html><html><head><title>504 Gateway Time-out</title><script>alert(1)</script></head><body><h1>504 Gateway Time-out</h1></body></html>";
  const error = await failure(() => new Response(page, { status: 504, headers: { "Content-Type": "text/html" } }));
  assert.equal(error.code, "UPSTREAM_TIMEOUT");
  assert.match(error.message, /HTTP 504 Gateway Timeout: "504 Gateway Time-out"/);
  assert.match(error.message, /may have accepted it/);
  assert.doesNotMatch(error.message, /[<>]|alert/);
});

test("an empty or unparseable error body still says what status came back", async () => {
  const empty = await failure(() => new Response(null, { status: 502 }));
  assert.match(empty.message, /^The proxy in front of Pistead got no valid answer from the server \(HTTP 502 Bad Gateway\)\./);
  const broken = await failure(() => new Response("upstream connect error or disconnect/reset before headers", { status: 503, headers: { "Content-Type": "application/json" } }));
  assert.match(broken.message, /HTTP 503 Service Unavailable: "upstream connect error or disconnect\/reset before headers"/);
  const notFound = await failure(() => Response.json({}, { status: 404 }));
  assert.equal(notFound.message, "The request failed before reaching Pistead's API (HTTP 404 Not Found).");
});

test("rate limits and long proxy pages stay short and plain", async () => {
  const limited = await failure(() => new Response("Too many requests, slow down", { status: 429, headers: { "Content-Type": "text/plain" } }));
  assert.equal(limited.code, "RATE_LIMITED");
  assert.match(limited.message, /HTTP 429 Too Many Requests: "Too many requests, slow down"/);
  const long = await failure(() => new Response("x".repeat(5000), { status: 502, headers: { "Content-Type": "text/plain" } }));
  assert.ok(long.message.length < 500);
});

test("no markup survives, whether literal, entity-encoded or in tags the page doesn't usually use", async () => {
  const encoded = await failure(() => new Response("<pre>&lt;b&gt;bold&lt;/b&gt; &amp;lt;i&amp;gt; Tom &amp; Jerry</pre>", { status: 502, headers: { "Content-Type": "text/html" } }));
  assert.match(encoded.message, /: "bold &lt;i&gt; Tom & Jerry"/);
  const encodedScript = await failure(() => Response.json({ message: "&lt;script&gt;alert(1)&lt;/script&gt;Origin down" }, { status: 502 }));
  assert.match(encodedScript.message, /: "Origin down"/);
  assert.doesNotMatch(encoded.message, /[<>]/);
  const h2 = await failure(() => new Response("<h2>Upstream <em>unavailable</em></h2>", { status: 503, headers: { "Content-Type": "text/html" } }));
  assert.match(h2.message, /: "Upstream unavailable"/);
  const json = await failure(() => Response.json({ message: "<script>x</script>broken" }, { status: 502 }));
  assert.doesNotMatch(json.message, /[<>]/);
});

test("an empty title falls back to the page's heading", async () => {
  const page = "<html><head><title> </title></head><body><h1>Origin <b>down</b></h1></body></html>";
  const error = await failure(() => new Response(page, { status: 502, headers: { "Content-Type": "text/html" } }));
  assert.match(error.message, /: "Origin down"/);
});

test("proxy JSON quotes a useful field or a bare string, never a bare status word", async () => {
  const status = await failure(() => Response.json({ status: "error", code: 502 }, { status: 502 }));
  assert.match(status.message, /\(HTTP 502 Bad Gateway\)\./);
  const bare = await failure(() => Response.json("no healthy upstream", { status: 503 }));
  assert.match(bare.message, /HTTP 503 Service Unavailable: "no healthy upstream"/);
});

test("a successful answer cut off mid-body is described, not a bare SyntaxError", async () => {
  const error = await failure(() => new Response('{"session":{"id":', { status: 201, headers: { "Content-Type": "application/json" } }));
  assert.equal(error.code, "BACKEND_UNAVAILABLE");
  assert.match(error.message, /incomplete or garbled \(HTTP 201\)/);
});

test("successful JSON answers are returned as before", async () => {
  assert.deepEqual(await answering(() => Response.json({ ok: true }))("/api/test"), { ok: true });
});
