import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
import { decodeText, fetchPage, htmlToText, webFetchUrl, type FetchEntry } from "../apps/runner/src/web.js";
import type { UpstreamRequest } from "../apps/runner/src/api-access.js";
import { RunnerError } from "../apps/runner/src/protocol.js";
import type { NetworkPolicy } from "../packages/shared/src/network.js";
import { webLimits, webSearchCount, webSearchQuery } from "../packages/shared/src/web.js";
import { ConfigurationError, loadConfig } from "../apps/server/src/config.js";
import { webSearchConfigurationError, webSearchProvider } from "../apps/server/src/web-search.js";

const open: NetworkPolicy = { mode: "open", domains: [], packageRegistries: true };

/** A stand-in for the web: each URL's answer, and every request made. */
function web(pages: Record<string, { status?: number; headers?: IncomingHttpHeaders; body?: Buffer | string | (() => Readable) }>) {
  const requests: UpstreamRequest[] = [];
  const bodies: Readable[] = [];
  const upstream = async (request: UpstreamRequest) => {
    requests.push(request);
    const page = pages[request.url.href];
    if (!page) throw new RunnerError(502, `${request.url.hostname} does not resolve to a public address`);
    const body = typeof page.body === "function" ? page.body() : Readable.from(page.body === undefined ? [] : [Buffer.from(page.body)]);
    bodies.push(body);
    return { status: page.status ?? 200, headers: page.headers ?? {}, body };
  };
  return { upstream, requests, bodies };
}

async function refusal(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RunnerError, String(error));
    assert.equal(error.status, status, error.message);
    assert.match(error.message, message);
    return true;
  });
}

test("HTML becomes text an agent reads: headings, lists, links, code, tables; no scripts, styles or comments", () => {
  const html = `<!doctype html><html><head><title>Docs &amp; more</title><style>p { color: red }</style><script>var x = "<p>not text</p>";</script></head>
<body><nav><a href="/">Home</a> <a href="#top">Top</a> <a href="javascript:void(0)">Menu</a></nav>
<h1>Getting   started</h1><p>Read the <a href="guide?x=1&amp;y=2">guide</a>, then <code>npm install</code>.</p>
<ul><li>One</li><li>Two<ol><li>Nested</li></ol></li></ul>
<pre><code>if (a &lt; b) {
  return;
}</code></pre>
<table><tr><th>Name</th><th>Size</th></tr><tr><td>a</td><td>1</td></tr></table>
<!-- <p>hidden</p> --><p>Caf&eacute;s&nbsp;&#x2014;&#8212; &bogus; <img src="x.png" alt="A diagram"></p><noscript>Enable JS</noscript></body></html>`;
  const { title, text } = htmlToText(html, new URL("https://docs.example.com/start/"));
  assert.equal(title, "Docs & more");
  assert.equal(text, [
    "[Home](https://docs.example.com/) Top Menu",
    "",
    "# Getting started",
    "",
    "Read the [guide](https://docs.example.com/start/guide?x=1&y=2), then `npm install`.",
    "",
    "- One",
    "- Two",
    "  - Nested",
    "",
    "```",
    "if (a < b) {",
    "  return;",
    "}",
    "```",
    "",
    "Name | Size |",
    "a | 1 |",
    "",
    "Cafés —— &bogus; [image: A diagram]",
  ].join("\n"));
});

test("malformed HTML converts in time proportional to its length", () => {
  for (const html of ["<a ".repeat(200_000), "<div ".repeat(200_000) + ">", "<script>".repeat(50_000), "<!--".repeat(100_000), `<p title="${"x".repeat(1_000_000)}`]) {
    const started = performance.now();
    htmlToText(html, new URL("https://example.com/"));
    assert.ok(performance.now() - started < 2000, `${html.slice(0, 10)}… took too long`);
  }
});

test("deeply nested lists indent only so far, and no page converts to more text than web_fetch decodes", () => {
  const started = performance.now();
  const { text } = htmlToText("<ul><li>x".repeat(50_000), new URL("https://example.com/"));
  assert.ok(performance.now() - started < 2000);
  assert.ok(text.length < 50_000 * 25, `${text.length} characters`);
  assert.ok(text.split("\n").every(line => line.length <= 2 * 8 + 3), "indentation is capped");
  const huge = htmlToText(`<p>${"word ".repeat(3_000_000)}</p>`, new URL("https://example.com/"));
  assert.ok(huge.text.length <= webLimits.decodedBytes);
});

test("a page that leaves out </head> keeps its body, and a skipped element ends only at its own end tag", () => {
  assert.deepEqual(htmlToText("<head><title>T</title><meta charset=utf-8><body><p>Hi</p>", new URL("https://example.com/")), { title: "T", text: "Hi" });
  assert.equal(htmlToText('<script>var a = "</scripture>";</script><p>After</p>', new URL("https://example.com/")).text, "After");
});

