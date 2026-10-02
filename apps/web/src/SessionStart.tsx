import { useEffect, useState, type FormEvent } from "react";
import type { AgentVersion, ModelDefinition, SessionRecord, UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { ConnectionStatus, HostCapabilities, useConnections } from "./Connections";
import { Feedback, useAction } from "./ui";

export function SessionStart({ workspace, user, versions, selectedVersion, selectVersion, models, openSession }: { workspace: Workspace | null; user: UserProfile; versions: AgentVersion[]; selectedVersion: string; selectVersion: (id: string) => void; models: ModelDefinition[]; openSession: (id: string) => void }) {
  const connections = useConnections(workspace ? `/api/workspaces/${segment(workspace.id)}/connectors` : null);
  const [title, setTitle] = useState("");
  const [trustedHost, setTrustedHost] = useState("");
  const action = useAction();
  const selected = versions.find(version => version.id === selectedVersion);
  const model = models.find(item => item.id === selected?.modelId);
  const host = connections.data?.connectors.find(item => item.id === model?.connectorId);
  const foreign = Boolean(host && host.ownerId !== user.id);
  const availableModel = Boolean(host?.models.some(item => item.provider === model?.provider && item.modelId === model?.modelId));
  const available = Boolean(host?.online && !host.revokedAt && availableModel);
  useEffect(() => { setTrustedHost(""); setTitle(selected?.name ?? ""); }, [selectedVersion, selected?.name, host?.id, host?.ownerId]);
  function start(event: FormEvent) {
    event.preventDefault();
    if (!workspace || !selected || !host || !available || action.busy || (foreign && trustedHost !== host.id)) return;
    void action.run(async () => {
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: { workspaceId: workspace.id, agentVersionId: selected.id, title: title.trim() || selected.name, ...(foreign ? { trustedConnectorId: host.id } : {}) } });
      openSession(result.session.id);
    });
  }
  return <aside className="rail"><p className="eyebrow">Reuse an agent</p><h2>A fresh session.<br />Your identity.</h2><p>You are the immutable session owner. The agent author and the machine's host owner are separate roles. To collaborate in an existing session, use <strong>Join session</strong> in Sessions.</p>
    <form onSubmit={start}><fieldset disabled={action.busy}><label className="field">Published version<select required value={selectedVersion} onChange={event => selectVersion(event.target.value)} disabled={!versions.length}><option value="">Choose an agent version</option>{versions.map(agent => <option key={agent.id} value={agent.id}>{agent.name} / v{agent.version}</option>)}</select></label><label className="field">Session title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="A new line of inquiry" /></label>
      <Feedback error={connections.error} />
      {selected && <section className="host-trust" aria-label="Selected agent host"><h3>Where this session runs</h3>{connections.loading ? <p role="status">Checking shared host...</p> : host ? <><div className="section-heading"><strong>{host.name}</strong><ConnectionStatus connector={host} /></div><p>Hosted by <strong>{host.ownerName}</strong>{foreign ? "" : " (you)"}</p><p className="metadata">Host owner ID: {host.ownerId}<br />Connection ID: {host.id}</p><p>Local model: {model?.name} <span className="metadata">{model?.provider} / {model?.modelId}</span></p><HostCapabilities connector={host} />{!availableModel && <p className="notice">This pinned model is no longer advertised by its host. Ask the host owner to restore the local model; no substitute will be chosen.</p>}{foreign && <label className="check-label trust-acknowledgement"><input type="checkbox" checked={trustedHost === host.id} onChange={event => setTrustedHost(event.target.checked ? host.id : "")} /><span>I trust {host.ownerName}'s host ({host.name}) to process this session's prompts and files. Its operator can access this work. I remain the session owner.</span></label>}<p className="metadata">This creates a new session, not access to the host's personal Pi history or old sessions. Your personal GitHub credentials are not sent to this host; model credentials remain on the local host.</p></> : <p className="notice">This version has no available shared local connection. Its host may have been unshared or revoked. Choose a connected model and publish a new agent version.</p>}<button type="button" className="button secondary small" disabled={connections.loading} onClick={connections.refresh}>Refresh host status</button></section>}
      <Feedback {...action} /><button className="button primary" disabled={!selected || !available || (foreign && trustedHost !== host?.id)}>{action.busy ? "Starting..." : "Start my own session"}</button>
    </fieldset></form>
  </aside>;
}
