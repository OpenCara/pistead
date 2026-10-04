import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentVersion, ModelDefinition, SessionRecord, Workspace } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { useApp } from "./app-context";
import { ConnectionStatus, HostCapabilities, useConnections } from "./hosts";
import { Icon } from "./icons";
import { RepositorySnapshotPolicy, useWorkspaceRepositories } from "./repositories";
import { href, navigate } from "./router";
import { Alert, Button, Combobox, DropdownMenu, EmptyState, Feedback, IdentityBadge, InfoTip, LinkButton, Loading, PageLoading, useAction, useResource } from "./ui";
import "./new-session.css";

/** Set by the agent settings "Start a session" action; consumed once. Holds an agent version id or agent id. */
const HANDOFF_KEY = "pistead.newSessionAgent";
/** The agent version most recently used to start a session. */
const LAST_AGENT_KEY = "pistead.lastAgent";
const TITLE_LIMIT = 80;

type Visibility = "workspace" | "private";

function readStorage(storage: () => Storage, key: string): string {
  try { return storage().getItem(key) ?? ""; } catch { return ""; }
}

function writeStorage(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch { /* Private mode: the preference is simply not remembered. */ }
}

/** Matches an exact version id, else the newest runnable version of a logical agent id. */
function findVersion(versions: AgentVersion[], id: string): AgentVersion | undefined {
  if (!id) return undefined;
  return versions.find(version => version.id === id)
    ?? versions.filter(version => version.agentId === id).sort((a, b) => b.version - a.version)[0];
}

function deriveTitle(content: string, fallback: string): string {
  const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
  return Array.from(firstLine).slice(0, TITLE_LIMIT).join("").trim() || fallback;
}

export function NewSession({ workspaceId }: { workspaceId: string }) {
  const { workspaces, workspacesLoading, workspacesError, refreshWorkspaces, currentWorkspace, selectWorkspace } = useApp();
  const workspace = workspaces.find(item => item.id === workspaceId) ?? null;
  // Starting here makes this the default workspace for the sidebar and later sessions.
  useEffect(() => {
    if (workspace && currentWorkspace?.id !== workspace.id) selectWorkspace(workspace.id);
  }, [workspace, currentWorkspace?.id, selectWorkspace]);
  if (!workspace) {
    if (workspacesLoading) return <PageLoading />;
    if (workspacesError) return <div className="new-session"><Alert variant="error" title="Unable to load workspaces" actions={<Button variant="outline" size="sm" onClick={refreshWorkspaces}>Retry</Button>}>{workspacesError}</Alert></div>;
    return <div className="new-session"><EmptyState title="Workspace not found" action={<LinkButton variant="ghost" href={href({ name: "sessions" })}>View sessions</LinkButton>}>You may no longer be a member of this workspace.</EmptyState></div>;
  }
  // Keyed so agent, trust and repository state never carry across workspaces.
  return <Composer key={workspace.id} workspace={workspace} />;
}

