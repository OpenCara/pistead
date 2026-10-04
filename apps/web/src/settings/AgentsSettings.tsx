import { useState, type FormEvent } from "react";
import { toolNames, type AgentVersion, type ModelDefinition, type ToolName, type UserProfile, type Workspace } from "../../../../packages/shared/src/types";
import { api, segment } from "../api";
import { useApp } from "../app-context";
import { useConnections } from "../hosts";
import { Icon } from "../icons";
import { href, navigate } from "../router";
import { Alert, Button, CardBody, Collapsible, Combobox, EmptyState, Feedback, Field, LinkButton, PageLoading, ResourceState, Row, Section, StatusBadge, Timestamp, useAction, useResource } from "../ui";

/** Read by the new-session screen to preselect an agent version. */
const NEW_SESSION_AGENT_KEY = "pistead.newSessionAgent";

function startSession(workspace: Workspace, version: AgentVersion) {
  try { sessionStorage.setItem(NEW_SESSION_AGENT_KEY, version.id); } catch { /* Private mode: the picker falls back to its default. */ }
  navigate({ name: "new", workspaceId: workspace.id });
}

type AgentGroup = { agentId: string; versions: AgentVersion[]; latest: AgentVersion; runTarget?: AgentVersion; editFrom?: AgentVersion; own: boolean; published: boolean; private: boolean; publishable: boolean };

/** One entry per agent: versions newest first, the newest runnable one to start, the latest own one to revise. */
function groupAgents(all: AgentVersion[], runnableIds: Set<string>, ownIds: Set<string>, workspaceId: string | undefined): AgentGroup[] {
  const byAgent = new Map<string, Map<string, AgentVersion>>();
  for (const version of all) {
    const versions = byAgent.get(version.agentId) ?? new Map<string, AgentVersion>();
    versions.set(version.id, version);
    byAgent.set(version.agentId, versions);
  }
  return [...byAgent].map(([agentId, unique]): AgentGroup => {
    const versions = [...unique.values()].sort((a, b) => b.version - a.version);
    const latestPrivate = versions.find(version => !version.workspaceId && ownIds.has(version.id));
    const publishedHere = versions.filter(version => Boolean(workspaceId) && version.workspaceId === workspaceId);
    return {
      agentId,
      versions,
      latest: versions[0],
      runTarget: versions.find(version => runnableIds.has(version.id)),
      editFrom: versions.find(version => ownIds.has(version.id)),
      own: versions.some(version => ownIds.has(version.id)),
      published: publishedHere.length > 0,
      private: versions.some(version => !version.workspaceId),
      // Publishing copies the latest private version into a newer published version, so it is unpublished until one exists.
      publishable: Boolean(latestPrivate && !publishedHere.some(version => version.version > latestPrivate.version)),
    };
  });
}

