import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApprovalRecord, EntryView, SessionRecord, SessionView, SubmitResult, UserProfile } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage, segment } from "./api";
import { CopyField, Details, Empty, Feedback, PageHeading, Timestamp, useAction } from "./ui";
import { SessionHost } from "./SessionHost";
import { SessionControls } from "./SessionControls";
import { SessionRepositories } from "./SessionRepositories";

function useLiveSession(id: string) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"connecting" | "online" | "reconnecting" | "offline">("connecting");
  const [revision, setRevision] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const reconnect = useCallback(() => setRevision(current => current + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | null = null;
    let retryTimer: number | undefined;
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
      stream.onopen = () => { retryDelay = 1000; setStatus("online"); void fetchCommittedView(); };
      stream.onerror = () => {
        if (stopped || controller.signal.aborted) return;
        setStatus("reconnecting");
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
    return () => { controller.abort(); stream?.close(); window.clearTimeout(retryTimer); window.clearInterval(interval); refreshRef.current = () => {}; };
  }, [id, revision]);
  return { session, view, error, status, refresh, reconnect };
}

const toolCall = /^([a-z_]+)\(.*\)$/s;

/** User and assistant messages render as chat bubbles; system, tool calls and tool results collapse to one row. */
function TranscriptEntry({ entry, userId }: { entry: EntryView; userId: string }) {
  const actor = entry.actorId && <span title={entry.actorId}>{entry.actorId === userId ? "you" : entry.actorId}</span>;
  const call = entry.role === "assistant" ? toolCall.exec(entry.text.trim()) : null;
  if (call || entry.role === "system" || entry.role === "toolResult") {
    const label = call ? `Tool · ${call[1]}` : entry.role === "toolResult" ? "Tool result" : "System";
    return <article className="entry" data-role={entry.role}><Details summary={<>{label}{actor && <> · {actor}</>}</>}><pre>{entry.text}</pre></Details></article>;
  }
  return <article className="entry" data-role={entry.role}><header className="entry-header"><span title={entry.kind}>{entry.role}</span>{actor && <span title={entry.actorId}>{entry.actorId === userId ? "by you" : `by ${entry.actorId}`}</span>}</header><div className="entry-body">{entry.text}</div></article>;
}

