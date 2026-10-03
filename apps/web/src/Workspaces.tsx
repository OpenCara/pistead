import { useState, type FormEvent } from "react";
import type { AgentVersion, SessionRecord, UserProfile, Workspace, WorkspaceRole } from "../../../packages/shared/src/types";
import type { WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { WorkspaceRepositories } from "./WorkspaceRepositories";
import { useConnections } from "./Connections";
import { api, segment } from "./api";
import { Checklist, Details, Empty, Feedback, PageHeading, ResourceState, useAction, useResource } from "./ui";

interface Member { userId: string; role: WorkspaceRole; displayName?: string; githubLogin?: string | null }

export function Workspaces({ user, workspaces, workspace, refresh, select }: { user: UserProfile; workspaces: Workspace[]; workspace: Workspace | null; refresh: () => void; select: (id: string) => void }) {
  const [creating, setCreating] = useState(false);
  if (workspaces.length === 0) return <>
    <PageHeading title="Workspaces">A shared home for your repositories, people, agents and sessions.</PageHeading>
    <section className="section"><div className="empty-state"><h3>Create your first workspace</h3><p>Name it, then bind a repository and connect your Pi.</p><CreateWorkspace refresh={refresh} select={select} /></div></section>
  </>;
  return <>
    <PageHeading title={workspace?.name ?? "Workspaces"} actions={!creating && <button type="button" className="button secondary small" onClick={() => setCreating(true)}>New workspace</button>}>Set up repositories and people for this workspace.</PageHeading>
    {creating && <section className="section" aria-label="New workspace"><div className="section-heading"><h2>New workspace</h2></div><CreateWorkspace refresh={refresh} select={select} close={() => setCreating(false)} /></section>}
    {workspace ? <WorkspaceHome key={workspace.id} user={user} workspace={workspace} /> : <section className="section"><Empty title="No workspace selected">Choose a workspace from the workspace menu.</Empty></section>}
  </>;
}

function CreateWorkspace({ refresh, select, close }: { refresh: () => void; select: (id: string) => void; close?: () => void }) {
  const [name, setName] = useState("");
  const action = useAction();
  function create(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const result = await api<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: { name: name.trim() } });
      setName("");
      select(result.workspace.id);
      refresh();
      close?.();
    }, "Workspace created. Next, bind a GitHub repository.");
  }
  return <form onSubmit={create}><label className="field">Workspace name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="The field studio" /></label><Feedback {...action} /><div className="actions"><button className="button primary" disabled={action.busy || !name.trim()}>{action.busy ? "Creating..." : "Create workspace"}</button>{close && <button type="button" className="button secondary" disabled={action.busy} onClick={close}>Cancel</button>}</div></form>;
}

function WorkspaceHome({ user, workspace }: { user: UserProfile; workspace: Workspace }) {
  const admin = workspace.ownerId === user.id || workspace.role === "admin" || workspace.role === "owner";
  const repositories = useResource<{ repositories: WorkspaceRepository[] }>(`/api/workspaces/${segment(workspace.id)}/repositories`);
  const connectors = useConnections(`/api/workspaces/${segment(workspace.id)}/connectors`);
  const agents = useResource<{ agents: AgentVersion[] }>("/api/agents");
  const sessions = useResource<{ sessions: SessionRecord[] }>("/api/sessions");
  const steps = [
    { label: "Bind a GitHub repository", done: Boolean(repositories.data?.repositories.length), detail: admin ? undefined : "An owner or admin does this.", action: <button type="button" className="button secondary small" onClick={() => document.getElementById("workspace-repositories")?.scrollIntoView({ behavior: "smooth" })}>Go to repositories</button> },
    { label: "Connect a Pi", done: Boolean(connectors.data?.connectors.some(connector => !connector.revokedAt && connector.online && (connector.ownerId === user.id || connector.workspaceIds.includes(workspace.id)))), action: <a className="button secondary small" href="#connections">Connect</a> },
    { label: "Create an agent", done: Boolean(agents.data?.agents.length), action: <a className="button secondary small" href="#agents">Create</a> },
    { label: "Start a session", done: Boolean(sessions.data?.sessions.some(session => session.workspaceId === workspace.id)), action: <a className="button secondary small" href="#agents">Start</a> },
  ];
  const complete = steps.every(step => step.done);
  return <>
    <section className="section" aria-label="Workspace setup">
      {complete ? <><div className="section-heading"><h2>Ready to work</h2><span className="badge success">Setup complete</span></div><Details summary="Setup"><Checklist items={steps} /></Details></> : <><div className="section-heading"><h2>Get started</h2><span className="badge">{steps.filter(step => step.done).length} / {steps.length}</span></div><Checklist items={steps} /></>}
    </section>
    <div className="split-layout">
      <WorkspaceRepositories workspace={workspace} user={user} admin={admin} repositories={repositories.data?.repositories ?? null} loading={repositories.loading} error={repositories.error} refresh={repositories.refresh} />
      <Members workspace={workspace} admin={admin} />
    </div>
  </>;
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
    }, "Membership saved.");
  }
  return <section className="section"><div className="section-heading"><h2>Members</h2>{resource.data && <span className="badge">{resource.data.members.length}</span>}<button type="button" className="button secondary small" disabled={resource.loading} onClick={resource.refresh}>Refresh</button></div>
    <ResourceState {...resource} retry={resource.refresh}>{resource.data?.members.length === 0 ? <Empty title="No members to display">Owners and admins manage membership.</Empty> : <div className="row-list">{resource.data?.members.map(member => <div className="list-row" key={member.userId}><div className="row-main"><h3>{member.displayName || member.githubLogin || member.userId}</h3><p className="metadata"><span className={`badge${member.role === "member" ? "" : " success"}`}>{member.role}</span></p></div>{admin && member.userId !== workspace.ownerId && <button className="button danger small" disabled={action.busy} onClick={() => { if (window.confirm(`Remove ${member.displayName || member.userId} from this workspace?`)) void action.run(async () => { await api(`${path}/${segment(member.userId)}`, { method: "DELETE" }); resource.refresh(); }, "Membership removed."); }}>Remove</button>}</div>)}</div>}</ResourceState>
    <Feedback {...action} />
    {admin && <Details summary="Add or update a member"><form onSubmit={save}><div className="inline-fields"><label className="field">User ID<input required value={userId} onChange={event => setUserId(event.target.value)} placeholder="Copy from their Profile" /></label><label className="field">Role<select value={role} onChange={event => setRole(event.target.value as "member" | "admin")}><option value="member">Member</option><option value="admin">Admin</option></select></label></div><button className="button secondary" disabled={action.busy || !userId.trim()}>{action.busy ? "Saving..." : "Save membership"}</button></form></Details>}
    <Details summary="What membership allows">
      {!admin && <p>Only workspace owners and admins can manage membership.</p>}
      <p>Members can use published agents and follow workspace-visible sessions read-only, which shows prompts, tool output and repository content in the transcript. Private sessions, and ask, write, approve or manage permissions, require explicit grants.</p>
      <p>Membership never grants GitHub access, tool execution, or use of anyone's private Pi host.</p>
    </Details>
  </section>;
}
