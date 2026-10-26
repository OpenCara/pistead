import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { SessionRecord, SessionView } from "../packages/shared/src/types.js";
import { ApiError } from "../packages/client/src/api.js";
import { liveTiming, startLiveSession, type EventStream, type StreamStatus } from "../packages/client/src/live-session.js";

const record = { id: "s1" } as SessionRecord;
const idleView = { sessionId: "s1", busy: false, queue: [] } as unknown as SessionView;
const activeView = { sessionId: "s1", busy: false, queue: [{ submissionId: "q1", actorId: "u1", mode: "write", status: "running" }] } as unknown as SessionView;
const offline = new ApiError(503, "connector_offline", "The connector is offline or has reconnected.");

type Listener = (event: { data?: unknown }) => void;

class FakeStream implements EventStream {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close() {}
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
}

interface Backend {
  session: SessionRecord | ApiError;
  view: SessionView | ApiError;
  /** Snapshots each new /events stream sends before the Worker ends it (none: it ends empty), or "hold" to keep it open. */
  stream: SessionView[] | "hold";
  /** Answers reads of earlier entries (`/entries?...`). */
  entries?: (path: string) => unknown;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function liveSession(t: TestContext, backend: Backend) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  let hidden = false;
  const requests: { at: number; path: string }[] = [];
  const streams: FakeStream[] = [];
  const visibility = new Set<() => void>();
  const state: { session?: SessionRecord | null; view?: SessionView | null; error: string; status?: StreamStatus } = { error: "" };
  const live = startLiveSession("s1", {
    session: value => { state.session = value; },
    view: value => { state.view = value; },
    error: value => { state.error = value; },
    status: value => { state.status = value; },
  }, {
    async api<T>(path: string) {
      requests.push({ at: now, path });
      if (path.includes("/entries?")) {
        const page = backend.entries?.(path);
        if (page instanceof ApiError) throw page;
        return page as T;
      }
      const answer = path.endsWith("/view") ? backend.view : backend.session;
      if (answer instanceof ApiError) throw answer;
      return (path.endsWith("/view") ? { view: answer } : { session: answer }) as T;
    },
    openEvents(url) {
      requests.push({ at: now, path: url });
      const stream = new FakeStream();
      streams.push(stream);
      const snapshots = backend.stream;
      if (snapshots !== "hold") queueMicrotask(() => {
        for (const view of snapshots) stream.emit("view", JSON.stringify({ view }));
        stream.emit("error");
      });
      return stream;
    },
    hidden: () => hidden,
    onVisibilityChange(listener) { visibility.add(listener); return () => visibility.delete(listener); },
  });
  t.after(() => live.stop());
  await flush();
  return {
    live, requests, streams, state,
    async advance(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) { now += 250; t.mock.timers.tick(250); await flush(); }
    },
    async setHidden(value: boolean) { hidden = value; for (const listener of visibility) listener(); await flush(); },
    opens: () => requests.filter(request => request.path.includes("/events")).map(request => request.at),
    since: (at: number) => requests.filter(request => request.at >= at).length,
  };
}

test("a session whose host stays offline backs off to one stream a minute instead of hammering the Worker", async t => {
  const live = await liveSession(t, { session: record, view: offline, stream: [] });
  await live.advance(60 * 60_000);
  const opens = live.opens();
  const gaps = opens.slice(1).map((at, index) => at - opens[index]!);
  assert.equal(gaps[0], liveTiming.firstBackoffMs);
  assert.ok(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]!), `gaps never shrink while every stream fails: ${gaps.join(",")}`);
  assert.equal(gaps.at(-1), liveTiming.maxBackoffMs);
  // One open tab used to make about 3,100 requests an hour against an offline host.
  assert.ok(live.requests.length < 400, `${live.requests.length} requests in an hour`);
  assert.equal(live.state.status, "reconnecting");
  assert.equal(live.state.error, offline.message);
});

test("a hidden page makes no requests until it is visible again", async t => {
  const live = await liveSession(t, { session: record, view: idleView, stream: [idleView] });
  await live.setHidden(true);
  const hiddenAt = live.requests.length;
  await live.advance(30 * 60_000);
  assert.equal(live.requests.length, hiddenAt);
  await live.setHidden(false);
  const resumed = live.requests.slice(hiddenAt).map(request => request.path);
  assert.deepEqual(resumed, ["/api/sessions/s1", "/api/sessions/s1/events?since="]);
});

