import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApprovalRecord, SessionRecord, SessionView, SubmitResult, UserProfile } from "../../../packages/shared/src/types";
import { api, ApiError, errorMessage, segment } from "./api";
import { Empty, Feedback, PageHeading, Timestamp, useAction } from "./ui";
import { SessionControls } from "./SessionControls";

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

export function SessionDetail({ id, user, goBack }: { id: string; user: UserProfile; goBack: () => void }) {
  const live = useLiveSession(id);
  const [mode, setMode] = useState<"write" | "ask">("write");
  const [content, setContent] = useState("");
  const [conversationId, setConversationId] = useState("");
  const request = useRef<{ key: string; id: string } | null>(null);
  const submission = useAction();
  const approvalAction = useAction();
  const permissions = live.session?.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  const canApprove = permissions.includes("approve");
  const actualMode = mode === "ask" && !canAsk ? "write" : mode;
  const permitted = actualMode === "write" ? canWrite : canAsk;
  const view = live.view;
  const conversations = view?.conversations ?? [];
  const sideConversations = conversations.filter(item => item.mode === "ask" && (!item.actorId || item.actorId === user.id));
  const entries = view?.entries.filter(entry => {
    const conversation = conversations.find(item => item.id === entry.conversationId);
    if (actualMode === "ask") return conversation?.mode === "ask" && (!conversation.actorId || conversation.actorId === user.id) && (!conversationId || entry.conversationId === conversationId);
    return conversation?.mode !== "ask";
  }) ?? [];
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!permitted || !content.trim()) return;
    const sent = content;
    const key = `${actualMode}:${sent}`;
    // Retry the same failed submission with the same idempotency key, not a duplicate turn.
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    void submission.run(async () => {
      const result = await api<SubmitResult>(`/api/sessions/${segment(id)}/${actualMode === "ask" ? "ask" : "submit"}`, { method: "POST", body: { content: sent, requestId } });
      if (actualMode === "ask") setConversationId(result.conversationId);
      setContent(current => current === sent ? "" : current);
      request.current = null;
      live.refresh();
    }, "Accepted. Committed output will appear in the live view.");
  }
  function decide(approval: ApprovalRecord, decision: "approve" | "deny") {
    if (decision === "approve" && !window.confirm("Approve this exact operation? It will run as the session owner.")) return;
    void approvalAction.run(async () => {
      await api(`/api/sessions/${segment(id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision } });
      live.refresh();
    }, decision === "approve" ? "Approval decision recorded." : "Operation denied.");
  }
  return <>
    <PageHeading number="03" title={live.session?.title ?? "Opening the session."} actions={<button className="button secondary" onClick={goBack}>Back to sessions</button>}>Shared work has a clear owner. Every permission is checked by the server.</PageHeading>
    <Feedback error={live.error} />
    {live.error && <div className="actions"><button className="button secondary" onClick={live.reconnect}>Reconnect and check access</button></div>}
    {!view && !live.error && <p className="loading" role="status">Loading identity and committed history...</p>}
    {view && live.session && <>
      <section className="owner-banner" aria-label="Session owner identity"><div><p className="eyebrow">Acts as owner</p><h2>{view.owner.displayName}</h2><p>{view.owner.githubLogin ? `GitHub @${view.owner.githubLogin}` : "No GitHub login connected"} <span aria-hidden="true">/</span> {view.owner.gitName} &lt;{view.owner.gitEmail}&gt;</p></div><div><span className="badge">{live.session.ownerId === user.id ? "You own this session" : "You are a collaborator"}</span><p className="mono">Your permissions: {permissions.join(" / ") || "none"}</p><p className="metadata">Session ID: {id}</p></div></section>
      <div className="session-layout"><div className="session-main"><section className="section"><div className="section-heading"><h2>Committed conversation</h2><span className={`stream-status ${live.status}`} role="status">{live.status === "online" ? "Live" : live.status === "reconnecting" ? "Reconnecting automatically" : live.status === "offline" ? "Disconnected" : "Connecting"}</span></div>
        <div className="mode-tabs" role="group" aria-label="Conversation mode"><button className={actualMode === "write" ? "active" : ""} aria-pressed={actualMode === "write"} onClick={() => setMode("write")}>Shared conversation</button>{canAsk && <button className={actualMode === "ask" ? "active" : ""} aria-pressed={actualMode === "ask"} onClick={() => setMode("ask")}>My side ask</button>}</div>
        <p className="muted">{actualMode === "ask" ? "A read-only side conversation, not a private channel: authorized session readers may access it. Asking cannot write files or invoke the main session's tools." : canWrite ? "Your submissions continue the shared session using the owner's identity and allowed tools." : "Read-only access. You can follow committed work, but cannot submit to the shared conversation."}</p>
        {actualMode === "write" && !canWrite && canAsk && <div className="notice"><p>You can ask questions in a read-only side conversation.</p><button className="button secondary small" onClick={() => setMode("ask")}>Open my side ask</button></div>}
        {actualMode === "ask" && sideConversations.length > 0 && <label className="field">Side conversation<select value={conversationId} onChange={event => setConversationId(event.target.value)}><option value="">All my side asks</option>{sideConversations.map((conversation, index) => <option value={conversation.id} key={conversation.id}>Side ask {index + 1} / {conversation.id.slice(0, 8)}</option>)}</select></label>}
        <div className="transcript" aria-label={actualMode === "ask" ? "Side ask history" : "Shared session history"}>{!entries.length ? <Empty title={actualMode === "ask" ? "A question on the side" : "The conversation begins here"}>{actualMode === "ask" ? "Ask about the work without changing it." : "Committed messages and tool results will appear here."}</Empty> : entries.map(entry => <article className="entry" key={entry.id}><header className="entry-header"><span>{entry.role}</span><span>{entry.kind}</span>{entry.actorId && <span title={entry.actorId}>Initiated by {entry.actorId === user.id ? "you" : entry.actorId}</span>}</header><div className="entry-body">{entry.text}</div></article>)}</div>
        {view.busy && <p className="notice" role="status">The agent is working. You can leave this page; execution continues on the runner.</p>}
        {permitted && <form className="composer" onSubmit={submit}><label className="field">{actualMode === "ask" ? "Ask without making changes" : "Continue the shared work"}<textarea rows={4} required value={content} onChange={event => setContent(event.target.value)} disabled={submission.busy} placeholder={actualMode === "ask" ? "What would you like to understand?" : "Describe the next step..."} /></label><Feedback {...submission} /><div className="actions"><button className="button primary" disabled={submission.busy || !content.trim()}>{submission.busy ? "Submitting..." : actualMode === "ask" ? "Send side ask" : "Submit to session"}</button><span className="metadata">{actualMode === "ask" ? "Read-only branch" : "Runs as session owner"}</span></div></form>}
      </section>
      <section className="section"><div className="section-heading"><h2>Approval desk</h2><span className="badge">{view.approvals.filter(approval => approval.status === "pending").length} pending</span></div><p className="muted">Approvals bind an exact operation and its arguments. Only collaborators with approve permission can decide.</p><Feedback {...approvalAction} />
        {!view.approvals.length ? <Empty title="Nothing awaiting a decision">Sensitive operations appear here before execution.</Empty> : <div className="approval-list">{view.approvals.map(approval => <article className="approval" key={approval.id}><div className="section-heading"><h3>{approval.operation.kind}</h3><span className={`badge ${approval.status === "pending" ? "warning" : ""}`}>{approval.status}</span></div><pre className="operation">{JSON.stringify(approval.operation, null, 2)}</pre><p className="metadata">Requested by {approval.requestedBy} / <Timestamp value={approval.createdAt} /></p>{approval.decidedBy && <p className="metadata">Decision by {approval.decidedBy}</p>}{approval.result && <pre>{approval.result}</pre>}{approval.status === "pending" && (canApprove ? <div className="actions"><button className="button primary small" disabled={approvalAction.busy} onClick={() => decide(approval, "approve")}>Approve exact operation</button><button className="button danger small" disabled={approvalAction.busy} onClick={() => decide(approval, "deny")}>Deny</button></div> : <p className="muted">Waiting for an authorized approver.</p>)}</article>)}</div>}
      </section></div><aside className="session-sidebar"><SessionControls session={live.session} user={user} onChange={live.refresh} /></aside></div>
    </>}
  </>;
}
