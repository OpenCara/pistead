import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import type { ApprovalRecord, EntryView, SessionRecord, SessionView, SubmitResult, UserProfile } from "../../../packages/shared/src/types";
import { redactSecrets, REDACTED } from "../../../packages/shared/src/redaction";
import { api, segment } from "./api";
import { useApp } from "./app-context";
import { accessUnavailable, ChatOptionsBar, chatOptionsBody, initialSelection, rememberChat, type ChatSelection } from "./chat-options";
import { useConnections } from "./hosts";
import { Icon, type IconName } from "./icons";
import { activeStatuses, startLiveSession, type StreamStatus } from "./live-session";
import { Markdown } from "./markdown";
import { PeopleProvider, Username, useWorkspacePeople } from "./people";
import { RepositoryPreparationCard } from "./repository-preparation";
import { preparingRepositories } from "../../../packages/client/src/repository-progress";
import { navigate } from "./router";
import { ApprovalCard, SessionPanel, useSessionActions, type AuditEvent, type PanelTab } from "./session-panel";
import { splitToolCalls } from "../../../packages/client/src/transcript";
import {
  Alert, Button, Combobox, DropdownMenu, EmptyState, Feedback, Field, formatDuration, PageLoading, ScreenHeader, SegmentedControl,
  Sheet, Spinner, StatusBadge, useAction, useResource, type MenuItem,
} from "./ui";
import "./session.css";

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
    setStatus("connecting");
    const live = startLiveSession(id, { session: setSession, view: setView, error: setError, status: setStatus });
    refreshRef.current = live.refresh;
    return () => { live.stop(); refreshRef.current = () => {}; };
  }, [id, revision]);
  return { session, view, error, status, refresh, reconnect };
}

const PANEL_KEY = "pistead.sessionPanel";

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

/** Why a model request failed, from the only details that cross the host boundary: provider, model and HTTP status. */
function modelFailure({ provider, modelId, status }: NonNullable<EntryView["error"]>): string {
  const name = provider ?? "the provider";
  if (status === 401 || status === 403) return `The host's Pi credentials for ${name} were rejected. The host owner should check Pi's login or API key, then restart the connector.`;
  if (status === 429) return `Rate limited by ${name}. Try again shortly.`;
  if (status !== undefined && status >= 500 && status < 600) return `${name} is unavailable. Try again shortly.`;
  return `The request to ${[provider, modelId].filter(Boolean).join("/") || "the model"} failed${status ? ` (HTTP ${status})` : ""}`;
}

/** One collapsed row for tool calls, tool results and system entries; expanding it shows the raw text. */
function ToolDetails({ role, icon, label, text }: { role?: string; icon: IconName; label: ReactNode; text: string }) {
  return <details className="entry-tool" data-role={role}>
    <summary><Icon name={icon} size={14} /><span className="truncate">{label}</span><Icon name="chevron-right" size={14} /></summary>
    <pre>{text}</pre>
  </details>;
}

