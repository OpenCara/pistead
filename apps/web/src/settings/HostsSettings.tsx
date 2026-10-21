import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectorInfo, ConnectorPairing } from "../../../../packages/shared/src/connector";
import type { Workspace } from "../../../../packages/shared/src/types";
import type { WorkspaceRepositoryList } from "../../../../packages/shared/src/repositories";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { ConnectionStatus, HostCapabilities, hostTone, useConnections, type ConnectionsResource } from "../hosts";
import { Icon } from "../icons";
import { href, navigate } from "../router";
import { Alert, Button, CardBody, Collapsible, Combobox, confirmDialog, CopyField, EmptyState, Feedback, Field, LinkButton, Loading, ResourceState, Row, Section, Sheet, StatusDot, Timestamp, useAction, useResource, type ActionState } from "../ui";
import "./settings.css";

const hostsInfo = <>
  Hosts are the Pis you pair. A paired host runs a dedicated app runtime for your own use and stays private to you until you share it with a workspace. Whoever operates a host sees the prompts and repository files processed on it, including private source, but never receives a GitHub token. Model credentials stay in Pi on the host. Status refreshes every 10 seconds.
</>;

const workspacesHref = (workspaceId?: string) => href(workspaceId ? { name: "settings", section: "workspaces", id: workspaceId } : { name: "settings", section: "workspaces" });

