import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectorInfo, ConnectorPairing } from "../../../packages/shared/src/connector";
import type { UserProfile, Workspace } from "../../../packages/shared/src/types";
import type { WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { api, errorMessage, segment } from "./api";
import { Empty, Feedback, PageHeading, ResourceState, Timestamp, useAction, useResource, type ActionState } from "./ui";

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
  const state = connector.revokedAt ? "Revoked" : !connector.online ? "Offline" : !connector.capabilities.sandbox ? "Sandbox unverified" : "Online";
  return <span className={`badge ${state === "Online" ? "" : "warning"}`}>{state}</span>;
}

export function HostCapabilities({ connector }: { connector: ConnectorInfo }) {
  return <p className="metadata">Host-reported platform: {connector.capabilities.platform || "Unknown"}. {!connector.online ? "Host is offline. It must reconnect before work can run. " : ""}{!connector.capabilities.sandbox ? "Sandbox support is unverified, not necessarily unavailable. The connector reports conservatively; the runner verifies isolation during per-session repository preparation. " : "The host reports sandbox support, but this is not a security attestation. "}{!connector.capabilities.productionShell ? "Production shell resource limits are not confirmed. " : "The host reports production shell resource limits; these must still be verified. "}The runner verifies prerequisites for each session; verification failures stop the affected work. Production shell requires verified CPU, memory, process and writable-storage limits, with no unrestricted host-shell fallback. Native Windows is unsupported; use Linux or WSL2 with Pi configured in that environment.</p>;
}

function ModelMetadata({ connector }: { connector: ConnectorInfo }) {
  return <div className="connection-models"><h4>Native local models</h4>{connector.models.length ? <ul>{connector.models.map(model => <li key={`${model.provider}:${model.modelId}`}><strong>{model.name}</strong><span className="metadata">{model.provider} / {model.modelId}</span></li>)}</ul> : <p className="muted">No locally configured models advertised yet.</p>}</div>;
}

export function WorkspaceConnections({ workspace, user, configured }: { workspace: Workspace; user: UserProfile; configured: boolean }) {
  const resource = useConnections(`/api/workspaces/${segment(workspace.id)}/connectors`);
  return <section className="section"><div className="section-heading"><span className="section-number">03</span><h2>Available Pi connections</h2><button className="button secondary small" disabled={resource.loading} onClick={resource.refresh}>Refresh hosts</button></div>
    <p>Use your own private Pi or a host explicitly shared with this workspace. Pairing connects a Pi for your own use; only the separate Share Pi with workspace action lets other members run sessions on it.</p>
    <p className="muted">Model metadata is read-only. Configure providers and credentials in Pi on the host, never in this workspace. The host operator can see session prompts and repository files, including private source, but receives no GitHub token.</p>
    <ResourceState {...resource} retry={resource.refresh}>{!resource.data?.connectors.length ? <Empty title="Bring a local Pi to the table">{configured ? "Repository setup is complete. Connect your Pi for your own use next; it stays private by default." : "First, ask an owner or admin to complete repository setup above. Pairing and sharing require at least one configured repository."}</Empty> : <div className="row-list">{resource.data.connectors.map(connector => <article className="connection-card" key={connector.id}><div className="section-heading"><h3>{connector.name}</h3><ConnectionStatus connector={connector} /></div><p>Hosted by <strong>{connector.ownerName}</strong>{connector.ownerId === user.id ? " (you)" : ""}</p><p className="metadata">{connector.workspaceIds.includes(workspace.id) ? `Shared with ${workspace.name}: members can run sessions on this Pi.` : `Private Pi: connected to ${workspace.name} for your own use, not shared with members.`}</p><p className="metadata">Host owner ID: {connector.ownerId}</p><HostCapabilities connector={connector} /><ModelMetadata connector={connector} /></article>)}</div>}</ResourceState>
    {!configured && <p className="notice">Pairing, new sharing and new sessions stay disabled until repository setup is confirmed. Configure or refresh repositories above.</p>}
    <a className="button secondary" href="#connections">{configured ? "Connect Pi / manage my connections" : "View connection status"}</a>
    {configured && <p className="muted">Once your Pi is online, <a href="#agents">create a private agent in the Agent Library</a>, select a model from your Pi, and run it without publishing. Sessions are workspace-visible by default: members can read prompts, tool output and repository content shown in the transcript, without direct GitHub access or tool execution. This does not share your Pi or publish the agent. Ask, write, approve and manage permissions require explicit session grants.</p>}
  </section>;
}