test("idle sessions reopen slowly, running ones quickly, and snapshots render without refetching the view", async t => {
  const backend: Backend = { session: record, view: idleView, stream: [idleView] };
  const live = await liveSession(t, backend);
  assert.equal(live.state.status, "online");
  await live.advance(liveTiming.idleReopenMs - 250);
  assert.equal(live.opens().length, 1);
  await live.advance(250);
  assert.equal(live.opens().length, 2);

  // A user action (sending a message) looks for the new run without waiting out the idle delay.
  backend.stream = [activeView];
  const before = live.opens().length;
  live.live.refresh();
  await flush();
  assert.equal(live.opens().length, before + 1);
  assert.deepEqual(live.state.view, activeView);
  const lastOpen = live.opens().at(-1)!;
  await live.advance(liveTiming.activeReopenMs);
  assert.equal(live.opens().at(-1), lastOpen + liveTiming.activeReopenMs);

  // Only the initial load fetched /view; every later snapshot came from the stream.
  assert.equal(live.requests.filter(request => request.path.endsWith("/view")).length, 1);
});

test("a refresh while a stream is open looks again as soon as that stream ends", async t => {
  const backend: Backend = { session: record, view: idleView, stream: "hold" };
  const live = await liveSession(t, backend);
  const open = live.streams.at(-1)!;
  open.emit("view", JSON.stringify({ view: idleView }));
  // The user sends a message while the open stream's snapshots may predate it.
  live.live.refresh();
  await flush();
  assert.equal(live.opens().length, 1);
  open.emit("error");
  await live.advance(liveTiming.activeReopenMs);
  assert.deepEqual(live.opens(), [0, liveTiming.activeReopenMs]);
});

test("losing access clears the session and stops every request", async t => {
  const backend: Backend = { session: record, view: idleView, stream: [idleView] };
  const live = await liveSession(t, backend);
  backend.session = new ApiError(403, "forbidden", "You no longer have access to this session.");
  backend.stream = [];
  await live.advance(liveTiming.idleReopenMs);
  assert.equal(live.state.status, "offline");
  assert.equal(live.state.session, null);
  assert.equal(live.state.view, null);
  const revokedAt = live.requests.at(-1)!.at;
  await live.advance(60 * 60_000);
  assert.equal(live.since(revokedAt + 1), 0);
});

test("a host preparing repositories reopens the stream quickly before any message, then slows down once ready", async t => {
  // Not busy and nothing queued: only the preparation itself keeps the pace up.
  const preparing = { ...idleView, repositories: { status: "preparing", items: [] } } as unknown as SessionView;
  const backend: Backend = { session: record, view: preparing, stream: [preparing] };
  const live = await liveSession(t, backend);
  await live.advance(liveTiming.activeReopenMs);
  assert.deepEqual(live.opens(), [0, liveTiming.activeReopenMs]);
  assert.equal(live.state.view?.repositories?.status, "preparing");
  backend.stream = [idleView];
  await live.advance(liveTiming.activeReopenMs);
  assert.deepEqual(live.opens(), [0, liveTiming.activeReopenMs, 2 * liveTiming.activeReopenMs]);
  await live.advance(liveTiming.idleReopenMs - 250);
  assert.equal(live.opens().length, 3);
  await live.advance(250);
  assert.equal(live.opens().length, 4);
});

