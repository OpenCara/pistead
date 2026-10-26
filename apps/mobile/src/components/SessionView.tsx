import {
  accessUnavailable, activeStatuses, chatOptionsBody, decidesHostCommands, HOST_COMMAND_WAITING, initialSelection, isHostCommand, modelUnavailable,
  mustConfirmAutoApprove, preparingRepositories, segment, type ChatSelection,
} from "@pistead/client";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { Stack } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import { redactSecrets, REDACTED } from "../../../../packages/shared/src/redaction";
// Brings in `SessionRecord.linkShared`, which link sharing declares there.
import type {} from "../../../../packages/shared/src/sharing";
import type { ApprovalRecord, SessionRecord, SessionView as LiveView, SubmitResult, UserProfile } from "../../../../packages/shared/src/types";
import { useAppData } from "../lib/app-data";
import { useSession } from "../lib/auth";
import { saveDraft, takeDraft } from "../lib/drafts";
import { useKeyboardVisible, useOpenSession } from "../lib/layout";
import { useLiveSession } from "../lib/live-session";
import { PeopleProvider, useUsername, useWorkspacePeople } from "../lib/people";
import { useAction, useResource } from "../lib/resource";
import { usePalette } from "../theme";
import { ApprovalCard } from "./ApprovalCard";
import { ChatOptionsBar, useConfirmAutoApprove } from "./ChatOptionsBar";
import { Composer } from "./Composer";
import { RepositoryPreparationCard } from "./RepositoryPreparation";
import { TranscriptEntry } from "./TranscriptEntry";
import { Badge, Banner, Button, Chip, EmptyState, Feedback, IconButton, Loading, OptionSheet, styles as ui } from "./ui";

/**
 * One session: live transcript, pending approvals and the chat box. `embedded` renders its own title bar (the wide
 * layout's detail pane); otherwise it configures the stack screen's header. Remount per session id (key) so drafts,
 * request IDs and picks never leak between sessions.
 */
