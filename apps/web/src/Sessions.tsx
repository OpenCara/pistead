import { useState, type FormEvent } from "react";
import type { SessionRecord, UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { Details, Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction, useResource } from "./ui";

const statusBadge: Record<SessionRecord["status"], string> = { ready: "badge success", provisioning: "badge warning", error: "badge danger", archived: "badge" };

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
    <PageHeading title="Sessions" actions={<button className="button primary" onClick={openLibrary}>Use an agent to start</button>}>Sessions you own, were shared with you, or can view in your workspace.</PageHeading>
    <section className="section"><div className="section-heading"><h2>{workspace ? `Sessions in ${workspace.name}` : "Accessible sessions"}</h2><button className="button secondary small" onClick={resource.refresh}>Refresh</button></div>
      <ResourceState {...resource} retry={resource.refresh}>{!sessions.length ? <Empty title="No sessions yet">Start one from the Agent Library, or ask a session owner to share theirs.</Empty> : <div className="row-list">{sessions.map(session => {
        const isOwner = session.ownerId === user.id;
        const viewerOnly = !isOwner && session.permissions?.includes("read") && session.permissions.every(permission => permission === "read");
        return <div className="list-row" key={session.id}>
          <div className="row-main">
            <h3>{session.title}</h3>
            <p className="metadata"><span className={statusBadge[session.status]}>{session.status}</span> <span className="badge">{isOwner ? "Yours" : viewerOnly ? "Viewer" : "Shared"}</span> <span className="badge">{session.visibility === "workspace" ? "Workspace" : "Private"}</span> <Timestamp value={session.createdAt} /></p>
          </div>
          <div className="row-actions"><button className="button secondary" onClick={() => openSession(session.id)}>Open</button></div>
        </div>;
      })}</div>}</ResourceState>
    </section>
    <Details summary="Open a session by ID">
      <form onSubmit={join}><label className="field">Session ID<input required value={joinId} onChange={event => setJoinId(event.target.value)} placeholder="Ask the owner for the session ID" autoComplete="off" /></label><Feedback {...action} /><button className="button secondary" disabled={action.busy || !joinId.trim()}>{action.busy ? "Checking access..." : "Open session"}</button></form>
    </Details>
    <Details summary="Who can see a session">
      <p>Private sessions are visible to their owner and people with an explicit grant. Workspace-visible sessions can be viewed by every workspace member.</p>
      <p>Viewing never allows asking, writing, approving or managing; those need separate grants. An agent's author gets no automatic access. Opening a session keeps its original owner identity and history.</p>
      <p>Only the owner can change visibility, which is separate from sharing a host or publishing an agent.</p>
    </Details>
  </>;
}
