// Pure rules for which server the app may load and where its remote window may navigate; no Electron imports, so
// tests run them directly.

export const DEFAULT_SERVER = "https://pistead.com";
/** GitHub OAuth runs in the app window; the server sends the browser there and GitHub sends it back. */
export const GITHUB_ORIGIN = "https://github.com";
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true };

/** The canonical origin for a configured server, or an error message for the Settings form. */
export function parseServerOrigin(input: string): { ok: true; origin: string } | { ok: false; error: string } {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, error: "Enter the server's address, for example https://pistead.com." }; }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[\s\\]/.test(value)) {
    return { ok: false, error: "Enter only the server's origin, without a path, for example https://pistead.com." };
  }
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol === "http:" && Object.hasOwn(LOOPBACK_HOSTS, url.hostname)) return { ok: true, origin: url.origin };
  return { ok: false, error: "The server must use HTTPS; plain HTTP is allowed only for localhost and 127.0.0.1." };
}

/** Plain HTTP reaches only loopback servers, for development; the connector needs the same explicit opt-in. */
export const isLoopbackHttp = (origin: string): boolean => origin.startsWith("http:");

export type NavigationDecision = "allow" | "external" | "deny";

/** Where a navigation of the remote window to `target` goes: stay in the app, the default browser, or nowhere. */
export function navigationDecision(target: string, server: string): NavigationDecision {
  let url: URL;
  try { url = new URL(target); } catch { return "deny"; }
  if (url.username || url.password) return "deny";
  if (url.origin === server || url.origin === GITHUB_ORIGIN) return "allow";
  return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? "external" : "deny";
}

/** New windows never open inside the app: web links go to the default browser. */
export function windowOpenDecision(target: string): "external" | "deny" {
  let url: URL;
  try { url = new URL(target); } catch { return "deny"; }
  return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") ? "external" : "deny";
}