test("text is decoded in the charset its Content-Type or meta tag names, else UTF-8", () => {
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/plain; charset=iso-8859-1", false), "café");
  assert.equal(decodeText(Buffer.from('<meta charset="windows-1252"><p>\x93hi\x94</p>', "latin1"), "text/html", true), '<meta charset="windows-1252"><p>“hi”</p>');
  assert.equal(decodeText(Buffer.from("héllo"), "text/plain; charset=no-such-charset", false), "héllo");
});

test("web_fetch reads only https:// URLs on port 443, without credentials; http:// is read as https://", () => {
  assert.deepEqual(webFetchUrl("http://example.com/a#part"), { url: new URL("https://example.com/a"), upgraded: true });
  assert.deepEqual(webFetchUrl(" https://example.com:443/b "), { url: new URL("https://example.com/b"), upgraded: false });
  for (const [input, message] of [["ftp://example.com/", /only https/], ["file:///etc/passwd", /only https/], ["https://user:pw@example.com/", /credentials/],
    ["https://example.com:8443/", /port 443/], ["http://example.com:8080/", /port/], ["example.com", /absolute/], [`https://example.com/${"a".repeat(3000)}`, /longer/]] as const) {
    assert.throws(() => webFetchUrl(input), (error: unknown) => error instanceof RunnerError && message.test(error.message), input);
  }
});

test("web_fetch reaches only what the workspace's network access allows, checking each redirect, and logs each decision", async () => {
  const { upstream, requests } = web({
    "https://docs.example.com/": { status: 301, headers: { location: "/v2/" } },
    "https://docs.example.com/v2/": { headers: { "content-type": "text/html; charset=utf-8" }, body: "<title>V2</title><p>Hello</p>" },
    "https://docs.example.com/away": { status: 302, headers: { location: "https://elsewhere.example.net/" } },
    "https://docs.example.com/plain": { status: 302, headers: { location: "http://docs.example.com/v2/" } },
    "https://docs.example.com/loop": { status: 302, headers: { location: "/loop" } },
  });
  let policy: NetworkPolicy = { mode: "off", domains: [], packageRegistries: true };
  const entries: FetchEntry[] = [];
  const fetch = (url: string) => fetchPage(url, { policy: async () => policy, upstream, record: entry => entries.push(entry) });

  await refusal(fetch("https://docs.example.com/"), 403, /network access is off/);
  assert.equal(requests.length, 0);
  policy = { mode: "allowlist", domains: ["docs.example.com"], packageRegistries: false };
  await refusal(fetch("https://other.example.com/"), 403, /not allowed by this workspace's network policy/);
  assert.equal(requests.length, 0);

  const page = await fetch("http://docs.example.com/");
  assert.deepEqual(page, { url: "https://docs.example.com/v2/", status: 200, contentType: "text/html", upgraded: true, truncated: false, kind: "text", text: "Hello", title: "V2" });
  // No credential or cookie ever goes along, only what a reader's GET sends.
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.deepEqual(Object.keys(request.headers).sort(), ["accept", "accept-encoding", "host", "user-agent"]);
  }
  await refusal(fetch("https://docs.example.com/away"), 403, /elsewhere\.example\.net is not allowed/);
  await refusal(fetch("https://docs.example.com/plain"), 502, /plain HTTP/);
  await refusal(fetch("https://docs.example.com/loop"), 502, /redirected more than 5 times/);
  // Unreachable hosts (no public address, say) say so.
  policy = open;
  await refusal(fetch("https://internal.example.com/"), 502, /does not resolve to a public address/);
  assert.deepEqual(entries.slice(0, 5), [
    { target: "https://docs.example.com/", outcome: "refused", reason: "docs.example.com is not reachable: this workspace's network access is off. Its owners and admins can allow hosts under Settings → Workspaces → the workspace → Network access" },
    { target: "https://other.example.com/", outcome: "refused", reason: "other.example.com is not allowed by this workspace's network policy" },
    { target: "https://docs.example.com/", outcome: "allowed", reason: "301 redirect" },
    { target: "https://docs.example.com/v2/", outcome: "allowed", reason: "200" },
    { target: "https://docs.example.com/away", outcome: "allowed", reason: "302 redirect" },
  ]);
});

