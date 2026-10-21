import { segment } from "@pistead/client";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput } from "react-native";
import type { SessionRecord } from "../../../../packages/shared/src/types";
import { Button, Feedback, styles as ui } from "../components/ui";
import { useSession } from "../lib/auth";
import { useOpenSessionFromModal } from "../lib/layout";
import { useAction } from "../lib/resource";
import { usePalette } from "../theme";

export default function OpenSessionScreen() {
  const { api } = useSession();
  const palette = usePalette();
  const openSession = useOpenSessionFromModal();
  const [sessionId, setSessionId] = useState("");
  const action = useAction();
  function open() {
    if (!sessionId.trim() || action.busy) return;
    void action.run(async () => {
      // Checks access before leaving, so a wrong ID is explained here.
      const result = await api<{ session: SessionRecord }>(`/api/sessions/${segment(sessionId.trim())}`);
      openSession(result.session.id);
    });
  }
  return <ScrollView contentContainerStyle={styles.column} keyboardShouldPersistTaps="handled">
    <Text style={[ui.small, { color: palette.muted }]}>Session ID — ask the session owner for its ID</Text>
    <TextInput testID="open-session-id" value={sessionId} onChangeText={setSessionId} autoFocus autoCapitalize="none" autoCorrect={false}
      returnKeyType="go" onSubmitEditing={open} accessibilityLabel="Session ID"
      style={[styles.input, { backgroundColor: palette.surface, borderColor: palette.border, color: palette.text }]} />
    <Feedback error={action.error} />
    <Button variant="primary" label={action.busy ? "Checking access..." : "Open session"} disabled={action.busy || !sessionId.trim()} onPress={open} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  column: { gap: 12, padding: 20, width: "100%", maxWidth: 560, alignSelf: "center" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
