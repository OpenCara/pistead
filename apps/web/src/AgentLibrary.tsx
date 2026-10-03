import { useState, type FormEvent } from "react";
import { toolNames, type AgentVersion, type ModelDefinition, type UserProfile, type ToolName, type Workspace } from "../../../packages/shared/src/types";
import { SessionStart } from "./SessionStart";
import { useConnections } from "./Connections";
import { api, segment } from "./api";
import { Details, Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction, useResource } from "./ui";

export function AgentLibrary({ workspace, user, openSession }: { user: UserProfile; workspace: Workspace | null; openSession: (id: string) => void }) {
  const own = useResource<{ agents: AgentVersion[] }>("/api/agents");
  const published = useResource<{ agents: AgentVersion[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/agents` : null);
  const models = useResource<{ models: ModelDefinition[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/models` : null);
  const [editing, setEditing] = useState<AgentVersion | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  const [selectedVersion, setSelectedVersion] = useState("");
  const action = useAction();
  const ownAgents = own.data?.agents ?? [];
  const publishedVersions = published.data?.agents ?? [];
  const workspaceModelIds = new Set((models.data?.models ?? []).map(model => model.id));
  const privateVersions = ownAgents.filter(agent => !agent.workspaceId && agent.authorId === user.id && workspaceModelIds.has(agent.modelId));
  const versions = [...privateVersions, ...publishedVersions];
  const runnableIds = new Set(versions.map(version => version.id));
  const groups = groupAgents([...versions, ...ownAgents], runnableIds, new Set(ownAgents.map(agent => agent.id)), workspace?.id);
  const connections = useConnections(workspace ? `/api/workspaces/${segment(workspace.id)}/connectors` : null);
  const localModels = (models.data?.models ?? []).filter(model => connections.data?.connectors.some(host => host.id === model.connectorId && !host.revokedAt && (host.ownerId === user.id || Boolean(workspace && host.workspaceIds.includes(workspace.id))) && host.models.some(local => local.provider === model.provider && local.modelId === model.modelId)));
  const editorOpen = authoring || Boolean(editing);
  function openEditor(agent: AgentVersion | null) { setSavedNotice(""); setEditing(agent); setAuthoring(!agent); }
  function closeEditor() { setAuthoring(false); setEditing(null); }
  function publish(agent: AgentVersion) {
    if (workspace) void action.run(async () => { await api(`/api/agents/${segment(agent.agentId)}/publish`, { method: "POST", body: { workspaceId: workspace.id } }); own.refresh(); published.refresh(); }, `Latest private version published to ${workspace.name}. Host access is unchanged.`);
  }
  return <>
    <PageHeading title="Agent library">Pick an agent and start a session. Create your own any time.</PageHeading>
    <div className="split-layout"><section className="section">
      <div className="section-heading"><h2>Agents</h2>{!editorOpen && <button className="button primary small" onClick={() => openEditor(null)}>New agent</button>}</div>
      <Feedback notice={savedNotice} />
      {editorOpen && <section className="host-trust" aria-label="Agent editor">
        <div className="section-heading"><h3>{editing ? `Revising ${editing.name}` : "New agent"}</h3><button className="button secondary small" onClick={closeEditor}>Cancel</button></div>
        {editing && <p className="muted">Saves a new private version. Existing sessions keep their pinned version.</p>}
        {!workspace ? <Empty title="Choose a workspace">Pick a workspace and connect your Pi before creating an agent.</Empty> : <><Feedback error={connections.error} /><ResourceState loading={models.loading || connections.loading} error={models.error} retry={() => { models.refresh(); connections.refresh(); }}>{models.data && <AgentEditor key={`${workspace.id}:${editing?.id ?? "new"}`} agent={editing} models={localModels} saved={() => { own.refresh(); closeEditor(); setSavedNotice("Private version saved. Choose Run to start a session."); }} />}</ResourceState></>}
      </section>}
      <ResourceState {...own} retry={own.refresh}><ResourceState {...published} retry={published.refresh}>
        {!groups.length ? <Empty title={workspace ? "No agents yet" : "Choose a workspace"}>{workspace ? "Create a private agent to run on your own Pi." : "Select a workspace to see and run its agents."}</Empty> : <div className="row-list">{groups.map(group => {
          const { latest, runTarget, editFrom } = group;
          const runButton = (version: AgentVersion) => <button className={`button ${selectedVersion === version.id ? "primary" : "secondary"} small`} aria-pressed={selectedVersion === version.id} disabled={!workspace} onClick={() => setSelectedVersion(version.id)}>Run</button>;
          return <div className="list-row" key={group.agentId}><div className="row-main">
            <div className="section-heading"><h3>{latest.name}</h3><span className="badge">v{latest.version}</span>{group.published && <span className="badge success">Published</span>}{group.private && <span className="badge">Private</span>}</div>
            {latest.description && <p>{latest.description}</p>}
            <p className="metadata">{latest.tools.length} allowed tools / <Timestamp value={latest.createdAt} />{!runTarget && workspace && " / no version runs here yet; save a revision with a model available here"}</p>
            {group.versions.length > 1 && <Details summary={`Versions (${group.versions.length})`}><ul className="queue-list">{group.versions.map(version => <li key={version.id}><div className="section-heading"><strong>v{version.version}</strong><span className={version.workspaceId ? "badge success" : "badge"}>{version.workspaceId ? (version.workspaceId === workspace?.id ? "Published" : "Published elsewhere") : "Private"}</span>{runnableIds.has(version.id) && runButton(version)}</div><p className="metadata">{version.name} / {version.tools.length} allowed tools / <Timestamp value={version.createdAt} /></p></li>)}</ul></Details>}
          </div><div className="row-actions">
            {runTarget && runButton(runTarget)}
            {editFrom && <button className="button secondary small" onClick={() => openEditor(editFrom)}>Edit</button>}
            {group.publishable && editFrom && <button className="button secondary small" disabled={!workspace || action.busy} onClick={() => publish(editFrom)}>Publish</button>}
          </div></div>;
        })}</div>}
      </ResourceState></ResourceState>
      <Feedback {...action} />
      <Details summary="Private vs. published agents">
        <p>Private agents run on your own Pi; publishing is optional. Publish shares the latest version's instructions, allowed tools, and model reference with {workspace?.name ?? "the workspace"} — not your identity, environment, or conversation history.</p>
        <p>Publishing does not share your Pi host. Others can only run on a host its owner has explicitly shared. Editing creates a new private version; existing sessions keep their pinned version.</p>
      </Details>
    </section><SessionStart workspace={workspace} user={user} versions={versions} selectedVersion={selectedVersion} selectVersion={setSelectedVersion} models={models.data?.models ?? []} openSession={openSession} /></div>
  </>;
}

type AgentGroup = { agentId: string; versions: AgentVersion[]; latest: AgentVersion; runTarget?: AgentVersion; editFrom?: AgentVersion; published: boolean; private: boolean; publishable: boolean };

/** One entry per agent: versions newest first, the newest runnable one to Run, the latest own one to revise. */
function groupAgents(all: AgentVersion[], runnableIds: Set<string>, ownIds: Set<string>, workspaceId: string | undefined): AgentGroup[] {
  const byAgent = new Map<string, Map<string, AgentVersion>>();
  for (const version of all) {
    const versions = byAgent.get(version.agentId) ?? new Map<string, AgentVersion>();
    versions.set(version.id, version);
    byAgent.set(version.agentId, versions);
  }
  const groups = [...byAgent].map(([agentId, unique]): AgentGroup => {
    const versions = [...unique.values()].sort((a, b) => b.version - a.version);
    const latestPrivate = versions.find(version => !version.workspaceId && ownIds.has(version.id));
    const publishedHere = versions.filter(version => Boolean(workspaceId) && version.workspaceId === workspaceId);
    return {
      agentId,
      versions,
      latest: versions[0],
      runTarget: versions.find(version => runnableIds.has(version.id)),
      editFrom: versions.find(version => ownIds.has(version.id)),
      published: publishedHere.length > 0,
      private: versions.some(version => !version.workspaceId),
      // Publishing copies the latest private version into a newer published version, so it is unpublished until one exists.
      publishable: Boolean(latestPrivate && !publishedHere.some(version => version.version > latestPrivate.version)),
    };
  });
  // Agents you can run here come first.
  return [...groups.filter(group => group.runTarget), ...groups.filter(group => !group.runTarget)];
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
    });
  }
  return <form onSubmit={submit}><label className="field">Agent name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Repository naturalist" /></label><label className="field">Description<input maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="A short note on what this agent is for" /></label><label className="field">Instructions<textarea required rows={7} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Describe the agent's purpose, approach, and boundaries." /></label><label className="field">Model<select required value={modelId} onChange={event => setModelId(event.target.value)}><option value="">Choose an available local model</option>{models.map(model => <option value={model.id} key={model.id}>{model.name} / {model.provider} / host {model.connectorId}</option>)}</select></label>{!models.length && <p className="notice">No local models yet. <a href="#connections">Connect your Pi</a> or use a host a teammate has shared.</p>}
    <fieldset><legend>Tool allowlist</legend><p className="muted">Sensitive operations still need approval.</p><div className="tool-grid">{toolNames.map(tool => <label className="check-label" key={tool}><input type="checkbox" checked={tools.includes(tool)} onChange={event => setTools(current => event.target.checked ? [...current, tool] : current.filter(value => value !== tool))} /><span className="mono">{tool}</span></label>)}</div></fieldset><Feedback {...action} /><button className="button primary" disabled={action.busy || !models.some(model => model.id === modelId) || !name.trim() || !instructions.trim()}>{action.busy ? "Saving..." : agent ? "Save private revision" : "Save private agent"}</button>
  </form>;
}
