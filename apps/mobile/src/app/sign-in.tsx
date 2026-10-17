import Ionicons from "@expo/vector-icons/Ionicons";
import { errorMessage } from "@pistead/client";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner, Button, styles as ui } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/resource";
import { displayOrigin, parseOrigin } from "../lib/server";
import { usePalette } from "../theme";

export default function SignInScreen() {
  const { state, signInWithGitHub, signInWithToken, signOut, retry } = useAuth();
  const palette = usePalette();
  const storedOrigin = state.status === "signedOut" || state.status === "unreachable" ? state.origin : "";
  const [server, setServer] = useState(storedOrigin);
  const [editingServer, setEditingServer] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [token, setToken] = useState("");
  const action = useAction();
  const parsed = parseOrigin(server);
  const origin = "origin" in parsed ? parsed.origin : null;
  const input = [styles.input, { backgroundColor: palette.surface, borderColor: palette.border, color: palette.text }];

  if (state.status === "unreachable") {
    return <SafeAreaView style={[ui.flex, { backgroundColor: palette.background }]}>
      <View style={styles.column}>
        <Text style={[styles.title, { color: palette.text }]}>Can't reach Pistead</Text>
        <Banner tone="warning" title={displayOrigin(state.origin)}>{state.error}</Banner>
        <Button variant="primary" label="Try again" disabled={action.busy} onPress={retry} />
        <Button variant="ghost" label={action.busy ? "Signing out…" : "Sign out"} disabled={action.busy} onPress={() => void action.run(signOut)} />
      </View>
    </SafeAreaView>;
  }

  return <SafeAreaView style={[ui.flex, { backgroundColor: palette.background }]}>
    <KeyboardAvoidingView style={ui.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={styles.column} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text style={[styles.title, { color: palette.text }]}>Pistead</Text>
          <Text style={[styles.lead, { color: palette.muted }]}>Run Pi agents on your own machine, and work on them together with your team.</Text>
        </View>
        {state.status === "signedOut" && state.notice ? <Banner tone="warning">{state.notice}</Banner> : null}
        {action.error ? <Banner tone="danger" title="Sign-in problem">{action.error}</Banner> : null}
        <View style={styles.server}>
          <Text style={[ui.small, { color: palette.muted }]}>Server</Text>
          {editingServer ? <>
            <TextInput testID="server-input" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url"
              placeholder="https://pistead.com" placeholderTextColor={palette.muted} accessibilityLabel="Server address" style={input} />
            {"error" in parsed && <Text style={[ui.small, { color: palette.tones.danger.text }]}>{parsed.error}</Text>}
            <Text style={[ui.small, { color: palette.muted }]}>For a self-hosted Pistead, enter its address.</Text>
          </> : <View style={ui.inline}>
            <Text style={[styles.serverName, { color: palette.text }]} numberOfLines={1}>{origin ? displayOrigin(origin) : server}</Text>
            <Button testID="server-change" small variant="ghost" label="Change" onPress={() => setEditingServer(true)} />
          </View>}
        </View>
        <Button testID="github-sign-in" variant="primary" icon="logo-github" label="Continue with GitHub" busy={action.busy && !developerOpen} disabled={!origin || action.busy}
          onPress={() => void action.run(async () => { if (origin) await signInWithGitHub(origin); })} />
        <Text style={[ui.small, styles.footnote, { color: palette.muted }]}>Model credentials stay on your host. GitHub tokens stay on the server, or go only to your own hosts when you push with your account.</Text>
        {__DEV__ && <View style={[styles.developer, { borderColor: palette.border }]}>
          <Button testID="developer-toggle" small variant="ghost" icon={developerOpen ? "chevron-down" : "chevron-forward"} label="Developer sign-in" onPress={() => setDeveloperOpen(value => !value)} />
          {developerOpen && <>
            <Text style={[ui.small, { color: palette.muted }]}>Development builds only. Uses the server above (http://localhost or 127.0.0.1 allowed) and a token from a test-mode server's POST /api/auth/test.</Text>
            {/* Not a password: no Keychain "Save Password?" offer (textContentType) or Android autofill (autoComplete). */}
            <TextInput testID="developer-token" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry
              textContentType="oneTimeCode" autoComplete="off" importantForAutofill="no"
              placeholder="Test-mode token" placeholderTextColor={palette.muted} accessibilityLabel="Test-mode token" style={input} />
            <Button testID="developer-sign-in" label="Sign in with token" icon="key-outline" busy={action.busy && developerOpen} disabled={!origin || !token.trim() || action.busy}
              onPress={() => void action.run(async () => {
                if (!origin) return;
                try {
                  await signInWithToken(origin, token);
                } catch (reason) {
                  throw new Error(`Developer sign-in failed: ${errorMessage(reason)}`);
                }
              })} />
          </>}
        </View>}
        <View style={styles.mark}><Ionicons name="lock-closed-outline" size={14} color={palette.muted} /><Text style={[ui.small, { color: palette.muted }]}>Your sign-in is kept in this device's secure storage.</Text></View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  column: { flexGrow: 1, justifyContent: "center", gap: 16, padding: 24, width: "100%", maxWidth: 480, alignSelf: "center" },
  hero: { gap: 8 },
  title: { fontSize: 32, fontWeight: "800" },
  lead: { fontSize: 16, lineHeight: 22 },
  server: { gap: 6 },
  serverName: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  footnote: { textAlign: "center" },
  developer: { gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  mark: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
});
