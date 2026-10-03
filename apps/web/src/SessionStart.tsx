import { useEffect, useState, type FormEvent } from "react";
import type { AgentVersion, ModelDefinition, SessionRecord, UserProfile, Workspace } from "../../../packages/shared/src/types";
import type { WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { api, errorMessage, segment } from "./api";
import { ConnectionStatus, HostCapabilities, useConnections } from "./Connections";
import { Details, Feedback, useAction } from "./ui";
import { RepositorySnapshotPolicy } from "./SessionRepositories";

type SessionStartProps = { workspace: Workspace | null; user: UserProfile; versions: AgentVersion[]; selectedVersion: string; selectVersion: (id: string) => void; models: ModelDefinition[]; openSession: (id: string) => void };

export function SessionStart(props: SessionStartProps) {
  return <WorkspaceSessionStart key={props.workspace?.id ?? ""} {...props} />;
}

function WorkspaceSessionStart({ workspace, user, versions, selectedVersion, selectVersion, models, openSession }: SessionStartProps) {
  const connections = useConnections(workspace ? `/api/workspaces/${segment(workspace.id)}/connectors` : null);
  const workspaceId = workspace?.id;
  const [repositoryRevision, setRepositoryRevision] = useState(0);
  const [repositoryQuery, setRepositoryQuery] = useState<{ workspaceId: string; revision: number; repositories: WorkspaceRepository[]; error: string } | null>(null);
  // Scope results to both the workspace and refresh so stale bindings never enable Start.
  const currentRepositoryQuery = repositoryQuery?.workspaceId === workspaceId && repositoryQuery?.revision === repositoryRevision ? repositoryQuery : null;
  const repositoriesLoading = Boolean(workspaceId && !currentRepositoryQuery);
  const repositories = currentRepositoryQuery?.repositories ?? [];
  const repositoriesReady = Boolean(workspaceId && currentRepositoryQuery && !currentRepositoryQuery.error && repositories.length);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    api<{ repositories: WorkspaceRepository[] }>(`/api/workspaces/${segment(workspaceId)}/repositories`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setRepositoryQuery({ workspaceId, revision: repositoryRevision, repositories: result.repositories, error: "" });
    }).catch(reason => {
      if (!controller.signal.aborted) setRepositoryQuery({ workspaceId, revision: repositoryRevision, repositories: [], error: errorMessage(reason) });
    });
    return () => controller.abort();
  }, [workspaceId, repositoryRevision]);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "private">("workspace");
  const [trustedHost, setTrustedHost] = useState("");
  const action = useAction();
  const selected = versions.find(version => version.id === selectedVersion);
  const model = models.find(item => item.id === selected?.modelId);
  const host = connections.data?.connectors.find(item => item.id === model?.connectorId);
  const foreign = Boolean(host && host.ownerId !== user.id);
  const availableModel = Boolean(host?.models.some(item => item.provider === model?.provider && item.modelId === model?.modelId));
  const available = Boolean(host?.online && !host.revokedAt && availableModel && (host.ownerId === user.id || Boolean(workspace && host.workspaceIds.includes(workspace.id))));
  useEffect(() => { setTrustedHost(""); setTitle(selected?.name ?? ""); }, [selectedVersion, selected?.name, host?.id, host?.ownerId, workspaceId]);
  useEffect(() => { setTrustedHost(""); }, [repositoryRevision]);
  function start(event: FormEvent) {
    event.preventDefault();
    if (!workspace || !selected || !host || !available || !repositoriesReady || action.busy || (foreign && trustedHost !== host.id)) return;
    void action.run(async () => {
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: { workspaceId: workspace.id, agentVersionId: selected.id, title: title.trim() || selected.name, visibility, ...(foreign ? { trustedConnectorId: host.id } : {}) } });
      openSession(result.session.id);
    });
  }
  return <aside className="rail"><h2>Start a session</h2>
    <form onSubmit={start}><fieldset disabled={action.busy}><label className="field">Agent<select required value={selectedVersion} onChange={event => selectVersion(event.target.value)} disabled={!versions.length}><option value="">Choose an agent</option>{versions.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · v{agent.version} · {agent.workspaceId ? "Published" : "Private"}</option>)}</select></label><label className="field">Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="A new line of inquiry" /></label>
      <label className="field">Visibility<select value={visibility} onChange={event => setVisibility(event.target.value as "workspace" | "private")}><option value="workspace">Workspace - members can view</option><option value="private">Private - explicit grants only</option></select></label>
      <p className="muted">{visibility === "workspace" ? "Members can read the transcript but can't control the session." : "Only you and people you grant access can view it."}</p>
      <Details summary="Who can see and do what">
        <p>{visibility === "workspace" ? "Workspace members can view prompts, output, tool results, and repository content shown in the transcript. Asking the agent, invoking tools, or controlling the session needs an explicit grant." : "Workspace membership alone does not give access to a private session; only explicit session grants do."}</p>
        <p>You are the session owner; the agent author and host owner are separate roles. Viewing never grants GitHub access, and visibility does not share your Pi host, private agent, or local models.</p>
      </Details>
      <section className="host-trust" aria-label="Workspace repositories" aria-busy={repositoriesLoading}>
        {!workspace ? <p className="notice">Select a workspace before starting a session.</p> : repositoriesLoading ? <p role="status">Loading repositories...</p> : currentRepositoryQuery?.error ? <><Feedback error={currentRepositoryQuery.error} /><p className="muted">Retry before starting a session.</p></> : !repositories.length ? <p className="notice">No repositories configured. Ask a workspace owner or admin to <a href="#workspaces">bind one in Workspaces</a>, then refresh.</p> : <p><strong>{repositories.length === 1 ? "1 repository ready" : `${repositories.length} repositories ready`}</strong></p>}
        <div className="actions">{!workspace && <a className="button secondary small" href="#workspaces">Choose a workspace</a>}{workspace && <button type="button" className="button secondary small" disabled={repositoriesLoading} onClick={() => setRepositoryRevision(value => value + 1)}>{currentRepositoryQuery?.error ? "Retry repositories" : "Refresh repositories"}</button>}</div>
        <Details summary="Repositories for this session">
          {repositories.length > 0 && <ul className="queue-list">{repositories.map(repository => <li key={repository.id}><strong>{repository.fullName}</strong><p className="metadata">Configured ref: <code>{repository.ref}</code></p></li>)}</ul>}
          <p>Repositories are read with your GitHub access as session owner, not the host owner's or an admin's. Each ref is pinned to a commit before the session runs.</p>
          {workspace && <p><a href="#workspaces">Configure repositories in Workspaces</a></p>}
        </Details>
        <RepositorySnapshotPolicy />
      </section>
      <Feedback error={connections.error} />
      {selected && <section className="host-trust" aria-label="Selected agent host">{connections.loading ? <p role="status">Checking host...</p> : host ? <><div className="section-heading"><strong>Runs on {host.name}</strong><ConnectionStatus connector={host} /></div><p className="muted">{foreign ? <>Hosted by <strong>{host.ownerName}</strong></> : "Your host"} / {workspace && host.workspaceIds.includes(workspace.id) ? "shared with this workspace" : "private"} / {model?.name}</p><HostCapabilities connector={host} />{!availableModel && <p className="notice">This pinned model is no longer offered by its host. Ask the host owner to restore it; no substitute will be chosen.</p>}{foreign && <label className="check-label trust-acknowledgement"><input type="checkbox" checked={trustedHost === host.id} onChange={event => setTrustedHost(event.target.checked ? host.id : "")} /><span>I trust {host.ownerName}'s host ({host.name}) to process this session's prompts and repository files, including private repository snapshots; its operator can read them. Repository access uses my GitHub identity, not the host owner's or a workspace admin's. I remain the session owner.</span></label>}<Details summary="Host details">
          <p>Model: {model?.name} <span className="metadata">{model?.provider} / {model?.modelId}</span></p>
          <p className="metadata">Host owner ID: {host.ownerId}<br />Connection ID: {host.id}</p>
          <p>This creates a new session, not access to the host's personal Pi history or old sessions. Publishing an agent does not grant use of its host. Your GitHub credentials are not sent to the host; model credentials stay on it.</p>
        </Details></> : <p className="notice">No available host for this agent. Connect your own Pi, ask the host owner to share access, or save a revision with a model available to you.</p>}<button type="button" className="button secondary small" disabled={connections.loading} onClick={connections.refresh}>Refresh host status</button></section>}
      {action.busy && <p className="notice" role="status">Preparing your session: resolving repository commits and downloading snapshots to the Pi host's private session cache. The agent starts once every repository is ready.</p>}
      <Feedback {...action} /><button className="button primary" disabled={action.busy || !selected || !available || !repositoriesReady || (foreign && trustedHost !== host?.id)}>{action.busy ? "Preparing repository cache..." : "Start session"}</button>
    </fieldset></form>
  </aside>;
}
