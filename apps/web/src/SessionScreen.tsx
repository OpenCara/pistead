import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ApprovalRecord, EntryView, SessionRecord, SessionView, SubmitResult, UserProfile } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage, segment } from "./api";
import { useApp } from "./app-context";
import { Icon } from "./icons";
import { navigate } from "./router";
import { ApprovalCard, SessionPanel, useSessionActions, type AuditEvent, type PanelTab } from "./session-panel";
import {
  Alert, Button, Combobox, confirmDialog, DropdownMenu, EmptyState, Feedback, PageLoading, ScreenHeader, SegmentedControl,
  Spinner, StatusBadge, useAction, useResource, type MenuItem,
} from "./ui";
import "./session.css";

type StreamStatus = "connecting" | "online" | "reconnecting" | "offline";

function useLiveSession(id: string) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [revision, setRevision] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const reconnect = useCallback(() => setRevision(current => current + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | null = null;
    let retryTimer: number | undefined;
    // The poll transport ends every stream after a few seconds; only a reconnect that lingers is news.
    let reconnectNotice: number | undefined;
    let retryDelay = 1000;
    let fetching = false;
    let queued = false;
    let stopped = false;
    const base = `/api/sessions/${segment(id)}`;
    setStatus("connecting");
    async function fetchCommittedView() {
      if (stopped || controller.signal.aborted) return;
      if (fetching) { queued = true; return; }
      fetching = true;
      let checkingAccess = true;
      try {
        const metadata = await api<{ session: SessionRecord }>(base, { signal: controller.signal });
        checkingAccess = false;
        if (!controller.signal.aborted) setSession(metadata.session);
        const snapshot = await api<{ view: SessionView }>(`${base}/view`, { signal: controller.signal });
        if (!controller.signal.aborted && !stopped) {
          setView(snapshot.view);
          setError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          if (checkingAccess && reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
            // Do not keep a previously authorized transcript visible after access is revoked.
            stopped = true;
            stream?.close();
            setSession(null);
            setView(null);
            setStatus("offline");
          }
        }
      } finally {
        fetching = false;
        if (queued && !controller.signal.aborted && !stopped) { queued = false; void fetchCommittedView(); }
      }
    }
    refreshRef.current = () => { void fetchCommittedView(); };
    function openStream() {
      if (controller.signal.aborted || stopped) return;
      stream = new EventSource(`${base}/events`, { withCredentials: true });
      stream.onopen = () => { retryDelay = 1000; window.clearTimeout(reconnectNotice); reconnectNotice = undefined; setStatus("online"); void fetchCommittedView(); };
      stream.onerror = () => {
        if (stopped || controller.signal.aborted) return;
        reconnectNotice ??= window.setTimeout(() => setStatus("reconnecting"), 3000);
        stream?.close();
        void fetchCommittedView();
        // Recreate even a permanently CLOSED stream after HTTP or content-type failures.
        retryTimer = window.setTimeout(openStream, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 16000);
      };
      // Events invalidate the committed view; token deltas are never rendered as durable history.
      stream.onmessage = () => { void fetchCommittedView(); };
      stream.addEventListener("view", () => { void fetchCommittedView(); });
      stream.addEventListener("revoked", () => { setStatus("reconnecting"); void fetchCommittedView(); });
    }
    void fetchCommittedView().then(openStream);
    // Revalidate permissions even when a quiet session produces no history events.
    const interval = window.setInterval(() => { void fetchCommittedView(); }, 15000);
    return () => { controller.abort(); stream?.close(); window.clearTimeout(retryTimer); window.clearTimeout(reconnectNotice); window.clearInterval(interval); refreshRef.current = () => {}; };
  }, [id, revision]);
  return { session, view, error, status, refresh, reconnect };
}

const PANEL_KEY = "pistead.sessionPanel";
const toolCall = /^([a-z_]+)\(.*\)$/s;
const activeStatuses = ["queued", "admitting", "running"];

