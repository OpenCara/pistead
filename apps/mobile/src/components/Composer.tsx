import Ionicons from "@expo/vector-icons/Ionicons";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { usePalette } from "../theme";
import { styles as ui } from "./ui";

/** The chat box: a growing text field and a send button, with option pickers and a hint below. */
export function Composer({ value, onChange, onSubmit, busy, disabled, placeholder, sendLabel, hint, tools }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; busy: boolean; disabled?: boolean;
  placeholder: string; sendLabel: string; hint: string; tools?: ReactNode;
}) {
  const palette = usePalette();
  const canSend = !disabled && !busy && value.trim() !== "";
  return <View style={styles.composer}>
    <View style={[styles.box, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <TextInput testID="composer-input" value={value} onChangeText={onChange} editable={!busy && !disabled} multiline
        placeholder={placeholder} placeholderTextColor={palette.muted} accessibilityLabel={placeholder}
        style={[styles.input, { color: palette.text }]} />
      <Pressable testID="composer-send" accessibilityRole="button" accessibilityLabel={busy ? "Sending..." : sendLabel} disabled={!canSend} onPress={onSubmit}
        style={({ pressed }) => [styles.send, { backgroundColor: palette.primary, opacity: !canSend ? 0.35 : pressed ? 0.7 : 1 }]}>
        {busy ? <ActivityIndicator size="small" color={palette.onPrimary} /> : <Ionicons name="arrow-up" size={20} color={palette.onPrimary} />}
      </Pressable>
    </View>
    {tools && <View style={ui.inline}>{tools}</View>}
    <Text style={[ui.small, { color: palette.muted }]}>{hint}</Text>
  </View>;
}

const styles = StyleSheet.create({
  composer: { gap: 8 },
  box: { flexDirection: "row", alignItems: "flex-end", gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, paddingLeft: 14, paddingRight: 6, paddingVertical: 6 },
  input: { flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 160, paddingTop: 6, paddingBottom: 6 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
});