/** User messages are plain-text bubbles; assistant text is markdown; tool calls, results and system entries collapse to one row. */
function TranscriptEntry({ entry, userId }: { entry: EntryView; userId: string }) {
  const actor = entry.actorId && <Username id={entry.actorId} you />;
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  const toolLabel = calls.length > 0 && `Tool · ${calls[0].name}`;
  if (entry.kind === "workspace.run-stopped") return <div className="entry-stopped" role="note"><span>Stopped{actor && <> by {actor}</>}</span></div>;
  if (entry.kind === "workspace.run-crashed") return <div className="entry-stopped" role="note"><span>{entry.text}</span></div>;
  if ((toolLabel && !prose.trim()) || entry.role === "system" || entry.role === "toolResult") {
    const label = toolLabel || (entry.role === "toolResult" ? "Tool result" : "System");
    // A tool call row would show the model's time, not the tool's, so only results carry a duration.
    const took = entry.role === "toolResult" && entry.durationMs !== undefined
      && <> · <span title="How long the tool ran">{formatDuration(entry.durationMs)}</span></>;
    return <ToolDetails role={entry.role} icon={toolLabel ? "tool" : "terminal"} label={<>{label}{took}{actor && <> · {actor}</>}</>} text={entry.text} />;
  }
  if (entry.error) {
    return <div className="entry-error" title={entry.kind}>
      <Alert variant="error" title="Model request failed">{modelFailure(entry.error)}</Alert>
      {actor && <div className="entry-actor">by {actor}</div>}
    </div>;
  }
  if (entry.role === "user") {
    return <div className="entry-user" title={entry.kind}>
      <div className="entry-bubble">{entry.text}</div>
      {actor && entry.actorId !== userId && <div className="entry-actor">by {actor}</div>}
    </div>;
  }
  const took = entry.durationMs !== undefined && <span title="How long the model took to reply">{formatDuration(entry.durationMs)}</span>;
  return <div className="entry-assistant" data-role={entry.role} title={entry.kind}>
    <Markdown text={prose} />
    {toolLabel && <ToolDetails icon="tool" label={toolLabel} text={calls.map(call => call.line).join("\n")} />}
    {(actor || took) && <div className="entry-actor">{actor && <>by {actor}</>}{actor && took && " · "}{took}</div>}
  </div>;
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  // Remount per session so drafts, request IDs and panel forms never leak between sessions.
  return <SessionPane key={sessionId} id={sessionId} />;
}

