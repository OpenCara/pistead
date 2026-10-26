import Ionicons from "@expo/vector-icons/Ionicons";
import { sessionStatus } from "@pistead/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import type { SessionRecord } from "../../../../packages/shared/src/types";
import { useAppData } from "../lib/app-data";
import { useSession } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { usePalette } from "../theme";
import { Banner, Button, EmptyState, Loading, styles as ui } from "./ui";

/** Sessions grouped by workspace, newest first; archived ones only on request. `selectedId` highlights the open one. */
export function SessionList({ selectedId, onOpen, onNew }: { selectedId?: string; onOpen: (id: string) => void; onNew: () => void }) {
  const { user } = useSession();
  const { sessions, sessionsLoading, sessionsReloading, sessionsError, refreshSessions, workspaces, refreshWorkspaces, liveActivity } = useAppData();
  const palette = usePalette();
  const [query, setQuery] = useState("");
  const [pulled, setPulled] = useState(false);
  // The spinner shown for a pull ends with the reload it started.
  useEffect(() => { if (!sessionsReloading) setPulled(false); }, [sessionsReloading]);
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = sessions.filter(session => session.status === "archived").length;

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byWorkspace = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
      if (session.status === "archived" && !showArchived) continue;
      if (needle && !session.title.toLowerCase().includes(needle)) continue;
      const list = byWorkspace.get(session.workspaceId);
      if (list) list.push(session);
      else byWorkspace.set(session.workspaceId, [session]);
    }
    const order = workspaces.map(workspace => workspace.id);
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return [...byWorkspace.entries()].sort(([a], [b]) => rank(a) - rank(b))
      .map(([id, data]) => ({ key: id, title: workspaces.find(workspace => workspace.id === id)?.name ?? "Other workspace", data }));
  }, [sessions, query, showArchived, workspaces]);

  function pullToRefresh() {
    setPulled(true);
    refreshSessions();
    refreshWorkspaces();
  }

  if (sessionsLoading) return <Loading />;
  const header = <View style={styles.header}>
    <TextInput value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor={palette.muted} clearButtonMode="while-editing"
      accessibilityLabel="Search sessions by title" autoCorrect={false}
      style={[styles.search, { backgroundColor: palette.surface, borderColor: palette.border, color: palette.text }]} />
    {archivedCount > 0 && <Button small variant="ghost" icon="archive-outline" label={showArchived ? "Hide archived" : `Show archived (${archivedCount})`} onPress={() => setShowArchived(value => !value)} />}
    {sessionsError ? <Banner tone="danger" title="Could not load sessions" actions={<Button small label="Try again" onPress={refreshSessions} />}>{sessionsError}</Banner> : null}
  </View>;
  return <SectionList testID="session-list" sections={sections} keyExtractor={session => session.id} stickySectionHeadersEnabled={false}
    contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag"
    refreshControl={<RefreshControl refreshing={pulled} onRefresh={pullToRefresh} />}
    ListHeaderComponent={header}
    ListEmptyComponent={sessions.length
      ? <EmptyState title={!query.trim() && !showArchived ? "All sessions are archived" : "No matching sessions"} />
      : <EmptyState title="No sessions yet" action={<Button label="Start a session" icon="add" onPress={onNew} />} />}
    renderSectionHeader={({ section }) => <Text style={[styles.sectionTitle, { color: palette.muted }]} numberOfLines={1}>{section.title}</Text>}
    renderItem={({ item: session }) => {
      const isOwner = session.ownerId === user.id;
      const viewerOnly = !isOwner && session.permissions?.includes("read") && session.permissions.every(permission => permission === "read");
      const selected = session.id === selectedId;
      // The session on screen shows what its live view shows, not what the list last fetched.
      const status = sessionStatus(session, liveActivity?.sessionId === session.id ? liveActivity.activity : undefined);
      return <Pressable testID={`session-row-${session.id}`} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => onOpen(session.id)}
        style={({ pressed }) => [styles.row, { backgroundColor: selected || pressed ? palette.selection : palette.surface, borderColor: palette.border }]}>
        <View accessibilityLabel={status.label ? undefined : session.status} style={[styles.status, { backgroundColor: palette.tones[status.tone].text }]} />
        <View style={ui.flex}>
          <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>{session.title}</Text>
          <Text style={[ui.small, { color: palette.muted }]} numberOfLines={1}>
            {status.label && <><Text testID={`session-status-${session.id}`} style={[styles.statusLabel, { color: palette.tones[status.tone].text }]}>{status.label}</Text> · </>}
            {session.pullRequest && <><Text testID={`session-pull-${session.id}`} accessibilityLabel={`Pull request ${session.pullRequest.number ?? ""}`.trim()}>{session.pullRequest.number === undefined ? "PR" : `PR #${session.pullRequest.number}`}</Text> · </>}
            {isOwner ? "Yours" : viewerOnly ? "Viewer" : "Shared"} · {session.visibility === "workspace" ? "Workspace-visible" : "Private"} · {relativeTime(session.createdAt)}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={palette.muted} />
      </Pressable>;
    }} />;
}

const styles = StyleSheet.create({
  header: { gap: 8, padding: 16, paddingBottom: 4 },
  search: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  status: { width: 8, height: 8, borderRadius: 4 },
  title: { fontSize: 16, fontWeight: "500" },
  statusLabel: { fontWeight: "600" },
});
