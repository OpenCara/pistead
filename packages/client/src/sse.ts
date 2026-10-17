import type { EventStream } from "./live-session";

type Listener = (event: { data?: unknown }) => void;

/**
 * Server-sent events from text chunks, as the HTML standard parses them: lines end in CRLF, LF or CR; "event" and
 * "data" fields build an event that a blank line dispatches ("message" when it names no type); comments and other
 * fields are ignored, and an event cut off by the end of the stream is dropped.
 */
export class SseParser {
  #buffer = "";
  #type = "";
  #data: string[] = [];
  /** The last chunk ended in CR, so an LF opening the next one belongs to the same line end. */
  #pendingCarriageReturn = false;

  constructor(private readonly dispatch: (type: string, data: string) => void) {}

  push(chunk: string): void {
    if (this.#pendingCarriageReturn && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.#pendingCarriageReturn = false;
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.search(/\r\n|\r|\n/);
      if (end < 0) break;
      const newline = this.#buffer.startsWith("\r\n", end) ? 2 : 1;
      // A CR at the very end may be the first half of a CRLF split across chunks.
      if (newline === 1 && this.#buffer[end] === "\r" && end === this.#buffer.length - 1) this.#pendingCarriageReturn = true;
      this.#line(this.#buffer.slice(0, end));
      this.#buffer = this.#buffer.slice(end + newline);
    }
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length) this.dispatch(this.#type || "message", this.#data.join("\n"));
      this.#type = "";
      this.#data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#type = value;
    else if (field === "data") this.#data.push(value);
  }
}

export interface FetchEventStreamOptions {
  /** A fetch whose responses stream their bodies (response.body.getReader()), such as expo/fetch. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  url: string;
  headers?: Record<string, string>;
}

/**
 * An EventStream over fetch, for platforms without EventSource. Like EventSource it reports the end of the stream, and
 * any failure to open or read it, as an "error" event; close() stops it without one.
 */
export function openFetchEventStream(options: FetchEventStreamOptions): EventStream {
  const listeners = new Map<string, Listener[]>();
  const controller = new AbortController();
  let closed = false;
  const emit = (type: string, data?: string) => {
    if (closed) return;
    for (const listener of listeners.get(type) ?? []) listener(data === undefined ? {} : { data });
  };
  const read = async () => {
    const response = await options.fetch(options.url, {
      headers: { Accept: "text/event-stream", ...options.headers }, signal: controller.signal, credentials: "omit",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser(emit);
    for (;;) {
      const part = await reader.read();
      if (part.done || closed) break;
      parser.push(decoder.decode(part.value, { stream: true }));
    }
    if (closed) await reader.cancel().catch(() => {});
    else parser.push(decoder.decode());
  };
  // A refused, failed or aborted stream ends like one the server closed.
  void read().catch(() => {}).then(() => emit("error"));
  return {
    addEventListener(type, listener) { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    close() {
      closed = true;
      controller.abort();
    },
  };
}
