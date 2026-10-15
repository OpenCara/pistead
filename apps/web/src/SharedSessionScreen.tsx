import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SharedSession, SharedSessionView } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage } from "./api";
import { Logo } from "./icons";
import { TranscriptEntry } from "./SessionScreen";
import { Alert, EmptyState, PageLoading, ScreenHeader, Spinner, StatusBadge, Timestamp } from "./ui";
import "./session.css";

/**
 * A share link reads the committed view with plain requests, never a stream: again soon while work runs, slowly while
 * the session is idle, backing off while it can't be reached, and not at all while the page is hidden.
 */
export const sharedTiming = { busyMs: 3_000, idleMs: 15_000, firstBackoffMs: 5_000, maxBackoffMs: 60_000 } as const;

interface SharedState {
  session: SharedSession | null;
  view: SharedSessionView | null;
  /** Why the latest refresh failed; the last view received stays on screen. */
  error: string;
  /** The link doesn't open a session (any more), so nothing it showed before stays on screen. */
  invalid: boolean;
}

function useSharedSession(token: string): SharedState {
  const [state, setState] = useState<SharedState>({ session: null, view: null, error: "", invalid: false });
  useEffect(() => {
    const controller = new AbortController();
    const headers = { "X-Share-Token": token };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let failures = 0;
    let busy = false;

    function schedule() {
      clearTimeout(timer);
      if (controller.signal.aborted || document.hidden) return;
      const delay = failures ? Math.min(sharedTiming.maxBackoffMs, sharedTiming.firstBackoffMs * 2 ** (failures - 1))
        : busy ? sharedTiming.busyMs : sharedTiming.idleMs;
      timer = setTimeout(() => void load(), delay);
    }

    async function load() {
      if (controller.signal.aborted || loading) return;
      loading = true;
      clearTimeout(timer);
      try {
        // The cheap check first: it shows the title even while the session's host can't be reached.
        const { session } = await api<{ session: SharedSession }>("/api/shared", { signal: controller.signal, headers });
        if (controller.signal.aborted) return;
        setState(current => ({ ...current, session }));
        const { view } = await api<{ view: SharedSessionView }>("/api/shared/view", { signal: controller.signal, headers });
        if (controller.signal.aborted) return;
        busy = view.busy;
        failures = 0;
        setState(current => ({ ...current, view, error: "" }));
      } catch (reason) {
        if (controller.signal.aborted) return;
        // Only the link check answers not_found; an unreachable host answers with its own errors.
        if (reason instanceof ApiError && reason.status === 404 && reason.code === "not_found") {
          setState({ session: null, view: null, error: "", invalid: true });
          return;
        }
        failures++;
        setState(current => ({ ...current, error: errorMessage(reason) }));
      } finally {
        loading = false;
      }
      schedule();
    }

    function visibilityChange() {
      if (document.hidden) clearTimeout(timer);
      else void load();
    }
    document.addEventListener("visibilitychange", visibilityChange);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChange);
    };
  }, [token]);
  return state;
}

/** What anyone with a session's share link sees, signed in or not: its shared conversation, read-only. */
export function SharedSessionScreen({ token }: { token: string }) {
  const { session, view, error, invalid } = useSharedSession(token);
  const transcript = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const entries = (view?.entries ?? []).filter(entry => entry.role !== "system" || entry.text.trim());
  const lastEntryId = entries.at(-1)?.id;
  const title = session?.title;
  useEffect(() => { document.title = title ? `${title} · Pistead` : "Shared session · Pistead"; }, [title]);
  // Follow new entries unless the reader has scrolled up.
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lastEntryId, entries.length]);

  if (invalid || !session) {
    if (!invalid && !error) return <PageLoading />;
    return <div className="welcome">
      <main id="main-content" className="welcome-inner" tabIndex={-1}>
        <Logo size={40} />
        <h1>{invalid ? "This link doesn't work" : "Can't open this session right now"}</h1>
        {invalid ? <p>The session's owner may have turned the link off. Ask them for a new one.</p>
          : <Alert variant="error" title="Couldn't load the shared session">{error} This page keeps trying.</Alert>}
      </main>
    </div>;
  }

  const badge = error ? <StatusBadge tone="warning" dot>Reconnecting</StatusBadge>
    : !view ? <StatusBadge tone="neutral" dot>Connecting</StatusBadge>
    : view.busy ? <StatusBadge tone="running" dot>Working</StatusBadge>
    : session.status === "archived" ? <StatusBadge tone="neutral">Archived</StatusBadge>
    : <StatusBadge tone="success" dot>Live</StatusBadge>;
  return <div className="shared-screen">
    <ScreenHeader leading={<Logo size={22} />} title={session.title} subtitle={`Shared by ${session.ownerName}`}
      actions={<span className="session-badges">{badge}<StatusBadge>Read-only</StatusBadge></span>} />
    {error && view && <div className="session-alerts">
      <Alert variant="warning" role="status" title="Can't refresh right now">{error} This page keeps trying and shows the last view it received.</Alert>
    </div>}
    <main id="main-content" className="session-transcript" ref={transcript} tabIndex={-1} aria-label="Shared session history" onScroll={event => {
      const element = event.currentTarget;
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      <div className="chat-column">
        {!view ? (error ? <EmptyState title="The conversation isn't available right now">The session's host may be offline. This page keeps trying.</EmptyState> : <PageLoading />)
          : entries.length ? entries.map(entry => <TranscriptEntry entry={entry} userId="" key={entry.id} />)
          : <EmptyState title="The conversation begins here">Messages and tool results appear here as the work goes on</EmptyState>}
      </div>
    </main>
    <footer className="shared-status">
      <div className="chat-column">
        {view?.busy ? <><Spinner />Working...</> : view ? "Idle" : null}
        {view && <span aria-hidden="true">·</span>}
        <span>Read-only, shared by link · Started <Timestamp value={session.createdAt} /></span>
      </div>
    </footer>
  </div>;
}
