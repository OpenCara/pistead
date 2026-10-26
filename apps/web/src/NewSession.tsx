import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ModelDefinition, SessionRecord, Workspace } from "../../../packages/shared/src/types";
import { canCreateSessions } from "../../../packages/shared/src/policy";
import { api, segment } from "./api";
import { useApp } from "./app-context";
import { AttachmentStrip, encodeImages, handOverImages, imagesUnavailable, useAttachments } from "./attachments";
import {
  autoApproveConfirmed, ChatOptionsBar, chatOptionsBody, confirmAutoApprove, mustConfirmAutoApprove, preferredSelection, readChatPreference, rememberChat, type ChatSelection,
} from "./chat-options";
import { writeDraft } from "./drafts";
import { ConnectionStatus, HostCapabilities, useConnections } from "./hosts";
import { Icon } from "./icons";
import { useWorkspacePeople } from "./people";
import { RepositoryClonePolicy, useWorkspaceRepositories } from "./repositories";
import { href, navigate } from "./router";
import { Alert, Button, Combobox, DropdownMenu, EmptyState, Feedback, IdentityBadge, InfoTip, LinkButton, Loading, PageLoading, useAction, useResource } from "./ui";
import { usernameWithId } from "../../../packages/client/src/usernames";
import "./new-session.css";

/** The model the last session started on: `model:<workspace model id>`. */
const LAST_START_KEY = "pistead.lastStart";
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

function deriveTitle(content: string, fallback: string): string {
  const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
  return Array.from(firstLine).slice(0, TITLE_LIMIT).join("").trim() || fallback;
}

const sameModel = (a: { provider: string; modelId: string }, b: { provider: string; modelId: string }) => a.provider === b.provider && a.modelId === b.modelId;

/** A host owner's "username(id)". Rendered in the host details tip, so the workspace's members load only once it opens. */
function HostOwner({ workspaceId, ownerId }: { workspaceId: string; ownerId: string }) {
  const people = useWorkspacePeople(workspaceId);
  return <>{usernameWithId(people.person(ownerId))}</>;
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
  if (!canCreateSessions(workspace.role)) {
    return <div className="new-session"><EmptyState title="You're a viewer in this workspace" action={<LinkButton variant="ghost" href={href({ name: "sessions" })}>View sessions</LinkButton>}>Viewers follow the workspace's shared sessions read-only and can't start sessions. Ask a workspace owner or admin for the member role.</EmptyState></div>;
  }
  // Keyed so host, trust and repository state never carry across workspaces.
  return <Composer key={workspace.id} workspace={workspace} />;
}

