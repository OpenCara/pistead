import { useState, type FormEvent } from "react";
import type { UserProfile, Workspace, WorkspaceRole } from "../../../packages/shared/src/types";
import type { WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { WorkspaceRepositories } from "./WorkspaceRepositories";
import { WorkspaceConnections } from "./Connections";
import { api, segment } from "./api";
import { Empty, Feedback, PageHeading, ResourceState, useAction, useResource } from "./ui";

interface Member { userId: string; role: WorkspaceRole; displayName?: string; githubLogin?: string | null }

export function Workspaces({ user, workspaces, workspace, refresh, select }: { user: UserProfile; workspaces: Workspace[]; workspace: Workspace | null; refresh: () => void; select: (id: string) => void }) {
  const [name, setName] = useState("");
  const action = useAction();
  function create(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const result = await api<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: { name: name.trim() } });
      setName("");
      select(result.workspace.id);
      refresh();
    }, "Workspace created. Next, bind at least one GitHub repository below.");
  }
  return <>
    <PageHeading title="Workspaces">A place for people, private or published agents, and workspace-visible sessions. Members can follow those sessions read-only; additional session permissions require explicit grants.</PageHeading>
    <ol className="setup-steps" aria-label="Workspace setup"><li><strong>Create a workspace</strong><span>Choose the people and place.</span></li><li><strong>Bind repositories</strong><span>An owner or admin chooses GitHub source.</span></li><li><strong>Connect Pi</strong><span>Pair your Pi for your own use. Sharing stays optional.</span></li><li><strong>Run a private agent</strong><span>Create an agent using your Pi model and run it without publishing. Keep the default workspace-visible session for members to follow read-only.</span></li></ol>
    <div className="split-layout"><section className="section">
      <div className="section-heading"><h2>Your workspaces</h2><span className="badge">{workspaces.length}</span></div>
      {workspaces.length === 0 ? <Empty title="Start a workshop">Create a workspace, bind repositories, and connect your private Pi. You can run your own agent without publishing or sharing the host.</Empty> : <div className="row-list">{workspaces.map(item => <div className="list-row" key={item.id}><div className="row-main"><h3>{item.name}</h3><p className="metadata">{item.role ?? (item.ownerId === user.id ? "owner" : "member")}</p></div><button className={`button ${workspace?.id === item.id ? "primary" : "secondary"} small`} onClick={() => select(item.id)} aria-pressed={workspace?.id === item.id}>{workspace?.id === item.id ? "Selected" : "Select workspace"}</button></div>)}</div>}
    </section><aside className="rail"><h2>Create a workspace</h2><form onSubmit={create}><label className="field">Workspace name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="The field studio" /></label><Feedback {...action} /><button className="button primary" disabled={action.busy || !name.trim()}>{action.busy ? "Creating..." : "Create workspace"}</button></form></aside></div>
    {workspace && <WorkspaceSettings key={workspace.id} user={user} workspace={workspace} />}
  </>;
}

function WorkspaceSettings({ user, workspace }: { user: UserProfile; workspace: Workspace }) {
  const admin = workspace.ownerId === user.id || workspace.role === "admin" || workspace.role === "owner";
  const repositories = useResource<{ repositories: WorkspaceRepository[] }>(`/api/workspaces/${segment(workspace.id)}/repositories`);
  const configured = !repositories.loading && !repositories.error && Boolean(repositories.data?.repositories.length);
  return <><WorkspaceRepositories workspace={workspace} user={user} admin={admin} repositories={repositories.data?.repositories ?? null} loading={repositories.loading} error={repositories.error} refresh={repositories.refresh} /><div className="split-layout"><WorkspaceConnections workspace={workspace} user={user} configured={configured} /><Members workspace={workspace} admin={admin} /></div></>;
}

function Members({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/members`;
  const resource = useResource<{ members: Member[] }>(path);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const action = useAction();
  function save(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      await api(path, { method: "POST", body: { userId: userId.trim(), role } });
      setUserId("");
      resource.refresh();
    }, "Membership saved. Members can view workspace-visible sessions read-only; further session permissions require explicit grants.");
  }
  return <section className="section"><div className="section-heading"><h2>People in {workspace.name}</h2></div><p className="muted">Membership gives access to published agents and read-only access to workspace-visible sessions. Private sessions require explicit grants. Workspace-visible sessions expose prompts, tool output and repository content shown in the transcript, not direct GitHub access or tool execution. Membership alone does not grant ask, write, approve or manage permissions, or use of private Pi hosts.</p>
    <ResourceState {...resource} retry={resource.refresh}>{resource.data?.members.length === 0 && <Empty title="No members to display">Workspace membership is managed by the owner and admins.</Empty>}<div className="row-list">{resource.data?.members.map(member => <div className="list-row" key={member.userId}><div className="row-main"><h3>{member.displayName || member.githubLogin || member.userId}</h3><p className="metadata">{member.role} / {member.userId}</p></div>{admin && member.userId !== workspace.ownerId && <button className="button danger small" disabled={action.busy} onClick={() => { if (window.confirm(`Remove ${member.displayName || member.userId} from this workspace?`)) void action.run(async () => { await api(`${path}/${segment(member.userId)}`, { method: "DELETE" }); resource.refresh(); }, "Membership removed."); }}>Remove</button>}</div>)}</div></ResourceState>
    {admin ? <form onSubmit={save}><h3>Add or update a member</h3><div className="inline-fields"><label className="field">User ID<input required value={userId} onChange={event => setUserId(event.target.value)} placeholder="Copy from their Profile" /></label><label className="field">Role<select value={role} onChange={event => setRole(event.target.value as "member" | "admin")}><option value="member">Member</option><option value="admin">Admin</option></select></label></div><button className="button secondary" disabled={action.busy || !userId.trim()}>{action.busy ? "Saving..." : "Save membership"}</button></form> : <p className="muted">Only workspace owners and admins can manage membership.</p>}
    <Feedback {...action} />
  </section>;
}