/** Everything the agents screens need: own and published versions, runnable set, and models usable on the user's hosts. */
function useAgentCatalog(user: UserProfile, workspace: Workspace | null) {
  const own = useResource<{ agents: AgentVersion[] }>("/api/agents");
  const published = useResource<{ agents: AgentVersion[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/agents` : null);
  const models = useResource<{ models: ModelDefinition[] }>(workspace ? `/api/workspaces/${segment(workspace.id)}/models` : null);
  const connections = useConnections(workspace ? `/api/workspaces/${segment(workspace.id)}/connectors` : null);
  const ownAgents = own.data?.agents ?? [];
  const publishedVersions = published.data?.agents ?? [];
  const workspaceModelIds = new Set((models.data?.models ?? []).map(model => model.id));
  const privateVersions = ownAgents.filter(agent => !agent.workspaceId && agent.authorId === user.id && workspaceModelIds.has(agent.modelId));
  const runnableIds = new Set([...privateVersions, ...publishedVersions].map(version => version.id));
  const groups = groupAgents([...publishedVersions, ...ownAgents], runnableIds, new Set(ownAgents.map(agent => agent.id)), workspace?.id);
  const hosts = connections.data?.connectors ?? [];
  const localModels = (models.data?.models ?? []).filter(model => hosts.some(host => host.id === model.connectorId && !host.revokedAt && (host.ownerId === user.id || Boolean(workspace && host.workspaceIds.includes(workspace.id))) && host.models.some(local => local.provider === model.provider && local.modelId === model.modelId)));
  const hostNames = new Map(hosts.map(host => [host.id, host.name]));
  return { own, published, models, connections, groups, localModels, hostNames, runnableIds };
}

const agentsInfo = <div className="stack">
  <p>Private agents run on your own hosts; publishing is optional. Publishing shares the latest version's instructions, allowed tools and model reference with the workspace, never your identity, environment or conversation history.</p>
  <p>Publishing does not share your hosts. Others can only run on a host its owner has explicitly shared. Editing creates a new private version; existing sessions stay pinned to their version.</p>
</div>;

export function AgentsSettings({ id }: { id?: string }) {
  const { user, currentWorkspace } = useApp();
  if (id) return <>
    <a className="btn ghost sm" href={href({ name: "settings", section: "agents" })}><Icon name="chevron-left" size={16} />Agents</a>
    <AgentDetail key={id} id={id} user={user} workspace={currentWorkspace} />
  </>;
  return <AgentList user={user} workspace={currentWorkspace} />;
}

function versionBadges(group: AgentGroup) {
  return <>
    <StatusBadge>v{group.latest.version}</StatusBadge>
    {group.published
      ? <StatusBadge tone="success">Published</StatusBadge>
      : group.private && <StatusBadge>Private</StatusBadge>}
    {group.published && group.publishable && <StatusBadge tone="warning">Unpublished changes</StatusBadge>}
  </>;
}

function AgentList({ user, workspace }: { user: UserProfile; workspace: Workspace | null }) {
  const { own, published, groups } = useAgentCatalog(user, workspace);
  const mine = groups.filter(group => group.own);
  const others = groups.filter(group => !group.own);
  return <>
    <Section title="Your agents" info={agentsInfo} action={<LinkButton variant="outline" size="sm" icon="plus" href={href({ name: "settings", section: "agents", id: "new" })}>New agent</LinkButton>}>
      <ResourceState {...own} retry={own.refresh}>
        {!mine.length
          ? <EmptyState title="No agents yet" />
          : mine.map(group => <Row key={group.agentId} title={group.latest.name} hint={group.latest.description || undefined} trailing={versionBadges(group)} href={href({ name: "settings", section: "agents", id: group.agentId })} chevron />)}
      </ResourceState>
    </Section>
    {workspace && <Section title={`Published in ${workspace.name}`} info="Agents teammates have published to this workspace. Publishing never shares the author's host; sessions run only on hosts you can use">
      <ResourceState loading={own.loading || published.loading} error={published.error} retry={published.refresh}>
        {!others.length
          ? <CardBody><span className="muted">No published agents from others</span></CardBody>
          : others.map(group => <Row key={group.agentId} title={group.latest.name} hint={[group.latest.description, `v${group.latest.version}`].filter(Boolean).join(" · ")} trailing={group.runTarget && <Button variant="outline" size="sm" onClick={() => startSession(workspace, group.runTarget!)}>Start session</Button>} />)}
      </ResourceState>
    </Section>}
  </>;
}

function AgentDetail({ id, user, workspace }: { id: string; user: UserProfile; workspace: Workspace | null }) {
  const { own, published, models, connections, groups, localModels, hostNames, runnableIds } = useAgentCatalog(user, workspace);
  const [notice, setNotice] = useState("");
  const publishAction = useAction();
  const creating = id === "new";
  if (own.loading || published.loading) return <PageLoading />;
  if (own.error || published.error) return <Alert variant="error" title="Unable to load agents" actions={<Button variant="outline" size="sm" onClick={() => { own.refresh(); published.refresh(); }}>Try again</Button>}>{own.error || published.error}</Alert>;
  const group = creating ? undefined : groups.find(item => item.agentId === id);
  if (!creating && !group) return <EmptyState title="Agent not found" />;
  const editFrom = group?.editFrom ?? null;
  const readOnly = Boolean(group && !editFrom);
  function publish(agent: AgentVersion) {
    if (workspace) void publishAction.run(async () => {
      await api(`/api/agents/${segment(agent.agentId)}/publish`, { method: "POST", body: { workspaceId: workspace.id } });
      own.refresh();
      published.refresh();
    }, `Latest private version published to ${workspace.name}. Host access is unchanged.`);
  }
  function saved(agent: AgentVersion) {
    own.refresh();
    setNotice(creating ? "" : "Private version saved. Existing sessions keep their pinned version.");
    if (creating) navigate({ name: "settings", section: "agents", id: agent.agentId });
  }
  return <>
    {!workspace
      ? <Alert variant="info" title="Choose a workspace" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "workspaces" })}>Workspaces</LinkButton>}>Models come from hosts in your current workspace. Create or choose a workspace first.</Alert>
      : <ResourceState loading={models.loading || connections.loading} error={models.error} retry={() => { models.refresh(); connections.refresh(); }}>
        {models.data && <AgentEditor key={`${workspace.id}:${editFrom?.id ?? group?.latest.id ?? "new"}`} agent={editFrom ?? group?.latest ?? null} readOnly={readOnly} models={localModels} hostNames={hostNames} connectionsError={connections.error} notice={notice} saved={saved} />}
      </ResourceState>}
    {group && workspace && <Section title="Use">
      <Row title="Start a session with this agent" hint={group.runTarget ? `Runs v${group.runTarget.version} in ${workspace.name}` : `No version runs in ${workspace.name} yet. Save a revision with a model available here`} trailing={<Button variant="outline" size="sm" disabled={!group.runTarget} onClick={() => group.runTarget && startSession(workspace, group.runTarget)}>Start session</Button>} />
      {editFrom && (group.publishable
        ? <Row title={`Publish to ${workspace.name}`} hint="Shares the latest private version's instructions, tools and model reference. Host access is unchanged" trailing={<Button variant="outline" size="sm" disabled={publishAction.busy} onClick={() => publish(editFrom)}>{publishAction.busy ? "Publishing..." : "Publish"}</Button>} />
        : group.published && <Row title={`Published to ${workspace.name}`} trailing={<StatusBadge tone="success">Published</StatusBadge>} />)}
      {(publishAction.error || publishAction.notice) && <CardBody><Feedback {...publishAction} /></CardBody>}
    </Section>}
    {group && <Section title="Versions" info="Each save creates a new version. Sessions stay pinned to the version they started with">
      <Collapsible title={`${group.versions.length} ${group.versions.length === 1 ? "version" : "versions"}`} trailing={versionBadges(group)}>
        {group.versions.map(version => <Row key={version.id} title={`v${version.version} · ${version.name}`} hint={<>{version.tools.length} allowed tools · <Timestamp value={version.createdAt} /></>} trailing={<>
          {runnableIds.has(version.id) && <StatusBadge tone="info">Runnable</StatusBadge>}
          <StatusBadge tone={version.workspaceId ? "success" : "neutral"}>{version.workspaceId ? (version.workspaceId === workspace?.id ? "Published" : "Published elsewhere") : "Private"}</StatusBadge>
        </>} />)}
      </Collapsible>
    </Section>}
  </>;
}

function AgentEditor({ agent, readOnly, models, hostNames, connectionsError, notice, saved }: { agent: AgentVersion | null; readOnly: boolean; models: ModelDefinition[]; hostNames: Map<string, string>; connectionsError: string; notice: string; saved: (agent: AgentVersion) => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [modelId, setModelId] = useState(agent?.modelId ?? models[0]?.id ?? "");
  const [tools, setTools] = useState<ToolName[]>(agent?.tools ?? ["identity", "list_files", "read_file"]);
  const action = useAction();
  const model = models.find(item => item.id === modelId);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (readOnly || action.busy) return;
    void action.run(async () => {
      const result = await api<{ agent: AgentVersion }>(agent ? `/api/agents/${segment(agent.agentId)}/versions` : "/api/agents", { method: "POST", body: { name: name.trim(), description, instructions, modelId, tools } });
      saved(result.agent);
    });
  }
  return <form className="stack-lg" onSubmit={submit}>
    <Section title="Details">
      <CardBody>
        <Field label="Name"><input className="input" required maxLength={120} disabled={readOnly} value={name} onChange={event => setName(event.target.value)} placeholder="Repository naturalist" /></Field>
        <Field label="Description"><input className="input" maxLength={500} disabled={readOnly} value={description} onChange={event => setDescription(event.target.value)} placeholder="A short note on what this agent is for" /></Field>
      </CardBody>
    </Section>
    <Section title="Instructions">
      <CardBody>
        <textarea className="textarea" required rows={7} disabled={readOnly} aria-label="Instructions" value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Describe the agent's purpose, approach and boundaries" />
      </CardBody>
    </Section>
    <Section title="Model" info="Models advertised by hosts you can use in this workspace: your own, or ones a teammate has shared">
      <Row title={model?.name ?? "No model selected"} hint={model ? `${model.provider} on ${hostNames.get(model.connectorId ?? "") ?? "unknown host"}` : agent && !readOnly ? "The previous model is no longer available here. Choose another" : undefined} trailing={<Combobox label="Model" value={model ? modelId : ""} disabled={readOnly || !models.length} placeholder="Choose a model" options={models.map(item => ({ value: item.id, label: item.name, hint: hostNames.get(item.connectorId ?? "") ?? item.provider }))} onChange={setModelId} />} />
      {!models.length && !readOnly && <CardBody><Alert variant="warning" title="No models available" actions={<LinkButton variant="outline" size="sm" href={href({ name: "settings", section: "hosts" })}>Pair a host</LinkButton>}>Pair your Pi or use a host a teammate has shared.</Alert></CardBody>}
      {connectionsError && <CardBody><Feedback error={connectionsError} /></CardBody>}
    </Section>
    <Section title="Tools" info="Sensitive operations still need approval">
      {toolNames.map(tool => <label className="row check-row" key={tool}>
        <input type="checkbox" className="checkbox" disabled={readOnly} checked={tools.includes(tool)} onChange={event => setTools(current => event.target.checked ? [...current, tool] : current.filter(value => value !== tool))} />
        <span className="mono">{tool}</span>
      </label>)}
    </Section>
    {!readOnly && <div className="inline">
      <Feedback error={action.error} notice={notice} />
      <span className="spacer" />
      <Button variant="default" type="submit" disabled={action.busy || !models.some(item => item.id === modelId) || !name.trim() || !instructions.trim()}>{action.busy ? "Saving..." : agent ? "Save revision" : "Create agent"}</Button>
    </div>}
  </form>;
}