export function Connections({ user, workspaces, workspace, selectWorkspace }: { user: UserProfile; workspaces: Workspace[]; workspace: Workspace | null; selectWorkspace: (id: string) => void }) {
  const resource = useConnections("/api/connectors");
  return <>
    <PageHeading number="04" title="Your Pi. Private by default.">Create a workspace, bind its GitHub repositories, then connect your Pi for your own use. Sharing the host with workspace members is a separate, optional action.</PageHeading>
    <div className="split-layout"><section className="section"><div className="section-heading"><h2>Your connections</h2><button className="button secondary small" disabled={resource.loading} onClick={resource.refresh}>Refresh connections</button></div>
      <p className="muted">Status refreshes every 10 seconds while this page is visible. Any host operator can see prompts and repository files processed on their machine, including private source. Workspace-visible sessions are read-only for members unless explicitly granted more permissions; host sharing and agent publishing do not grant session control.</p>
      <p className="muted">New sessions are workspace-visible by default, including prompts, tool output and repository content shown in the transcript. Read-only viewing grants neither direct GitHub access nor tool execution. Choose private session visibility if members should not see that content.</p>
      <ResourceState {...resource} retry={resource.refresh}>{!resource.data?.connectors.length ? <Empty title="Make the first connection">Choose a configured workspace, create a pairing code, and run the connector from the app repository on your Linux or WSL2 Pi host.</Empty> : <div className="row-list">{resource.data.connectors.map(connector => <OwnedConnection key={connector.id} connector={connector} user={user} workspaces={workspaces} refresh={resource.refresh} selectWorkspace={selectWorkspace} />)}</div>}</ResourceState>
    </section><aside className="rail"><p className="eyebrow">03 / Connect your local Pi</p><h2>Keep the keys at home.</h2><p>Pairing connects a dedicated app runtime. It does not attach to your private interactive Pi conversations or import old sessions.</p>
      <label className="field">Workspace to connect for your own use<select value={workspace?.id ?? ""} disabled={!workspaces.length} onChange={event => selectWorkspace(event.target.value)}><option value="" disabled>Choose a workspace</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
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
    {!workspace ? <p className="notice"><a href="#workspaces">Create or select a workspace</a>, then ask its owner or admin to bind GitHub repositories before pairing.</p> : <ResourceState {...repositories} retry={repositories.refresh}>{!repositories.data?.repositories.length ? <p className="notice">No repositories are configured for {workspace.name}. <a href="#workspaces">Open repository setup</a>; an owner or admin must bind at least one before you can pair or share a host.</p> : <p className="notice" role="status">{workspace.name} has {repositories.data.repositories.length} configured {repositories.data.repositories.length === 1 ? "repository" : "repositories"}. Claiming the code connects this Pi to the workspace for your own use. It stays private unless you explicitly share it.</p>}</ResourceState>}
    {workspace && <div className="actions"><button type="button" className="button secondary small" disabled={repositories.loading || action.busy} onClick={repositories.refresh}>Refresh repository setup</button><a href="#workspaces">Manage repositories</a></div>}
    <form onSubmit={create}><label className="field">Connection name<input required maxLength={120} autoComplete="off" value={name} onChange={event => setName(event.target.value)} placeholder="My Linux workstation" /></label><p className="metadata">Creating and claiming this code makes the host and its local models available to you in <strong>{workspace?.name ?? "the workspace you choose"}</strong>, not to other members. To let members run their own sessions on it later, choose Share Pi with workspace. Personal Pi history is never imported.</p><Feedback {...action} /><button className="button primary" disabled={action.busy || !name.trim() || !configured}>{action.busy ? "Creating code..." : pairing ? "Create another pairing code" : "Create pairing code"}</button></form>
    <section className="pairing-panel" aria-label="Local Pi installation requirements"><h3>Prepare the app checkout</h3><ol><li>Use Linux or WSL2; native Windows is unsupported. Install Node.js 24 and pnpm 10.32.1 in that environment. Configure Pi locally there, including its providers and models, and ensure the Linux sandbox and resource-limit prerequisites are available.</li><li>As a GitHub user authorized to read the private <code>OpenCara/agent-workspace</code> repository, clone the app and install its dependencies:<pre><code>{"git clone https://github.com/OpenCara/agent-workspace.git\ncd agent-workspace\npnpm install"}</code></pre>If GitHub reports that the repository is missing or access is denied, authenticate Git as an authorized user or ask the repository owner for access. Never paste a token into this page or a command URL.</li><li>Run <code>pnpm connect</code> with the pairing arguments below from that cloned app repository root, where its existing <code>package.json</code> lives. Do not run it in an arbitrary target project folder. Do not create a package file or use <code>pnpm init</code> as a workaround. Session source is downloaded separately into private caches.</li></ol></section>
    {expired && <p className="notice" role="status">The pairing code expired and was cleared. Create a new code to try again.</p>}
    {pairing && <section className="pairing-panel" aria-label="One-time pairing instructions"><h3>Connect privately to {workspace?.name}</h3><p role="status">Your single-use code is ready. Claim it to connect this Pi for your own use in {workspace?.name}, without sharing it. Complete these steps before it expires.</p><ol><li>From the prepared <code>agent-workspace</code> repository root, run:<pre><code>{`pnpm connect --server ${window.location.origin} --pairing-id ${pairing.id}`}</code></pre></li><li>Enter this single-use code when the CLI privately prompts you:<p className="pairing-code"><code>{pairing.code}</code></p></li><li>Return here and refresh connections to confirm that the host is online, connected to {workspace?.name}, and not shared.</li><li><a href="#agents">Open the Agent Library</a>, create a private agent using a model from your Pi, and run it without publishing. Keep the default workspace-visible session so members can follow read-only, including prompts, tool output and repository content shown in the transcript. Your Pi and agent remain private; members gain neither direct GitHub access nor tool execution.</li></ol><p>Expires <Timestamp value={pairing.expiresAt} />. Treat this code as a secret; do not share it with teammates. It is held only in this page's memory, not browser storage.</p><button type="button" className="button secondary small" onClick={() => { setPairing(null); refreshConnections(); }}>Done / hide code</button><p className="metadata">Hiding or switching workspaces clears the displayed code but does not revoke it. An unused code stays tied to its original workspace until expiry.</p></section>}
    <p className="metadata">The host can see private repository snapshots and prompts, but receives no GitHub OAuth token. Model credentials stay in Pi on the host. An offline machine cannot execute new work. No public local listener or inbound tunnel is needed.</p>
  </>;
}

function OwnedConnection({ connector, user, workspaces, refresh, selectWorkspace }: { connector: ConnectorInfo; user: UserProfile; workspaces: Workspace[]; refresh: () => void; selectWorkspace: (id: string) => void }) {
  const action = useAction();
  const [workspaceId, setWorkspaceId] = useState("");
  const own = connector.ownerId === user.id;
  const available = workspaces.filter(workspace => !connector.workspaceIds.includes(workspace.id));
  const target = available.find(workspace => workspace.id === workspaceId) ?? available[0];
  return <article className="connection-card"><div className="section-heading"><h3>{connector.name}</h3><ConnectionStatus connector={connector} /></div><p>Host owner: <strong>{connector.ownerName}</strong>{own ? " (you)" : ""}</p><p className="metadata">Connection ID: {connector.id}</p><HostCapabilities connector={connector} /><ModelMetadata connector={connector} /><Feedback {...action} />
    {own && <><h4>Connected workspaces</h4>{!connector.connectedWorkspaceIds?.length ? <p className="muted">No connected workspaces reported.</p> : <ul className="connection-shares">{connector.connectedWorkspaceIds.map(id => <li key={id}><span>{workspaces.find(workspace => workspace.id === id)?.name ?? id} / {connector.workspaceIds.includes(id) ? "Shared with members" : "Private: your own use only"}</span></li>)}</ul>}</>}
    {own && !connector.revokedAt && <><h4>Shared with</h4>{!connector.workspaceIds.length ? <p className="muted">Private Pi. Not shared with any workspace; you can still use it in your connected workspaces.</p> : <ul className="connection-shares">{connector.workspaceIds.map(id => <li key={id}><span>{workspaces.find(workspace => workspace.id === id)?.name ?? id}</span><button className="button secondary small" disabled={action.busy} onClick={() => { if (window.confirm("Stop sharing this Pi? Other members' sessions can no longer run work on it in this workspace. It stays connected for your own use; existing session records and visibility are unchanged.")) void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}/shares/${segment(id)}`, { method: "DELETE" }); refresh(); }, "Pi sharing stopped. Your private connection remains available."); }}>Unshare</button></li>)}</ul>}
      {target ? <><h4>Share Pi with workspace</h4><label className="field">Workspace to share with (optional)<select value={target.id} disabled={action.busy} onChange={event => setWorkspaceId(event.target.value)}>{available.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><ShareConnection key={target.id} connector={connector} workspace={target} action={action} refresh={refresh} selectWorkspace={selectWorkspace} /></> : !workspaces.length && <p><a href="#workspaces">Create or join a workspace</a> and configure its repositories before sharing.</p>}
      <button className="button danger small revoke-connection" disabled={action.busy} onClick={() => { if (window.confirm(`Revoke ${connector.name}? This disconnects its runtime and blocks work in every connected workspace, including your own sessions. Pair again to reconnect; existing session records are not deleted.`)) void action.run(async () => { await api(`/api/connectors/${segment(connector.id)}`, { method: "DELETE" }); refresh(); }, "Connection revoked."); }}>Revoke connection</button>
    </>}
  </article>;
}

function ShareConnection({ connector, workspace, action, refresh, selectWorkspace }: { connector: ConnectorInfo; workspace: Workspace; action: ActionState; refresh: () => void; selectWorkspace: (id: string) => void }) {
  const repositories = useResource<{ repositories: WorkspaceRepository[] }>(`/api/workspaces/${segment(workspace.id)}/repositories`);
  const configured = !repositories.loading && !repositories.error && Boolean(repositories.data?.repositories.length);
  return <form onSubmit={event => {
    event.preventDefault();
    if (!configured || action.busy) return;
    void action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/shares/${segment(workspace.id)}`, { method: "PUT", body: {} });
      refresh();
    }, "Pi shared with workspace. Session visibility and permissions are unchanged; personal Pi history is not imported.");
  }}>
    <ResourceState {...repositories} retry={repositories.refresh}>{!repositories.data?.repositories.length && <p className="notice">No repositories are configured for {workspace.name}. Ask an owner or admin to bind at least one before sharing.</p>}</ResourceState>
    <p className="metadata">Optional: sharing with {workspace.name} lets members start their own sessions on this host using its local models. Its operator can see their repository snapshots and prompts. This does not publish agents, change session visibility or permissions, import personal Pi history, or share GitHub credentials.</p>
    <div className="actions"><button className="button secondary small" disabled={action.busy || !configured}>{action.busy ? "Saving..." : "Share Pi with workspace"}</button><button type="button" className="button secondary small" disabled={repositories.loading || action.busy} onClick={repositories.refresh}>Refresh setup</button><a href="#workspaces" onClick={() => selectWorkspace(workspace.id)}>Open repository setup</a></div>
  </form>;
}