function SessionPane({ id }: { id: string }) {
  const { user, workspaces, sessions, refreshSessions, setLiveActivity } = useApp();
  const live = useLiveSession(id);
  const session = live.session;
  const view = live.view;
  const audit = useResource<{ events: AuditEvent[] }>(`/api/sessions/${segment(id)}/audit`);
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [tab, setTab] = useState<PanelTab>("details");
  const permissions = session?.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  // Archived sessions are read-only on the server; don't offer decisions that would be refused.
  const archived = session?.status === "archived";
  // A session that pinned its repositories when it started stays readable only.
  const frozen = session?.frozen === true;
  const canApprove = permissions.includes("approve") && !archived && !frozen;
  const isOwner = session?.ownerId === user.id;
  const [renaming, setRenaming] = useState(false);
  const hosts = useConnections(session?.connectorId ? `/api/workspaces/${segment(session.workspaceId)}/connectors` : null);
  const host = hosts.data?.connectors.find(item => item.id === session?.connectorId);
  const hostOnline = host?.online;
  const previousHostOnline = useRef(hostOnline);
  useEffect(() => {
    // A host that reconnects would otherwise wait out the live-update backoff (up to a minute).
    if (previousHostOnline.current === false && hostOnline) live.refresh();
    previousHostOnline.current = hostOnline;
  }, [hostOnline, live.refresh]);
  // Session lists show this view's activity while the session is on screen, then a refreshed list takes over again.
  const viewActivity = view?.activity;
  useEffect(() => { setLiveActivity(viewActivity ? { sessionId: id, activity: viewActivity } : null); }, [id, viewActivity, setLiveActivity]);
  useEffect(() => () => { setLiveActivity(null); refreshSessions(); }, [setLiveActivity, refreshSessions]);
  const activeQueue = (view?.queue ?? []).filter(item => activeStatuses.includes(item.status));
  const refreshAll = useCallback(() => { live.refresh(); audit.refresh(); refreshSessions(); }, [live.refresh, audit.refresh, refreshSessions]);
  const actions = useSessionActions({
    session, user,
    backupBlocked: archived || frozen || !view || Boolean(live.error) || view.busy || activeQueue.length > 0,
    onChange: refreshAll,
  });
  const openSession = useCallback((target: string) => { refreshSessions(); navigate({ name: "session", sessionId: target }); }, [refreshSessions]);
  const approvalAction = useAction();

  const known = session ?? sessions.find(item => item.id === id);
  // Everyone a session names (owner, host owner, grantees, writers) is or was a member of its workspace.
  const people = useWorkspacePeople(known?.workspaceId ?? null);
  const workspaceName = known && workspaces.find(workspace => workspace.id === known.workspaceId)?.name;
  const visibility = session?.visibility ?? "private";
  const streamBadge = live.status === "online" ? <StatusBadge tone="success" dot>Live</StatusBadge>
    : live.status === "reconnecting" ? <StatusBadge tone="warning" dot>Reconnecting</StatusBadge>
    : live.status === "offline" ? <StatusBadge tone="danger" dot>Disconnected</StatusBadge>
    : <StatusBadge tone="neutral" dot>Connecting</StatusBadge>;

  const menu: (MenuItem | "separator")[] = [{ label: "Copy session ID", icon: "copy", onSelect: () => void navigator.clipboard.writeText(id) }];
  if (session && isOwner && !archived) {
    menu.push({ label: "Rename", icon: "pencil", disabled: actions.action.busy, onSelect: () => setRenaming(true) });
    menu.push({ label: visibility === "workspace" ? "Make private" : "Make workspace-visible", icon: visibility === "workspace" ? "lock" : "globe", disabled: actions.action.busy, onSelect: actions.changeVisibility });
    if (!frozen) menu.push({ label: "Create backup", icon: "archive", disabled: actions.backupsOff || actions.backupsPending || actions.backupBlocked || actions.action.busy,
      hint: actions.backupsOff ? "Backups are off" : actions.backupBlocked ? "Session busy" : undefined, onSelect: actions.createBackup });
    menu.push({ label: "Archive", icon: "archive", disabled: actions.action.busy, onSelect: actions.archive });
  }
  if (session && isOwner && archived) {
    menu.push({ label: "Unarchive", icon: "archive", disabled: actions.action.busy, onSelect: actions.unarchive });
  }
  if (known) menu.push("separator", { label: "Open in workspace settings", icon: "settings", onSelect: () => navigate({ name: "settings", section: "workspaces", id: known.workspaceId }) });

  /** `scope` answers a permission request: allow the one call, or the same need for the rest of the session. */
  async function decide(approval: ApprovalRecord, decision: "approve" | "deny", scope?: "call" | "session") {
    if (!canApprove || approvalAction.busy || !approval.reviewHash || approval.status !== "pending") return;
    // The card is the prompt: it shows the exact operation, who it runs as, its resource limits and any unsandboxed-host warning, so a click decides at once.
    const notice = approval.operation.kind === "permission"
      ? decision === "deny" ? "Not allowed" : scope === "session" ? "Allowed for the rest of the session" : "Allowed for this call"
      : decision === "approve" ? "Approval decision recorded" : "Operation denied";
    await approvalAction.run(async () => {
      await api(`/api/sessions/${segment(id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision, reviewHash: approval.reviewHash, ...(scope ? { scope } : {}) } });
      live.refresh();
      audit.refresh();
    }, notice);
  }

  // A failed start explains itself in the conversation area, where the chat box restarts it.
  const startFailed = !view && Boolean(session && (session.status === "error" || session.status === "provisioning"));
  const badge = startFailed ? <StatusBadge tone={session?.status === "error" ? "danger" : "running"} dot>{session?.status === "error" ? "Not started" : "Starting"}</StatusBadge>
    : !view && live.error ? <StatusBadge tone="warning" dot>Unavailable</StatusBadge>
    : streamBadge;
  return <PeopleProvider people={people}><div className={panelOpen && session ? "session-screen panel-open" : "session-screen"}>
    <div className="session-pane">
      <ScreenHeader
        title={known?.title ?? "Session"}
        subtitle={workspaceName}
        actions={<>
          {session && <span className="session-badges">{archived ? <StatusBadge tone="neutral">Archived</StatusBadge> : badge}<StatusBadge>{visibility === "workspace" ? "Workspace-visible" : "Private"}</StatusBadge>{session.linkShared && <StatusBadge tone="info">Link shared</StatusBadge>}</span>}
          {session && <Button variant="ghost" size="xs" icon="panel-right" aria-label="Toggle session panel" title="Session panel" aria-pressed={panelOpen} onClick={() => setPanelOpen(!panelOpen)} />}
          <DropdownMenu label="Session actions" items={menu} />
        </>}
      />
      {(archived || frozen || session?.cloneUnavailable || (live.error && !startFailed) || actions.action.error || actions.action.notice) && <div className="session-alerts">
        {frozen && !archived && <Alert title="Read-only">
          This session pinned its repositories when it started, which sessions no longer do. Its conversation, approvals and backups stay viewable, but it no longer runs. Start a new session to continue the work.
        </Alert>}
        {session?.cloneUnavailable && !frozen && <Alert variant="warning" title="Can't clone repositories">{session.cloneUnavailable}</Alert>}
        {archived && <Alert title="Archived" actions={isOwner && <Button variant="outline" size="sm" disabled={actions.action.busy} onClick={actions.unarchive}>Unarchive</Button>}>
          This session is read-only. {isOwner ? "Unarchive it to continue the work." : "Only its owner can unarchive it."}
        </Alert>}
        {live.error && !startFailed && <Alert variant="error" title={session ? "Live updates interrupted" : "Unable to open session"} actions={<Button variant="outline" size="sm" onClick={live.reconnect}>Reconnect and check access</Button>}>{live.error}</Alert>}
        <Feedback {...actions.action} />
      </div>}
      {!view ? (!live.error ? <PageLoading />
        : session ? <UnavailableConversation id={id} user={user} session={session} error={live.error} recovered={() => { live.reconnect(); refreshSessions(); }} />
        : <div className="session-transcript" />) : session && <Conversation
        id={id} user={user} session={session} view={view} host={host} stale={Boolean(live.error)} refresh={live.refresh}
        pinned={<>
          {view.repositories && <RepositoryPreparationCard sessionId={id} preparation={view.repositories}
            canRestart={isOwner && !archived && permissions.includes("manage")} onRestarted={refreshAll} />}
          {session.hostUnsandboxed && (canWrite || canApprove) && <Alert variant="error" title="Unsandboxed host">This session's host runs without a sandbox. Approved commands and commits execute directly on the host owner's machine with their full user permissions, network access and no resource limits.</Alert>}
          {view.approvals.filter(approval => approval.status === "pending").map(approval => {
            const permission = approval.operation.kind === "permission";
            // Only the session owner can let a call do more than the session allows.
            const hostCommand = approval.operation.kind === "host.bash";
            const ownerOnly = permission || approval.operation.kind === "git.repin";
            const decides = canApprove && (hostCommand ? session.connectorOwnerId === user.id : !ownerOnly || isOwner);
            const disabled = approvalAction.busy || !approval.reviewHash;
            return <ApprovalCard approval={approval} key={approval.id}>
              {decides ? <>
                {!approval.reviewHash && <Alert variant="warning" title="No verified review commitment" actions={<Button variant="outline" size="sm" disabled={approvalAction.busy} onClick={live.refresh}>Refresh approval</Button>}>Refresh before deciding; the server must bind the displayed operation and requester.</Alert>}
                {permission ? <div className="inline">
                  <Button variant="default" size="sm" disabled={disabled} onClick={() => void decide(approval, "approve", "call")}>Allow once</Button>
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => void decide(approval, "approve", "session")}>Allow for this session</Button>
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => void decide(approval, "deny")}>Deny</Button>
                </div> : <div className="inline">
                  <Button variant="default" size="sm" disabled={disabled} onClick={() => void decide(approval, "approve")}>Approve</Button>
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => void decide(approval, "deny")}>Deny</Button>
                  <span className="muted small">Runs as {hostCommand ? "the host OS user (outside the sandbox)" : view.owner.displayName} · each approval covers one exact operation and its arguments</span>
                </div>}
              </> : <p className="muted small">{hostCommand ? "Waiting for the host owner, who needs approve access to this session" : ownerOnly ? "Waiting for the session owner" : "Waiting for an authorized approver"}</p>}
            </ApprovalCard>;
          })}
          <Feedback {...approvalAction} />
        </>}
      />}
    </div>
    {session && panelOpen && <>
      <button type="button" className="session-scrim" aria-label="Close session panel" onClick={() => setPanelOpen(false)} />
      <SessionPanel session={session} view={view} user={user} hosts={hosts} tab={tab} setTab={setTab} onClose={() => setPanelOpen(false)} refresh={live.refresh} audit={audit} actions={actions} openSession={openSession} />
    </>}
    {session && isOwner && <RenameSheet open={renaming} title={session.title} busy={actions.action.busy} onClose={() => setRenaming(false)}
      onSave={async title => { if (await actions.rename(title)) setRenaming(false); }} />}
  </div></PeopleProvider>;
}

function RenameSheet({ open, title, busy, onClose, onSave }: { open: boolean; title: string; busy: boolean; onClose: () => void; onSave: (title: string) => void }) {
  const [value, setValue] = useState(title);
  // Start from the current title each time the sheet opens.
  useEffect(() => { if (open) setValue(title); }, [open, title]);
  const next = value.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (next && !busy) onSave(next);
  }
  return <Sheet open={open} title="Rename session" onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
    <Button type="submit" form="rename-session-form" variant="default" disabled={busy || !next}>{busy ? "Saving..." : "Rename"}</Button>
  </>}>
    <form id="rename-session-form" className="stack" onSubmit={submit}>
      <Field label="Title">
        <input className="input" required autoFocus maxLength={200} value={value} onChange={event => setValue(event.target.value)} autoComplete="off" />
      </Field>
    </form>
  </Sheet>;
}

function Conversation({ id, user, session, view, host, stale, refresh, pinned }: { id: string; user: UserProfile; session: SessionRecord; view: SessionView; host: ConnectorInfo | undefined; stale: boolean; refresh: () => void; pinned: ReactNode }) {
  const owner = session.ownerId === user.id;
  // Initialised once per session (SessionPane remounts per id); view refreshes never reset the user's picks.
  const [selection, setSelection] = useState<ChatSelection>(() => initialSelection(view, owner));
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
  const stopping = useAction();
  const [receipt, setReceipt] = useState<SubmitResult | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const permissions = session.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  const actualMode = mode === "ask" && !canAsk ? "write" : mode;
  const archived = session.status === "archived";
  const frozen = session.frozen === true;
  const permitted = !archived && !frozen && (actualMode === "write" ? canWrite : canAsk);
  const queue = view.queue ?? [];
  const activeQueue = queue.filter(item => activeStatuses.includes(item.status));
  const recentSubmissions = queue.filter(item => !activeStatuses.includes(item.status)).slice(-5).reverse();
  // Stopping takes the running message and everything queued; hosts that predate it don't offer it.
  const canStop = Boolean(view.stoppable) && !archived && canWrite && activeQueue.length > 0;
  const stopPending = queue.some(item => item.status === "stopping");
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

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!permitted || !content.trim() || submission.busy) return;
    setReceipt(null);
    const sent = content;
    const options = chatOptionsBody(host, selection, actualMode === "ask" ? "ask" : "submit");
    // Changing the options is a different request, so it needs a new idempotency key.
    const key = `${actualMode}:${JSON.stringify(options ?? null)}:${sent}`;
    // Retry the same failed submission with the same idempotency key, not a duplicate turn.
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    stick.current = true;
    const unavailable = accessUnavailable(host, selection, actualMode === "ask" ? "ask" : "submit");
    void submission.run(async () => {
      if (unavailable) throw new Error(unavailable);
      const result = await api<SubmitResult>(`/api/sessions/${segment(id)}/${actualMode === "ask" ? "ask" : "submit"}`, { method: "POST", body: { content: sent, requestId, ...(options ? { options } : {}) } });
      setReceipt(result);
      // The next new chat starts from the model and reasoning this one went with.
      if (options) rememberChat(host, selection);
      if (actualMode === "ask") setConversationId(result.conversationId);
      setContent(current => current === sent ? "" : current);
      request.current = null;
      refresh();
    });
  }

  function stop() {
    if (!canStop || stopping.busy) return;
    void stopping.run(async () => {
      await api(`/api/sessions/${segment(id)}/stop`, { method: "POST", body: {} });
      refresh();
    });
  }

  // The transcript hides secrets from everyone, but the agent and its host receive the message as typed.
  const draftHasSecret = Boolean(content.trim()) && redactSecrets(content) !== content;

  const queueLabel = preparingRepositories(view)
    ? <><Spinner />Preparing repositories...{activeQueue.length > 0 && <span className="muted"> · {activeQueue.length} queued</span>}</>
    : stopPending ? <><Spinner />Stopping...{activeQueue.length > 0 && <span className="muted"> · {activeQueue.length} queued</span>}</>
    // A call waiting on a card holds its message until someone decides.
    : view.busy
    ? <><Spinner />{view.activity === "waiting" ? "Waiting for a decision" : "Working"}...{activeQueue.length > 0 && <span className="muted"> · {activeQueue.length} queued</span>}</>
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
              <span className="muted small">By <Username id={item.actorId} you /> · Receipt <code>{item.submissionId}</code></span>
            </li>)}</ol>}
            {recentSubmissions.length > 0 && <ul className="queue-items">{recentSubmissions.map(item => <li key={item.submissionId}>
              <span>{item.status} · {item.mode === "ask" ? "Side ask" : "Shared submission"}</span>
              <span className="muted small">By <Username id={item.actorId} you /> · Receipt <code>{item.submissionId}</code></span>
            </li>)}</ul>}
            <div className="inline"><Button variant="outline" size="sm" icon="refresh" onClick={refresh}>Refresh queue</Button></div>
          </div>
        </details>
        <ComposerInput
          value={content}
          onChange={setContent}
          onSubmit={submit}
          busy={submission.busy}
          disabled={!permitted}
          onStop={canStop ? stop : undefined}
          stopping={stopping.busy}
          label={actualMode === "ask" ? "Ask without making changes" : "Continue the shared work"}
          placeholder={!permitted ? "Read-only" : actualMode === "ask" ? "Ask without changing anything" : "Message the agent"}
          sendLabel={actualMode === "ask" ? "Send side ask" : "Submit to session"}
          hint={archived ? "Read-only · this session is archived" : frozen ? "Read-only · this session pinned its repositories when it started" : !permitted ? (canAsk ? "Read-only · switch to Side ask to ask questions" : "Read-only · submitting needs write permission")
            : actualMode === "ask" ? "Read-only · anyone who can view this session can see side asks"
            : `Runs as ${view.owner.displayName}${view.owner.id === user.id ? " (you)" : ""}`}
          tools={<>
            {canAsk && <SegmentedControl<"write" | "ask"> size="xs" label="Conversation mode" value={actualMode} onChange={setMode} options={[{ value: "write", label: "Shared" }, { value: "ask", label: "Side ask" }]} />}
            {actualMode === "ask" && sideConversations.length > 0 && <Combobox<string> label="Side conversation" side="above" value={conversationId} onChange={setConversationId} options={[
              { value: "", label: "All my side asks" },
              ...sideConversations.map((conversation, index) => ({ value: conversation.id, label: `Side ask ${index + 1}`, hint: conversation.id.slice(0, 8) })),
            ]} />}
            {permitted && <ChatOptionsBar host={host} value={selection} onChange={setSelection} owner={owner} showAccess={actualMode === "write"} unsandboxed={Boolean(session.hostUnsandboxed || host?.capabilities.unsandboxed)} />}
          </>}
        />
        {draftHasSecret && <p className="muted small" role="status">This message looks like it holds a secret. Everyone, you included, sees it as {REDACTED} in the transcript, but the agent and its host receive it as typed.</p>}
        <Feedback error={submission.error || stopping.error} />
      </div>
    </div>
  </>;
}

/** The chat box: auto-growing input; Enter sends, Shift+Enter adds a line, IME composition is respected. */
/** `onStop`, while the agent works and the person may stop it, shows a stop button beside send; messages can still be queued. */
function ComposerInput({ value, onChange, onSubmit, onStop, stopping, busy, disabled, label, placeholder, sendLabel, hint, tools }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; onStop?: () => void; stopping?: boolean; busy: boolean; disabled?: boolean;
  label: string; placeholder: string; sendLabel: string; hint: ReactNode; tools?: ReactNode;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!disabled && !busy && value.trim()) onSubmit();
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  }
  return <form className="composer" onSubmit={submit}>
    <textarea ref={input} rows={1} required value={value} disabled={busy || disabled} aria-label={label} placeholder={placeholder}
      onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
    <div className="composer-toolbar">
      {tools}
      <span className="composer-hint">{hint}</span>
      <span className="composer-actions">
        {onStop && <Button variant="outline" size="sm" icon="stop" className="composer-stop" aria-label={stopping ? "Stopping..." : "Stop"} title="Stop the running message and those queued" disabled={stopping} onClick={onStop} />}
        <Button type="submit" variant="default" size="sm" icon="send" className="composer-send" aria-label={busy ? "Sending..." : sendLabel} title={sendLabel} disabled={busy || disabled || !value.trim()} />
      </span>
    </div>
  </form>;
}

/**
 * Shown when the transcript cannot load. A session whose start failed is restarted by its owner's
 * next message: restart re-provisions on the pinned host, then the message is submitted.
 */
function UnavailableConversation({ id, user, session, error, recovered }: { id: string; user: UserProfile; session: SessionRecord; error: string; recovered: () => void }) {
  const [content, setContent] = useState("");
  const request = useRef<{ content: string; id: string } | null>(null);
  const action = useAction();
  const failed = session.status === "error" || session.status === "provisioning";
  const canRestart = failed && session.ownerId === user.id && Boolean(session.permissions?.includes("manage"));
  const canWrite = Boolean(session.permissions?.includes("write"));
  function send() {
    const sent = content;
    // Same text retried after a failure keeps its idempotency key.
    if (request.current?.content !== sent) request.current = { content: sent, id: crypto.randomUUID() };
    const requestId = request.current.id;
    void action.run(async () => {
      await api(`/api/sessions/${segment(id)}/restart`, { method: "POST" });
      try {
        await api<SubmitResult>(`/api/sessions/${segment(id)}/submit`, { method: "POST", body: { content: sent, requestId } });
      } catch (reason) {
        // The session is running again; hand the unsent text to the live conversation.
        try { sessionStorage.setItem(`pistead.draft.${id}`, sent); } catch { /* Storage unavailable: the text is lost. */ }
        recovered();
        throw reason;
      }
      request.current = null;
      setContent("");
      recovered();
    });
  }
  const title = session.status === "error" ? "This session didn't start" : session.status === "provisioning" ? "This session is still starting" : "This session can't be reached";
  const body = canRestart ? "Send a message to start it again on its host. Your message runs once it's ready."
    : failed ? "Only the session owner can start it again."
    : canWrite ? "Messages can be sent once the host is back online."
    : "The conversation appears once the host is back online.";
  return <>
    <div className="session-transcript">
      <div className="chat-column">
        <EmptyState title={title}>
          <span className="stack">
            <span>{body}</span>
            {failed && error && <span className="muted small">{error}</span>}
          </span>
        </EmptyState>
      </div>
    </div>
    <div className="session-bottom">
      <div className="chat-column stack">
        <ComposerInput
          value={content}
          onChange={setContent}
          onSubmit={send}
          busy={action.busy}
          disabled={!canRestart}
          label="Message the agent"
          placeholder={canRestart ? "Message the agent to start the session again" : "Message the agent"}
          sendLabel={canRestart ? "Restart and send" : "Sending is unavailable"}
          hint={action.busy ? "Starting the session and preparing repositories..." : canRestart ? "Restarts the session, then sends" : failed ? "Only the owner can restart this session" : canWrite ? "Waiting for the host" : "Read-only — submitting needs write permission"}
        />
        <Feedback error={action.error} />
      </div>
    </div>
  </>;
}
