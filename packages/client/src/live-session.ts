import type { SessionRecord, SessionView } from "../../shared/src/types";
import { applyViewPatch, isViewPatch } from "../../shared/src/view-patch";
import { ApiError, errorMessage, segment } from "./api";

export type StreamStatus = "connecting" | "online" | "reconnecting" | "offline";

export const activeStatuses = ["queued", "admitting", "running"];

/**
 * The server ends every /events stream after a few view snapshots, and every stream and fetch costs a request (a
 * client retrying a session whose host was offline used to send thousands an hour). Streams therefore reopen
 * quickly only while a run is active, slowly while the session is idle, with doubling backoff after streams that end
 * without a snapshot, and never while the app or page is hidden.
 */
export const liveTiming = {
  activeReopenMs: 1_000,
  idleReopenMs: 10_000,
  firstBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  accessCheckMs: 30_000,
} as const;

/** The parts of EventSource a live session uses. Browsers pass an EventSource; native apps a fetch-based stream (see sse.ts). */
export interface EventStream {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface LiveSessionHandlers {
  session(session: SessionRecord | null): void;
  view(view: SessionView | null): void;
  error(message: string): void;
  status(status: StreamStatus): void;
}

export interface LiveSessionDependencies {
  api<T>(path: string, options: { signal: AbortSignal }): Promise<T>;
  /** Opens the session's /events stream; `path` starts with /api/. */
  openEvents(path: string): EventStream;
  /** The page is hidden or the app is in the background: no streams then. */
  hidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
}

export interface LiveSession {
  /** Reloads now and looks for new work right away, e.g. after the user sends a message. */
  refresh(): void;
  stop(): void;
}

export function startLiveSession(id: string, handlers: LiveSessionHandlers, dependencies: LiveSessionDependencies): LiveSession {
  const controller = new AbortController();
  const base = `/api/sessions/${segment(id)}`;
  let stream: EventStream | null = null;
  let cancelReopen = () => {};
  let failures = 0;
  let active = false;
  /** Set by refresh() while a stream is open: that stream may predate the change, so look again right after it. */
  let followUp = false;
  let loading = false;
  let pending: boolean | undefined;
  let revoked = false;
  /** The view shown and its revision: streams send only what changed since it. */
  let current: SessionView | null = null;
  let revision: string | undefined;
  const running = () => !revoked && !controller.signal.aborted;

  function showView(view: SessionView, at?: string) {
    current = view;
    revision = typeof at === "string" ? at : undefined;
    // A cache host preparing repositories reports progress worth showing every second, even before any message.
    active = view.busy || (view.queue ?? []).some(item => activeStatuses.includes(item.status)) || view.repositories?.status === "preparing";
    handlers.view(view);
    handlers.error("");
  }

  function closeStream() {
    stream?.close();
    stream = null;
  }

  function revoke() {
    // Do not keep a previously authorized transcript visible after access is revoked.
    revoked = true;
    current = null;
    revision = undefined;
    closeStream();
    cancelReopen();
    handlers.session(null);
    handlers.view(null);
    handlers.status("offline");
  }

  /** Session metadata (which rechecks access) and, when asked, the committed view; overlapping calls coalesce. */
  async function load(withView: boolean): Promise<void> {
    if (!running()) return;
    if (loading) { pending = pending === true || withView; return; }
    loading = true;
    let checkingAccess = true;
    try {
      const metadata = await dependencies.api<{ session: SessionRecord }>(base, { signal: controller.signal });
      checkingAccess = false;
      if (!running()) return;
      handlers.session(metadata.session);
      if (!withView) return;
      const snapshot = await dependencies.api<{ view: SessionView; revision?: string }>(`${base}/view`, { signal: controller.signal });
      if (running()) showView(snapshot.view, snapshot.revision);
    } catch (reason) {
      if (!running()) return;
      handlers.error(errorMessage(reason));
      if (checkingAccess && reason instanceof ApiError && [401, 403, 404].includes(reason.status)) revoke();
    } finally {
      loading = false;
      if (pending !== undefined && running()) {
        const next = pending;
        pending = undefined;
        void load(next);
      }
    }
  }

  function schedule(delay: number) {
    cancelReopen();
    if (!running() || dependencies.hidden()) return;
    const timer = setTimeout(openStream, delay);
    cancelReopen = () => clearTimeout(timer);
  }

  function openStream() {
    cancelReopen();
    if (!running() || dependencies.hidden() || stream) return;
    const opened = dependencies.openEvents(`${base}/events?since=${revision ?? ""}`);
    stream = opened;
    let delivered = false;
    const deliver = (view: SessionView, at: string | undefined) => {
      delivered = true;
      failures = 0;
      handlers.status("online");
      showView(view, at);
    };
    // Snapshots carry the same checked view as GET /view, so they render without a refetch.
    opened.addEventListener("view", event => {
      if (stream !== opened || !running()) return;
      let snapshot: { view?: SessionView; revision?: string } | null;
      try { snapshot = JSON.parse(String(event.data)) as { view?: SessionView; revision?: string } | null; } catch { return; }
      if (!snapshot?.view) return;
      deliver(snapshot.view, snapshot.revision);
    });
    // What changed since the revision this client holds; nothing at all while the session is quiet.
    opened.addEventListener("patch", event => {
      if (stream !== opened || !running()) return;
      let patch: unknown;
      try { patch = (JSON.parse(String(event.data)) as { patch?: unknown } | null)?.patch; } catch { return; }
      if (!isViewPatch(patch) || !current || patch.base !== revision) {
        // Not ours to apply: the next stream starts again from a whole view.
        revision = undefined;
        return;
      }
      let view: SessionView;
      try { view = applyViewPatch(current, patch); } catch { revision = undefined; return; }
      deliver(view, patch.revision);
    });
    // EventSource reports the end of every stream as an error, including the Worker's normal close.
    opened.addEventListener("error", () => {
      if (stream !== opened) return;
      closeStream();
      if (!running()) return;
      const eager = followUp;
      followUp = false;
      if (delivered) return schedule(active || eager ? liveTiming.activeReopenMs : liveTiming.idleReopenMs);
      failures++;
      handlers.status("reconnecting");
      // Explain the failure (an offline host, lost access) once per failed stream.
      void load(true);
      schedule(Math.min(liveTiming.maxBackoffMs, liveTiming.firstBackoffMs * 2 ** (failures - 1)));
    });
  }

  const stopVisibility = dependencies.onVisibilityChange(() => {
    if (!running()) return;
    if (dependencies.hidden()) {
      cancelReopen();
      closeStream();
      return;
    }
    void load(false);
    openStream();
  });
  // Revalidate access even when a quiet session produces no snapshots.
  const accessTimer = setInterval(() => { if (!dependencies.hidden()) void load(false); }, liveTiming.accessCheckMs);
  void load(true).then(openStream);

  return {
    refresh() {
      // The view comes from the stream: a /view fetch racing it could land last and show an older state.
      void load(false);
      if (stream) followUp = true;
      else openStream();
    },
    stop() {
      controller.abort();
      closeStream();
      cancelReopen();
      clearInterval(accessTimer);
      stopVisibility();
    },
  };
}