test("web_fetch decodes compressed pages, stops at its download limit, returns images, and refuses other files unread", async () => {
  const big = () => Readable.from((function* () { for (let index = 0; index < 7; index++) yield Buffer.alloc(1024 * 1024, 0x61); })());
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const { upstream, bodies } = web({
    "https://example.com/gzip": { headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(JSON.stringify({ ok: true })) },
    "https://example.com/big": { headers: { "content-type": "text/plain" }, body: big },
    "https://example.com/image.png": { headers: { "content-type": "image/png" }, body: png },
    "https://example.com/file.pdf": { headers: { "content-type": "application/pdf", "content-length": "1234" }, body: big },
    "https://example.com/zstd": { headers: { "content-type": "text/plain", "content-encoding": "zstd" }, body: "x" },
    "https://example.com/binary": { body: Buffer.from([0, 1, 2, 3]) },
    "https://example.com/missing": { status: 404, headers: { "content-type": "text/html" }, body: "<h1>Not found</h1>" },
  });
  const fetch = (url: string) => fetchPage(url, { policy: async () => open, upstream });
  assert.deepEqual(await fetch("https://example.com/gzip"), { url: "https://example.com/gzip", status: 200, contentType: "application/json", truncated: false, kind: "text", text: '{"ok":true}' });
  const large = await fetch("https://example.com/big");
  assert.equal(large.kind === "text" && large.text.length, webLimits.downloadBytes);
  assert.equal(large.truncated, true);
  const image = await fetch("https://example.com/image.png");
  assert.equal(image.kind, "image");
  assert.deepEqual(image.kind === "image" && [Buffer.from(image.bytes).equals(png), image.mimeType], [true, "image/png"]);
  const before = bodies.length;
  await refusal(fetch("https://example.com/file.pdf"), 415, /application\/pdf \(1234 bytes\).*curl/);
  assert.equal(bodies[before]!.destroyed, true, "a file web_fetch doesn't read is never downloaded");
  await refusal(fetch("https://example.com/zstd"), 502, /encoding/);
  await refusal(fetch("https://example.com/binary"), 415, /isn't text/);
  // An error page is still a page, with its status.
  assert.deepEqual(await fetch("https://example.com/missing"), { url: "https://example.com/missing", status: 404, contentType: "text/html", truncated: false, kind: "text", text: "# Not found" });
});

test("web_fetch stops with its call", async () => {
  const controller = new AbortController();
  const upstream = async (request: UpstreamRequest) => {
    const body = new Readable({ read() {} });
    body.push("partial");
    request.signal?.addEventListener("abort", () => body.destroy(new Error("aborted")));
    setTimeout(() => controller.abort(), 10);
    return { status: 200, headers: { "content-type": "text/plain" }, body };
  };
  await refusal(fetchPage("https://example.com/slow", { policy: async () => open, upstream, signal: controller.signal }), 499, /stopped/);
});

test("web search queries and counts are checked before anything leaves the host", () => {
  assert.equal(webSearchQuery("  rust \n async  traits "), "rust async traits");
  assert.throws(() => webSearchQuery(" "), /empty/);
  assert.throws(() => webSearchQuery("x".repeat(401)), /at most 400/);
  assert.throws(() => webSearchQuery(42), /text/);
  assert.equal(webSearchCount(undefined), 8);
  assert.equal(webSearchCount(20), 20);
  for (const count of [0, 21, 1.5, "3"]) assert.throws(() => webSearchCount(count), /whole number/);
});

test("search results with markup that never closes are cleaned in time, within their limits", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ results: [{ title: "<".repeat(900_000), url: "https://example.com/", content: "<b".repeat(400_000) }] }));
  const provider = webSearchProvider({ APP_ORIGIN: "x", WEB_SEARCH: "tavily", WEB_SEARCH_API_KEY: "key" } as never)!;
  const started = performance.now();
  const [hit] = await provider.search("query", 1);
  assert.ok(performance.now() - started < 2000);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(hit!.title.length <= webLimits.titleLength && hit!.snippet.length <= webLimits.snippetLength);
});

test("the server refuses to start with an incomplete web search provider, and offers none unless one is complete", async () => {
  assert.equal(webSearchConfigurationError({}), undefined);
  assert.equal(webSearchConfigurationError({ WEB_SEARCH: "off" }), undefined);
  assert.match(webSearchConfigurationError({ WEB_SEARCH: "google" })!, /must be/);
  assert.match(webSearchConfigurationError({ WEB_SEARCH: "brave" })!, /WEB_SEARCH_API_KEY/);
  assert.match(webSearchConfigurationError({ WEB_SEARCH: "searxng", WEB_SEARCH_URL: "https://user:pw@search.example.com" })!, /WEB_SEARCH_URL/);
  assert.equal(webSearchConfigurationError({ WEB_SEARCH: "searxng", WEB_SEARCH_URL: "http://searxng:8080" }), undefined);
  assert.equal(webSearchProvider({ APP_ORIGIN: "x", WEB_SEARCH: "brave" } as never), undefined);
  assert.equal(webSearchProvider({ APP_ORIGIN: "x", WEB_SEARCH: "Tavily", WEB_SEARCH_API_KEY: "key" } as never)?.name, "tavily");
  const base = { APP_ORIGIN: "https://pistead.example.com", SESSION_SECRET: "s".repeat(32), VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"), DATABASE_URL: "sqlite::memory:" };
  await assert.rejects(loadConfig({ ...base, WEB_SEARCH: "tavily" }), ConfigurationError);
  const config = await loadConfig({ ...base, WEB_SEARCH: "brave", WEB_SEARCH_API_KEY: "brave-key" });
  try { assert.deepEqual([config.env.WEB_SEARCH, config.env.WEB_SEARCH_API_KEY], ["brave", "brave-key"]); }
  finally { await config.env.CONNECTOR_HUB?.close(); await config.env.DB.close(); }
});
