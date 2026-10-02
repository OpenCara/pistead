import { useState, type FormEvent } from "react";
import type { ModelDefinition, UserProfile, Workspace, WorkspaceRole } from "../../../packages/shared/src/types";
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
    }, "Workspace created.");
  }
  return <>
    <PageHeading number="01" title="Room to work.">A place for people, published agents, and a shared model catalog. Session access is always granted separately.</PageHeading>
    <div className="split-layout"><section className="section">
      <div className="section-heading"><span className="section-number">01</span><h2>Your workspaces</h2><span className="badge">{workspaces.length}</span></div>
      {workspaces.length === 0 ? <Empty title="Start a workshop">Create a workspace to curate models and publish reusable agents.</Empty> : <div className="row-list">{workspaces.map(item => <div className="list-row" key={item.id}><div className="row-main"><h3>{item.name}</h3><p className="metadata">{item.role ?? (item.ownerId === user.id ? "owner" : "member")}</p></div><button className={`button ${workspace?.id === item.id ? "primary" : "secondary"} small`} onClick={() => select(item.id)} aria-pressed={workspace?.id === item.id}>{workspace?.id === item.id ? "Selected" : "Select workspace"}</button></div>)}</div>}
    </section><aside className="rail"><p className="eyebrow">A new space</p><h2>Bring your team.</h2><form onSubmit={create}><label className="field">Workspace name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="The field studio" /></label><Feedback {...action} /><button className="button primary" disabled={action.busy || !name.trim()}>{action.busy ? "Creating..." : "Create workspace"}</button></form></aside></div>
    {workspace && <WorkspaceSettings key={workspace.id} user={user} workspace={workspace} />}
  </>;
}

function WorkspaceSettings({ user, workspace }: { user: UserProfile; workspace: Workspace }) {
  const admin = workspace.ownerId === user.id || workspace.role === "admin" || workspace.role === "owner";
  return <div className="split-layout"><Members workspace={workspace} admin={admin} /><Models workspace={workspace} admin={admin} /></div>;
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
    }, "Membership saved. This does not grant access to any session.");
  }
  return <section className="section"><div className="section-heading"><span className="section-number">02</span><h2>People in {workspace.name}</h2></div><p className="muted">Membership gives access to published agents, not other people's sessions.</p>
    <ResourceState {...resource} retry={resource.refresh}>{resource.data?.members.length === 0 && <Empty title="No members to display">Workspace membership is managed by the owner and admins.</Empty>}<div className="row-list">{resource.data?.members.map(member => <div className="list-row" key={member.userId}><div className="row-main"><h3>{member.displayName || member.githubLogin || member.userId}</h3><p className="metadata">{member.role} / {member.userId}</p></div>{admin && member.userId !== workspace.ownerId && <button className="button danger small" disabled={action.busy} onClick={() => { if (window.confirm(`Remove ${member.displayName || member.userId} from this workspace?`)) void action.run(async () => { await api(`${path}/${segment(member.userId)}`, { method: "DELETE" }); resource.refresh(); }, "Membership removed."); }}>Remove</button>}</div>)}</div></ResourceState>
    {admin ? <form onSubmit={save}><h3>Add or update a member</h3><div className="inline-fields"><label className="field">User ID<input required value={userId} onChange={event => setUserId(event.target.value)} placeholder="Copy from their Profile" /></label><label className="field">Role<select value={role} onChange={event => setRole(event.target.value as "member" | "admin")}><option value="member">Member</option><option value="admin">Admin</option></select></label></div><button className="button secondary" disabled={action.busy || !userId.trim()}>{action.busy ? "Saving..." : "Save membership"}</button></form> : <p className="muted">Only workspace owners and admins can manage membership.</p>}
    <Feedback {...action} />
  </section>;
}

function Models({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/models`;
  const resource = useResource<{ models: ModelDefinition[] }>(path);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ModelDefinition["provider"]>("openai");
  const [modelId, setModelId] = useState("");
  const action = useAction();
  function create(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      await api(path, { method: "POST", body: { name: name.trim(), provider, modelId: modelId.trim() } });
      setName(""); setModelId(""); resource.refresh();
    }, "Model added to the catalog.");
  }
  return <section className="section"><div className="section-heading"><span className="section-number">03</span><h2>Model catalog</h2></div><p className="muted">Shared model references, never shared credentials. Provider keys are configured on the runner.</p>
    <ResourceState {...resource} retry={resource.refresh}>{resource.data?.models.length === 0 && <Empty title="A blank catalog">An admin can add a model before anyone authors an agent.</Empty>}<div className="row-list">{resource.data?.models.map(model => <div className="list-row" key={model.id}><div className="row-main"><h3>{model.name}</h3><p className="metadata">{model.provider} / {model.modelId}</p></div>{model.provider === "faux" && <span className="badge warning">Test model</span>}</div>)}</div></ResourceState>
    {admin && <form onSubmit={create}><h3>Add a model</h3><label className="field">Catalog name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Studio reasoning model" /></label><div className="inline-fields"><label className="field">Provider<select value={provider} onChange={event => setProvider(event.target.value as ModelDefinition["provider"])}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="faux">Faux (test environments only)</option></select></label><label className="field">Provider model ID<input required value={modelId} onChange={event => setModelId(event.target.value)} placeholder="Provider's exact model identifier" /></label></div><button className="button secondary" disabled={action.busy || !name.trim() || !modelId.trim()}>{action.busy ? "Adding..." : "Add model"}</button></form>}
    <Feedback {...action} />
  </section>;
}