export function SessionView({ id, embedded }: { id: string; embedded: boolean }) {
  const { user, api } = useSession();
  const { sessions, workspaces, refreshSessions, setLiveActivity } = useAppData();
  const palette = usePalette();
  const headerHeight = useHeaderHeight();
  const live = useLiveSession(id);
  const { session, view } = live;
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const permissions = session?.permissions ?? [];
  // Archived sessions are read-only on the server; don't offer decisions that would be refused.
  // Archived sessions, and sessions that pinned their repositories when they started, are read-only on the server.
  const archived = session?.status === "archived";
  const readOnly = archived || session?.frozen === true;
  const canApprove = permissions.includes("approve") && !readOnly;
  const isOwner = session?.ownerId === user.id;
  const hosts = useResource<{ connectors: ConnectorInfo[] }>(session?.connectorId ? `/api/workspaces/${segment(session.workspaceId)}/connectors` : null, 10_000);
  const host = hosts.data?.connectors.find(item => item.id === session?.connectorId);
  const hostOnline = host?.online;
  const previousHostOnline = useRef(hostOnline);
  useEffect(() => {
    // A host that reconnects would otherwise wait out the live-update backoff (up to a minute).
    if (previousHostOnline.current === false && hostOnline) live.refresh();
    previousHostOnline.current = hostOnline;
  }, [hostOnline, live.refresh]);
  const action = useAction();
  const approvalAction = useAction();
  const openSession = useOpenSession();

  const known = session ?? sessions.find(item => item.id === id);
  // Everyone a session names (owner, host owner, writers, approvers) is or was a member of its workspace.
  const people = useWorkspacePeople(known?.workspaceId ?? null);
  const title = known?.title ?? "Session";
  const workspaceName = known && workspaces.find(workspace => workspace.id === known.workspaceId)?.name;
  const approvals = view?.approvals ?? [];
  const pendingCount = approvals.filter(approval => approval.status === "pending").length;

  // Session lists show what this live view shows, not what they last fetched.
  const viewActivity = view?.activity;
  useEffect(() => { setLiveActivity(viewActivity ? { sessionId: id, activity: viewActivity } : null); }, [id, viewActivity, setLiveActivity]);
  useEffect(() => () => { setLiveActivity(null); refreshSessions(); }, [setLiveActivity, refreshSessions]);

  /** `scope` answers a permission request: allow the one call, or the same need for the rest of the session. */
  async function decide(approval: ApprovalRecord, decision: "approve" | "deny", scope?: "call" | "session") {
    if (!canApprove || approvalAction.busy || !approval.reviewHash || approval.status !== "pending") return;
    // The card is the prompt: it shows the exact operation, who it runs as, its resource limits and any unsandboxed-host warning, so a tap decides at once.
    const notice = approval.operation.kind === "permission"
      ? decision === "deny" ? "Not allowed" : scope === "session" ? "Allowed for the rest of the session" : "Allowed for this call"
      : decision === "approve" ? "Approval decision recorded" : "Operation denied";
    await approvalAction.run(async () => {
      await api(`/api/sessions/${segment(id)}/approvals/${segment(approval.id)}`, { method: "POST", body: { decision, reviewHash: approval.reviewHash, ...(scope ? { scope } : {}) } });
      live.refresh();
    }, notice);
  }

  function unarchive() {
    void action.run(async () => {
      await api(`/api/sessions/${segment(id)}/unarchive`, { method: "POST" });
      live.refresh();
      refreshSessions();
    }, "Session unarchived");
  }

  function copyId() {
    void action.run(async () => { await Clipboard.setStringAsync(id); }, "Session ID copied");
  }

  // A failed start explains itself in the conversation area, where the chat box restarts it.
  const startFailed = !view && Boolean(session && (session.status === "error" || session.status === "provisioning"));
  const badge = archived ? <Badge>Archived</Badge>
    : startFailed ? <Badge tone={session?.status === "error" ? "danger" : "running"} dot>{session?.status === "error" ? "Not started" : "Starting"}</Badge>
    : !view && live.error ? <Badge tone="warning" dot>Unavailable</Badge>
    : live.status === "online" ? <Badge tone="success" dot>Live</Badge>
    : live.status === "reconnecting" ? <Badge tone="warning" dot>Reconnecting</Badge>
    : live.status === "offline" ? <Badge tone="danger" dot>Disconnected</Badge>
    : <Badge dot>Connecting</Badge>;
  const headerActions = <View style={styles.headerActions}>
    <IconButton testID="session-approvals" icon="shield-checkmark-outline" label={pendingCount ? `Approvals, ${pendingCount} pending` : "Approvals"} badge={pendingCount} onPress={() => setApprovalsOpen(true)} disabled={!view} />
    <IconButton icon="copy-outline" label="Copy session ID" onPress={copyId} />
  </View>;

  const pendingApprovalCard = (approval: ApprovalRecord) => {
    const permission = approval.operation.kind === "permission";
    // Only the session owner can let a call do more than the session allows. A host command, as every command of a
    // session that runs on its host is, is decided by its host's owner or a member granted host commands.
    const hostCommand = isHostCommand(approval.operation, session ?? {});
    const ownerOnly = permission || approval.operation.kind === "git.repin";
    const decides = canApprove && (hostCommand ? decidesHostCommands(session ?? {}, host, user.id) : !ownerOnly || isOwner);
    const disabled = approvalAction.busy || !approval.reviewHash;
    return <ApprovalCard approval={approval} key={approval.id}>
      {decides ? <>
        {!approval.reviewHash && <Banner tone="warning" title="No verified review commitment" actions={<Button small label="Refresh approval" disabled={approvalAction.busy} onPress={live.refresh} />}>
          Refresh before deciding; the server must bind the displayed operation and requester.
        </Banner>}
        {permission ? <View style={ui.inline}>
          <Button small variant="primary" label="Allow once" disabled={disabled} onPress={() => void decide(approval, "approve", "call")} />
          {/* Each host command asks again: it runs outside the sandbox. */}
          {!(approval.operation.kind === "permission" && approval.operation.tool === "host_bash") && <Button small label="Allow for this session" disabled={disabled} onPress={() => void decide(approval, "approve", "session")} />}
          <Button small label="Deny" disabled={disabled} onPress={() => void decide(approval, "deny")} />
        </View> : <>
          <View style={ui.inline}>
            <Button testID="approval-approve" small variant="primary" label="Approve" disabled={disabled} onPress={() => void decide(approval, "approve")} />
            <Button testID="approval-deny" small label="Deny" disabled={disabled} onPress={() => void decide(approval, "deny")} />
          </View>
          <Text testID="approval-hint" style={[ui.small, { color: palette.muted }]}>
            Runs as {hostCommand ? "the host OS user (outside the sandbox)" : view?.owner.displayName} · each approval covers one exact operation and its arguments
          </Text>
        </>}
      </> : <Text style={[ui.small, { color: palette.muted }]}>
        {hostCommand ? HOST_COMMAND_WAITING : ownerOnly ? "Waiting for the session owner" : "Waiting for an authorized approver"}
      </Text>}
    </ApprovalCard>;
  };

  return <PeopleProvider people={people}><KeyboardAvoidingView style={[ui.flex, { backgroundColor: palette.background }]} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={headerHeight}>
    {embedded ? <View style={[styles.paneHeader, { borderColor: palette.border, backgroundColor: palette.surface }]}>
      <Text style={[styles.paneTitle, { color: palette.text }]} numberOfLines={1}>{title}</Text>
      {headerActions}
    </View> : <Stack.Screen options={{ title, headerRight: () => headerActions }} />}
    {session && <View style={[styles.strip, { borderColor: palette.border }]}>
      {workspaceName && <Text style={[ui.small, { color: palette.muted }]} numberOfLines={1}>{workspaceName}</Text>}
      {badge}
      <Badge>{session.visibility === "workspace" ? "Workspace-visible" : "Private"}</Badge>
      {session.linkShared && <Badge tone="info">Link shared</Badge>}
      {host && !host.online && <Badge tone="warning" dot>Host offline</Badge>}
      <SessionPeople session={session} host={host} />
    </View>}
    {(archived || (live.error && !startFailed) || action.error || action.notice) && <View style={styles.alerts}>
      {archived && <Banner title="Archived" actions={isOwner && <Button small label="Unarchive" disabled={action.busy} onPress={unarchive} />}>
        {`This session is read-only. ${isOwner ? "Unarchive it to continue the work." : "Only its owner can unarchive it."}`}
      </Banner>}
      {live.error && !startFailed && <Banner tone="danger" title={session ? "Live updates interrupted" : "Unable to open session"} actions={<Button small label="Reconnect and check access" onPress={live.reconnect} />}>
        {live.error}
      </Banner>}
      <Feedback error={action.error} notice={action.notice} />
    </View>}
    {!view ? (!live.error ? <Loading />
      : session ? <UnavailableConversation id={id} user={user} session={session} error={live.error} recovered={() => { live.reconnect(); refreshSessions(); }} />
      : <View style={ui.flex} />)
      : session && <Conversation id={id} user={user} session={session} view={view} host={host} stale={Boolean(live.error)} refresh={live.refresh}
        pinned={<>
          {view.repositories && <RepositoryPreparationCard sessionId={id} preparation={view.repositories}
            canRestart={isOwner && !archived && permissions.includes("manage")} onRestarted={() => { live.refresh(); refreshSessions(); }} />}
          {session.hostUnsandboxed && (permissions.includes("write") || canApprove) && (session.hostEnvironment
            ? <Banner tone="danger" title="Runs on the host">
              This session runs directly on its host, without the sandbox. Approved commands and commits execute on the host owner's machine with their full user permissions, network access and no resource limits; only the host owner, or members they granted host commands, decide them.
            </Banner>
            : <Banner tone="danger" title="Unsandboxed host">
              This session's host runs without a sandbox. Approved commands and commits execute directly on the host owner's machine with their full user permissions, network access and no resource limits.
            </Banner>)}
          {approvals.filter(approval => approval.status === "pending").map(pendingApprovalCard)}
          <Feedback error={approvalAction.error} notice={approvalAction.notice} />
        </>} />}
    <ApprovalsSheet visible={approvalsOpen} approvals={approvals} olderApprovals={view?.olderApprovals} onClose={() => setApprovalsOpen(false)}
      onOpenSession={target => { refreshSessions(); openSession(target); }} />
  </KeyboardAvoidingView></PeopleProvider>;
}

