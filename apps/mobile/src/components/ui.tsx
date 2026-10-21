import Ionicons from "@expo/vector-icons/Ionicons";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette, type Tone } from "../theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

/** A yes/no question with the action named on its button; resolves false when cancelled. */
export function confirm({ title, message, confirmLabel, destructive }: { title: string; message: string; confirmLabel: string; destructive?: boolean }): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
    { text: confirmLabel, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) });
  return promise;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ label, onPress, variant = "secondary", small, icon, disabled, busy, testID, style }: {
  label: string; onPress: () => void; variant?: ButtonVariant; small?: boolean; icon?: IconName; disabled?: boolean; busy?: boolean;
  testID?: string; style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  const colors = {
    primary: { background: palette.primary, text: palette.onPrimary, border: palette.primary },
    secondary: { background: palette.surface, text: palette.text, border: palette.border },
    ghost: { background: "transparent", text: palette.text, border: "transparent" },
    danger: { background: palette.tones.danger.background, text: palette.tones.danger.text, border: palette.tones.danger.background },
  }[variant];
  const inactive = disabled || busy;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: inactive, busy }}
    disabled={inactive} onPress={onPress}
    style={({ pressed }) => [styles.button, small && styles.buttonSmall, { backgroundColor: colors.background, borderColor: colors.border, opacity: inactive ? 0.45 : pressed ? 0.7 : 1 }, style]}>
    {busy ? <ActivityIndicator size="small" color={colors.text} /> : icon && <Ionicons name={icon} size={small ? 14 : 16} color={colors.text} />}
    <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: colors.text }]} numberOfLines={1}>{label}</Text>
  </Pressable>;
}

/** An icon-only header or toolbar button. */
export function IconButton({ icon, label, onPress, disabled, testID, badge }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; testID?: string; badge?: number }) {
  const palette = usePalette();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
    <Ionicons name={icon} size={22} color={palette.text} />
    {badge ? <View style={[styles.iconBadge, { backgroundColor: palette.tones.warning.text }]}><Text style={styles.iconBadgeText}>{badge}</Text></View> : null}
  </Pressable>;
}

export function Badge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  const colors = usePalette().tones[tone];
  return <View style={[styles.badge, { backgroundColor: colors.background }]}>
    {dot && <View style={[styles.dot, { backgroundColor: colors.text }]} />}
    <Text style={[styles.badgeText, { color: colors.text }]} numberOfLines={1}>{children}</Text>
  </View>;
}

export function Banner({ tone = "neutral", title, children, actions, testID }: { tone?: Tone; title?: string; children?: ReactNode; actions?: ReactNode; testID?: string }) {
  const palette = usePalette();
  const colors = palette.tones[tone];
  return <View testID={testID} style={[styles.banner, { backgroundColor: colors.background }]}>
    {title && <Text style={[styles.bannerTitle, { color: colors.text }]}>{title}</Text>}
    {typeof children === "string" ? <Text style={[styles.bannerBody, { color: palette.text }]}>{children}</Text> : children}
    {actions && <View style={styles.inline}>{actions}</View>}
  </View>;
}

/** The outcome of an action: its error, or its success notice. */
export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <Banner tone="danger">{error}</Banner>;
  if (notice) return <Banner tone="success">{notice}</Banner>;
  return null;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const palette = usePalette();
  return <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }, style]}>{children}</View>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  const palette = usePalette();
  return <View style={styles.empty}>
    <Text style={[styles.emptyTitle, { color: palette.text }]}>{title}</Text>
    {typeof children === "string" ? <Text style={[styles.emptyBody, { color: palette.muted }]}>{children}</Text> : children}
    {action}
  </View>;
}

export function Loading({ label }: { label?: string }) {
  const palette = usePalette();
  return <View style={styles.loading}>
    <ActivityIndicator color={palette.muted} />
    {label && <Text style={{ color: palette.muted }}>{label}</Text>}
  </View>;
}

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
  destructive?: boolean;
}

/**
 * A list of choices in a sheet: Android-ready, unlike ActionSheetIOS, and room for a hint under each choice.
 * On iOS the choice applies once the sheet has gone, so a confirmation it raises is not swallowed by the closing modal.
 */
export function OptionSheet<T extends string>({ visible, title, options, value, onSelect, onClose }: {
  visible: boolean; title: string; options: Option<T>[]; value?: T; onSelect: (value: T) => void; onClose: () => void;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const chosen = useRef<{ value: T } | null>(null);
  function choose(next: T) {
    onClose();
    if (Platform.OS === "ios") chosen.current = { value: next };
    else onSelect(next);
  }
  function dismissed() {
    const next = chosen.current;
    chosen.current = null;
    if (next) onSelect(next.value);
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={dismissed} supportedOrientations={["portrait", "landscape"]}>
    <View style={styles.sheetBackdrop}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: palette.surface, paddingBottom: insets.bottom + 8 }]}>
        <View style={[styles.sheetHeader, { borderColor: palette.border }]}>
          <Text style={[styles.sheetTitle, { color: palette.text }]}>{title}</Text>
          <IconButton icon="close" label="Close" onPress={onClose} />
        </View>
        <ScrollView>
          {options.map(option => {
            const tone = option.destructive ? palette.tones.danger.text : palette.text;
            return <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected: option.value === value }}
              onPress={() => choose(option.value)}
              style={({ pressed }) => [styles.sheetRow, { backgroundColor: pressed ? palette.selection : "transparent" }]}>
              <View style={styles.flex}>
                <Text style={[styles.sheetLabel, { color: tone }]}>{option.label}</Text>
                {option.hint && <Text style={[styles.small, { color: palette.muted }]}>{option.hint}</Text>}
              </View>
              {option.value === value && <Ionicons name="checkmark" size={20} color={palette.text} />}
            </Pressable>;
          })}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

/** A compact picker trigger showing the current choice. */
export function Chip({ label, icon, onPress, tone, disabled, testID }: { label: string; icon?: IconName; onPress: () => void; tone?: Tone; disabled?: boolean; testID?: string }) {
  const palette = usePalette();
  const color = tone ? palette.tones[tone].text : palette.text;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.chip, { borderColor: palette.border, backgroundColor: tone ? palette.tones[tone].background : palette.surface, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}>
    {icon && <Ionicons name={icon} size={14} color={color} />}
    <Text style={[styles.chipText, { color }]} numberOfLines={1}>{label}</Text>
    <Ionicons name="chevron-down" size={12} color={palette.muted} />
  </Pressable>;
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  small: { fontSize: 13, lineHeight: 18 },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  buttonSmall: { minHeight: 34, paddingHorizontal: 12, borderRadius: 8 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  buttonTextSmall: { fontSize: 14 },
  iconButton: { padding: 6 },
  iconBadge: { position: "absolute", top: 0, right: 0, minWidth: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  iconBadgeText: { color: "#ffffff", fontSize: 10, fontWeight: "700" },
  badge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  banner: { borderRadius: 10, padding: 12, gap: 6 },
  bannerTitle: { fontSize: 14, fontWeight: "700" },
  bannerBody: { fontSize: 14, lineHeight: 20 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  empty: { alignItems: "center", justifyContent: "center", padding: 32, gap: 8, flexGrow: 1 },
  emptyTitle: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  sheetBackdrop: { flex: 1, justifyContent: "flex-end", alignItems: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { width: "100%", maxWidth: 520, maxHeight: "75%", borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  sheetTitle: { fontSize: 16, fontWeight: "700" },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  sheetLabel: { fontSize: 16 },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 220 },
  chipText: { fontSize: 13, fontWeight: "500", flexShrink: 1 },
});
