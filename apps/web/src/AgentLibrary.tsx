import { useState, type FormEvent } from "react";
import { toolNames, type AgentVersion, type ModelDefinition, type UserProfile, type ToolName, type Workspace } from "../../../packages/shared/src/types";
import { SessionStart } from "./SessionStart";
import { useConnections } from "./Connections";
import { api, segment } from "./api";
import { Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction, useResource } from "./ui";

export function AgentLibrary({ workspace, user, openSession }: { user: UserProfile; workspace: Workspace | null; openSession: (id: string) => void }) {
  const own = useResource<{ agents: AgentVersion[] }>("/api/agents");
  const published = useResource<{ agents: AgentVersion[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/agents` : null);
  const models = useResource<{ models: ModelDefinition[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/models` : null);
  const [editing, setEditing] = useState<AgentVersion | null>(null);
  const [selectedVersion, setSelectedVersion] = useState("");
  const action = useAction();
  const versions = published.data?.agents ?? [];
  const connections = useConnections(workspace ? `/api/workspaces/${segment(workspace.id)}/connectors` : null);
  const localModels = (models.data?.models ?? []).filter(model => connections.data?.connectors.some(host => host.id === model.connectorId && !host.revokedAt && host.models.some(local => local.provider === model.provider && local.modelId === model.modelId)));
  return <>
    <PageHeading number="02" title="Good work, repeatable.">Author privately. Publish a version. Let someone make it their own.</PageHeading>
    <div className="split-layout"><section className="section"><div className="section-heading"><span className="section-number">01</span><h2>Published in {workspace?.name ?? "your workspace"}</h2></div>
      <p className="muted">Reuse shares instructions, allowed tools, and a model reference. It never shares the author's identity, environment, or conversation history.</p>
      {!workspace ? <Empty title="Choose a workspace">Select or create a workspace to browse its published agents.</Empty> : <ResourceState {...published} retry={published.refresh}>
        {!versions.length ? <Empty title="The shelf is ready">Publish a private agent to make an immutable version available here.</Empty> : <div className="row-list">{versions.map(agent => <div className="list-row" key={agent.id}><div className="row-main"><p className="eyebrow">Version {agent.version}</p><h3>{agent.name}</h3><p>{agent.description || "No description provided."}</p><p className="metadata">{agent.tools.length} allowed tools / <Timestamp value={agent.createdAt} /></p></div><button className={`button ${selectedVersion === agent.id ? "primary" : "secondary"} small`} aria-pressed={selectedVersion === agent.id} onClick={() => { setSelectedVersion(agent.id); }}>Use this version</button></div>)}</div>}
      </ResourceState>}
    </section><SessionStart workspace={workspace} user={user} versions={versions} selectedVersion={selectedVersion} selectVersion={setSelectedVersion} models={models.data?.models ?? []} openSession={openSession} /></div>
    <div className="split-layout"><section className="section"><div className="section-heading"><span className="section-number">02</span><h2>Your private workbench</h2></div><p className="muted">Save private definitions, then publish deliberately. Editing creates a new private version; existing sessions keep their pinned version.</p>
      <ResourceState {...own} retry={own.refresh}>{own.data?.agents.length === 0 && <Empty title="Your first agent starts here">Give it a purpose, a model, and only the tools it needs.</Empty>}<div className="row-list">{own.data?.agents.map(agent => <div className="list-row" key={agent.id}><div className="row-main"><h3>{agent.name}</h3><p className="metadata">v{agent.version} / {agent.workspaceId ? "published" : "private"}</p><p>{agent.description}</p></div><div className="row-actions"><button className="button secondary small" onClick={() => setEditing(agent)}>New revision</button>{!agent.workspaceId && <button className="button secondary small" disabled={!workspace || action.busy} onClick={() => { if (workspace) void action.run(async () => { await api(`/api/agents/${segment(agent.agentId)}/publish`, { method: "POST", body: { workspaceId: workspace.id } }); own.refresh(); published.refresh(); }, `Latest private version published to ${workspace.name}.`); }}>Publish latest</button>}</div></div>)}</div></ResourceState>
    </section><section className="section"><div className="section-heading"><span className="section-number">03</span><h2>{editing ? "A new revision" : "Author an agent"}</h2></div>{editing && <div className="notice"><p>Revising {editing.name}. This saves a new private version.</p><button className="button secondary small" onClick={() => setEditing(null)}>Start a different agent</button></div>}
      {!workspace ? <Empty title="A model needs a home">Choose a workspace with a shared local Pi connection before authoring.</Empty> : <><Feedback error={connections.error} /><ResourceState loading={models.loading || connections.loading} error={models.error} retry={() => { models.refresh(); connections.refresh(); }}>{models.data && <AgentEditor key={`${workspace.id}:${editing?.id ?? "new"}`} agent={editing} models={localModels} saved={() => { own.refresh(); setEditing(null); }} />}</ResourceState></>}
    </section></div>
  </>;
}

function AgentEditor({ agent, models, saved }: { agent: AgentVersion | null; models: ModelDefinition[]; saved: () => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [modelId, setModelId] = useState(agent?.modelId ?? models[0]?.id ?? "");
  const [tools, setTools] = useState<ToolName[]>(agent?.tools ?? ["identity", "list_files", "read_file"]);
  const action = useAction();
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      await api(agent ? `/api/agents/${segment(agent.agentId)}/versions` : "/api/agents", { method: "POST", body: { name: name.trim(), description, instructions, modelId, tools } });
      if (!agent) { setName(""); setDescription(""); setInstructions(""); }
      saved();
    }, "Private version saved. Publish it when you are ready.");
  }
  return <form onSubmit={submit}><label className="field">Agent name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Repository naturalist" /></label><label className="field">Description<input maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="A short note on what this agent is for" /></label><label className="field">Instructions<textarea required rows={7} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Describe the agent's purpose, approach, and boundaries." /></label><label className="field">Model<select required value={modelId} onChange={event => setModelId(event.target.value)}><option value="">Choose a catalog model</option>{models.map(model => <option value={model.id} key={model.id}>{model.name} / {model.provider} / host {model.connectorId}</option>)}</select></label>{!models.length && <p className="notice">Connect your local Pi and share it in Connections, or ask a teammate to share a connection. Native model metadata is read-only here.</p>}
    <fieldset><legend>Tool allowlist</legend><p className="muted">An allowlist is not permission to bypass policy. Sensitive operations still require server-authorized approval.</p><div className="tool-grid">{toolNames.map(tool => <label className="check-label" key={tool}><input type="checkbox" checked={tools.includes(tool)} onChange={event => setTools(current => event.target.checked ? [...current, tool] : current.filter(value => value !== tool))} /><span className="mono">{tool}</span></label>)}</div></fieldset><Feedback {...action} /><button className="button primary" disabled={action.busy || !models.some(model => model.id === modelId) || !name.trim() || !instructions.trim()}>{action.busy ? "Saving..." : agent ? "Save private revision" : "Save private agent"}</button>
  </form>;
}
