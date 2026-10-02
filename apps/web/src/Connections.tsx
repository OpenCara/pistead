import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectorInfo, ConnectorPairing } from "../../../packages/shared/src/connector";
import type { UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, errorMessage, segment } from "./api";
import { Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction } from "./ui";

export function useConnections(path: string | null) {
  const [data, setData] = useState<{ connectors: ConnectorInfo[] } | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const previousPath = useRef<string | null | undefined>(undefined);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    if (previousPath.current !== path) {
      previousPath.current = path;
      setData(null);
      setLoading(Boolean(path));
    }
    setError("");
    if (!path) return () => controller.abort();
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{ connectors: ConnectorInfo[] }>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (reason) {
        if (!controller.signal.aborted) { setData(null); setError(errorMessage(reason)); }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, revision]);
  return { data, loading, error, refresh };
}

export function ConnectionStatus({ connector }: { connector: ConnectorInfo }) {
  const state = connector.revokedAt ? "Revoked" : !connector.online ? "Offline" : !connector.capabilities.sandbox ? "Sandbox unavailable" : "Online";
  return <span className={`badge ${state === "Online" ? "" : "warning"}`}>{state}</span>;
}

export function HostCapabilities({ connector }: { connector: ConnectorInfo }) {
  return <p className="metadata">Host-reported platform: {connector.capabilities.platform || "Unknown"}. {!connector.online ? "Host is offline. It must reconnect before work can run. " : ""}{!connector.capabilities.sandbox ? "Host reports that a supported Linux sandbox is unavailable. Non-shell session work may still be available; shell execution fails closed rather than falling back to an unrestricted host shell." : !connector.capabilities.productionShell ? "Production shell is unavailable: verified per-session CPU, memory, process and writable-storage limits are required. No unrestricted shell fallback." : "Host reports sandbox support and production shell resource limits. This is not a security attestation; the runner verifies prerequisites when work runs."}</p>;
}

function ModelMetadata({ connector }: { connector: ConnectorInfo }) {
  return <div className="connection-models"><h4>Native local models</h4>{connector.models.length ? <ul>{connector.models.map(model => <li key={`${model.provider}:${model.modelId}`}><strong>{model.name}</strong><span className="metadata">{model.provider} / {model.modelId}</span></li>)}</ul> : <p className="muted">No locally configured models advertised yet.</p>}</div>;
}

export function WorkspaceConnections({ workspace, user }: { workspace: Workspace; user: UserProfile }) {
  const resource = useConnections(`/api/workspaces/${segment(workspace.id)}/connectors`);
  return <section className="section"><div className="section-heading"><span className="section-number">03</span><h2>Shared connections</h2><button className="button secondary small" disabled={resource.loading} onClick={resource.refresh}>Refresh hosts</button></div>
    <p>Choose whose machine runs your agent. Sharing a connection makes its advertised models available here, not its owner's private Pi history or old sessions.</p>
    <p className="muted">Model metadata is read-only. Configure providers and credentials in Pi on the host, never in this workspace.</p>
    <ResourceState {...resource} retry={resource.refresh}>{!resource.data?.connectors.length ? <Empty title="Bring a local Pi to the table">Connect your Pi, then explicitly share it with this workspace.</Empty> : <div className="row-list">{resource.data.connectors.map(connector => <article className="connection-card" key={connector.id}><div className="section-heading"><h3>{connector.name}</h3><ConnectionStatus connector={connector} /></div><p>Hosted by <strong>{connector.ownerName}</strong>{connector.ownerId === user.id ? " (you)" : ""}</p><p className="metadata">Host owner ID: {connector.ownerId}</p><HostCapabilities connector={connector} /><ModelMetadata connector={connector} /></article>)}</div>}</ResourceState>
    <a className="button secondary" href="#connections">Manage my connections</a>
  </section>;
}

