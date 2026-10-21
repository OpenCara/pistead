import { repositoryProgressText, repositoryProgressValue, segment } from "@pistead/client";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from "react-native";
import type { RepositoryPreparationView } from "../../../../packages/shared/src/types";
import { useSession } from "../lib/auth";
import { useAction } from "../lib/resource";
import { monospace, usePalette } from "../theme";
import { Banner, Button, Card, Feedback, styles as ui } from "./ui";

/**
 * A cache host preparing this session's repositories (connect --repo-cache): one bar per repository while it clones or
 * fetches, checks and checks out. If that failed, its reason, and for the owner a way to try again.
 */
export function RepositoryPreparationCard({ sessionId, preparation, canRestart, onRestarted }: {
  sessionId: string; preparation: RepositoryPreparationView; canRestart: boolean; onRestarted: () => void;
}) {
  const { api } = useSession();
  const palette = usePalette();
  const action = useAction();
  if (preparation.status === "failed") {
    const restart = () => void action.run(async () => {
      await api(`/api/sessions/${segment(sessionId)}/restart`, { method: "POST" });
      onRestarted();
    });
    return <Banner tone="danger" title="Repositories could not be prepared"
      actions={canRestart ? <Button small label={action.busy ? "Restarting..." : "Restart session"} disabled={action.busy} onPress={restart} /> : undefined}>
      <Text style={[styles.body, { color: palette.text }]}>{preparation.error ?? "The host could not prepare this session's repositories."}</Text>
      <Text style={[ui.small, { color: palette.muted }]}>{canRestart
        ? "Fix the cause on the host, then restart the session. Queued messages run once the repositories are ready."
        : "The session owner can restart the session once the cause is fixed."}</Text>
      <Feedback error={action.error} />
    </Banner>;
  }
  return <Card>
    <View style={ui.inline} accessibilityRole="header">
      <ActivityIndicator size="small" color={palette.muted} />
      <Text style={[styles.head, { color: palette.text }]}>Preparing repositories</Text>
    </View>
    {preparation.items.map(item => {
      const text = repositoryProgressText(item);
      return <View key={item.path} style={styles.item}>
        <View style={styles.row}>
          <Text selectable style={[styles.path, { color: palette.text }]} numberOfLines={1}>{item.path}</Text>
          <Text style={[ui.small, styles.text, { color: palette.muted }]}>{text}</Text>
        </View>
        <ProgressBar value={repositoryProgressValue(item)} label={`${item.path}: ${text}`} />
      </View>;
    })}
    <Text style={[ui.small, { color: palette.muted }]}>The first session on a host clones each repository with its full history; later sessions fetch only what changed. Messages sent now run when this is done.</Text>
  </Card>;
}

/** Without a value the bar is indeterminate: Git reports no percentage in this phase. */
function ProgressBar({ value, label }: { value: number | undefined; label: string }) {
  const palette = usePalette();
  const indeterminate = value === undefined;
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!indeterminate) return;
    const loop = Animated.loop(Animated.timing(slide, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: false }));
    loop.start();
    return () => { loop.stop(); slide.setValue(0); };
  }, [indeterminate, slide]);
  const fill = { backgroundColor: palette.tones.running.text };
  return <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={indeterminate ? undefined : { min: 0, max: 100, now: value }}
    style={[styles.track, { backgroundColor: palette.code }]}>
    {indeterminate
      ? <Animated.View style={[styles.fill, fill, styles.segment, { left: slide.interpolate({ inputRange: [0, 1], outputRange: ["-30%", "100%"] }) }]} />
      : <View style={[styles.fill, fill, { width: `${value}%` }]} />}
  </View>;
}

const styles = StyleSheet.create({
  head: { fontSize: 14, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  item: { gap: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2 },
  path: { fontFamily: monospace, fontSize: 13, flexShrink: 1 },
  text: { flexShrink: 1 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
  segment: { position: "absolute", width: "30%" },
});
