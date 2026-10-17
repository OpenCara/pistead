import test from "node:test";
import assert from "node:assert/strict";
import { openFetchEventStream, SseParser } from "../packages/client/src/sse.js";
import type { EventStream } from "../packages/client/src/live-session.js";

function parse(chunks: string[]): [string, string][] {
  const events: [string, string][] = [];
  const parser = new SseParser((type, data) => events.push([type, data]));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

test("events parse the same wherever the network splits them, including a CRLF across chunks", () => {
  const stream = ': keep-alive\r\nevent: view\r\ndata: {"a":1}\r\n\r\nevent: view\ndata: line one\ndata:line two\n\ndata: plain\r\rid: 7\nretry: 10\n\n';
  const expected: [string, string][] = [["view", '{"a":1}'], ["view", "line one\nline two"], ["message", "plain"]];
  assert.deepEqual(parse([stream]), expected);
  // Every split point, so CR, LF and field boundaries each land at a chunk edge.
  for (let cut = 1; cut < stream.length; cut++) assert.deepEqual(parse([stream.slice(0, cut), stream.slice(cut)]), expected, `split at ${cut}`);
  assert.deepEqual(parse([...stream]), expected);
});

test("an event cut off by the end of the stream is never dispatched, and a blank event dispatches nothing", () => {
  assert.deepEqual(parse(["event: view\n\n", "event: view\ndata: partial"]), []);
});

/** A fetch answering with `chunks` as a streamed body; `gate` holds the body back until it resolves, `open` never ends it. */
function streamingFetch(chunks: Uint8Array[], options: { status?: number; gate?: Promise<void>; open?: boolean; cancelled?: () => void } = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await options.gate;
        for (const chunk of chunks) controller.enqueue(chunk);
        if (!options.open) controller.close();
      },
      cancel: () => options.cancelled?.(),
    });
    return new Response(body, { status: options.status ?? 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, requests };
}

/** Records every event of `stream` and settles once it reports its end. */
function record(stream: EventStream) {
  const received: string[] = [];
  const ended = Promise.withResolvers<void>();
  stream.addEventListener("view", event => received.push(`view ${String(event.data)}`));
  stream.addEventListener("error", () => { received.push("error"); ended.resolve(); });
  return { received, ended: ended.promise };
}

test("a fetch event stream delivers each event, then reports the end of the stream as an error, like EventSource", async () => {
  // A two-byte character split across two network chunks.
  const bytes = new TextEncoder().encode('event: view\ndata: {"t":"é"}\n\n');
  const split = bytes.indexOf(0xc3) + 1;
  const { fetch, requests } = streamingFetch([bytes.slice(0, split), bytes.slice(split)]);
  const stream = openFetchEventStream({ fetch, url: "https://pistead.example/api/sessions/s1/events", headers: { Authorization: "Bearer token" } });
  const { received, ended } = record(stream);
  await ended;
  assert.deepEqual(received, ['view {"t":"é"}', "error"]);
  assert.equal(requests[0]!.url, "https://pistead.example/api/sessions/s1/events");
  assert.deepEqual(requests[0]!.init.headers, { Accept: "text/event-stream", Authorization: "Bearer token" });
});

test("a refused or failed stream reports an error", async () => {
  for (const fetch of [streamingFetch([], { status: 401 }).fetch, async () => { throw new TypeError("offline"); }]) {
    const { received, ended } = record(openFetchEventStream({ fetch, url: "https://pistead.example/events" }));
    await ended;
    assert.deepEqual(received, ["error"]);
  }
});

test("a closed stream stops reading and reports nothing more", async () => {
  const gate = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const { fetch } = streamingFetch([new TextEncoder().encode("event: view\ndata: 1\n\n")], { gate: gate.promise, open: true, cancelled: cancelled.resolve });
  const stream = openFetchEventStream({ fetch, url: "https://pistead.example/events" });
  const { received } = record(stream);
  stream.close();
  gate.resolve();
  await cancelled.promise;
  // Let the reader finish after its cancellation; the end of the stream must stay silent.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, []);
});