export function Connections({ user, workspaces }: { user: UserProfile; workspaces: Workspace[] }) {
  const resource = useConnections("/api/connectors");
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<ConnectorPairing | null>(null);
  const [expired, setExpired] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (!pairing) return;
    const delay = Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => { setPairing(null); setExpired(true); }, delay);
    return () => window.clearTimeout(timer);
  }, [pairing]);
  function create(event: FormEvent) {
    event.preventDefault();
    if (action.busy || !name.trim()) return;
    setPairing(null);
    setExpired(false);
    void action.run(async () => {
      const result = await api<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name: name.trim() } });
      setPairing(result.pairing);
    });
  }
  return <>
    <PageHeading number="04" title="Your Pi. A shared possibility.">Connect a local runtime, then decide where to share it. Your credentials stay on your machine.</PageHeading>
    <div className="split-layout"><section className="section"><div className="section-heading"><h2>Your connections</h2><button className="button secondary small" disabled={resource.loading} onClick={resource.refresh}>Refresh connections</button></div>
      <p className="muted">Status refreshes every 10 seconds while this page is visible. A shared host can see prompts and files processed on its machine. Session ownership and session grants remain separate.</p>
      <ResourceState {...resource} retry={resource.refresh}>{!resource.data?.connectors.length ? <Empty title="Make the first connection">Create a pairing code and run the connector on the machine where you use Pi.</Empty> : <div className="row-list">{resource.data.connectors.map(connector => <OwnedConnection key={connector.id} connector={connector} user={user} workspaces={workspaces} refresh={resource.refresh} />)}</div>}</ResourceState>
    </section><aside className="rail"><p className="eyebrow">Connect your local Pi</p><h2>Keep the keys at home.</h2><p>Pairing connects a dedicated app runtime. It does not attach to your private interactive Pi conversations or import old sessions.</p>
      <form onSubmit={create}><label className="field">Connection name<input required maxLength={120} autoComplete="off" value={name} onChange={event => setName(event.target.value)} placeholder="My Linux workstation" /></label><Feedback {...action} /><button className="button primary" disabled={action.busy || !name.trim()}>{action.busy ? "Creating code..." : pairing ? "Create another pairing code" : "Create pairing code"}</button></form>
      {expired && <p className="notice" role="status">The pairing code expired and was cleared. Create a new code to try again.</p>}
      {pairing && <section className="pairing-panel" aria-label="One-time pairing instructions"><h3>Pair on your own machine</h3><p role="status">Your single-use pairing code is ready. Complete these steps before it expires.</p><ol><li>In the installed connector project, run:<pre><code>{`pnpm connect --server ${window.location.origin} --pairing-id ${pairing.id}`}</code></pre></li><li>Enter this single-use code when the CLI privately prompts you:<p className="pairing-code"><code>{pairing.code}</code></p></li><li>Return here, confirm your host is connected, and choose a workspace to share it with.</li></ol><p>Expires <Timestamp value={pairing.expiresAt} />. Treat this code as a secret; do not share it with teammates. It is held only in this page's memory, not browser storage.</p><button className="button secondary small" onClick={() => { setPairing(null); resource.refresh(); }}>Done / hide code</button><p className="metadata">Hiding clears the code from this page; an unused code remains valid until its expiry.</p></section>}
      <p className="metadata">The local connector needs a supported Linux sandbox with verified resource limits. Unsupported platforms or missing isolation cannot run production shell tools. An offline machine cannot execute new work. No public local listener or inbound tunnel is needed.</p>
    </aside></div>
  </>;
}

function OwnedConnection({ connector, user, workspaces, refresh }: { connector: ConnectorInfo; user: UserProfile; workspaces: Workspace[]; refresh: () => void }) {
  const action = useAction();
  const [workspaceId, setWorkspaceId] = useState("");
  const own = connector.ownerId === user.id;
  const available = workspaces.filter(workspace => !connector.workspaceIds.includes(workspace.id));
  const target = available.find(workspace => workspace.id === workspaceId)?.id ?? available[0]?.id ?? "";
  return <article className="connection-card"><div className="section-heading"><h3>{connector.name}</h3><ConnectionStatus connector={connector} /></div><p>Host owner: <strong>{connector.ownerName}</strong>{own ? " (you)" : ""}</p><p className="metadata">Connection ID: {connector.id}</p><HostCapabilities connector={connector} /><ModelMetadata connector={connector} /><Feedback {...action} />
    {own && !connector.revokedAt && <><h4>Shared with</h4>{!connector.workspaceIds.length ? <p className="muted">Not shared with any workspace.</p> : <ul className="connection-shares">{connector.workspaceIds.map(id => <li key={id}><span>{workspaces.find(workspace => workspace.id === id)?.name ?? id}</span><button className="button secondary small" disabled={action.busy} onClick={() => { if (window.confirm("Unshare this connection? New work and callbacks in this workspace will be blocked; existing session records are not deleted.")) void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}/shares/${segment(id)}`, { method: "DELETE" }); refresh(); }, "Connection unshared."); }}>Unshare</button></li>)}</ul>}
      {available.length > 0 ? <form onSubmit={event => { event.preventDefault(); if (!target || action.busy) return; void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}/shares/${segment(target)}`, { method: "PUT", body: {} }); refresh(); }, "Shared. Existing sessions and personal Pi history remain private."); }}><label className="field">Share with workspace<select value={target} onChange={event => setWorkspaceId(event.target.value)}>{available.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><p className="metadata">Members may deliberately create new sessions on this host using its local models. This does not grant access to old sessions.</p><button className="button secondary small" disabled={action.busy || !target}>Share connection</button></form> : !workspaces.length && <p>Create or join a workspace before sharing.</p>}
      <button className="button danger small revoke-connection" disabled={action.busy} onClick={() => { if (window.confirm(`Revoke ${connector.name}? This disconnects its runtime and blocks work in every shared workspace. Pair again to reconnect; existing session records are not deleted.`)) void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}`, { method: "DELETE" }); refresh(); }, "Connection revoked."); }}>Revoke connection</button>
    </>}
  </article>;
}
