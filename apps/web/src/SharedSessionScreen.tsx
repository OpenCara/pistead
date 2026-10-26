import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SharedSession, SharedSessionView } from "../../../packages/shared/src/sharing";
import type { EntryView } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage } from "./api";
import { Icon, Logo, type IconName } from "./icons";
import { Markdown } from "./markdown";
import { splitToolCalls } from "../../../packages/client/src/transcript";
import { COMPACTION_FAILED_TITLE, compactionFailureText } from "../../../packages/client/src/compaction";
import { Alert, EmptyState, formatDuration, PageLoading, ScreenHeader, Spinner, StatusBadge, Timestamp } from "./ui";
import "./session.css";
import "./shared-session.css";

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

/** Why a model request failed, from the only details that cross the host boundary: provider, model and HTTP status. */
function modelFailure({ provider, modelId, status }: NonNullable<EntryView["error"]>): string {
  const name = provider ?? "the provider";
  if (status === 401 || status === 403) return `The host's Pi credentials for ${name} were rejected.`;
  if (status === 429) return `Rate limited by ${name}.`;
  if (status !== undefined && status >= 500 && status < 600) return `${name} was unavailable.`;
  return `The request to ${[provider, modelId].filter(Boolean).join("/") || "the model"} failed${status ? ` (HTTP ${status})` : ""}`;
}

/** One collapsed row for tool calls, tool results and system entries; expanding it shows the raw text. */
function ToolDetails({ role, icon, label, text }: { role?: string; icon: IconName; label: ReactNode; text: string }) {
  return <details className="entry-tool" data-role={role}>
    <summary><Icon name={icon} size={14} /><span className="truncate">{label}</span><Icon name="chevron-right" size={14} /></summary>
    <pre>{text}</pre>
  </details>;
}

/**
 * One entry, drawn as the session screen draws it but without saying who sent it: a share link's entries carry no
 * attribution, and its viewers have no workspace whose members could be named.
 */
function SharedEntry({ entry }: { entry: EntryView }) {
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  const toolLabel = calls.length > 0 && `Tool · ${calls[0].name}`;
  if (entry.kind === "workspace.run-stopped") return <div className="entry-stopped" role="note"><span>Stopped</span></div>;
  if (entry.kind === "workspace.run-crashed") return <div className="entry-stopped" role="note"><span>{entry.text}</span></div>;
  if ((toolLabel && !prose.trim()) || entry.role === "system" || entry.role === "toolResult") {
    const label = toolLabel || (entry.role === "toolResult" ? "Tool result" : "System");
    // A tool call row would show the model's time, not the tool's, so only results carry a duration.
    const took = entry.role === "toolResult" && entry.durationMs !== undefined
      && <> · <span title="How long the tool ran">{formatDuration(entry.durationMs)}</span></>;
    return <ToolDetails role={entry.role} icon={toolLabel ? "tool" : "terminal"} label={<>{label}{took}</>} text={entry.text} />;
  }
  if (entry.error) {
    // A link's viewers can't send the next message, so they get the cause without the advice.
    if (entry.error.compaction) {
      return <div className="entry-error" title={entry.kind}>
        <Alert variant="error" title={COMPACTION_FAILED_TITLE}>{compactionFailureText(entry.error.compaction, { advice: false })}</Alert>
      </div>;
    }
    return <div className="entry-error" title={entry.kind}><Alert variant="error" title="Model request failed">{modelFailure(entry.error)}</Alert></div>;
  }
  if (entry.role === "user") return <div className="entry-user" title={entry.kind}><div className="entry-bubble">{entry.text}</div></div>;
  const took = entry.durationMs !== undefined && <span title="How long the model took to reply">{formatDuration(entry.durationMs)}</span>;
  return <div className="entry-assistant" data-role={entry.role} title={entry.kind}>
    <Markdown text={prose} />
    {toolLabel && <ToolDetails icon="tool" label={toolLabel} text={calls.map(call => call.line).join("\n")} />}
    {took && <div className="entry-actor">{took}</div>}
  </div>;
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
          : entries.length ? entries.map(entry => <SharedEntry entry={entry} key={entry.id} />)
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