function Composer({ workspace }: { workspace: Workspace }) {
  const { user, refreshSessions } = useApp();
  const workspacePath = `/api/workspaces/${segment(workspace.id)}`;
  const own = useResource<{ agents: AgentVersion[] }>("/api/agents");
  const published = useResource<{ agents: AgentVersion[] }>(`${workspacePath}/agents`);
  const models = useResource<{ models: ModelDefinition[] }>(`${workspacePath}/models`);
  const connections = useConnections(`${workspacePath}/connectors`);
  const repos = useWorkspaceRepositories(workspace.id);

  const [handoff] = useState(() => readStorage(() => sessionStorage, HANDOFF_KEY));
  const [lastUsed] = useState(() => readStorage(() => localStorage, LAST_AGENT_KEY));
  useEffect(() => { writeStorage(() => sessionStorage, HANDOFF_KEY, null); }, []);

  const [selectedId, setSelectedId] = useState("");
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("workspace");
  const [trustedHost, setTrustedHost] = useState("");
  const action = useAction();
  const input = useRef<HTMLTextAreaElement>(null);

  const modelList = models.data?.models;
  // Runnable: your own private versions whose model this workspace offers, plus versions published here.
  const versions = useMemo(() => {
    const workspaceModelIds = new Set((modelList ?? []).map(model => model.id));
    const privateVersions = (own.data?.agents ?? []).filter(agent => !agent.workspaceId && agent.authorId === user.id && workspaceModelIds.has(agent.modelId));
    return [...privateVersions, ...(published.data?.agents ?? [])];
  }, [own.data, published.data, modelList, user.id]);
  const agentsLoading = own.loading || published.loading || models.loading;
  const agentsError = own.error || published.error || models.error;

  const selected = versions.find(version => version.id === selectedId) ?? findVersion(versions, handoff) ?? findVersion(versions, lastUsed) ?? versions[0];
  const model = modelList?.find(item => item.id === selected?.modelId);
  const connectors = connections.data?.connectors;
  const host = connectors?.find(item => item.id === model?.connectorId);
  const foreign = Boolean(host && host.ownerId !== user.id);
  const availableModel = Boolean(host?.models.some(item => item.provider === model?.provider && item.modelId === model?.modelId));
  const available = Boolean(host?.online && !host.revokedAt && availableModel && (host.ownerId === user.id || host.workspaceIds.includes(workspace.id)));
  const repositories = repos.repositories;
  const repositoriesReady = Boolean(repositories && !repos.error && !repos.loading && repositories.length);
  const trusted = !foreign || Boolean(host && trustedHost === host.id);
  const canStart = Boolean(selected && host && available && repositoriesReady && trusted && !action.busy);

  // A trust acknowledgement covers one agent on one host against one repository set.
  useEffect(() => { setTrustedHost(""); }, [selected?.id, host?.id, host?.ownerId, repositories]);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [content]);

  function start(event?: FormEvent) {
    event?.preventDefault();
    if (!canStart || !selected || !host) return;
    const message = content.trim();
    void action.run(async () => {
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: { workspaceId: workspace.id, agentVersionId: selected.id, title: deriveTitle(content, selected.name), visibility, ...(foreign ? { trustedConnectorId: host.id } : {}) } });
      const sessionId = result.session.id;
      writeStorage(() => localStorage, LAST_AGENT_KEY, selected.id);
      if (message) {
        try {
          await api(`/api/sessions/${segment(sessionId)}/submit`, { method: "POST", body: { content: message, requestId: crypto.randomUUID() } });
        } catch {
          // The session exists; keep the unsent text for its composer instead of failing the start.
          writeStorage(() => sessionStorage, `pistead.draft.${sessionId}`, message);
        }
      }
      refreshSessions();
      navigate({ name: "session", sessionId });
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      start();
    }
  }

  const workspaceSettings = href({ name: "settings", section: "workspaces", id: workspace.id });
  const hostName = (version: AgentVersion) => {
    const connectorId = modelList?.find(item => item.id === version.modelId)?.connectorId;
    return connectors?.find(item => item.id === connectorId)?.name ?? "No host";
  };

  function blockingAlert() {
    if (repos.error) return <Alert variant="warning" title="Unable to load repositories" actions={<Button variant="outline" size="sm" onClick={repos.refresh}>Retry</Button>}>{repos.error}</Alert>;
    if (repositories && !repositories.length) return <Alert variant="warning" title="No repositories in this workspace" actions={<LinkButton variant="outline" size="sm" href={workspaceSettings}>Add repository</LinkButton>}>Sessions need at least one repository. Workspace owners and admins can bind one in workspace settings.</Alert>;
    if (agentsError) return <Alert variant="error" title="Unable to load agents" actions={<Button variant="outline" size="sm" onClick={() => { own.refresh(); published.refresh(); models.refresh(); }}>Retry</Button>}>{agentsError}</Alert>;
    if (!agentsLoading && !versions.length) return <Alert variant="info" title="No agents yet" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "agents", id: "new" })}>Create an agent</LinkButton>}>Create a private agent to run on your own Pi, or ask a workspace member to publish one here.</Alert>;
    if (!selected || connections.loading || !modelList) return null;
    const refreshHost = <Button variant="outline" size="sm" onClick={connections.refresh}>Refresh host status</Button>;
    if (connections.error) return <Alert variant="warning" title="Unable to check host" actions={refreshHost}>{connections.error}</Alert>;
    if (!host) return <Alert variant="warning" title="No available host for this agent" actions={refreshHost}>Connect your own Pi, ask the host owner to share access, or save a revision with a model available to you.</Alert>;
    if (!availableModel) return <Alert variant="warning" title="Model no longer offered" actions={refreshHost}>This pinned model is no longer offered by {host.name}. Ask the host owner to restore it; no substitute will be chosen.</Alert>;
    if (!available) return <Alert variant="warning" title={`${host.name} is unavailable`} actions={refreshHost}>{host.revokedAt ? "This host was revoked." : !host.online ? "It must reconnect before work can run." : "This host isn't shared with this workspace."}</Alert>;
    if (foreign) return <Alert variant="warning" title={`Hosted by ${host.ownerName}`}>
      <label className="check-row new-session-trust">
        <input type="checkbox" className="checkbox" checked={trustedHost === host.id} disabled={action.busy} onChange={event => setTrustedHost(event.target.checked ? host.id : "")} />
        <span>I trust {host.ownerName}'s host ({host.name}) to process this session's prompts and repository files, including private repository snapshots; its operator can read them. Repository access uses my GitHub identity, not the host owner's or a workspace admin's. I remain the session owner.</span>
      </label>
    </Alert>;
    return null;
  }

  const visibilityItems = [
    { label: "Workspace", icon: "globe" as const, hint: "Members can view", onSelect: () => setVisibility("workspace") },
    { label: "Private", icon: "lock" as const, hint: "Explicit grants only", onSelect: () => setVisibility("private") },
  ];

  return <div className="new-session">
    <div className="new-session-hero">
      <h1 className="new-session-title">What should we work on?</h1>
      <div className="new-session-subtitle">
        <IdentityBadge name={workspace.name} id={workspace.id} />
        <span className="truncate">{workspace.name}</span>
        <LinkButton variant="ghost" size="xs" href={workspaceSettings}>Workspace settings</LinkButton>
      </div>
    </div>
    {blockingAlert()}
    <form className="composer-card" onSubmit={start} aria-busy={action.busy}>
      <fieldset disabled={action.busy}>
        <textarea ref={input} className="composer-input" rows={2} value={content} onChange={event => setContent(event.target.value)} onKeyDown={onKeyDown} placeholder="Describe the task" aria-label="First message" autoFocus />
        <div className="composer-toolbar">
          <Combobox label="Agent" placeholder={agentsLoading ? "Loading agents..." : "Choose an agent"} disabled={!versions.length} value={selected?.id ?? ""} options={versions.map(version => ({ value: version.id, label: version.name, hint: `v${version.version} · ${hostName(version)}` }))} onChange={setSelectedId} />
          <DropdownMenu label="Visibility" align="start" items={visibilityItems} trigger={<><Icon name={visibility === "workspace" ? "globe" : "lock"} size={14} />{visibility === "workspace" ? "Workspace" : "Private"}</>} />
          <InfoTip label="Who can see and do what">
            <div className="stack">
              <p>{visibility === "workspace" ? "Workspace members can view prompts, output, tool results, and repository content shown in the transcript. Asking the agent, invoking tools, or controlling the session needs an explicit grant." : "Workspace membership alone does not give access to a private session; only explicit session grants do."}</p>
              <p>You are the session owner; the agent author and host owner are separate roles. Viewing never grants GitHub access, and visibility does not share your Pi host, private agent, or local models.</p>
            </div>
          </InfoTip>
          <span className="spacer" />
          {action.busy && <Loading>Preparing repositories...</Loading>}
          <Button type="submit" variant="default" icon="send" className="composer-send" aria-label="Start session" title="Start session" disabled={!canStart} />
        </div>
      </fieldset>
    </form>
    <Feedback error={action.error} />
    <div className="new-session-meta">
      {action.busy
        ? <span role="status">Resolving repository commits and downloading snapshots to the Pi host's private session cache. The agent starts once every repository is ready.</span>
        : <>
          {selected && (connections.loading || models.loading ? <Loading>Checking host...</Loading> : host && <>
            <ConnectionStatus connector={host} />
            <span>{host.name}</span>
            <span>·</span>
            <span>{model?.name}</span>
            <span>·</span>
            <span>{foreign ? `Hosted by ${host.ownerName}` : "Your host"}, {host.workspaceIds.includes(workspace.id) ? "shared with this workspace" : "private"}</span>
            <InfoTip label="Host and model details">
              <div className="stack">
                <p>Model: {model?.name} <span className="muted">{model?.provider} / {model?.modelId}</span></p>
                <p className="muted small">Host owner ID: {host.ownerId}<br />Connection ID: {host.id}</p>
                <p>This creates a new session, not access to the host's personal Pi history or old sessions. Publishing an agent does not grant use of its host. Your GitHub credentials are not sent to the host; model credentials stay on it.</p>
              </div>
            </InfoTip>
          </>)}
          {repos.loading ? <Loading>Loading repositories...</Loading> : repositories && repositories.length > 0 && <>
            {host && <span>·</span>}
            <span>{repositories.length === 1 ? "1 repository" : `${repositories.length} repositories`}</span>
            <InfoTip label="Repositories for this session">
              <div className="stack">
                <ul>{repositories.map(repository => <li key={repository.id}><strong>{repository.fullName}</strong> <span className="muted">at <code>{repository.ref}</code></span></li>)}</ul>
                <p>Repositories are read with your GitHub access as session owner, not the host owner's or an admin's. Each ref is pinned to a commit before the session runs.</p>
                <RepositorySnapshotPolicy />
              </div>
            </InfoTip>
            <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh repositories" title="Refresh repositories" onClick={repos.refresh} />
          </>}
        </>}
    </div>
    {host && !action.busy && <HostCapabilities connector={host} />}
  </div>;
}