/** Who the work runs as and whose machine it runs on, as the web's session panel names them. */
function SessionPeople({ session, host }: { session: SessionRecord; host: ConnectorInfo | undefined }) {
  const { user } = useSession();
  const palette = usePalette();
  const name = useUsername();
  const hostOwner = host?.ownerName ?? (session.connectorOwnerId ? name(session.connectorOwnerId) : "unknown");
  return <Text testID="session-people" style={[ui.small, styles.stripLine, { color: palette.muted }]} numberOfLines={2}>
    Owned by {name(session.ownerId, true)}
    {session.connectorId ? ` · ${host?.name ?? "Pinned host"}, hosted by ${hostOwner}${session.connectorOwnerId === user.id ? " (you)" : ""}` : " · Operator-managed session"}
  </Text>;
}

/** Commands auto-approve ran have no card; the transcript marks their calls. */
const AUTO_APPROVED_NOTE = "Commands that ran under auto-approve are marked on their tool calls in the conversation.";

/**
 * Every approval of the session, pending first, with what each decided one did. On iOS a repinned session opens once
 * the sheet has gone, so the navigation is not hidden behind (or dropped by) the closing modal.
 */
function ApprovalsSheet({ visible, approvals, olderApprovals, onClose, onOpenSession }: { visible: boolean; approvals: ApprovalRecord[]; olderApprovals?: number; onClose: () => void; onOpenSession: (id: string) => void }) {
  const palette = usePalette();
  const opening = useRef<string | null>(null);
  const sorted = [...approvals].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  function open(target: string) {
    onClose();
    if (Platform.OS === "ios") opening.current = target;
    else onOpenSession(target);
  }
  function dismissed() {
    const target = opening.current;
    opening.current = null;
    if (target) onOpenSession(target);
  }
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} onDismiss={dismissed}>
    <View style={[ui.flex, { backgroundColor: palette.background }]}>
      <View style={[styles.paneHeader, { borderColor: palette.border, backgroundColor: palette.surface }]}>
        <Text style={[styles.paneTitle, { color: palette.text }]}>Approvals</Text>
        <Button small variant="ghost" label="Done" onPress={onClose} />
      </View>
      {sorted.length ? <ScrollView contentContainerStyle={styles.sheetList}>
        {sorted.map(approval => <ApprovalCard key={approval.id} approval={approval} onOpenSession={open} />)}
        {!!olderApprovals && <Text style={[ui.small, { color: palette.muted }]}>{`${olderApprovals} older settled ${olderApprovals === 1 ? "approval isn't" : "approvals aren't"} listed. ${AUTO_APPROVED_NOTE}`}</Text>}
      </ScrollView> : <EmptyState title="No approvals">{`Commands, commits, pushes and GitHub actions that need a decision appear here. ${AUTO_APPROVED_NOTE}`}</EmptyState>}
    </View>
  </Modal>;
}

