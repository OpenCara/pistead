import { useState, type FormEvent } from "react";
import type { SessionRecord, UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction, useResource } from "./ui";

export function Sessions({ user, workspace, openSession, openLibrary }: { user: UserProfile; workspace: Workspace | null; openSession: (id: string) => void; openLibrary: () => void }) {
  const resource = useResource<{ sessions: SessionRecord[] }>("/api/sessions");
  const [joinId, setJoinId] = useState("");
  const action = useAction();
  const sessions = resource.data?.sessions.filter(session => !workspace || session.workspaceId === workspace.id) ?? [];
  function join(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const result = await api<{ session: SessionRecord }>(`/api/sessions/${segment(joinId.trim())}`);
      openSession(result.session.id);
    });
  }
  return <>
    <PageHeading number="03" title="Work, in company." actions={<button className="button primary" onClick={openLibrary}>Use an agent to start</button>}>Your own sessions, sessions explicitly shared with you, and workspace-visible sessions. Workspace visibility lets members view prompts and output; ask, write, approve, and manage still require separate grants. An agent's author does not automatically get access.</PageHeading>
    <div className="split-layout"><section className="section"><div className="section-heading"><span className="section-number">01</span><h2>{workspace ? `Sessions in ${workspace.name}` : "Accessible sessions"}</h2><button className="button secondary small" onClick={resource.refresh}>Refresh</button></div>
      <ResourceState {...resource} retry={resource.refresh}>{!sessions.length ? <Empty title="An open page">Start your own session from the Agent Library, open a workspace-visible session, or ask a session owner for an explicit grant.</Empty> : <div className="row-list">{sessions.map(session => {
        const isOwner = session.ownerId === user.id;
        const viewerOnly = !isOwner && session.permissions?.includes("read") && session.permissions.every(permission => permission === "read");
        return <div className="list-row" key={session.id}>
          <div className="row-main">
            <p className="eyebrow">{isOwner ? "Owned by you" : viewerOnly ? "Viewer-only" : "Shared with you"} / {session.status}</p>
            <h3>{session.title}</h3>
            <p className="metadata">Visibility: {session.visibility === "workspace" ? "Workspace-visible - members can view prompts and output" : "Private - owner and explicit grants only"}</p>
            <p className="metadata">{viewerOnly ? "Read-only viewer: no ask, write, approve, or manage access." : session.permissions?.join(" + ") || "Access checked on open"}</p>
            <p className="metadata"><Timestamp value={session.createdAt} /></p>
          </div>
          <button className="button secondary" onClick={() => openSession(session.id)}>{viewerOnly ? "View session" : "Open session"}</button>
        </div>;
      })}</div>}</ResourceState>
    </section><aside className="rail"><p className="eyebrow">Open an existing session</p><h2>Same work.<br />Same owner.</h2><p>Opening a session keeps the original owner's identity and committed history. Workspace members can view workspace-visible sessions without an explicit grant. Private sessions require ownership or an explicit grant.</p><p>Session visibility is separate from sharing a private host or publishing an agent. Only the session owner can change visibility.</p><form onSubmit={join}><label className="field">Session ID<input required value={joinId} onChange={event => setJoinId(event.target.value)} placeholder="Ask the owner for the session ID" autoComplete="off" /></label><Feedback {...action} /><button className="button secondary" disabled={action.busy || !joinId.trim()}>{action.busy ? "Checking access..." : "Open session"}</button></form></aside></div>
  </>;
}
