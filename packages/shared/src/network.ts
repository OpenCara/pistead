import { validGitHost, type GitProvider } from "./repositories.js";

/**
 * What a workspace's sandboxed sessions may reach through their host's egress proxy. The workspace's own repositories
 * are always reachable for Git reads, with the session owner's credential; this decides everything else:
 * - off: nothing else;
 * - allowlist: the listed domains, plus the package registries below when `packageRegistries` is set;
 * - open: any public host.
 * Private, loopback and link-local addresses are never reachable, whatever the mode.
 */
export const networkModes = ["off", "allowlist", "open"] as const;
export type NetworkMode = (typeof networkModes)[number];
export interface NetworkPolicy { mode: NetworkMode; domains: string[]; packageRegistries: boolean }

export const defaultNetworkPolicy: NetworkPolicy = Object.freeze({ mode: "off", domains: [], packageRegistries: true }) as NetworkPolicy;
export const networkLimits = { domains: 100 } as const;

/** Package registries an allowlist includes when `packageRegistries` is set. */
export const packageRegistryDomains: readonly string[] = Object.freeze([
  "registry.npmjs.org", "registry.yarnpkg.com", "jsr.io", "npm.jsr.io",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "rubygems.org", "index.rubygems.org",
  "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org",
  "api.nuget.org", "repo.packagist.org",
]);

/** An allowlist entry: a public DNS name without a port, optionally `*.` for any subdomain of it. */
export function validNetworkDomain(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.startsWith("*.") ? value.slice(2) : value;
  return !name.includes(":") && validGitHost(name);
}

/** A policy as the API accepts it; throws on anything else. Domains are kept unique, in order. */
export function parseNetworkPolicy(value: unknown): NetworkPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid network policy");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["mode", "domains", "packageRegistries"].includes(key))) throw new Error("Invalid network policy");
  if (!networkModes.includes(input.mode as NetworkMode)) throw new Error("Invalid network mode");
  if (typeof input.packageRegistries !== "boolean") throw new Error("Invalid package registry setting");
  const domains = input.domains ?? [];
  if (!Array.isArray(domains) || domains.length > networkLimits.domains) throw new Error(`At most ${networkLimits.domains} domains are allowed`);
  const invalid = domains.find(domain => !validNetworkDomain(domain));
  if (invalid !== undefined) throw new Error(`Invalid domain: ${String(invalid).slice(0, 100)}`);
  return { mode: input.mode as NetworkMode, domains: [...new Set(domains as string[])], packageRegistries: input.packageRegistries };
}

function matches(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}

/** Whether the policy lets a session reach `host` (a lowercase DNS name), before the address check. */
export function hostAllowed(policy: NetworkPolicy, host: string): boolean {
  switch (policy.mode) {
    case "off": return false;
    case "open": return true;
    case "allowlist":
      return policy.domains.some(pattern => matches(pattern, host)) || (policy.packageRegistries && packageRegistryDomains.includes(host));
  }
}

/** A workspace repository the egress proxy relays for Git reads, with the session owner's own credential. */
export interface EgressRepository {
  bindingId: string; provider: GitProvider; host: string; fullName: string;
  /** The provider's id of the repository, which keys the host cache; absent from older control planes. */
  repositoryId?: string;
}
/** What the control plane lets one session's egress proxy do; the proxy asks again every minute. */
export interface EgressGrant { policy: NetworkPolicy; repositories: EgressRepository[] }
/**
 * The Git smart-HTTP requests the relay forwards: a fetch's ref advertisement and the fetch itself, and in clone sessions a
 * push's (`receive-refs`, `receive-pack`), which may only update the session branch.
 */
export const egressGitServices = ["info-refs", "upload-pack", "receive-refs", "receive-pack"] as const;
export type EgressGitService = (typeof egressGitServices)[number];
/** The services that only read. */
export const egressReadServices: readonly EgressGitService[] = ["info-refs", "upload-pack"];
/** A push's services: only a clone session's own branch is pushed this way. */
export function egressPushService(service: EgressGitService): service is "receive-refs" | "receive-pack" {
  return !egressReadServices.includes(service);
}
