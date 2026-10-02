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
    <PageHeading number="03" title="Work, in company." actions={<button className="button primary" onClick={openLibrary}>Use an agent to start</button>}>Your own sessions and the sessions shared with you. An agent's author does not automatically get access.</PageHeading>
    <div className="split-layout"><section className="section"><div className="section-heading"><span className="section-number">01</span><h2>{workspace ? `Sessions in ${workspace.name}` : "Accessible sessions"}</h2><button className="button secondary small" onClick={resource.refresh}>Refresh</button></div>
      <ResourceState {...resource} retry={resource.refresh}>{!sessions.length ? <Empty title="An open page">Start your own session from the Agent Library, or ask a session owner to grant you access.</Empty> : <div className="row-list">{sessions.map(session => <div className="list-row" key={session.id}><div className="row-main"><p className="eyebrow">{session.ownerId === user.id ? "Owned by you" : "Shared with you"} / {session.status}</p><h3>{session.title}</h3><p className="metadata">{session.permissions?.join(" + ") || "Access checked on open"}</p><p className="metadata"><Timestamp value={session.createdAt} /></p></div><button className="button secondary" onClick={() => openSession(session.id)}>{session.ownerId === user.id ? "Open session" : "Join shared session"}</button></div>)}</div>}</ResourceState>
    </section><aside className="rail"><p className="eyebrow">Join an existing session</p><h2>Same work.<br />Same owner.</h2><p>Joining keeps the original owner's identity and committed history. You need an explicit session grant; workspace membership alone is not enough.</p><form onSubmit={join}><label className="field">Session ID<input required value={joinId} onChange={event => setJoinId(event.target.value)} placeholder="Ask the owner for the session ID" autoComplete="off" /></label><Feedback {...action} /><button className="button secondary" disabled={action.busy || !joinId.trim()}>{action.busy ? "Checking access..." : "Join shared session"}</button></form></aside></div>
  </>;
}
