import { chatOptionsBody, segment, type ChatSelection } from "@pistead/client";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import type { WorkspaceRepositoryList } from "../../../../packages/shared/src/repositories";
import type { ModelDefinition, SessionRecord, Workspace } from "../../../../packages/shared/src/types";
import { useAppData } from "../lib/app-data";
import { useSession } from "../lib/auth";
import { saveDraft } from "../lib/drafts";
import { useAction, useResource } from "../lib/resource";
import { usePalette } from "../theme";
import { ChatOptionsBar } from "./ChatOptionsBar";
import { Banner, Button, Chip, EmptyState, Feedback, Loading, OptionSheet, styles as ui } from "./ui";

const TITLE_LIMIT = 80;

type Visibility = "workspace" | "private";

function deriveTitle(content: string, fallback: string): string {
  const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
  return Array.from(firstLine).slice(0, TITLE_LIMIT).join("").trim() || fallback;
}

const sameModel = (a: { provider: string; modelId: string }, b: { provider: string; modelId: string }) => a.provider === b.provider && a.modelId === b.modelId;

/** Pick a workspace, then a host and model in it, optionally a first message; like the web's new-session screen. */
export function NewSessionForm({ onStarted }: { onStarted: (sessionId: string) => void }) {
  const { workspaces, workspacesLoading, workspacesError, refreshWorkspaces, lastWorkspaceId } = useAppData();
  const palette = usePalette();
  const [chosen, setChosen] = useState("");
  const [picking, setPicking] = useState(false);
  const workspace = workspaces.find(item => item.id === (chosen || lastWorkspaceId)) ?? workspaces[0];
  if (workspacesLoading) return <Loading />;
  if (workspacesError) return <View style={styles.column}><Banner tone="danger" title="Unable to load workspaces" actions={<Button small label="Retry" onPress={refreshWorkspaces} />}>{workspacesError}</Banner></View>;
  if (!workspace) return <EmptyState title="No workspace yet">Create a workspace on the web, add a repository and pair a host to start your first session.</EmptyState>;
  return <>
    <View style={[styles.workspaceBar, { borderColor: palette.border }]}>
      <Text style={[ui.small, { color: palette.muted }]}>Workspace</Text>
      <Chip testID="new-workspace" icon="people-outline" label={workspace.name} disabled={workspaces.length < 2} onPress={() => setPicking(true)} />
    </View>
    {/* Keyed so host, trust and repository state never carry across workspaces. */}
    <Composer key={workspace.id} workspace={workspace} onStarted={onStarted} />
    <OptionSheet<string> visible={picking} title="Workspace" value={workspace.id} onClose={() => setPicking(false)} onSelect={setChosen}
      options={workspaces.map(item => ({ value: item.id, label: item.name, hint: item.role }))} />
  </>;
}