export function SessionDetail({ id, user, goBack, openSession, selectWorkspace }: { id: string; user: UserProfile; goBack: () => void; openSession: (id: string) => void; selectWorkspace: (id: string) => void }) {
  const live = useLiveSession(id);
  const [mode, setMode] = useState<"write" | "ask">("write");
  const [content, setContent] = useState("");
  const [conversationId, setConversationId] = useState("");
  const request = useRef<{ key: string; id: string } | null>(null);
  const submission = useAction();
  const [receipt, setReceipt] = useState<SubmitResult | null>(null);
  const approvalAction = useAction();
  const permissions = live.session?.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  const canApprove = permissions.includes("approve");
  const isOwner = live.session?.ownerId === user.id;
  const viewerOnly = !isOwner && !permissions.some(permission => permission !== "read");
  const actualMode = mode === "ask" && !canAsk ? "write" : mode;
  const permitted = actualMode === "write" ? canWrite : canAsk;
  const view = live.view;
  const activeQueue = (view?.queue ?? []).filter(item => ["queued", "admitting", "running"].includes(item.status));
  const recentSubmissions = (view?.queue ?? []).filter(item => !["queued", "admitting", "running"].includes(item.status)).slice(-5).reverse();
  const conversations = view?.conversations ?? [];
  const sideConversations = conversations.filter(item => item.mode === "ask" && (!item.actorId || item.actorId === user.id));
  const entries = view?.entries.filter(entry => {
    if (entry.role === "system" && !entry.text.trim()) return false;
    const conversation = conversations.find(item => item.id === entry.conversationId);
    if (actualMode === "ask") return conversation?.mode === "ask" && (!conversation.actorId || conversation.actorId === user.id) && (!conversationId || entry.conversationId === conversationId);
    return conversation?.mode !== "ask";
  }) ?? [];
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!permitted || !content.trim() || submission.busy) return;
    setReceipt(null);
    const sent = content;
    const key = `${actualMode}:${sent}`;
    // Retry the same failed submission with the same idempotency key, not a duplicate turn.
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    void submission.run(async () => {
      const result = await api<SubmitResult>(`/api/sessions/${segment(id)}/${actualMode === "ask" ? "ask" : "submit"}`, { method: "POST", body: { content: sent, requestId } });
      setReceipt(result);
      if (actualMode === "ask") setConversationId(result.conversationId);
      setContent(current => current === sent ? "" : current);
      request.current = null;
      live.refresh();
    });
  }
  function decide(approval: ApprovalRecord, decision: "approve" | "deny") {
    if (!canApprove || approvalAction.busy || !approval.reviewHash || approval.status !== "pending") return;
    if (decision === "approve" && !window.confirm(live.session?.hostUnsandboxed
      ? "Approve this exact operation? It will run as the session owner on an UNSANDBOXED host: directly on the host owner's machine, with their full user permissions and network access, and no resource limits."
      : "Approve this exact operation? It will run as the session owner.")) return;
    void approvalAction.run(async () => {
      await api(`/api/sessions/${segment(id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision, reviewHash: approval.reviewHash } });
      live.refresh();
    }, decision === "approve" ? "Approval decision recorded." : "Operation denied.");
  }
  const session = live.session;
  const pendingApprovals = view?.approvals.filter(approval => approval.status === "pending") ?? [];
  const decidedApprovals = view?.approvals.filter(approval => approval.status !== "pending") ?? [];
  const queueStatus = activeQueue.length ? `${activeQueue.length} submission${activeQueue.length === 1 ? "" : "s"} queued or running` : view?.busy ? "Work is running" : "Queue is empty";
  const unsandboxedWarning = session?.hostUnsandboxed && (canWrite || canApprove) && <p className="notice danger">This session's host runs without a sandbox. Approved commands and commits execute directly on the host owner's machine with their full user permissions, network access and no resource limits.</p>;
  const approvalCard = (approval: ApprovalRecord) => <article className="approval" key={approval.id}><div className="section-heading"><h3>{approval.operation.kind}</h3><span className={`badge ${approval.status === "pending" ? "warning" : ""}`}>{approval.status}</span></div><pre className="operation">{JSON.stringify(approval.operation, null, 2)}</pre><p className="metadata">Requested by {approval.requestedBy} / <Timestamp value={approval.createdAt} /></p>{approval.decidedBy && <p className="metadata">Decision by {approval.decidedBy}</p>}{approval.result && <pre>{approval.result}</pre>}{approval.status === "pending" && (canApprove ? <>{!approval.reviewHash && <div className="notice"><p>This approval has no verified review commitment. Refresh before deciding; the server must bind the displayed operation and requester.</p><button className="button secondary small" disabled={approvalAction.busy} onClick={live.refresh}>Refresh approval</button></div>}<div className="actions"><button className="button primary small" disabled={approvalAction.busy || !approval.reviewHash} onClick={() => decide(approval, "approve")}>Approve exact operation</button><button className="button danger small" disabled={approvalAction.busy || !approval.reviewHash} onClick={() => decide(approval, "deny")}>Deny</button></div></> : <p className="muted">Waiting for an authorized approver.</p>)}</article>;
  const sidebar = session && <aside className="session-sidebar">
    <SessionHost session={session} user={user} />
    <SessionRepositories session={session} refresh={live.refresh} selectWorkspace={selectWorkspace} />
    <SessionControls session={session} user={user} onChange={live.refresh} busy={!view || Boolean(live.error) || view.busy || activeQueue.length > 0} openSession={openSession} />
  </aside>;
  return <>
    <PageHeading eyebrow="Session" title={session?.title ?? "Opening the session."} actions={<button className="button secondary" onClick={goBack}>Back to sessions</button>}>{view ? `Runs as ${view.owner.displayName}${isOwner ? " (you)" : ""}. The server checks every action.` : "The server checks every action."}</PageHeading>
    {session && <div className="actions" aria-label="Session status">
      <span className="badge">{isOwner ? "Owner" : viewerOnly ? "Viewer" : "Collaborator"}</span>
      <span className="badge">{session.visibility === "workspace" ? "Workspace-visible" : "Private"}</span>
      <span className={`stream-status ${live.status}`} role="status">{live.status === "online" ? "Live" : live.status === "reconnecting" ? "Reconnecting automatically" : live.status === "offline" ? "Disconnected" : "Connecting"}</span>
    </div>}
    <Feedback error={live.error} />
    {live.error && <div className="actions"><button className="button secondary" onClick={live.reconnect}>Reconnect and check access</button></div>}
    {!view && !live.error && <p className="loading" role="status">Loading identity and committed history...</p>}
    {session && <Details summary="Access and identity">
      {view && <p>Work runs as <strong>{view.owner.displayName}</strong> ({view.owner.githubLogin ? `GitHub @${view.owner.githubLogin}` : "no GitHub login connected"}), committing as {view.owner.gitName} &lt;{view.owner.gitEmail}&gt;.</p>}
      <p>Your permissions: <strong>{permissions.join(", ") || "none"}</strong>.{viewerOnly ? " You can follow committed work but can't ask, submit, approve, manage grants, change visibility, or use backups." : ""}</p>
      <p>{session.visibility === "workspace"
        ? "Workspace-visible: all workspace members can view existing and future prompts and output, including tool output, repository content in the transcript, and side asks."
        : "Private: only the owner and members with a session grant can view prompts and output."} Viewing doesn't grant ask, write, approve or manage permissions, GitHub access, or tool use. Only the owner can change visibility; it's separate from host sharing and agent publishing.</p>
      <p className="metadata">Session ID</p>
      <CopyField value={id} />
    </Details>}
    {!view && sidebar}
    {view && session && <div className="session-layout"><div className="session-main">
      <Feedback {...approvalAction} />
      {pendingApprovals.length > 0 && <section className="section" aria-label="Pending approvals">
        <div className="section-heading"><h2>Waiting for approval</h2><span className="badge warning">{pendingApprovals.length} pending</span></div>
        <p className="muted">{canApprove ? "Each approval covers one exact operation and its arguments." : "Only collaborators with approve permission can decide."}</p>
        {unsandboxedWarning}
        <div className="approval-list">{pendingApprovals.map(approvalCard)}</div>
      </section>}
      <section className="section" aria-label="Conversation">
        <div className="section-heading"><h2>Conversation</h2></div>
        {canAsk && <div className="mode-tabs" role="group" aria-label="Conversation mode"><button className={actualMode === "write" ? "active" : ""} aria-pressed={actualMode === "write"} onClick={() => setMode("write")}>Shared conversation</button><button className={actualMode === "ask" ? "active" : ""} aria-pressed={actualMode === "ask"} onClick={() => setMode("ask")}>My side ask</button></div>}
        {actualMode === "ask" && <p className="muted">Read-only: can't change files or run tools. Anyone who can view this session can see side asks.</p>}
        {actualMode === "write" && !canWrite && (canAsk
          ? <div className="notice"><p>You can ask questions in a read-only side conversation.</p><button className="button secondary small" onClick={() => setMode("ask")}>Open my side ask</button></div>
          : <p className="muted">You can follow along; submitting needs write permission.</p>)}
        {actualMode === "ask" && sideConversations.length > 0 && <label className="field">Side conversation<select value={conversationId} onChange={event => setConversationId(event.target.value)}><option value="">All my side asks</option>{sideConversations.map((conversation, index) => <option value={conversation.id} key={conversation.id}>Side ask {index + 1} / {conversation.id.slice(0, 8)}</option>)}</select></label>}
        <div className="transcript" aria-label={actualMode === "ask" ? "Side ask history" : "Shared session history"}>{!entries.length ? <Empty title={actualMode === "ask" ? "A question on the side" : "The conversation begins here"}>{actualMode === "ask" ? "Ask about the work without changing it." : "Committed messages and tool results will appear here."}</Empty> : entries.map(entry => <TranscriptEntry entry={entry} userId={user.id} key={entry.id} />)}</div>
        <Details summary={<span role="status" aria-live="polite">{queueStatus}</span>}>
          <p className="metadata">Submissions and side asks share one queue; permissions are checked again before work runs. You can leave this page: accepted work continues while the host is online and authorized.</p>
          {live.error && <p className="notice">This is the last received queue view; live host status is not confirmed.</p>}
          {Boolean(activeQueue.length) && <ol className="queue-list">{activeQueue.map((item, index) => <li key={item.submissionId}><div className="section-heading"><strong>{index + 1}. {item.mode === "ask" ? "Read-only side ask" : "Shared submission"}</strong><span className="badge">{item.status}</span></div><p>Submitted by {item.actorId === user.id ? "you" : item.actorId}</p><p className="metadata">Receipt: {item.submissionId}</p></li>)}</ol>}
          {recentSubmissions.length > 0 && <><h3>Recent outcomes</h3><ul className="queue-list">{recentSubmissions.map(item => <li key={item.submissionId}><strong>{item.status}</strong> / {item.mode === "ask" ? "Side ask" : "Shared submission"}<p className="metadata">By {item.actorId === user.id ? "you" : item.actorId} / Receipt: {item.submissionId}</p></li>)}</ul></>}
          <div className="actions"><button type="button" className="button secondary small" onClick={live.refresh}>Refresh queue</button></div>
        </Details>
        {actualMode === "write" && canWrite && !pendingApprovals.length && unsandboxedWarning}
        {permitted && <form className="composer" onSubmit={submit}><label className="field">{actualMode === "ask" ? "Ask without making changes" : "Continue the shared work"}<textarea rows={4} required value={content} onChange={event => setContent(event.target.value)} disabled={submission.busy} placeholder={actualMode === "ask" ? "What would you like to understand?" : "Describe the next step..."} /></label><Feedback {...submission} />{receipt && <p className="notice" role="status">Submission {receipt.status}{receipt.queuePosition !== undefined ? ` / queue position ${receipt.queuePosition}` : ""}. Receipt: <code>{receipt.submissionId}</code>.</p>}<div className="actions"><button className="button primary" disabled={submission.busy || !content.trim()}>{submission.busy ? "Submitting..." : actualMode === "ask" ? "Send side ask" : "Submit to session"}</button><span className="metadata">{actualMode === "ask" ? "Read-only branch" : "Runs as session owner"}</span></div></form>}
      </section>
      {decidedApprovals.length > 0 && <Details summary={`Approval history (${decidedApprovals.length})`}><div className="approval-list">{decidedApprovals.map(approvalCard)}</div></Details>}
    </div>{sidebar}</div>}
  </>;
}