function usePanelOpen() {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(PANEL_KEY);
      if (stored) return stored === "open";
    } catch { /* Storage unavailable: fall back to the viewport default. */ }
    return window.matchMedia("(min-width: 1100px)").matches;
  });
  const set = useCallback((value: boolean) => {
    setOpen(value);
    try { localStorage.setItem(PANEL_KEY, value ? "open" : "closed"); } catch { /* Keep the in-memory choice. */ }
  }, []);
  return [open, set] as const;
}

/** User messages are bubbles; assistant text is plain; tool calls, results and system entries collapse to one row. */
function TranscriptEntry({ entry, userId }: { entry: EntryView; userId: string }) {
  const actor = entry.actorId && <span title={entry.actorId}>{entry.actorId === userId ? "you" : entry.actorId}</span>;
  const call = entry.role === "assistant" ? toolCall.exec(entry.text.trim()) : null;
  if (call || entry.role === "system" || entry.role === "toolResult") {
    const label = call ? `Tool · ${call[1]}` : entry.role === "toolResult" ? "Tool result" : "System";
    return <details className="entry-tool" data-role={entry.role}>
      <summary><Icon name={call ? "tool" : "terminal"} size={14} /><span className="truncate">{label}{actor && <> · {actor}</>}</span><Icon name="chevron-right" size={14} /></summary>
      <pre>{entry.text}</pre>
    </details>;
  }
  if (entry.role === "user") {
    return <div className="entry-user" title={entry.kind}>
      <div className="entry-bubble">{entry.text}</div>
      {actor && entry.actorId !== userId && <div className="entry-actor">by {actor}</div>}
    </div>;
  }
  return <div className="entry-assistant" data-role={entry.role} title={entry.kind}>
    {entry.text}
    {actor && <div className="entry-actor">by {actor}</div>}
  </div>;
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  // Remount per session so drafts, request IDs and panel forms never leak between sessions.
  return <SessionPane key={sessionId} id={sessionId} />;
}