function Conversation({ id, user, session, view, host, stale, refresh, pinned }: {
  id: string; user: UserProfile; session: SessionRecord; view: LiveView; host: ConnectorInfo | undefined; stale: boolean; refresh: () => void; pinned: ReactNode;
}) {
  const { api } = useSession();
  const { rememberChat, autoApproveConfirmed } = useAppData();
  const confirmAutoApprove = useConfirmAutoApprove();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const owner = session.ownerId === user.id;
  // Initialised once per session (the view remounts per id); view refreshes never reset the user's picks.
  const [selection, setSelection] = useState<ChatSelection>(() => initialSelection(view, owner));
  const [mode, setMode] = useState<"write" | "ask">("write");
  // A first message that failed to send from the new-session screen is handed over here.
  const [content, setContent] = useState(() => takeDraft(id));
  const [conversationId, setConversationId] = useState("");
  const [pickingConversation, setPickingConversation] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  // Set while the owner decides on Auto-approve, so a second tap can't send the message twice.
  const confirming = useRef(false);
  const submission = useAction();
  const stopping = useAction();
  const [receipt, setReceipt] = useState<SubmitResult | null>(null);
  const list = useRef<FlatList>(null);
  const stick = useRef(true);
  const permissions = session.permissions ?? [];
  const canWrite = permissions.includes("write");
  const canAsk = permissions.includes("ask");
  const actualMode = mode === "ask" && !canAsk ? "write" : mode;
  const readOnly = session.status === "archived" || session.frozen === true;
  const permitted = !readOnly && (actualMode === "write" ? canWrite : canAsk);
  const unsandboxed = Boolean(session.hostUnsandboxed || host?.capabilities.unsandboxed);
  const queue = view.queue ?? [];
  const activeQueue = queue.filter(item => activeStatuses.includes(item.status));
  const recentSubmissions = queue.filter(item => !activeStatuses.includes(item.status)).slice(-5).reverse();
  // Stopping takes the running message and everything queued; hosts that predate it don't offer it.
  const canStop = Boolean(view.stoppable) && session.status !== "archived" && canWrite && activeQueue.length > 0;
  const stopPending = queue.some(item => item.status === "stopping");
  const conversations = view.conversations;
  const sideConversations = conversations.filter(item => item.mode === "ask" && (!item.actorId || item.actorId === user.id));
  const entries = view.entries.filter(entry => {
    if (entry.role === "system" && !entry.text.trim()) return false;
    const conversation = conversations.find(item => item.id === entry.conversationId);
    if (actualMode === "ask") return conversation?.mode === "ask" && (!conversation.actorId || conversation.actorId === user.id) && (!conversationId || entry.conversationId === conversationId);
    return conversation?.mode !== "ask";
  });

  // FlatList's own scrollToEnd measures the footer from a layout event that can arrive after the content grew, which
  // leaves a new approval card (in the footer) below the fold; the native scroll view knows the real content end.
  const toEnd = useCallback(() => list.current?.getNativeScrollRef()?.scrollToEnd({ animated: false }), []);

  // Switching conversations starts at their newest entry.
  useEffect(() => {
    stick.current = true;
    toEnd();
  }, [actualMode, conversationId, toEnd]);

  // Follow new entries unless the reader has scrolled up. Only the reader's own scrolling decides: scroll events that
  // growing content produces would otherwise report "scrolled up" just before the list should follow.
  const onScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
  }, []);

  async function submit() {
    if (!permitted || !content.trim() || submission.busy || confirming.current) return;
    const options = chatOptionsBody(host, selection, actualMode === "ask" ? "ask" : "submit");
    const unavailable = accessUnavailable(host, selection, actualMode === "ask" ? "ask" : "submit") ?? modelUnavailable(host, selection);
    // The owner's chat box can start on Auto-approve without asking, and it merges too: the first message that would asks
    // first, unless it can't be sent anyway.
    if (!unavailable && host && mustConfirmAutoApprove(options, autoApproveConfirmed)) {
      confirming.current = true;
      const confirmed = await confirmAutoApprove(host, unsandboxed).finally(() => { confirming.current = false; });
      // Declined, the chat box asks before acting instead, and nothing is sent until the owner sends again.
      if (!confirmed) { setSelection(current => ({ ...current, access: "approval" })); return; }
    }
    setReceipt(null);
    const sent = content;
    // Changing the options is a different request, so it needs a new idempotency key.
    const key = `${actualMode}:${JSON.stringify(options ?? null)}:${sent}`;
    // Retry the same failed submission with the same idempotency key, not a duplicate turn.
    if (request.current?.key !== key) request.current = { key, id: Crypto.randomUUID() };
    const requestId = request.current.id;
    stick.current = true;
    void submission.run(async () => {
      if (unavailable) throw new Error(unavailable);
      const result = await api<SubmitResult>(`/api/sessions/${segment(id)}/${actualMode === "ask" ? "ask" : "submit"}`, { method: "POST", body: { content: sent, requestId, ...(options ? { options } : {}) } });
      setReceipt(result);
      // The next new chat starts from the model and reasoning this one went with, the session's own where none was picked.
      if (options) rememberChat(host, selection, view.agent);
      if (actualMode === "ask") setConversationId(result.conversationId);
      setContent(current => current === sent ? "" : current);
      request.current = null;
      refresh();
    });
  }

  function stop() {
    if (!canStop || stopping.busy) return;
    void stopping.run(async () => {
      await api(`/api/sessions/${segment(id)}/stop`, { method: "POST", body: {} });
      refresh();
    });
  }

  // The transcript hides secrets from everyone, but the agent and its host receive the message as typed.
  const draftHasSecret = Boolean(content.trim()) && redactSecrets(content) !== content;

  const queued = activeQueue.length > 0 ? ` · ${activeQueue.length} queued` : "";
  const queueLabel = preparingRepositories(view) ? `Preparing repositories...${queued}`
    : stopPending ? `Stopping...${queued}`
    // A call waiting on a card holds its message until someone decides.
    : view.busy ? `${view.activity === "waiting" ? "Waiting for a decision" : "Working"}...${queued}`
    : activeQueue.length ? `${activeQueue.length} queued` : "Idle";
  const name = useUsername();
  const sideIndex = sideConversations.findIndex(item => item.id === conversationId);

  return <>
    <FlatList ref={list} style={ui.flex} data={entries} keyExtractor={entry => entry.id}
      contentContainerStyle={[styles.transcript, !entries.length && styles.grow]}
      renderItem={({ item }) => <TranscriptEntry entry={item} userId={user.id} />}
      ItemSeparatorComponent={Separator}
      ListEmptyComponent={<EmptyState title={actualMode === "ask" ? "A question on the side" : "The conversation begins here"}>
        {actualMode === "ask" ? "Ask about the work without changing it" : "Committed messages and tool results will appear here"}
      </EmptyState>}
      ListFooterComponent={<View style={styles.pinned}>{pinned}</View>}
      onScrollEndDrag={onScrollEnd} onMomentumScrollEnd={onScrollEnd} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => { if (stick.current) toEnd(); }}
      // The chat box below grows and shrinks (hints, chat options, the keyboard); the newest entry stays in view.
      onLayout={() => { if (stick.current) toEnd(); }}
      accessibilityLabel={actualMode === "ask" ? "Side ask history" : "Shared session history"} />
    <View style={[styles.bottom, { borderColor: palette.border, backgroundColor: palette.background, paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 8) }]}>
      <Pressable testID="queue-line" accessibilityRole="button" accessibilityState={{ expanded: queueOpen }} onPress={() => setQueueOpen(value => !value)} style={styles.queueLine}>
        <Text style={[ui.small, { color: palette.muted }]} accessibilityLiveRegion="polite">{queueLabel}</Text>
        <Text style={[ui.small, { color: palette.muted }]}>{queueOpen ? "Hide" : "Details"}</Text>
      </Pressable>
      {queueOpen && <View style={styles.queueDetail}>
        <Text style={[ui.small, { color: palette.muted }]}>Submissions and side asks share one queue; permissions are checked again before work runs. You can leave this screen: accepted work continues while the host is online and authorized.</Text>
        {stale && <Text style={[ui.small, { color: palette.text }]}>This is the last received queue view; live host status is not confirmed.</Text>}
        {receipt && <Text style={[ui.small, { color: palette.text }]}>Last receipt {receipt.submissionId} · {receipt.status}{receipt.queuePosition !== undefined ? ` · queue position ${receipt.queuePosition}` : ""}</Text>}
        {activeQueue.map((item, index) => <Text key={item.submissionId} style={[ui.small, { color: palette.text }]}>
          {index + 1}. {item.mode === "ask" ? "Read-only side ask" : "Shared submission"} · {item.status} · by {name(item.actorId, true)}
        </Text>)}
        {recentSubmissions.map(item => <Text key={item.submissionId} style={[ui.small, { color: palette.muted }]}>
          {item.status} · {item.mode === "ask" ? "Side ask" : "Shared submission"} · by {name(item.actorId, true)}
        </Text>)}
        <View style={ui.inline}><Button small icon="refresh" label="Refresh queue" onPress={refresh} /></View>
      </View>}
      <Composer value={content} onChange={setContent} onSubmit={submit} busy={submission.busy} disabled={!permitted}
        onStop={canStop ? stop : undefined} stopping={stopping.busy}
        placeholder={!permitted ? "Read-only" : actualMode === "ask" ? "Ask without changing anything" : "Message the agent"}
        sendLabel={actualMode === "ask" ? "Send side ask" : "Submit to session"}
        hint={session.status === "archived" ? "Read-only · this session is archived" : session.frozen ? "Read-only · this session pinned its repositories when it started" : !permitted ? (canAsk ? "Read-only · switch to Side ask to ask questions" : "Read-only · submitting needs write permission")
          : actualMode === "ask" ? "Read-only · anyone who can view this session can see side asks"
          : `Runs as ${view.owner.displayName}${view.owner.id === user.id ? " (you)" : ""}`}
        tools={(canAsk || permitted) && <>
          {canAsk && <View style={[styles.segments, { borderColor: palette.border }]} accessibilityRole="tablist">
            {(["write", "ask"] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: actualMode === item }} onPress={() => setMode(item)}
              style={[styles.segment, actualMode === item && { backgroundColor: palette.selection }]}>
              <Text style={[styles.segmentText, { color: actualMode === item ? palette.text : palette.muted }]}>{item === "write" ? "Shared" : "Side ask"}</Text>
            </Pressable>)}
          </View>}
          {actualMode === "ask" && sideConversations.length > 0 && <Chip label={sideIndex < 0 ? "All my side asks" : `Side ask ${sideIndex + 1}`} onPress={() => setPickingConversation(true)} />}
          {permitted && <ChatOptionsBar host={host} value={selection} onChange={setSelection} owner={owner} showAccess={actualMode === "write"} unsandboxed={unsandboxed} />}
        </>} />
      {draftHasSecret && <Text testID="draft-secret" style={[ui.small, { color: palette.muted }]} accessibilityLiveRegion="polite">
        This message looks like it holds a secret. Everyone, you included, sees it as {REDACTED} in the transcript, but the agent and its host receive it as typed.
      </Text>}
      <Feedback error={submission.error || stopping.error} />
    </View>
    <OptionSheet<string> visible={pickingConversation} title="Side conversation" value={conversationId} onClose={() => setPickingConversation(false)} onSelect={setConversationId}
      options={[{ value: "", label: "All my side asks" }, ...sideConversations.map((conversation, index) => ({ value: conversation.id, label: `Side ask ${index + 1}`, hint: conversation.id.slice(0, 8) }))]} />
  </>;
}

