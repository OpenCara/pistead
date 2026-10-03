import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApprovalRecord, SessionRecord, SessionView, SubmitResult, UserProfile } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage, segment } from "./api";
import { Empty, Feedback, PageHeading, Timestamp, useAction } from "./ui";
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
    if (decision === "approve" && !window.confirm("Approve this exact operation? It will run as the session owner.")) return;
    void approvalAction.run(async () => {
      await api(`/api/sessions/${segment(id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision, reviewHash: approval.reviewHash } });
      live.refresh();
    }, decision === "approve" ? "Approval decision recorded." : "Operation denied.");
  }
  return <>
    <PageHeading number="03" title={live.session?.title ?? "Opening the session."} actions={<button className="button secondary" onClick={goBack}>Back to sessions</button>}>Shared work has a clear owner. Every permission is checked by the server.</PageHeading>
    <Feedback error={live.error} />
    {live.error && <div className="actions"><button className="button secondary" onClick={live.reconnect}>Reconnect and check access</button></div>}
    {!view && !live.error && <p className="loading" role="status">Loading identity and committed history...</p>}
    {live.session && <section className="notice" aria-label="Session viewing access">
      <p><strong>{live.session.visibility === "workspace" ? "Workspace-visible" : "Private"}</strong> / {isOwner ? "Session owner" : viewerOnly ? "Viewer-only access" : "Granted collaborator access"}</p>
      <p>{live.session.visibility === "workspace"
        ? "All workspace members can view this session's existing and future prompts and output, including tool output, repository content shown in the transcript, and side asks. Workspace viewing does not grant ask, write, approve, or manage permissions."
        : "Only the owner and workspace members with explicit session grants can view this session's prompts and output."}</p>
      {viewerOnly && <p>You can follow committed work, but cannot ask questions, submit work, approve operations, manage grants, change visibility, or access backups.</p>}
      <p className="metadata">Workspace viewing does not grant direct GitHub access or permission to run tools. Only the owner can change visibility. Session visibility is separate from private host sharing and agent publication.</p>
    </section>}
    {live.session && <SessionHost session={live.session} user={user} />}
    {!view && live.session && <SessionControls session={live.session} user={user} onChange={live.refresh} busy openSession={openSession} />}
    {live.session && <SessionRepositories session={live.session} refresh={live.refresh} selectWorkspace={selectWorkspace} />}
    {view && live.session && <>
      <section className="owner-banner" aria-label="Session owner identity"><div><p className="eyebrow">Acts as owner</p><h2>{view.owner.displayName}</h2><p>{view.owner.githubLogin ? `GitHub @${view.owner.githubLogin}` : "No GitHub login connected"} <span aria-hidden="true">/</span> {view.owner.gitName} &lt;{view.owner.gitEmail}&gt;</p></div><div><span className="badge">{isOwner ? "You own this session" : viewerOnly ? "You are a read-only viewer" : "You are a collaborator"}</span><p className="mono">Your permissions: {permissions.join(" / ") || "none"}</p><p className="metadata">Session ID: {id}</p></div></section>
      <div className="session-layout"><div className="session-main"><section className="section"><div className="section-heading"><h2>Committed conversation</h2><span className={`stream-status ${live.status}`} role="status">{live.status === "online" ? "Live" : live.status === "reconnecting" ? "Reconnecting automatically" : live.status === "offline" ? "Disconnected" : "Connecting"}</span></div>
        <div className="mode-tabs" role="group" aria-label="Conversation mode"><button className={actualMode === "write" ? "active" : ""} aria-pressed={actualMode === "write"} onClick={() => setMode("write")}>Shared conversation</button>{canAsk && <button className={actualMode === "ask" ? "active" : ""} aria-pressed={actualMode === "ask"} onClick={() => setMode("ask")}>My side ask</button>}</div>
        <p className="muted">{actualMode === "ask" ? "A read-only side conversation, not a private channel: authorized session readers, including workspace members when workspace-visible, may access its prompts and output. Asking cannot write files or invoke the main session's tools." : canWrite ? "Your submissions continue the shared session using the owner's identity and allowed tools." : "You can follow committed work, but submitting to the shared conversation requires write permission."}</p>
        {actualMode === "write" && !canWrite && canAsk && <div className="notice"><p>You can ask questions in a read-only side conversation.</p><button className="button secondary small" onClick={() => setMode("ask")}>Open my side ask</button></div>}
        {actualMode === "ask" && sideConversations.length > 0 && <label className="field">Side conversation<select value={conversationId} onChange={event => setConversationId(event.target.value)}><option value="">All my side asks</option>{sideConversations.map((conversation, index) => <option value={conversation.id} key={conversation.id}>Side ask {index + 1} / {conversation.id.slice(0, 8)}</option>)}</select></label>}
        <div className="transcript" aria-label={actualMode === "ask" ? "Side ask history" : "Shared session history"}>{!entries.length ? <Empty title={actualMode === "ask" ? "A question on the side" : "The conversation begins here"}>{actualMode === "ask" ? "Ask about the work without changing it." : "Committed messages and tool results will appear here."}</Empty> : entries.map(entry => <article className="entry" key={entry.id}><header className="entry-header"><span>{entry.role}</span><span>{entry.kind}</span>{entry.actorId && <span title={entry.actorId}>Initiated by {entry.actorId === user.id ? "you" : entry.actorId}</span>}</header><div className="entry-body">{entry.text}</div></article>)}</div>
        <section className="submission-queue" aria-label="Live submissions"><div className="section-heading"><h3>Live submissions</h3><button type="button" className="button secondary small" onClick={live.refresh}>Refresh queue</button></div><p className="metadata">Write submissions and read-only side asks share a durable FIFO queue. Permissions are checked again before work runs.</p><p role="status" aria-live="polite">{activeQueue.length ? `${activeQueue.length} submission${activeQueue.length === 1 ? "" : "s"} in the latest queue view.` : view.busy ? "Session work is active; waiting for the next queue update." : "No queued work in the latest view."}</p>{Boolean(activeQueue.length) && <ol className="queue-list">{activeQueue.map((item, index) => <li key={item.submissionId}><div className="section-heading"><strong>{index + 1}. {item.mode === "ask" ? "Read-only side ask" : "Shared submission"}</strong><span className="badge">{item.status}</span></div><p>Submitted by {item.actorId === user.id ? "you" : item.actorId}</p><p className="metadata">Receipt: {item.submissionId}</p></li>)}</ol>}{recentSubmissions.length > 0 && <details><summary>Recent submission outcomes</summary><ul className="queue-list">{recentSubmissions.map(item => <li key={item.submissionId}><strong>{item.status}</strong> / {item.mode === "ask" ? "Side ask" : "Shared submission"}<p className="metadata">By {item.actorId === user.id ? "you" : item.actorId} / Receipt: {item.submissionId}</p></li>)}</ul></details>}{live.error && <p className="notice">This is the last received queue view; live host status is not confirmed.</p>}</section>
        {view.busy && <p className="notice" role="status">Work is queued or running. You can leave this page; accepted work remains on the host. Progress depends on the host being online and authorized.</p>}
        {permitted && <form className="composer" onSubmit={submit}><label className="field">{actualMode === "ask" ? "Ask without making changes" : "Continue the shared work"}<textarea rows={4} required value={content} onChange={event => setContent(event.target.value)} disabled={submission.busy} placeholder={actualMode === "ask" ? "What would you like to understand?" : "Describe the next step..."} /></label><Feedback {...submission} />{receipt && <p className="notice" role="status">Submission {receipt.status}{receipt.queuePosition !== undefined ? ` / queue position ${receipt.queuePosition}` : ""}. Receipt: <code>{receipt.submissionId}</code>. Committed output appears in the live view.</p>}<div className="actions"><button className="button primary" disabled={submission.busy || !content.trim()}>{submission.busy ? "Submitting..." : actualMode === "ask" ? "Send side ask" : "Submit to session"}</button><span className="metadata">{actualMode === "ask" ? "Read-only branch" : "Runs as session owner"}</span></div></form>}
      </section>
      <section className="section"><div className="section-heading"><h2>Approval desk</h2><span className="badge">{view.approvals.filter(approval => approval.status === "pending").length} pending</span></div><p className="muted">Approvals bind an exact operation and its arguments. Only collaborators with approve permission can decide.</p><Feedback {...approvalAction} />
        {!view.approvals.length ? <Empty title="Nothing awaiting a decision">Sensitive operations appear here before execution.</Empty> : <div className="approval-list">{view.approvals.map(approval => <article className="approval" key={approval.id}><div className="section-heading"><h3>{approval.operation.kind}</h3><span className={`badge ${approval.status === "pending" ? "warning" : ""}`}>{approval.status}</span></div><pre className="operation">{JSON.stringify(approval.operation, null, 2)}</pre><p className="metadata">Requested by {approval.requestedBy} / <Timestamp value={approval.createdAt} /></p>{approval.decidedBy && <p className="metadata">Decision by {approval.decidedBy}</p>}{approval.result && <pre>{approval.result}</pre>}{approval.status === "pending" && (canApprove ? <>{!approval.reviewHash && <div className="notice"><p>This approval has no verified review commitment. Refresh before deciding; the server must bind the displayed operation and requester.</p><button className="button secondary small" disabled={approvalAction.busy} onClick={live.refresh}>Refresh approval</button></div>}<div className="actions"><button className="button primary small" disabled={approvalAction.busy || !approval.reviewHash} onClick={() => decide(approval, "approve")}>Approve exact operation</button><button className="button danger small" disabled={approvalAction.busy || !approval.reviewHash} onClick={() => decide(approval, "deny")}>Deny</button></div></> : <p className="muted">Waiting for an authorized approver.</p>)}</article>)}</div>}
      </section></div><aside className="session-sidebar"><SessionControls session={live.session} user={user} onChange={live.refresh} busy={Boolean(live.error) || view.busy || activeQueue.length > 0} openSession={openSession} /></aside></div>
    </>}
  </>;
}