function Composer({ workspace }: { workspace: Workspace }) {
  const { user, refreshSessions } = useApp();
  const workspacePath = `/api/workspaces/${segment(workspace.id)}`;
  const models = useResource<{ models: ModelDefinition[] }>(`${workspacePath}/models`);
  const connections = useConnections(`${workspacePath}/connectors`);
  const repos = useWorkspaceRepositories(workspace.id);

  const [lastStart] = useState(() => readStorage(() => localStorage, LAST_START_KEY));
  const [lastChat] = useState(readChatPreference);

  const [choice, setChoice] = useState("");
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("workspace");
  const [trustedHost, setTrustedHost] = useState("");
  // Where the session runs: in the sandbox, or directly on the host, which only its owner chooses where it accepts that.
  const [onHost, setOnHost] = useState(false);
  const action = useAction();
  const input = useRef<HTMLTextAreaElement>(null);

  const modelList = models.data?.models;
  const connectors = connections.data?.connectors;
  // Hosts with a model you can use here, yours first.
  const hosts = useMemo(() => {
    const offering = new Set((modelList ?? []).map(model => model.connectorId));
    return (connectors ?? []).filter(host => offering.has(host.id) && !host.revokedAt)
      .sort((a, b) => Number(b.ownerId === user.id) - Number(a.ownerId === user.id));
  }, [connectors, modelList, user.id]);
  // The chosen host, else the one the last session started on, else the first online one.
  const remembered = lastStart.startsWith("model:") ? modelList?.find(model => model.id === lastStart.slice(6)) : undefined;
  const host = hosts.find(item => item.id === choice)
    ?? hosts.find(item => item.id === remembered?.connectorId) ?? hosts.find(item => item.online) ?? hosts[0];
  const hostKey = host?.id ?? "";
  const hostModel = (wanted?: { provider: string; modelId: string }) => wanted && host && host.models.some(item => sameModel(item, wanted))
    ? modelList?.find(item => item.connectorId === host.id && sameModel(item, wanted)) : undefined;
  // Picks belong to one host; switching starts from its model again: the model last chatted with when this host offers
  // it, else the model last started on this host, else the host's first model. Reasoning starts at the level last
  // chatted with where the model supports it, else at the level the host's Pi starts that model at.
  const [chat, setChat] = useState<{ key: string; value: ChatSelection } | null>(null);
  const fallbackModel = hostModel(remembered) ?? host?.models.map(item => hostModel(item)).find(Boolean);
  const selection: ChatSelection = chat?.key === hostKey ? chat.value
    : preferredSelection(host, lastChat, fallbackModel, item => Boolean(hostModel(item)));
  // The session starts on the model picked here, one the host offers.
  const model = hostModel(selection.model);
  const foreign = Boolean(host && host.ownerId !== user.id);
  const available = Boolean(host?.online && !host.revokedAt && model && (host.ownerId === user.id || host.workspaceIds.includes(workspace.id)));
  const repositories = repos.repositories;
  const repositoriesReady = Boolean(repositories && !repos.error && !repos.loading && (repositories.length || !repos.required));
  const trusted = !foreign || Boolean(host && trustedHost === host.id);
  const hostSessions = Boolean(host?.hostSessions && host.ownerId === user.id);
  const runOnHost = hostSessions && onHost;
  const unsandboxed = Boolean(host?.capabilities.unsandboxed || runOnHost);
  const canStart = Boolean(model && host && available && repositoriesReady && trusted && !action.busy);
  const attachments = useAttachments(imagesUnavailable(host));

  // Set while the owner decides on Auto-approve, so a second Enter can't start a second session.
  const confirming = useRef(false);

  // A trust acknowledgement covers one host against one repository set.
  useEffect(() => { setTrustedHost(""); }, [hostKey, host?.ownerId, repositories]);
  // Each host starts in the sandbox: running on one is chosen for it, never carried over from another.
  useEffect(() => { setOnHost(false); }, [hostKey]);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [content]);

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (!canStart || !model || !host || confirming.current) return;
    const message = content.trim();
    const pasted = attachments.images;
    const options = chatOptionsBody(host, selection, "submit");
    // The chat box starts on Auto-approve without asking, and it merges too: the first message that would asks first.
    if (mustConfirmAutoApprove(options, autoApproveConfirmed())) {
      confirming.current = true;
      const confirmed = await confirmAutoApprove(host, unsandboxed).finally(() => { confirming.current = false; });
      // Declined, the chat box asks before acting instead, and nothing starts until the owner sends again.
      if (!confirmed) { setChat({ key: hostKey, value: { ...selection, access: "approval" } }); return; }
    }
    void action.run(async () => {
      // Before the session exists: an image that can't be read stops the start instead of leaving a session behind.
      const images = await encodeImages(pasted);
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: { workspaceId: workspace.id, modelId: model.id, title: deriveTitle(content, model.name), visibility,
        ...(foreign ? { trustedConnectorId: host.id } : {}), ...(runOnHost ? { hostEnvironment: true } : {}) } });
      const sessionId = result.session.id;
      writeStorage(() => localStorage, LAST_START_KEY, `model:${model.id}`);
      rememberChat(host, selection);
      if (message || images.length) {
        try {
          await api(`/api/sessions/${segment(sessionId)}/submit`, { method: "POST", body: { content: message, requestId: crypto.randomUUID(), ...(options ? { options } : {}),
            ...(images.length ? { images } : {}) } });
        } catch {
          // The session exists; keep the unsent text and images for its composer instead of failing the start.
          writeDraft(sessionId, message);
          handOverImages(sessionId, pasted);
        }
      }
      refreshSessions();
      navigate({ name: "session", sessionId });
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void start();
    }
  }

  const workspaceSettings = href({ name: "settings", section: "workspaces", id: workspace.id });

  function blockingAlert() {
    if (repos.error) return <Alert variant="warning" title="Unable to load repositories" actions={<Button variant="outline" size="sm" onClick={repos.refresh}>Retry</Button>}>{repos.error}</Alert>;
    if (repositories && !repositories.length && repos.required) return <Alert variant="warning" title="No repositories in this workspace" actions={<LinkButton variant="outline" size="sm" href={workspaceSettings}>Add repository</LinkButton>}>Sessions need at least one repository. Workspace owners and admins can bind one in workspace settings.</Alert>;
    if (models.error) return <Alert variant="error" title="Unable to load models" actions={<Button variant="outline" size="sm" onClick={models.refresh}>Retry</Button>}>{models.error}</Alert>;
    if (!models.loading && !connections.loading && !connections.error && !hosts.length) return <Alert variant="info" title="No host to chat with yet" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "hosts" })}>Pair a host</LinkButton>}>Pair your own Pi to chat with its models, or ask a workspace member to share their host here.</Alert>;
    if (!host || connections.loading || !modelList) return null;
    const refreshHost = <Button variant="outline" size="sm" onClick={connections.refresh}>Refresh host status</Button>;
    if (connections.error) return <Alert variant="warning" title="Unable to check host" actions={refreshHost}>{connections.error}</Alert>;
    if (!model) return <Alert variant="warning" title={`No model on ${host.name}`} actions={refreshHost}>{host.name} offers no model you can use in this workspace.</Alert>;
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
  const environmentItems = [
    { label: "Sandbox", icon: "shield" as const, hint: "Isolated, with the workspace's network access", onSelect: () => setOnHost(false) },
    { label: "On this host", icon: "server" as const, hint: "No sandbox: runs as the host's user", onSelect: () => setOnHost(true) },
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
        <AttachmentStrip attachments={attachments} disabled={action.busy} />
        <textarea ref={input} className="composer-input" rows={2} value={content} onChange={event => setContent(event.target.value)} onKeyDown={onKeyDown} onPaste={attachments.paste} placeholder="Describe the task" aria-label="First message" autoFocus />
        {attachments.notice && <p className="composer-notice" role="status">{attachments.notice}</p>}
        <div className="composer-toolbar">
          <Combobox label="Host" placeholder={models.loading || connections.loading ? "Loading..." : "Choose a host"} disabled={!hosts.length} value={hostKey}
            options={hosts.map(item => ({ value: item.id, label: item.name, hint: item.ownerId === user.id ? "Your host" : `${item.ownerName}'s host` }))}
            onChange={setChoice} />
          <DropdownMenu label="Visibility" align="start" items={visibilityItems} trigger={<><Icon name={visibility === "workspace" ? "globe" : "lock"} size={14} />{visibility === "workspace" ? "Workspace" : "Private"}</>} />
          {hostSessions && <DropdownMenu label="Where it runs" align="start" items={environmentItems} trigger={<><Icon name={runOnHost ? "server" : "shield"} size={14} />{runOnHost ? "On host" : "Sandbox"}</>} />}
          <InfoTip label="Who can see and do what">
            <div className="stack">
              <p>{visibility === "workspace" ? "Workspace members can view prompts, output, tool results, and repository content shown in the transcript. Collaborators and admins can also send messages to it; anything more (approving tool calls, managing the session) needs an explicit grant." : "Workspace membership alone does not give access to a private session; only explicit session grants do."}</p>
              <p>You are the session owner; the host owner is a separate role. Viewing never grants access to your Git accounts, and visibility does not share your Pi host or local models.</p>
            </div>
          </InfoTip>
          <ChatOptionsBar host={host} value={selection} onChange={value => setChat({ key: hostKey, value })} owner showAccess unsandboxed={unsandboxed} />
          <span className="spacer" />
          {action.busy && <Loading>Preparing repositories...</Loading>}
          <Button type="submit" variant="default" icon="send" className="composer-send" aria-label="Start session" title="Start session" disabled={!canStart} />
        </div>
      </fieldset>
    </form>
    <Feedback error={action.error} />
    {runOnHost && host && <Alert variant="warning" title="Runs on your host, without the sandbox">
      Its commands run on {host.name} as its user, with its files, credentials, network and GPU, and no resource limits; the workspace's network access doesn't apply. Approve them as you would commands you run yourself: people you share the session with can't decide them unless you granted them host commands.
    </Alert>}
    <div className="new-session-meta">
      {action.busy
        ? <span role="status">Resolving repository commits and downloading snapshots to the Pi host's private session cache. The agent starts once every repository is ready.</span>
        : <>
          {host && (connections.loading || models.loading ? <Loading>Checking host...</Loading> : <>
            <ConnectionStatus connector={host} />
            <span>{host.name}</span>
            <span>·</span>
            <span>{model?.name}</span>
            <span>·</span>
            <span>{foreign ? `Hosted by ${host.ownerName}` : "Your host"}, {host.workspaceIds.includes(workspace.id) ? "shared with this workspace" : "private"}</span>
            <InfoTip label="Host and model details">
              <div className="stack">
                <p>Model: {model?.name} <span className="muted">{model?.provider} / {model?.modelId}</span></p>
                <p className="muted small">Host owner: <HostOwner workspaceId={workspace.id} ownerId={host.ownerId} /><br />Connection ID: {host.id}</p>
                <p>This creates a new session, not access to the host's personal Pi history or old sessions. Your Git account credentials are not sent to the host; model credentials stay on it.</p>
              </div>
            </InfoTip>
          </>)}
          {repos.loading ? <Loading>Loading repositories...</Loading> : repositories && repositories.length > 0 && <>
            {host && <span>·</span>}
            <span>{repositories.length === 1 ? "1 repository" : `${repositories.length} repositories`}</span>
            <InfoTip label="Repositories for this session">
              <div className="stack">
                <ul>{repositories.map(repository => <li key={repository.id}><strong>{repository.fullName}</strong> <span className="muted">at <code>{repository.ref}</code></span></li>)}</ul>
                <p>Repository access uses your connected Git account as session owner, not the host owner's or an admin's. The agent clones the repositories it needs with Git as it works; where it can't run shell commands, the session starts with an empty worktree.</p>
                <RepositoryClonePolicy />
              </div>
            </InfoTip>
            <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh repositories" title="Refresh repositories" onClick={repos.refresh} />
          </>}
        </>}
    </div>
    {host && !action.busy && <HostCapabilities connector={host} />}
  </div>;
}
