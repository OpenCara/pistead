import { usernameWithId } from "@pistead/client";
import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Card, confirm, Feedback, styles as ui } from "../components/ui";
import { useAuth, useSession } from "../lib/auth";
import { timestamp } from "../lib/format";
import { useAction } from "../lib/resource";
import { displayOrigin } from "../lib/server";
import { usePalette } from "../theme";

function Row({ label, children }: { label: string; children: ReactNode }) {
  const palette = usePalette();
  return <View style={styles.row}>
    <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
    {typeof children === "string" ? <Text selectable style={[styles.value, { color: palette.text }]}>{children}</Text> : children}
  </View>;
}

export default function SettingsScreen() {
  const { signOut } = useAuth();
  const { user, origin, expiresAt } = useSession();
  const palette = usePalette();
  const action = useAction();
  const version = [Application.nativeApplicationVersion, Application.nativeBuildVersion && `(${Application.nativeBuildVersion})`].filter(Boolean).join(" ");
  async function confirmSignOut() {
    if (!await confirm({ title: "Sign out?", message: `This device signs out of ${displayOrigin(origin)} and forgets its sign-in.`, confirmLabel: "Sign out", destructive: true })) return;
    await signOut();
  }
  return <ScrollView contentContainerStyle={styles.column}>
    <Text style={[styles.heading, { color: palette.muted }]}>Account</Text>
    <Card>
      <Row label="Name">{user.displayName}</Row>
      {user.githubLogin && <Row label="GitHub">{`@${user.githubLogin}`}</Row>}
      <Row label="User ID">
        <View style={ui.inline}>
          <Text selectable testID="settings-user-id" style={[styles.value, { color: palette.text }]}>{usernameWithId(user)}</Text>
          <Button small variant="ghost" icon="copy-outline" label="Copy" onPress={() => void action.run(async () => { await Clipboard.setStringAsync(user.id); }, "User ID copied")} />
        </View>
      </Row>
      <Text style={[ui.small, { color: palette.muted }]}>Workspace owners add you with your user ID.</Text>
    </Card>
    <Text style={[styles.heading, { color: palette.muted }]}>Server</Text>
    <Card>
      <Row label="Address">{origin}</Row>
      <Row label="Status">{expiresAt ? `Signed in until ${timestamp(expiresAt)}` : "Signed in"}</Row>
      <Text style={[ui.small, { color: palette.muted }]}>Signed-in apps can be reviewed and revoked under Settings › Profile on the web.</Text>
    </Card>
    <Text style={[styles.heading, { color: palette.muted }]}>App</Text>
    <Card>
      <Row label="Version">{version || "Unknown"}</Row>
    </Card>
    <Feedback error={action.error} notice={action.notice} />
    <Button testID="sign-out" variant="danger" icon="log-out-outline" label="Sign out" onPress={() => void confirmSignOut()} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  column: { gap: 10, padding: 20, width: "100%", maxWidth: 640, alignSelf: "center" },
  heading: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", marginTop: 8 },
  row: { gap: 2 },
  label: { fontSize: 13 },
  value: { fontSize: 16 },
});
