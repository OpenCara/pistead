import { useEffect, useState } from "react";

export type SettingsSection = "profile" | "appearance" | "hosts" | "workspaces";

export type Route =
  | { name: "home" }
  | { name: "sessions" }
  | { name: "new"; workspaceId: string }
  | { name: "session"; sessionId: string }
  | { name: "settings"; section: SettingsSection; id?: string }
  /** A session's share link: the token lives in the fragment, so opening the link never sends it to the server. */
  | { name: "shared"; token: string };

const sections: readonly SettingsSection[] = ["profile", "appearance", "hosts", "workspaces"];

function decode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [head, first, second] = parts;
  if (head === "s" && decode(first)) return { name: "session", sessionId: decode(first)! };
  if (head === "sessions") return { name: "sessions" };
  if (head === "shared" && decode(first)) return { name: "shared", token: decode(first)! };
  if (head === "w" && decode(first) && second === "new") return { name: "new", workspaceId: decode(first)! };
  if (head === "settings") {
    const section = sections.find(item => item === first) ?? "profile";
    const id = decode(second);
    return id ? { name: "settings", section, id } : { name: "settings", section };
  }
  return { name: "home" };
}

export function href(route: Route): string {
  switch (route.name) {
    case "home": return "#/";
    case "sessions": return "#/sessions";
    case "new": return `#/w/${encodeURIComponent(route.workspaceId)}/new`;
    case "session": return `#/s/${encodeURIComponent(route.sessionId)}`;
    case "settings": return `#/settings/${route.section}${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
    case "shared": return `#/shared/${encodeURIComponent(route.token)}`;
  }
}

export function navigate(route: Route): void {
  const target = href(route);
  if (window.location.hash !== target) window.location.hash = target;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const change = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return route;
}