function Composer({ workspace, onStarted }: { workspace: Workspace; onStarted: (sessionId: string) => void }) {
  const { user, api } = useSession();
  const { refreshSessions, setLastWorkspaceId } = useAppData();
  const palette = usePalette();
  const workspacePath = `/api/workspaces/${segment(workspace.id)}`;
  const models = useResource<{ models: ModelDefinition[] }>(`${workspacePath}/models`);
  const connections = useResource<{ connectors: ConnectorInfo[] }>(`${workspacePath}/connectors`, 10_000);
  const repos = useResource<WorkspaceRepositoryList>(`${workspacePath}/repositories`);
  const [choice, setChoice] = useState("");
  const [pickingHost, setPickingHost] = useState(false);
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("workspace");
  const [trustedHost, setTrustedHost] = useState("");
  const action = useAction();

  const modelList = models.data?.models;
  const connectors = connections.data?.connectors;
  const repositories = repos.data?.repositories ?? null;
  // Until the listing says otherwise, sessions need a repository (always, except for test users on a test-mode server).
  const repositoriesRequired = repos.data?.required ?? true;
  // Hosts with a model you can use here, yours first.
  const hosts = useMemo(() => {
    const offering = new Set((modelList ?? []).map(model => model.connectorId));
    return (connectors ?? []).filter(host => offering.has(host.id) && !host.revokedAt)
      .sort((a, b) => Number(b.ownerId === user.id) - Number(a.ownerId === user.id));
  }, [connectors, modelList, user.id]);
  const host = hosts.find(item => item.id === choice) ?? hosts.find(item => item.online) ?? hosts[0];
  const hostModel = (wanted?: { provider: string; modelId: string }) => wanted && host && host.models.some(item => sameModel(item, wanted))
    ? modelList?.find(item => item.connectorId === host.id && sameModel(item, wanted)) : undefined;
  // Picks belong to one host; switching starts from that host's first model again.
  const [chat, setChat] = useState<{ key: string; value: ChatSelection } | null>(null);
  const initialModel = host?.models.map(item => hostModel(item)).find(Boolean);
  // The level the host's Pi starts that model at, as the session itself will.
  const initialLevel = initialModel && host?.models.find(item => sameModel(item, initialModel))?.thinkingLevel;
  const selection: ChatSelection = host && chat?.key === host.id ? chat.value
    : { model: initialModel && { provider: initialModel.provider, modelId: initialModel.modelId }, thinkingLevel: initialLevel, access: "auto" };
  const model = hostModel(selection.model);
  const foreign = Boolean(host && host.ownerId !== user.id);
  const availableModel = Boolean(model && host?.models.some(item => sameModel(item, model)));
  const available = Boolean(host?.online && !host.revokedAt && availableModel && (host.ownerId === user.id || host.workspaceIds.includes(workspace.id)));
  const repositoriesReady = Boolean(repositories && !repos.error && !repos.loading && (repositories.length || !repositoriesRequired));
  const trusted = !foreign || Boolean(host && trustedHost === host.id);
  const canStart = Boolean(model && host && available && repositoriesReady && trusted && !action.busy);

  // A trust acknowledgement covers one host against one repository set.
  useEffect(() => { setTrustedHost(""); }, [host?.id, host?.ownerId, repositories]);

  function start() {
    if (!canStart || !model || !host) return;
    const message = content.trim();
    const options = chatOptionsBody(host, selection, "submit");
    void action.run(async () => {
      const result = await api<{ session: SessionRecord }>("/api/sessions", { method: "POST", body: {
        workspaceId: workspace.id, modelId: model.id, title: deriveTitle(content, model.name), visibility, ...(foreign ? { trustedConnectorId: host.id } : {}),
      } });
      const sessionId = result.session.id;
      setLastWorkspaceId(workspace.id);
      if (message) {
        try {
          await api(`/api/sessions/${segment(sessionId)}/submit`, { method: "POST", body: { content: message, requestId: Crypto.randomUUID(), ...(options ? { options } : {}) } });
        } catch {
          // The session exists; keep the unsent text for its chat box instead of failing the start.
          saveDraft(sessionId, message);
        }
      }
      refreshSessions();
      onStarted(sessionId);
    });
  }

  const loading = models.loading || connections.loading;
  function blockingAlert() {
    if (repos.error) return <Banner tone="warning" title="Unable to load repositories" actions={<Button small label="Retry" onPress={repos.refresh} />}>{repos.error}</Banner>;
    if (repositories && !repositories.length && repositoriesRequired) return <Banner tone="warning" title="No repositories in this workspace">Sessions need at least one repository. Workspace owners and admins can bind one in workspace settings on the web.</Banner>;
    if (models.error) return <Banner tone="danger" title="Unable to load models" actions={<Button small label="Retry" onPress={models.refresh} />}>{models.error}</Banner>;
    const refreshHost = <Button small label="Refresh host status" onPress={connections.refresh} />;
    if (connections.error) return <Banner tone="warning" title="Unable to check host" actions={refreshHost}>{connections.error}</Banner>;
    if (loading || !modelList || !connectors) return null;
    if (!hosts.length) return <Banner tone="info" title="No host to chat with yet">Pair your own Pi to chat with its models, or ask a workspace member to share their host here.</Banner>;
    if (!host) return null;
    if (!model) return <Banner tone="warning" title={`No model on ${host.name}`} actions={refreshHost}>{`${host.name} offers no model you can use in this workspace.`}</Banner>;
    if (!availableModel) return <Banner tone="warning" title="Model no longer offered" actions={refreshHost}>{`This model is no longer offered by ${host.name}. Ask the host owner to restore it; no substitute will be chosen.`}</Banner>;
    if (!available) return <Banner tone="warning" title={`${host.name} is unavailable`} actions={refreshHost}>{host.revokedAt ? "This host was revoked." : !host.online ? "It must reconnect before work can run." : "This host isn't shared with this workspace."}</Banner>;
    if (foreign) return <Banner tone="warning" title={`Hosted by ${host.ownerName}`}>
      <Pressable testID="new-trust" accessibilityRole="switch" accessibilityState={{ checked: trustedHost === host.id }} disabled={action.busy}
        onPress={() => setTrustedHost(trustedHost === host.id ? "" : host.id)} style={styles.trust}>
        <Switch value={trustedHost === host.id} disabled={action.busy} onValueChange={checked => setTrustedHost(checked ? host.id : "")} />
        <Text style={[styles.trustText, { color: palette.text }]}>
          I trust {host.ownerName}'s host ({host.name}) to process this session's prompts and repository files, including private repository snapshots; its operator can read them. Repository access uses my GitHub identity, not the host owner's or a workspace admin's. I remain the session owner.
        </Text>
      </Pressable>
    </Banner>;
    return null;
  }

  const hostState = (item: ConnectorInfo) => item.revokedAt ? "Revoked" : !item.online ? "Offline" : item.capabilities.unsandboxed ? "Unsandboxed"
    : !item.capabilities.sandbox ? "Sandbox unverified" : "Online";
  return <ScrollView contentContainerStyle={styles.column} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
    <Text style={[styles.title, { color: palette.text }]}>What should we work on?</Text>
    <TextInput testID="new-message" value={content} onChangeText={setContent} multiline editable={!action.busy} placeholder="Describe the task (optional)"
      placeholderTextColor={palette.muted} accessibilityLabel="First message"
      style={[styles.input, { backgroundColor: palette.surface, borderColor: palette.border, color: palette.text }]} />
    <View style={ui.inline}>
      <Chip testID="new-host" icon="server-outline" label={host ? host.name : loading ? "Loading..." : "No host"} disabled={hosts.length < 2 || action.busy} onPress={() => setPickingHost(true)} />
      <ChatOptionsBar host={host} value={selection} onChange={value => host && setChat({ key: host.id, value })} owner showAccess unsandboxed={Boolean(host?.capabilities.unsandboxed)} />
    </View>
    <View style={[styles.segments, { borderColor: palette.border }]} accessibilityRole="tablist">
      {(["workspace", "private"] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: visibility === item }} onPress={() => setVisibility(item)}
        style={[styles.segment, visibility === item && { backgroundColor: palette.selection }]}>
        <Text style={[styles.segmentText, { color: visibility === item ? palette.text : palette.muted }]}>{item === "workspace" ? "Workspace" : "Private"}</Text>
      </Pressable>)}
    </View>
    <Text style={[ui.small, { color: palette.muted }]}>
      {visibility === "workspace" ? "Workspace members can view prompts, output, tool results, and repository content shown in the transcript. Asking the agent, invoking tools, or controlling the session needs an explicit grant." : "Workspace membership alone does not give access to a private session; only explicit session grants do."}
    </Text>
    {blockingAlert()}
    {host?.capabilities.unsandboxed && <Banner tone="danger" title="Unsandboxed host">Agent work runs directly on the owner's machine without isolation: approved commands and commits run as their user, with access to their files, credentials and network, and no resource limits.</Banner>}
    {host && model && <Text style={[ui.small, { color: palette.muted }]}>
      {hostState(host)} · {host.name} · {model.name} · {foreign ? `Hosted by ${host.ownerName}` : "Your host"}, {host.workspaceIds.includes(workspace.id) ? "shared with this workspace" : "private"}
      {repositories?.length ? ` · ${repositories.length === 1 ? "1 repository" : `${repositories.length} repositories`}` : ""}
    </Text>}
    <Feedback error={action.error} />
    <Button testID="new-start" variant="primary" icon="arrow-up" label="Start session" busy={action.busy} disabled={!canStart} onPress={start} />
    {action.busy && <Text style={[ui.small, { color: palette.muted }]} accessibilityLiveRegion="polite">Resolving repository commits and downloading snapshots to the Pi host's private session cache. The agent starts once every repository is ready.</Text>}
    <OptionSheet<string> visible={pickingHost} title="Host" value={host?.id} onClose={() => setPickingHost(false)} onSelect={setChoice}
      options={hosts.map(item => ({ value: item.id, label: item.name, hint: `${item.ownerId === user.id ? "Your host" : `${item.ownerName}'s host`} · ${hostState(item)}` }))} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  workspaceBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  column: { gap: 12, padding: 20, width: "100%", maxWidth: 680, alignSelf: "center" },
  title: { fontSize: 24, fontWeight: "700" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, fontSize: 16, minHeight: 96, textAlignVertical: "top" },
  segments: { flexDirection: "row", alignSelf: "flex-start", borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, overflow: "hidden" },
  segment: { paddingHorizontal: 14, paddingVertical: 7 },
  segmentText: { fontSize: 13, fontWeight: "600" },
  trust: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  trustText: { flex: 1, fontSize: 14, lineHeight: 20 },
});
