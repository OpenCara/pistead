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
function ToolDetails({ icon, label, text }: { icon: IconName; label: string; text: string }) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  return <View style={[styles.tool, { borderColor: palette.border, backgroundColor: palette.surface }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={label} onPress={() => setOpen(value => !value)} style={styles.toolHead}>
      <Ionicons name={icon} size={14} color={palette.muted} />
      <Text style={[styles.toolLabel, { color: palette.muted }]} numberOfLines={1}>{label}</Text>
      <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={14} color={palette.muted} />
    </Pressable>
    {open && <Text selectable style={[styles.toolText, { color: palette.text, borderColor: palette.border }]}>{text}</Text>}
  </View>;
}

/** User messages are plain-text bubbles; assistant text is markdown; tool calls, results and system entries collapse to one row. */
export const TranscriptEntry = memo(function TranscriptEntry({ entry, userId }: { entry: EntryView; userId: string }) {
  const palette = usePalette();
  const name = useUsername();
  const actor = entry.actorId && name(entry.actorId, true);
  const { prose, calls } = entry.role === "assistant" ? splitToolCalls(entry.text) : { prose: entry.text, calls: [] };
  const toolLabel = calls.length > 0 ? `Tool · ${calls[0].name}` : "";
  const meta = [styles.meta, { color: palette.muted }];
  if ((toolLabel && !prose.trim()) || entry.role === "system" || entry.role === "toolResult") {
    const label = toolLabel || (entry.role === "toolResult" ? "Tool result" : "System");
    // A tool call row would show the model's time, not the tool's, so only results carry a duration.
    const took = entry.role === "toolResult" && entry.durationMs !== undefined ? ` · ${formatDuration(entry.durationMs)}` : "";
    return <ToolDetails icon={toolLabel ? "construct-outline" : "terminal-outline"} label={`${label}${took}${actor ? ` · ${actor}` : ""}`} text={entry.text} />;
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
    {toolLabel && <ToolDetails icon="construct-outline" label={toolLabel} text={calls.map(call => call.line).join("\n")} />}
    {(actor || took) && <Text style={meta}>{[actor && `by ${actor}`, took].filter(Boolean).join(" · ")}</Text>}
  </View>;
});

const styles = StyleSheet.create({
  entry: { gap: 6 },
  user: { alignItems: "flex-end" },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "88%" },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  meta: { fontSize: 12 },
  tool: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  toolHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  toolLabel: { flex: 1, fontSize: 13 },
  toolText: { fontFamily: monospace, fontSize: 12, lineHeight: 17, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