test("streams ask for what changed since the held revision and apply patches to the view shown", async t => {
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  const entry = { id: "0:1", kind: "message", role: "user", text: "hello" };
  const reply = { id: "0:2", kind: "message", role: "assistant", text: "hi" };
  const base = { ...idleView, entries: [entry], approvals: [], conversations: [] } as unknown as SessionView;
  const backend: Backend = { session: record, view: base, stream: "hold" };
  const live = await liveSession(t, backend);
  const open = live.streams.at(-1)!;
  open.emit("view", JSON.stringify({ view: base, revision: first }));
  const held = live.state.view!.entries[0];
  open.emit("patch", JSON.stringify({ patch: { base: first, revision: second, view: { sessionId: "s1", busy: true },
    lists: { entries: [1, reply], approvals: [], conversations: [], queue: [] } } }));
  assert.equal(live.state.view?.busy, true);
  assert.deepEqual(live.state.view?.entries, [entry, reply]);
  // The unchanged entry is the very object shown before.
  assert.equal(live.state.view?.entries[0], held);
  const shown = live.state.view;
  open.emit("patch", JSON.stringify({ patch: { base: second, revision: second } }));
  assert.equal(live.state.view, shown, "No change shows the same view");
  open.emit("error");
  await live.advance(liveTiming.activeReopenMs);
  assert.equal(live.requests.at(-1)!.path, `/api/sessions/s1/events?since=${second}`);

  // A patch from a revision this client does not hold is not applied, and the next stream asks for a whole view.
  const next = live.streams.at(-1)!;
  next.emit("patch", JSON.stringify({ patch: { base: first, revision: "c".repeat(32), view: { sessionId: "s1", busy: false },
    lists: { entries: [], approvals: [], conversations: [] } } }));
  assert.equal(live.state.view, shown);
  next.emit("error");
  await live.advance(liveTiming.firstBackoffMs);
  assert.equal(live.requests.filter(request => request.path.includes("/events")).at(-1)!.path, "/api/sessions/s1/events?since=");
});

test("a paged view reads earlier entries a page at a time, once per conversation, and keeps them as the window moves", async t => {
  const entry = (n: number) => ({ id: `0:${n}`, kind: "message", role: "assistant", text: `entry ${n}`, conversationId: "0" });
  const paged = (from: number, to: number, older: number, conversations: unknown[] = []) => ({
    ...idleView, approvals: [], entries: Array.from({ length: to - from + 1 }, (_, index) => entry(from + index)),
    conversations: [{ id: "0", mode: "write", olderEntries: older, previousEntryId: `0:${from - 1}` }, ...conversations],
  }) as unknown as SessionView;
  const pages: Record<string, { entries: unknown[]; older: number }> = {
    "0:5": { entries: [entry(3), entry(4)], older: 2 },
    "0:3": { entries: [entry(1), entry(2)], older: 0 },
  };
  const backend: Backend = { session: record, view: paged(5, 7, 4), stream: "hold",
    entries: path => pages[decodeURIComponent(/before=([^&]+)/.exec(path)![1]!)] ?? new ApiError(409, "entries_changed", "The transcript changed.") };
  const live = await liveSession(t, backend);
  const ids = () => live.state.view!.entries.map(item => item.id);
  const reads = () => live.requests.filter(request => request.path.includes("/entries?")).map(request => request.path);
  assert.deepEqual(ids(), ["0:5", "0:6", "0:7"]);

  // Scrolling asks again and again while a page is on its way: one read.
  await Promise.all([live.live.loadOlder("0"), live.live.loadOlder("0")]);
  assert.deepEqual(reads(), ["/api/sessions/s1/entries?conversation=0&before=0%3A5&limit=50"]);
  assert.deepEqual(ids(), ["0:3", "0:4", "0:5", "0:6", "0:7"]);
  assert.equal(live.state.view!.conversations[0]!.olderEntries, 2);
  await live.live.loadOlder("0");
  assert.deepEqual(ids(), ["0:1", "0:2", "0:3", "0:4", "0:5", "0:6", "0:7"]);
  assert.equal(live.state.view!.conversations[0]!.olderEntries, undefined, "Nothing left to read");
  await live.live.loadOlder("0");
  await live.live.loadOlder("unknown");
  assert.equal(reads().length, 2, "Nothing more to read, so nothing is asked");

  // New entries push the window on; what slid out of it stays shown.
  const stream = live.streams.at(-1)!;
  stream.emit("view", JSON.stringify({ view: paged(6, 8, 5) }));
  assert.deepEqual(ids(), ["0:1", "0:2", "0:3", "0:4", "0:5", "0:6", "0:7", "0:8"]);
  // A history that no longer joins up (after a compaction) starts again from the window, with earlier pages to read.
  stream.emit("view", JSON.stringify({ view: paged(20, 21, 9) }));
  assert.deepEqual(ids(), ["0:20", "0:21"]);
  assert.equal(live.state.view!.conversations[0]!.olderEntries, 9);
  await live.live.loadOlder("0");
  assert.equal(live.state.error, "The transcript changed.");
  assert.deepEqual(ids(), ["0:20", "0:21"]);
});
