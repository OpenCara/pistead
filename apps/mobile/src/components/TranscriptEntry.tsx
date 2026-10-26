import Ionicons from "@expo/vector-icons/Ionicons";
import { splitToolCalls } from "@pistead/client";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { EntryView } from "../../../../packages/shared/src/types";
import { formatDuration, modelFailure } from "../lib/format";
import { useUsername } from "../lib/people";
import { monospace, usePalette } from "../theme";
import { Markdown } from "./Markdown";
import { Banner, type IconName } from "./ui";

/** One collapsed row for tool calls, tool results and system entries; expanding it shows the raw text. */
function ToolDetails({ icon, label, text, trimmed }: { icon: IconName; label: string; text: string; trimmed?: EntryView["trimmed"] }) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  return <View style={[styles.tool, { borderColor: palette.border, backgroundColor: palette.surface }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={label} onPress={() => setOpen(value => !value)} style={styles.toolHead}>
      <Ionicons name={icon} size={14} color={palette.muted} />
      <Text style={[styles.toolLabel, { color: palette.muted }]} numberOfLines={1}>{label}</Text>
      <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={14} color={palette.muted} />
    </Pressable>
    {open && <Text selectable style={[styles.toolText, { color: palette.text, borderColor: palette.border }]}>{text}</Text>}
    {open && trimmed && <Text style={[styles.meta, { color: palette.muted }]}>
      {`Brief tool output · ${trimmed.lines === 1 ? "1 line" : `${trimmed.lines.toLocaleString()} lines`}, ${trimmed.chars.toLocaleString()} characters in full. The session's owner can show full tool output in the web app's session details.`}
    </Text>}
  </View>;
}

/**
 * " · Auto-approved" for an entry whose tool calls ran their commands under auto-approve, which have no approval card,
 * with any outcome other than the usual "executed" (still running, failed, interrupted).
 */
function autoApprovedSuffix(calls: EntryView["autoApproved"]): string {
  if (!Array.isArray(calls) || !calls.length) return "";
  const notes = calls.filter(call => call.status !== "executed").map(call => calls.length > 1 ? `${call.tool}: ${call.status}` : call.status);
  return ` · Auto-approved${calls.some(call => call.unbounded) ? " · No resource limits" : ""}${notes.map(note => ` · ${note}`).join("")}`;
}

/** User messages are plain-text bubbles; assistant text is markdown; tool calls, results and system entries collapse to one row. */
export const TranscriptEntry = memo(function TranscriptEntry({ entry, userId }: { entry: EntryView; userId: string }) {
  const palette = usePalette();
  const name = useUsername();
  const actor = entry.actorId && name(entry.actorId, true);
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  const toolLabel = calls.length > 0 ? `Tool · ${calls[0].name}` : "";
  const meta = [styles.meta, { color: palette.muted }];
  if (entry.kind === "workspace.run-stopped" || entry.kind === "workspace.run-crashed") {
    return <View style={styles.stopped} accessibilityRole="text">
      <View style={[styles.rule, { backgroundColor: palette.border }]} />
      <Text style={[meta, styles.stoppedText]}>{entry.kind === "workspace.run-crashed" ? entry.text : `Stopped${actor ? ` by ${actor}` : ""}`}</Text>
      <View style={[styles.rule, { backgroundColor: palette.border }]} />
    </View>;
  }
  if ((toolLabel && !prose.trim()) || entry.role === "system" || entry.role === "toolResult") {
    const label = toolLabel || (entry.role === "toolResult" ? "Tool result" : "System");
    // A tool call row would show the model's time, not the tool's, so only results carry a duration.
    const took = entry.role === "toolResult" && entry.durationMs !== undefined ? ` · ${formatDuration(entry.durationMs)}` : "";
    // A brief tool result's one line shows on its row.
    const line = entry.trimmed && entry.role === "toolResult" && entry.text.trim() ? ` · ${entry.text}` : "";
    return <ToolDetails icon={toolLabel ? "construct-outline" : "terminal-outline"} label={`${label}${took}${actor ? ` · ${actor}` : ""}${autoApprovedSuffix(entry.autoApproved)}${line}`}
      text={entry.text} trimmed={entry.trimmed} />;
  }
  if (entry.error) {
    return <View style={styles.entry}>
      <Banner tone="danger" title="Model request failed">{modelFailure(entry.error)}</Banner>
      {actor && <Text style={meta}>by {actor}</Text>}
    </View>;
  }
  if (entry.role === "user") {
    return <View style={[styles.entry, styles.user]}>
      <View style={[styles.bubble, { backgroundColor: palette.userBubble }]}>
        <Text selectable style={[styles.bubbleText, { color: palette.onUserBubble }]}>{entry.text}</Text>
      </View>
      {actor && entry.actorId !== userId && <Text style={meta}>by {actor}</Text>}
    </View>;
  }
  const took = entry.durationMs !== undefined ? formatDuration(entry.durationMs) : "";
  return <View style={styles.entry}>
    {prose.trim() !== "" && <Markdown text={prose} />}
    {toolLabel && <ToolDetails icon="construct-outline" label={`${toolLabel}${autoApprovedSuffix(entry.autoApproved)}`} text={calls.map(call => call.line).join("\n")} trimmed={entry.trimmed} />}
    {(actor || took) && <Text style={meta}>{[actor && `by ${actor}`, took].filter(Boolean).join(" · ")}</Text>}
  </View>;
});

const styles = StyleSheet.create({
  entry: { gap: 6 },
  user: { alignItems: "flex-end" },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "88%" },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  meta: { fontSize: 12 },
  stopped: { flexDirection: "row", alignItems: "center", gap: 10 },
  // A longer note wraps between the rules instead of pushing them off the screen.
  stoppedText: { flexShrink: 1, textAlign: "center" },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  tool: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  toolHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  toolLabel: { flex: 1, fontSize: 13 },
  toolText: { fontFamily: monospace, fontSize: 12, lineHeight: 17, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
