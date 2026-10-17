export const DEFAULT_ORIGIN = "https://pistead.com";

/** Hosts a development build may reach over plain HTTP: a server running on this Mac (the simulator shares its network). */
const localHosts = ["localhost", "127.0.0.1"];

/**
 * A server origin from what the user typed: scheme and host (with port), no path. HTTPS is required, except plain HTTP
 * to this machine in development builds. Parsed by hand: React Native's URL does not implement every getter.
 */
export function parseOrigin(input: string): { origin: string } | { error: string } {
  let text = input.trim().replace(/\/+$/, "");
  if (!text) return { error: "Enter the server address, e.g. https://pistead.com." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.exec(text);
  if (!match) return { error: "Enter only the server address (scheme and host), without a path." };
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const origin = `${scheme}://${host}${match[3] ?? ""}`;
  if (scheme === "https") return { origin };
  if (__DEV__ && localHosts.includes(host)) return { origin };
  return { error: __DEV__ ? "Use https://, or http:// only for localhost or 127.0.0.1." : "The server must use https://." };
}

/** The origin without its scheme, for compact display. */
export const displayOrigin = (origin: string) => origin.replace(/^https:\/\//, "");
