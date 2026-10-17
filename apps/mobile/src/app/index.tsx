import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { SessionList } from "../components/SessionList";
import { SessionView } from "../components/SessionView";
import { EmptyState, IconButton, styles as ui } from "../components/ui";
import { useWideLayout } from "../lib/layout";
import { usePalette } from "../theme";

/** The session list; in the wide layout, with the session chosen by the `session` parameter beside it. */
export default function SessionsScreen() {
  const router = useRouter();
  const wide = useWideLayout();
  const palette = usePalette();
  const { session: selected } = useLocalSearchParams<{ session?: string }>();

  // A window narrowed while a session is open (iPad split screen, rotation) keeps it open, as its own screen.
  useEffect(() => {
    if (wide || !selected) return;
    router.setParams({ session: undefined });
    router.push({ pathname: "/session/[id]", params: { id: selected } });
  }, [wide, selected, router]);

  const open = (id: string) => wide ? router.setParams({ session: id }) : router.push({ pathname: "/session/[id]", params: { id } });
  const header = <Stack.Screen options={{
    headerLeft: () => <IconButton testID="open-settings" icon="person-circle-outline" label="Settings" onPress={() => router.push("/settings")} />,
    headerRight: () => <View style={styles.actions}>
      <IconButton testID="open-by-id" icon="enter-outline" label="Open a session by ID" onPress={() => router.push("/open-session")} />
      <IconButton testID="new-session" icon="add" label="New session" onPress={() => router.push("/new")} />
    </View>,
  }} />;

  if (!wide) return <>{header}<SessionList onOpen={open} onNew={() => router.push("/new")} /></>;
  return <View style={[ui.flex, styles.split]}>
    {header}
    <View style={[styles.list, { borderColor: palette.border }]}>
      <SessionList selectedId={selected} onOpen={open} onNew={() => router.push("/new")} />
    </View>
    <View style={ui.flex}>
      {selected ? <SessionView key={selected} id={selected} embedded />
        : <EmptyState title="No session open">Choose a session from the list, or start a new one.</EmptyState>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  split: { flexDirection: "row" },
  list: { width: 340, borderRightWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
});