function Separator() {
  return <View style={styles.separator} />;
}

/**
 * Shown when the transcript cannot load. A session whose start failed is restarted by its owner's next message:
 * restart re-provisions on the pinned host, then the message is submitted.
 */
function UnavailableConversation({ id, user, session, error, recovered }: { id: string; user: UserProfile; session: SessionRecord; error: string; recovered: () => void }) {
  const { api } = useSession();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const [content, setContent] = useState("");
  const request = useRef<{ content: string; id: string } | null>(null);
  const action = useAction();
  const failed = session.status === "error" || session.status === "provisioning";
  const canRestart = failed && session.ownerId === user.id && Boolean(session.permissions?.includes("manage"));
  const canWrite = Boolean(session.permissions?.includes("write"));
  function send() {
    const sent = content;
    // Same text retried after a failure keeps its idempotency key.
    if (request.current?.content !== sent) request.current = { content: sent, id: Crypto.randomUUID() };
    const requestId = request.current.id;
    void action.run(async () => {
      await api(`/api/sessions/${segment(id)}/restart`, { method: "POST" });
      try {
        await api<SubmitResult>(`/api/sessions/${segment(id)}/submit`, { method: "POST", body: { content: sent, requestId } });
      } catch (reason) {
        // The session is running again; hand the unsent text to the live conversation.
        saveDraft(id, sent);
        recovered();
        throw reason;
      }
      request.current = null;
      setContent("");
      recovered();
    });
  }
  const title = session.status === "error" ? "This session didn't start" : session.status === "provisioning" ? "This session is still starting" : "This session can't be reached";
  const body = canRestart ? "Send a message to start it again on its host. Your message runs once it's ready."
    : failed ? "Only the session owner can start it again."
    : canWrite ? "Messages can be sent once the host is back online."
    : "The conversation appears once the host is back online.";
  return <>
    <ScrollView style={ui.flex} contentContainerStyle={styles.grow} keyboardDismissMode="interactive">
      <EmptyState title={title}>
        <Text style={[styles.centered, { color: palette.muted }]}>{body}</Text>
        {failed && error ? <Text style={[ui.small, styles.centered, { color: palette.muted }]}>{error}</Text> : null}
      </EmptyState>
    </ScrollView>
    <View style={[styles.bottom, { borderColor: palette.border, paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 8) }]}>
      <Composer value={content} onChange={setContent} onSubmit={send} busy={action.busy} disabled={!canRestart}
        placeholder={canRestart ? "Message the agent to start the session again" : "Message the agent"}
        sendLabel={canRestart ? "Restart and send" : "Sending is unavailable"}
        hint={action.busy ? "Starting the session and preparing repositories..." : canRestart ? "Restarts the session, then sends" : failed ? "Only the owner can restart this session" : canWrite ? "Waiting for the host" : "Read-only — submitting needs write permission"} />
      <Feedback error={action.error} />
    </View>
  </>;
}

const styles = StyleSheet.create({
  paneHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 52 },
  paneTitle: { flex: 1, fontSize: 17, fontWeight: "700" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  strip: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  stripLine: { width: "100%" },
  alerts: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  transcript: { padding: 16, width: "100%", maxWidth: 820, alignSelf: "center" },
  grow: { flexGrow: 1 },
  separator: { height: 14 },
  pinned: { gap: 10, paddingTop: 14 },
  bottom: { gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, width: "100%", maxWidth: 820, alignSelf: "center" },
  queueLine: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 },
  queueDetail: { gap: 6, paddingHorizontal: 4 },
  segments: { flexDirection: "row", borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, overflow: "hidden" },
  segment: { paddingHorizontal: 12, paddingVertical: 6 },
  segmentText: { fontSize: 13, fontWeight: "600" },
  centered: { textAlign: "center" },
  sheetList: { gap: 12, padding: 16 },
});
