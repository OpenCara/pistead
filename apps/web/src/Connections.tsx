import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectorInfo, ConnectorPairing } from "../../../packages/shared/src/connector";
import type { UserProfile, Workspace } from "../../../packages/shared/src/types";
import type { WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { api, errorMessage, segment } from "./api";
import { CopyButton, CopyField, Details, Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction, useResource, type ActionState } from "./ui";

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
  const state = connector.revokedAt ? "Revoked" : !connector.online ? "Offline" : connector.capabilities.unsandboxed ? "Unsandboxed" : !connector.capabilities.sandbox ? "Sandbox unverified" : "Online";
  return <span className={`badge ${state === "Online" ? "success" : state === "Unsandboxed" ? "danger" : "warning"}`}>{state}</span>;
}

export function HostCapabilities({ connector }: { connector: ConnectorInfo }) {
  const { capabilities } = connector;
  return <>
    {capabilities.unsandboxed && <div className="notice danger" role="note"><p><strong>Unsandboxed host.</strong> Agent work runs directly on the owner's machine without isolation: approved commands and commits run as their user, with access to their files, credentials and network, and no resource limits. File tools are confined to the session folder by path checks only.</p></div>}
    <Details summary="Host details">
      <p className="metadata">Platform: {capabilities.platform || "Unknown"}.{!connector.online && " Offline: it must reconnect before work can run."}</p>
      <p className="metadata">Sandbox: {capabilities.unsandboxed ? "disabled by the host owner." : !capabilities.sandbox ? "unverified (not necessarily unavailable); the runner checks isolation when preparing each session." : "reported by the host; not a security attestation."} Production shell limits: {capabilities.productionShell ? "reported; still verified per session." : "not confirmed."}</p>
      <p className="metadata">The runner verifies prerequisites for every session and stops work that fails. Production shell needs verified CPU, memory, process and storage limits, with no unrestricted fallback unless the owner disables isolation.</p>
      <p className="metadata">Native Windows is unsupported: use Linux or WSL2 with Pi configured there, or macOS without isolation.</p>
    </Details>
  </>;
}

function modelSummary(connector: ConnectorInfo) {
  const count = connector.models.length;
  if (!count) return "No models advertised";
  if (count <= 3) return connector.models.map(model => model.name).join(", ");
  return `${count} models`;
}

function ModelMetadata({ connector }: { connector: ConnectorInfo }) {
  return <div className="connection-models"><h4>Local models</h4>{connector.models.length ? <ul>{connector.models.map(model => <li key={`${model.provider}:${model.modelId}`}><strong>{model.name}</strong><span className="metadata">{model.provider} / {model.modelId}</span></li>)}</ul> : <p className="muted">No locally configured models advertised yet. Configure models in Pi on the host.</p>}</div>;
}

export function Connections({ user, workspaces, workspace, selectWorkspace }: { user: UserProfile; workspaces: Workspace[]; workspace: Workspace | null; selectWorkspace: (id: string) => void }) {
  const resource = useConnections("/api/connectors");
  return <>
    <PageHeading title="Connections">Connect your Pi hosts and choose who can use them.</PageHeading>
    <div className="split-layout"><section className="section"><div className="section-heading"><h2>Your Pi hosts</h2><button className="button secondary small" disabled={resource.loading} onClick={resource.refresh}>Refresh</button></div>
      <p className="muted">A paired Pi is private to you until you share it. Status refreshes every 10 seconds.</p>
      <ResourceState {...resource} retry={resource.refresh}>{!resource.data?.connectors.length ? <Empty title="No Pi hosts yet">Create a pairing code under Connect a Pi to connect your first host.</Empty> : <div className="row-list">{resource.data.connectors.map(connector => <OwnedConnection key={connector.id} connector={connector} user={user} workspaces={workspaces} refresh={resource.refresh} selectWorkspace={selectWorkspace} />)}</div>}</ResourceState>
      <Details summary="How hosts, sharing and visibility work">
        <p>Pairing starts a dedicated app runtime connected to a workspace for your own use. It does not attach to your interactive Pi conversations or import their history. Sharing with a workspace is a separate, optional step that lets members run their own sessions on the host.</p>
        <p>A host operator sees the prompts and repository files processed on their machine, including private source, but never receives a GitHub token. Model credentials stay in Pi on the host. An offline host cannot run new work; no public listener or inbound tunnel is needed.</p>
        <p>New sessions are workspace-visible by default: members can read prompts, tool output and repository content in the transcript, without direct GitHub access or tool execution. Choose private visibility to hide it. Sharing a host or publishing an agent never grants session control; further permissions require explicit session grants.</p>
      </Details>
    </section><aside className="rail"><h2>Connect a Pi</h2>
      <h3>1. Choose a workspace</h3>
      <label className="field">Workspace<select value={workspace?.id ?? ""} disabled={!workspaces.length} onChange={event => selectWorkspace(event.target.value)}><option value="" disabled>Choose a workspace</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <PairingSetup key={workspace?.id ?? "none"} workspace={workspace} refreshConnections={resource.refresh} />
    </aside></div>
  </>;
}

function PairingSetup({ workspace, refreshConnections }: { workspace: Workspace | null; refreshConnections: () => void }) {
  const repositories = useResource<{ repositories: WorkspaceRepository[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/repositories` : null);
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<ConnectorPairing | null>(null);
  const [expired, setExpired] = useState(false);
  const action = useAction();
  const mounted = useRef(true);
  const configured = Boolean(workspace && !repositories.loading && !repositories.error && repositories.data?.repositories.length);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!pairing) return;
    const delay = Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => { setPairing(null); setExpired(true); }, delay);
    return () => window.clearTimeout(timer);
  }, [pairing]);
  function create(event: FormEvent) {
    event.preventDefault();
    if (!workspace || !configured || action.busy || !name.trim()) return;
    setPairing(null);
    setExpired(false);
    void action.run(async () => {
      const result = await api<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name: name.trim(), workspaceId: workspace.id } });
      if (mounted.current) setPairing(result.pairing);
    });
  }
  return <>
    {!workspace ? <p className="notice"><a href="#workspaces">Create or select a workspace</a> with at least one bound repository.</p> : <ResourceState {...repositories} retry={repositories.refresh}>{!repositories.data?.repositories.length ? <p className="notice">No repositories configured for {workspace.name}. An owner or admin must <a href="#workspaces">bind one</a> before you can pair.</p> : <p className="metadata" role="status">{repositories.data.repositories.length} {repositories.data.repositories.length === 1 ? "repository" : "repositories"} configured in {workspace.name}.</p>}</ResourceState>}
    {workspace && <div className="actions"><button type="button" className="button secondary small" disabled={repositories.loading || action.busy} onClick={repositories.refresh}>Refresh repositories</button><a href="#workspaces">Manage repositories</a></div>}
    <h3>2. Name it and create a code</h3>
    <form onSubmit={create}><label className="field">Connection name<input required maxLength={120} autoComplete="off" value={name} onChange={event => setName(event.target.value)} placeholder="My Linux workstation" /></label><p className="metadata">The host stays private to you in {workspace?.name ?? "the chosen workspace"} until you share it.</p><Feedback {...action} /><button className="button primary" disabled={action.busy || !name.trim() || !configured}>{action.busy ? "Creating code..." : pairing ? "Create another pairing code" : "Create pairing code"}</button></form>
    <h3>3. Run the connector on your Pi</h3>
    {expired && <p className="notice" role="status">The pairing code expired and was cleared. Create a new code to try again.</p>}
    {pairing ? <section className="pairing-panel" aria-label="One-time pairing instructions">
      <p role="status">Code ready for {workspace?.name}. Expires <Timestamp value={pairing.expiresAt} />.</p>
      <p>Run this on your Pi host:</p>
      <CopyField value={`npx pistead@latest connect --server ${window.location.origin} --pairing-id ${pairing.id}`} label="Copy command" />
      <p>Then paste this code at the connector's hidden prompt (not on the command line):</p>
      <CopyField value={pairing.code} label="Copy code" />
      <p className="metadata">Single-use secret: don't share it. It is held only in this page's memory. Hiding it doesn't revoke it; an unused code stays tied to {workspace?.name} until it expires.</p>
      <button type="button" className="button secondary small" onClick={() => { setPairing(null); refreshConnections(); }}>Done</button>
      <p className="metadata">Once the host is online, <a href="#agents">create a private agent</a> with one of its models.</p>
    </section> : <p className="muted">The command and code appear here after you create a code.</p>}
    <Details summary="Host requirements">
      <p>Linux or WSL2 (native Windows is unsupported) with Node.js 24, Pi configured there with its providers and models, and bubblewrap, Python 3, Git and flock installed.</p>
      <p>No app checkout is needed; run from any folder. Session source downloads into private caches. Never paste a token into this page or a command.</p>
      <p>macOS has no sandbox: add <code>--unsafe-no-sandbox</code> to run agent work directly on your Mac as your user. The connector asks you to confirm, and Pistead labels the host Unsandboxed.</p>
    </Details>
  </>;
}

function OwnedConnection({ connector, user, workspaces, refresh, selectWorkspace }: { connector: ConnectorInfo; user: UserProfile; workspaces: Workspace[]; refresh: () => void; selectWorkspace: (id: string) => void }) {
  const action = useAction();
  const [workspaceId, setWorkspaceId] = useState("");
  const own = connector.ownerId === user.id;
  const available = workspaces.filter(workspace => !connector.workspaceIds.includes(workspace.id));
  const target = available.find(workspace => workspace.id === workspaceId) ?? available[0];
  const workspaceNames = new Map(workspaces.map(workspace => [workspace.id, workspace.name]));
  return <article className="connection-card"><div className="section-heading"><h3>{connector.name}</h3><ConnectionStatus connector={connector} /></div>
    <p className="metadata">{own ? "Yours" : `Owned by ${connector.ownerName}`} · {modelSummary(connector)} · {connector.workspaceIds.length ? `Shared with ${connector.workspaceIds.length} ${connector.workspaceIds.length === 1 ? "workspace" : "workspaces"}` : "Private"}</p>
    <HostCapabilities connector={connector} />
    <Feedback {...action} />
    <Details summary="Manage">
      {own && !connector.revokedAt && <><h4>Shared with</h4>{!connector.workspaceIds.length ? <p className="muted">Not shared. You can still use it in your connected workspaces.</p> : <ul className="connection-shares">{connector.workspaceIds.map(id => <li key={id}><span>{workspaceNames.get(id) ?? id}</span><button className="button secondary small" disabled={action.busy} onClick={() => { if (window.confirm("Stop sharing this Pi? Other members' sessions can no longer run work on it in this workspace. It stays connected for your own use; existing session records and visibility are unchanged.")) void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}/shares/${segment(id)}`, { method: "DELETE" }); refresh(); }, "Pi sharing stopped. Your private connection remains available."); }}>Unshare</button></li>)}</ul>}
        {target ? <><h4>Share with a workspace</h4><label className="field">Workspace<select value={target.id} disabled={action.busy} onChange={event => setWorkspaceId(event.target.value)}>{available.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><ShareConnection key={target.id} connector={connector} workspace={target} action={action} refresh={refresh} selectWorkspace={selectWorkspace} /></> : !workspaces.length && <p><a href="#workspaces">Create or join a workspace</a> and configure its repositories before sharing.</p>}</>}
      {own && <><h4>Connected workspaces</h4>{!connector.connectedWorkspaceIds?.length ? <p className="muted">No connected workspaces reported.</p> : <ul className="connection-shares">{connector.connectedWorkspaceIds.map(id => <li key={id}><span>{workspaceNames.get(id) ?? id} / {connector.workspaceIds.includes(id) ? "Shared with members" : "Private: your own use only"}</span></li>)}</ul>}</>}
      <ModelMetadata connector={connector} />
      <p className="metadata">Connection ID: <code>{connector.id}</code> <CopyButton value={connector.id} /></p>
      {own && !connector.revokedAt && <button className="button danger small revoke-connection" disabled={action.busy} onClick={() => { if (window.confirm(`Revoke ${connector.name}? This disconnects its runtime and blocks work in every connected workspace, including your own sessions. Pair again to reconnect; existing session records are not deleted.`)) void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}`, { method: "DELETE" }); refresh(); }, "Connection revoked."); }}>Revoke connection</button>}
    </Details>
  </article>;
}

function ShareConnection({ connector, workspace, action, refresh, selectWorkspace }: { connector: ConnectorInfo; workspace: Workspace; action: ActionState; refresh: () => void; selectWorkspace: (id: string) => void }) {
  const repositories = useResource<{ repositories: WorkspaceRepository[] }>(`/api/workspaces/${segment(workspace.id)}/repositories`);
  const configured = !repositories.loading && !repositories.error && Boolean(repositories.data?.repositories.length);
  return <form onSubmit={event => {
    event.preventDefault();
    if (!configured || action.busy) return;
    if (connector.capabilities.unsandboxed && !window.confirm(`Share an unsandboxed Pi with ${workspace.name}? Members' approved commands will run directly on your machine as your user, with access to your files, credentials and network, and no resource limits.`)) return;
    void action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/shares/${segment(workspace.id)}`, { method: "PUT", body: {} });
      refresh();
    }, "Pi shared with workspace. Session visibility and permissions are unchanged; personal Pi history is not imported.");
  }}>
    <ResourceState {...repositories} retry={repositories.refresh}>{!repositories.data?.repositories.length && <p className="notice">No repositories configured for {workspace.name}. Ask an owner or admin to bind one before sharing.</p>}</ResourceState>
    {connector.capabilities.unsandboxed && <p className="notice danger">This Pi runs without a sandbox. Sharing it lets members start sessions whose approved commands run directly on your machine as your user.</p>}
    <p className="metadata">Members of {workspace.name} can run their own sessions on this host; you will see their prompts and repository snapshots. Agents, session permissions and GitHub credentials are not shared.</p>
    <div className="actions"><button className="button secondary small" disabled={action.busy || !configured}>{action.busy ? "Saving..." : "Share Pi"}</button><button type="button" className="button secondary small" disabled={repositories.loading || action.busy} onClick={repositories.refresh}>Refresh setup</button><a href="#workspaces" onClick={() => selectWorkspace(workspace.id)}>Open repository setup</a></div>
  </form>;
}
