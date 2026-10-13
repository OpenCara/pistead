import { useEffect, useState, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
const KEY = "pistead.theme";

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Applies the preference to <html data-theme>; "system" follows prefers-color-scheme. */
export function applyTheme(preference: ThemePreference = stored()): void {
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function useTheme(): [ThemePreference, (value: ThemePreference) => void] {
  const [preference, setPreference] = useState(stored);
  useEffect(() => {
    applyTheme(preference);
    // Re-read storage: another hook instance (Settings -> Appearance) may have changed the choice.
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyTheme();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [preference]);
  return [preference, value => {
    try { localStorage.setItem(KEY, value); } catch { /* Private mode keeps the in-memory choice. */ }
    setPreference(value);
  }];
}

function resolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribeTheme(change: () => void): () => void {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The theme <html data-theme> shows now; follows a changed preference and, under "system", the OS theme. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, resolvedTheme, () => "light");
}