function count(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** Repository gate shared by pairing and sharing: work needs a bound repository wherever the server requires one. */
function useRepositoryGate(workspace: Workspace | null) {
  const repositories = useResource<WorkspaceRepositoryList>(workspace ? `/api/workspaces/${segment(workspace.id)}/repositories` : null);
  const listed = !repositories.loading && !repositories.error ? repositories.data : null;
  const configured = Boolean(workspace && listed && (listed.repositories.length || !listed.required));
  return { ...repositories, configured };
}

export function HostsSettings({ id }: { id?: string }) {
  const resource = useConnections("/api/connectors");
  const [pairing, setPairing] = useState(false);
  if (id) return <HostDetail id={id} resource={resource} />;
  const hosts = resource.data?.connectors ?? [];
  const empty = !resource.loading && !resource.error && !hosts.length;
  const pair = <Button variant={empty ? "default" : "outline"} size={empty ? "md" : "sm"} icon="plus" onClick={() => setPairing(true)}>Pair a host</Button>;
  return <>
    <Section title="Hosts" info={hostsInfo} action={hosts.length ? pair : undefined} bare={empty}>
      <ResourceState {...resource} retry={resource.refresh}>
        {empty ? <EmptyState title="No hosts yet" action={pair} /> : hosts.map(connector => <Row key={connector.id}
          leading={<StatusDot tone={hostTone(connector)} />}
          title={connector.name}
          hint={`${count(connector.models.length, "model", "models")} · ${connector.workspaceIds.length ? `Shared with ${count(connector.workspaceIds.length, "workspace", "workspaces")}` : "Private"}`}
          trailing={<ConnectionStatus connector={connector} />}
          href={href({ name: "settings", section: "hosts", id: connector.id })}
          chevron />)}
      </ResourceState>
    </Section>
    <SharedWithYou />
    {pairing && <PairHostSheet onClose={() => setPairing(false)} refresh={resource.refresh} />}
  </>;
}

function SharedWithYou() {
  const { user, workspaces } = useApp();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const report = useCallback((workspaceId: string, value: number) => setCounts(current => current[workspaceId] === value ? current : { ...current, [workspaceId]: value }), []);
  const settled = workspaces.every(workspace => workspace.id in counts);
  const total = workspaces.reduce((sum, workspace) => sum + (counts[workspace.id] ?? 0), 0);
  return <Section title="Shared with you" info="Hosts other members shared into your workspaces. You can run your own sessions on them; their operator sees your prompts and repository files. Agents, session permissions and GitHub credentials are not shared.">
    {workspaces.map(workspace => <WorkspaceSharedHosts key={workspace.id} workspace={workspace} userId={user.id} report={report} />)}
    {!settled ? <CardBody><Loading /></CardBody> : !total && <Row title="Nothing shared with you" hint="Hosts members share into your workspaces appear here" />}
  </Section>;
}

function WorkspaceSharedHosts({ workspace, userId, report }: { workspace: Workspace; userId: string; report: (workspaceId: string, value: number) => void }) {
  const resource = useConnections(`/api/workspaces/${segment(workspace.id)}/connectors`);
  const shared = (resource.data?.connectors ?? []).filter(connector => connector.ownerId !== userId);
  const visible = resource.error ? 1 : shared.length;
  useEffect(() => { if (!resource.loading) report(workspace.id, visible); }, [report, workspace.id, resource.loading, visible]);
  if (resource.error) return <Row leading={<StatusDot tone="danger" />} title={`Unable to load hosts for ${workspace.name}`} hint={resource.error} trailing={<Button variant="outline" size="sm" onClick={resource.refresh}>Try again</Button>} />;
  return <>{shared.map(connector => <Collapsible key={connector.id}
    leading={<StatusDot tone={hostTone(connector)} />}
    title={connector.name}
    hint={`${connector.ownerName} · ${workspace.name}`}
    trailing={<ConnectionStatus connector={connector} />}>
    <HostCapabilities connector={connector} />
    <span className="small muted">{connector.models.length ? connector.models.map(model => model.name).join(", ") : "No models advertised"}</span>
  </Collapsible>)}</>;
}

function PairHostSheet({ onClose, refresh }: { onClose: () => void; refresh: () => void }) {
  const { workspaces, currentWorkspace } = useApp();
  const [workspaceId, setWorkspaceId] = useState(currentWorkspace?.id ?? "");
  const workspace = workspaces.find(item => item.id === workspaceId) ?? null;
  const repositories = useRepositoryGate(workspace);
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<ConnectorPairing | null>(null);
  const [expired, setExpired] = useState(false);
  const action = useAction();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!pairing) return;
    const delay = Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => { setPairing(null); setExpired(true); }, delay);
    return () => window.clearTimeout(timer);
  }, [pairing]);
  function chooseWorkspace(value: string) {
    setWorkspaceId(value);
    setPairing(null);
    setExpired(false);
  }
  function create(event?: FormEvent) {
    event?.preventDefault();
    if (!workspace || !repositories.configured || action.busy || !name.trim()) return;
    setPairing(null);
    setExpired(false);
    void action.run(async () => {
      const result = await api<{ pairing: ConnectorPairing }>("/api/connectors/pairings", { method: "POST", body: { name: name.trim(), workspaceId: workspace.id } });
      if (mounted.current) setPairing(result.pairing);
    });
  }
  function done() {
    setPairing(null);
    refresh();
    onClose();
  }
  const createLabel = action.busy ? "Creating code..." : pairing ? "Create another code" : "Create pairing code";
  const footer = pairing
    ? <><Button variant="outline" disabled={action.busy || !name.trim() || !repositories.configured} onClick={() => create()}>{createLabel}</Button><Button variant="default" onClick={done}>Done</Button></>
    : <Button variant="default" disabled={action.busy || !name.trim() || !repositories.configured} onClick={() => create()}>{createLabel}</Button>;
  return <Sheet open wide title="Pair a host" onClose={onClose} footer={footer}>
    <div className="stack">
      {!workspaces.length ? <Alert variant="warning" title="No workspaces yet" actions={<LinkButton variant="outline" size="sm" href={workspacesHref()}>Set up a workspace</LinkButton>}>Create or join a workspace with at least one bound repository before pairing.</Alert> : <>
        <div className="field"><span className="field-label">Workspace</span><Combobox label="Workspace" placeholder="Choose a workspace" value={workspace?.id ?? ""} options={workspaces.map(item => ({ value: item.id, label: item.name }))} onChange={chooseWorkspace} disabled={action.busy} /></div>
        {workspace && <ResourceState {...repositories} retry={repositories.refresh}>
          {!repositories.configured
            ? <Alert variant="warning" title={`No repositories in ${workspace.name}`} actions={<><LinkButton variant="outline" size="sm" href={workspacesHref(workspace.id)}>Set up repositories</LinkButton><Button variant="ghost" size="sm" icon="refresh" disabled={repositories.loading || action.busy} onClick={repositories.refresh}>Refresh</Button></>}>An owner or admin must bind a repository before you can pair.</Alert>
            : <span className="small muted" role="status">{count(repositories.data?.repositories.length ?? 0, "repository", "repositories")} configured in {workspace.name}</span>}
        </ResourceState>}
      </>}
      <form onSubmit={create}>
        <Field label="Host name" hint={`The host stays private to you in ${workspace?.name ?? "the chosen workspace"} until you share it`}>
          <input className="input" required maxLength={120} autoComplete="off" value={name} onChange={event => setName(event.target.value)} placeholder="My Linux workstation" />
        </Field>
      </form>
      <Feedback {...action} />
      {expired && <Alert variant="warning" role="status" title="Pairing code expired">The code was cleared. Create a new code to try again.</Alert>}
      {pairing && <section className="stack" aria-label="One-time pairing instructions">
        <span role="status">Code ready for {workspace?.name}. Expires <Timestamp value={pairing.expiresAt} /></span>
        <Field label="Run this on your host"><CopyField value={`npx pistead@latest connect --server ${window.location.origin} --pairing-id ${pairing.id}`} label="Copy command" /></Field>
        <Field label="Paste at the hidden prompt, not on the command line"><CopyField value={pairing.code} label="Copy code" /></Field>
        <span className="small muted">Single-use secret: don't share it. It is held only in this page's memory. Hiding it doesn't revoke it; an unused code stays tied to {workspace?.name} until it expires.{workspace && <> Once the host is online, <a href={href({ name: "new", workspaceId: workspace.id })}>start a session</a> with one of its models.</>}</span>
      </section>}
      <Collapsible plain title="Host requirements">
        <span className="small">Linux or WSL2 (native Windows is unsupported) with Node.js 24, Pi configured there with its providers and models, and bubblewrap, Python 3, Git and flock installed.</span>
        <span className="small">No app checkout is needed; run from any folder. Session source downloads into private caches. Never paste a token into this page or a command.</span>
        <span className="small">macOS has no sandbox: add <code>--unsafe-no-sandbox</code> to run agent work directly on your Mac as your user, with only Git required. The connector asks you to confirm, and Pistead labels the host Unsandboxed: approved commands run with access to your files, credentials and network, and no resource limits.</span>
      </Collapsible>
    </div>
  </Sheet>;
}

