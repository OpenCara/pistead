import { Platform, useColorScheme } from "react-native";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "running";

export interface Palette {
  scheme: "light" | "dark";
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  selection: string;
  userBubble: string;
  onUserBubble: string;
  code: string;
  tones: Record<Tone, { text: string; background: string }>;
}

const light: Palette = {
  scheme: "light",
  background: "#f6f6f7",
  surface: "#ffffff",
  surfaceRaised: "#efeff1",
  border: "#dcdce0",
  text: "#18181b",
  muted: "#6b6b74",
  primary: "#18181b",
  onPrimary: "#ffffff",
  selection: "#e4e4e8",
  userBubble: "#e9e9ec",
  onUserBubble: "#18181b",
  code: "#f0f0f2",
  tones: {
    neutral: { text: "#52525b", background: "#ececef" },
    info: { text: "#1d4ed8", background: "#e0e9fd" },
    success: { text: "#15803d", background: "#dcf3e3" },
    warning: { text: "#a15c07", background: "#fcf0d4" },
    danger: { text: "#b91c1c", background: "#fbe1e1" },
    running: { text: "#6d28d9", background: "#ece4fc" },
  },
};

const dark: Palette = {
  scheme: "dark",
  background: "#0b0b0c",
  surface: "#161618",
  surfaceRaised: "#202023",
  border: "#2e2e33",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  primary: "#f4f4f5",
  onPrimary: "#18181b",
  selection: "#26262b",
  userBubble: "#26262b",
  onUserBubble: "#f4f4f5",
  code: "#1e1e22",
  tones: {
    neutral: { text: "#d4d4d8", background: "#27272a" },
    info: { text: "#93b4fb", background: "#16233f" },
    success: { text: "#7ad79a", background: "#11291a" },
    warning: { text: "#f5c062", background: "#33260b" },
    danger: { text: "#f79a9a", background: "#3a1414" },
    running: { text: "#c4a8fb", background: "#25183f" },
  },
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export const monospace = Platform.select({ ios: "Menlo", default: "monospace" });