function SessionPane({ id }: { id: string }) {
  const { user, workspaces, sessions, refreshSessions } = useApp();
  const live = useLiveSession(id);
  const session = live.session;
  const view = live.view;
  const audit = useResource<{ events: AuditEvent[] }>(`/api/sessions/${segment(id)}/audit`);
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [tab, setTab] = useState<PanelTab>("details");
  const permissions = session?.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  const canApprove = permissions.includes("approve");
  const isOwner = session?.ownerId === user.id;
  const activeQueue = (view?.queue ?? []).filter(item => activeStatuses.includes(item.status));
  const refreshAll = useCallback(() => { live.refresh(); audit.refresh(); refreshSessions(); }, [live.refresh, audit.refresh, refreshSessions]);
  const actions = useSessionActions({
    session, user,
    backupBlocked: !view || Boolean(live.error) || view.busy || activeQueue.length > 0,
    onChange: refreshAll,
  });
  const openSession = useCallback((target: string) => { refreshSessions(); navigate({ name: "session", sessionId: target }); }, [refreshSessions]);
  const approvalAction = useAction();

  const known = session ?? sessions.find(item => item.id === id);
  const workspaceName = known && workspaces.find(workspace => workspace.id === known.workspaceId)?.name;
  const visibility = session?.visibility ?? "private";
  const streamBadge = live.status === "online" ? <StatusBadge tone="success" dot>Live</StatusBadge>
    : live.status === "reconnecting" ? <StatusBadge tone="warning" dot>Reconnecting</StatusBadge>
    : live.status === "offline" ? <StatusBadge tone="danger" dot>Disconnected</StatusBadge>
    : <StatusBadge tone="neutral" dot>Connecting</StatusBadge>;

  const menu: (MenuItem | "separator")[] = [{ label: "Copy session ID", icon: "copy", onSelect: () => void navigator.clipboard.writeText(id) }];
  if (session && isOwner) {
    menu.push({ label: visibility === "workspace" ? "Make private" : "Make workspace-visible", icon: visibility === "workspace" ? "lock" : "globe", disabled: actions.action.busy, onSelect: actions.changeVisibility });
    menu.push({ label: "Create backup", icon: "archive", disabled: actions.backupBlocked || actions.action.busy, hint: actions.backupBlocked ? "Session busy" : undefined, onSelect: actions.createBackup });
  }
  if (known) menu.push("separator", { label: "Open in workspace settings", icon: "settings", onSelect: () => navigate({ name: "settings", section: "workspaces", id: known.workspaceId }) });

  async function decide(approval: ApprovalRecord, decision: "approve" | "deny") {
    if (!canApprove || approvalAction.busy || !approval.reviewHash || approval.status !== "pending") return;
    if (decision === "approve" && !await confirmDialog({
      title: "Approve this exact operation?",
      message: session?.hostUnsandboxed
        ? "It will run as the session owner on an UNSANDBOXED host: directly on the host owner's machine, with their full user permissions and network access, and no resource limits."
        : "It will run as the session owner.",
      confirmLabel: "Approve",
    })) return;
    await approvalAction.run(async () => {
      await api(`/api/sessions/${segment(id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision, reviewHash: approval.reviewHash } });
      live.refresh();
      audit.refresh();
    }, decision === "approve" ? "Approval decision recorded" : "Operation denied");
  }

  return <div className={panelOpen && session ? "session-screen panel-open" : "session-screen"}>
    <div className="session-pane">
      <ScreenHeader
        title={known?.title ?? "Session"}
        subtitle={workspaceName}
        actions={<>
          {session && <span className="session-badges">{streamBadge}<StatusBadge>{visibility === "workspace" ? "Workspace-visible" : "Private"}</StatusBadge></span>}
          {session && <Button variant="ghost" size="xs" icon="panel-right" aria-label="Toggle session panel" title="Session panel" aria-pressed={panelOpen} onClick={() => setPanelOpen(!panelOpen)} />}
          <DropdownMenu label="Session actions" items={menu} />
        </>}
      />
      {(live.error || actions.action.error || actions.action.notice) && <div className="session-alerts">
        {live.error && <Alert variant="error" title={session ? "Live updates interrupted" : "Unable to open session"} actions={<Button variant="outline" size="sm" onClick={live.reconnect}>Reconnect and check access</Button>}>{live.error}</Alert>}
        <Feedback {...actions.action} />
      </div>}
      {!view ? (live.error ? <div className="session-transcript" /> : <PageLoading />) : session && <Conversation
        id={id} user={user} session={session} view={view} stale={Boolean(live.error)} refresh={live.refresh}
        pinned={<>
          {session.hostUnsandboxed && (canWrite || canApprove) && <Alert variant="error" title="Unsandboxed host">This session's host runs without a sandbox. Approved commands and commits execute directly on the host owner's machine with their full user permissions, network access and no resource limits.</Alert>}
          {view.approvals.filter(approval => approval.status === "pending").map(approval => <ApprovalCard approval={approval} key={approval.id}>
            {canApprove ? <>
              {!approval.reviewHash && <Alert variant="warning" title="No verified review commitment" actions={<Button variant="outline" size="sm" disabled={approvalAction.busy} onClick={live.refresh}>Refresh approval</Button>}>Refresh before deciding; the server must bind the displayed operation and requester.</Alert>}
              <div className="inline">
                <Button variant="default" size="sm" disabled={approvalAction.busy || !approval.reviewHash} onClick={() => void decide(approval, "approve")}>Approve</Button>
                <Button variant="outline" size="sm" disabled={approvalAction.busy || !approval.reviewHash} onClick={() => void decide(approval, "deny")}>Deny</Button>
                <span className="muted small">Each approval covers one exact operation and its arguments</span>
              </div>
            </> : <p className="muted small">Waiting for an authorized approver</p>}
          </ApprovalCard>)}
          <Feedback {...approvalAction} />
        </>}
      />}
    </div>
    {session && panelOpen && <>
      <button type="button" className="session-scrim" aria-label="Close session panel" onClick={() => setPanelOpen(false)} />
      <SessionPanel session={session} view={view} user={user} tab={tab} setTab={setTab} onClose={() => setPanelOpen(false)} refresh={live.refresh} audit={audit} actions={actions} openSession={openSession} />
    </>}
  </div>;
}

function Conversation({ id, user, session, view, stale, refresh, pinned }: { id: string; user: UserProfile; session: SessionRecord; view: SessionView; stale: boolean; refresh: () => void; pinned: ReactNode }) {
  const [mode, setMode] = useState<"write" | "ask">("write");
  // A first message that failed to send from the new-session screen is handed over here.
  const [content, setContent] = useState(() => {
    try { return sessionStorage.getItem(`pistead.draft.${id}`) ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    try { sessionStorage.removeItem(`pistead.draft.${id}`); } catch { /* Storage unavailable: nothing to clear. */ }
  }, [id]);
  const [conversationId, setConversationId] = useState("");
  const request = useRef<{ key: string; id: string } | null>(null);
  const submission = useAction();
  const [receipt, setReceipt] = useState<SubmitResult | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const permissions = session.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  const actualMode = mode === "ask" && !canAsk ? "write" : mode;
  const permitted = actualMode === "write" ? canWrite : canAsk;
  const queue = view.queue ?? [];
  const activeQueue = queue.filter(item => activeStatuses.includes(item.status));
  const recentSubmissions = queue.filter(item => !activeStatuses.includes(item.status)).slice(-5).reverse();
  const conversations = view.conversations;
  const sideConversations = conversations.filter(item => item.mode === "ask" && (!item.actorId || item.actorId === user.id));
  const entries = view.entries.filter(entry => {
    if (entry.role === "system" && !entry.text.trim()) return false;
    const conversation = conversations.find(item => item.id === entry.conversationId);
    if (actualMode === "ask") return conversation?.mode === "ask" && (!conversation.actorId || conversation.actorId === user.id) && (!conversationId || entry.conversationId === conversationId);
    return conversation?.mode !== "ask";
  });
  const lastEntryId = entries.at(-1)?.id;

  // Follow new entries unless the reader has scrolled up.
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lastEntryId, entries.length]);
  useLayoutEffect(() => {
    stick.current = true;
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [actualMode, conversationId]);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [content]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!permitted || !content.trim() || submission.busy) return;
    setReceipt(null);
    const sent = content;
    const key = `${actualMode}:${sent}`;
    // Retry the same failed submission with the same idempotency key, not a duplicate turn.
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    stick.current = true;
    void submission.run(async () => {
      const result = await api<SubmitResult>(`/api/sessions/${segment(id)}/${actualMode === "ask" ? "ask" : "submit"}`, { method: "POST", body: { content: sent, requestId } });
      setReceipt(result);
      if (actualMode === "ask") setConversationId(result.conversationId);
      setContent(current => current === sent ? "" : current);
      request.current = null;
      refresh();
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  const queueLabel = view.busy
    ? <><Spinner />Working...{activeQueue.length > 0 && <span className="muted"> · {activeQueue.length} queued</span>}</>
    : activeQueue.length ? <>{activeQueue.length} queued</>
    : <>Idle</>;

  return <>
    <div className="session-transcript" ref={transcript} onScroll={event => {
      const element = event.currentTarget;
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }} aria-label={actualMode === "ask" ? "Side ask history" : "Shared session history"}>
      <div className="chat-column">
        {entries.length ? entries.map(entry => <TranscriptEntry entry={entry} userId={user.id} key={entry.id} />)
          : <EmptyState title={actualMode === "ask" ? "A question on the side" : "The conversation begins here"}>{actualMode === "ask" ? "Ask about the work without changing it" : "Committed messages and tool results will appear here"}</EmptyState>}
      </div>
    </div>
    <div className="session-bottom">
      <div className="chat-column stack">
        {pinned}
        <details className="queue-line">
          <summary role="status" aria-live="polite">{queueLabel}<Icon name="chevron-down" size={14} /></summary>
          <div className="queue-detail stack">
            <p className="muted small">Submissions and side asks share one queue; permissions are checked again before work runs. You can leave this page: accepted work continues while the host is online and authorized.</p>
            {stale && <p className="small">This is the last received queue view; live host status is not confirmed.</p>}
            {receipt && <p className="small">Last receipt <code>{receipt.submissionId}</code> · {receipt.status}{receipt.queuePosition !== undefined ? ` · queue position ${receipt.queuePosition}` : ""}</p>}
            {activeQueue.length > 0 && <ol className="queue-items">{activeQueue.map((item, index) => <li key={item.submissionId}>
              <span>{index + 1}. {item.mode === "ask" ? "Read-only side ask" : "Shared submission"} · {item.status}</span>
              <span className="muted small">By {item.actorId === user.id ? "you" : item.actorId} · Receipt <code>{item.submissionId}</code></span>
            </li>)}</ol>}
            {recentSubmissions.length > 0 && <ul className="queue-items">{recentSubmissions.map(item => <li key={item.submissionId}>
              <span>{item.status} · {item.mode === "ask" ? "Side ask" : "Shared submission"}</span>
              <span className="muted small">By {item.actorId === user.id ? "you" : item.actorId} · Receipt <code>{item.submissionId}</code></span>
            </li>)}</ul>}
            <div className="inline"><Button variant="outline" size="sm" icon="refresh" onClick={refresh}>Refresh queue</Button></div>
          </div>
        </details>
        {permitted ? <form className="composer" onSubmit={submit}>
          <textarea
            ref={textarea}
            rows={1}
            required
            value={content}
            disabled={submission.busy}
            aria-label={actualMode === "ask" ? "Ask without making changes" : "Continue the shared work"}
            placeholder={actualMode === "ask" ? "Ask without changing anything" : "Message the agent"}
            onChange={event => setContent(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-toolbar">
            {canAsk && <SegmentedControl<"write" | "ask"> size="xs" label="Conversation mode" value={actualMode} onChange={setMode} options={[{ value: "write", label: "Shared" }, { value: "ask", label: "Side ask" }]} />}
            {actualMode === "ask" && sideConversations.length > 0 && <Combobox<string> label="Side conversation" side="above" value={conversationId} onChange={setConversationId} options={[
              { value: "", label: "All my side asks" },
              ...sideConversations.map((conversation, index) => ({ value: conversation.id, label: `Side ask ${index + 1}`, hint: conversation.id.slice(0, 8) })),
            ]} />}
            <span className="composer-hint truncate">{actualMode === "ask" ? "Read-only · anyone who can view this session can see side asks" : `Runs as ${view.owner.displayName}${view.owner.id === user.id ? " (you)" : ""}`}</span>
            <Button type="submit" variant="default" size="sm" icon="send" className="composer-send" aria-label={submission.busy ? "Sending..." : actualMode === "ask" ? "Send side ask" : "Submit to session"} title={actualMode === "ask" ? "Send side ask" : "Submit to session"} disabled={submission.busy || !content.trim()} />
          </div>
        </form> : <div className="readonly-bar">
          {actualMode === "write" && canAsk ? <>
            <span>You can ask questions in a read-only side conversation</span>
            <Button variant="outline" size="sm" onClick={() => setMode("ask")}>Open side ask</Button>
          </> : <>
            <span>Read-only — you can follow along</span>
            <span className="muted small">Submitting needs write permission</span>
          </>}
        </div>}
        <Feedback error={submission.error} />
      </div>
    </div>
  </>;
}