function HostDetail({ id, resource }: { id: string; resource: ConnectionsResource }) {
  const connector = resource.data?.connectors.find(item => item.id === id);
  return <>
    <a className="btn ghost sm settings-back" href={href({ name: "settings", section: "hosts" })}><Icon name="chevron-left" />Hosts</a>
    <ResourceState {...resource} retry={resource.refresh}>
      {!connector ? <EmptyState title="Host not found" /> : <HostSections key={connector.id} connector={connector} refresh={resource.refresh} />}
    </ResourceState>
  </>;
}

function HostSections({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const { workspaces } = useApp();
  const shareAction = useAction();
  const revokeAction = useAction();
  const [reconnecting, setReconnecting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const workspaceNames = new Map(workspaces.map(workspace => [workspace.id, workspace.name]));
  const associated = [...new Set([...(connector.connectedWorkspaceIds ?? []), ...connector.workspaceIds])];
  const available = workspaces.filter(workspace => !connector.workspaceIds.includes(workspace.id));
  function unshare(workspaceId: string) {
    void (async () => {
      const confirmed = await confirmDialog({ title: "Stop sharing this host?", message: "Other members' sessions can no longer run work on it in this workspace. It stays connected for your own use; existing session records and visibility are unchanged.", confirmLabel: "Unshare" });
      if (!confirmed) return;
      await shareAction.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/shares/${segment(workspaceId)}`, { method: "DELETE" });
        refresh();
      }, "Host sharing stopped. Your private connection remains available.");
    })();
  }
  function remove() {
    void (async () => {
      const confirmed = await confirmDialog({ title: `Permanently remove ${connector.name}?`, message: "This permanently removes the host from your list, invalidates its credentials and stops sharing it in all workspaces. Existing sessions and their historical host references remain, but cannot run on this host. Local files are not deleted. To use this machine again, pair it as a new host.", confirmLabel: "Remove permanently", destructive: true });
      if (!confirmed) return;
      await revokeAction.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/permanent`, { method: "DELETE" });
        navigate({ name: "settings", section: "hosts" });
        refresh();
      });
    })();
  }
  function revoke() {
    void (async () => {
      const confirmed = await confirmDialog({ title: `Revoke ${connector.name}?`, message: "This disconnects its runtime and blocks work in every connected workspace, including your own sessions. Pair again to reconnect; existing session records are not deleted.", confirmLabel: "Revoke host", destructive: true });
      if (!confirmed) return;
      await revokeAction.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}`, { method: "DELETE" });
        refresh();
      }, "Host revoked.");
    })();
  }
  return <>
    <Section title="Status" bare>
      <div className="card">
        <Row title="Status" trailing={<ConnectionStatus connector={connector} />} />
        {!connector.online && <Row title={connector.revokedAt ? "Pair again" : "Reconnect host"} hint={connector.revokedAt ? "Revoked credentials cannot be reused; create a new pairing" : "Restart the saved connection on your host machine"}
          trailing={<Button variant="outline" size="sm" disabled={revokeAction.busy} onClick={() => connector.revokedAt ? setPairing(true) : setReconnecting(true)}>{connector.revokedAt ? "Pair again" : "Reconnect"}</Button>} />}
        <Row title="Owner" trailing={connector.ownerName} />
        <Row title="Paired" trailing={<Timestamp value={connector.createdAt} />} />
        {connector.revokedAt && <Row title="Revoked" trailing={<Timestamp value={connector.revokedAt} />} />}
      </div>
      <HostCapabilities connector={connector} />
    </Section>
    <Section title="Models" info="Models configured in Pi on this host. Configure providers and models in Pi on the host; credentials never leave it.">
      {connector.models.length
        ? connector.models.map(model => <Row key={`${model.provider}:${model.modelId}`} title={model.name} hint={`${model.provider} / ${model.modelId}`} />)
        : <Row title="No models advertised" hint="Configure models in Pi on the host" />}
    </Section>
    <Section title="Sharing" bare info="Sharing with a workspace is optional and lets its members run their own sessions on this host; you will see their prompts and repository snapshots. Agents, session permissions and GitHub credentials are not shared, and personal Pi history is never imported.">
      <div className="card">
        {!associated.length && <Row title="No connected workspaces reported" />}
        {associated.map(workspaceId => {
          const shared = connector.workspaceIds.includes(workspaceId);
          return <Row key={workspaceId} title={workspaceNames.get(workspaceId) ?? workspaceId} hint={shared ? "Shared with members" : "Private: your use only"}
            trailing={shared && !connector.revokedAt && <Button variant="outline" size="sm" disabled={shareAction.busy} onClick={() => unshare(workspaceId)}>Unshare</Button>} />;
        })}
        {!connector.revokedAt && (available.length
          ? <ShareRow connector={connector} available={available} busy={shareAction.busy} run={shareAction.run} refresh={refresh} />
          : !workspaces.length && <Row title="Share with workspace" hint="Create or join a workspace and configure its repositories before sharing" href={workspacesHref()} chevron />)}
      </div>
      <Feedback error={shareAction.error} notice={shareAction.notice} />
    </Section>
    <Section title="Details">
      <CardBody><Field label="Connection ID"><CopyField value={connector.id} label="Copy connection ID" /></Field></CardBody>
    </Section>
    <Section title="Danger zone" bare>
      <div className="card">
        <Row title="Revoke host" hint={connector.revokedAt ? <>Revoked <Timestamp value={connector.revokedAt} /></> : "Disconnects its runtime and blocks work in every connected workspace"}
          trailing={!connector.revokedAt && <Button variant="outline" size="sm" disabled={revokeAction.busy} onClick={revoke}>{revokeAction.busy ? "Revoking..." : "Revoke"}</Button>} />
        <Row title="Permanently remove host" hint="Remove from Pistead and invalidate access. Session history and local files are retained."
          trailing={<Button variant="outline" size="sm" disabled={revokeAction.busy} onClick={remove}>Remove permanently</Button>} />
      </div>
      <Feedback error={revokeAction.error} notice={revokeAction.notice} />
    </Section>
    {pairing && <PairHostSheet onClose={() => setPairing(false)} refresh={refresh} />}
    {reconnecting && <Sheet open title={`Reconnect ${connector.name}`} onClose={() => setReconnecting(false)} footer={<Button onClick={() => { refresh(); setReconnecting(false); }}>Done</Button>}>
      <div className="stack">
        <Alert variant={connector.online ? "success" : "warning"} title={connector.online ? "Host is connected" : "Start the connection on your host"}>Pistead cannot remotely start an offline host. If you use the desktop app, open it on the host and start its connection. For a CLI host, run the command below on the original machine with its saved pairing.</Alert>
        <Field label="Run on your host"><CopyField value={`npx pistead@latest connect${connector.capabilities.unsandboxed ? " --unsafe-no-sandbox" : ""}`} label="Copy reconnect command" /></Field>
        <span className="small muted">Use the same OS user and any original options, especially --state-dir, --resources, --pi-agent-dir, --model, --git-credentials and --repo-cache. Do not add --pairing-id or --force: the saved credentials preserve this host and its sessions. Stop any existing connector before starting another. Status refreshes every 10 seconds.</span>
        <span className="small muted">If the saved pairing is missing, pair a new host instead. A new pairing does not reconnect this host's existing sessions.</span>
        <Button variant="outline" onClick={refresh}>Refresh status</Button>
      </div>
    </Sheet>}
  </>;
}

function ShareRow({ connector, available, busy, run, refresh }: { connector: ConnectorInfo; available: Workspace[]; busy: boolean; run: ActionState["run"]; refresh: () => void }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const target = available.find(workspace => workspace.id === workspaceId) ?? available[0]!;
  const repositories = useRepositoryGate(target);
  async function share() {
    if (!repositories.configured || busy) return;
    if (connector.capabilities.unsandboxed && !await confirmDialog({ title: "Share an unsandboxed host?", message: `Share an unsandboxed Pi with ${target.name}? Members' approved commands will run directly on your machine as your user, with access to your files, credentials and network, and no resource limits.`, confirmLabel: "Share host", destructive: true })) return;
    await run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/shares/${segment(target.id)}`, { method: "PUT", body: {} });
      refresh();
    }, "Host shared with workspace. Session visibility and permissions are unchanged; personal Pi history is not imported.");
  }
  const hint = repositories.loading ? <Loading>Checking repositories...</Loading>
    : repositories.error ? <span className="field-error">{repositories.error}</span>
    : !repositories.configured ? <>No repositories configured for {target.name}. Ask an owner or admin to <a href={workspacesHref(target.id)}>bind one</a> before sharing</>
    : `Members of ${target.name} can run their own sessions on this host`;
  return <Row title="Share with workspace" hint={hint} trailing={<>
    <Combobox label="Workspace to share with" value={target.id} options={available.map(workspace => ({ value: workspace.id, label: workspace.name }))} onChange={setWorkspaceId} disabled={busy} />
    {(repositories.error || !repositories.configured) && !repositories.loading && <Button variant="ghost" size="sm" icon="refresh" aria-label="Refresh repositories" title="Refresh repositories" disabled={busy} onClick={repositories.refresh} />}
    <Button variant="outline" size="sm" disabled={busy || !repositories.configured} onClick={() => void share()}>{busy ? "Saving..." : "Share"}</Button>
  </>} />;
}
