import { validGitHost, type GitProvider } from "./repositories.js";
import type { GrantSource } from "./sources.js";

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
  /**
   * Whether the workspace lets sessions download this repository's Git LFS objects (a per-repository setting, off by
   * default). Absent from older control planes, which relay no LFS requests.
   */
  lfs?: boolean;
}
/** What the control plane lets one session's egress proxy do; the proxy asks again every minute. */
export interface EgressGrant {
  policy: NetworkPolicy;
  repositories: EgressRepository[];
  /**
   * The workspace's document sources (Notion, Google Drive, Feishu/Lark), which the agent reads through
   * the control plane (source_read), never through the proxy. Absent from older control planes.
   */
  sources?: GrantSource[];
}
/**
 * The Git requests the relay forwards: a fetch's ref advertisement and the fetch itself; in clone sessions a push's
 * (`receive-refs`, `receive-pack`), which may only update the session branch; and, for repositories with Git LFS on,
 * LFS downloads (`lfs-batch`, `lfs-object`).
 */
export const egressGitServices = ["info-refs", "upload-pack", "receive-refs", "receive-pack", "lfs-batch", "lfs-object"] as const;
export type EgressGitService = (typeof egressGitServices)[number];
/** The Git smart-HTTP services that only read; a refusal of one of them also ends a session's use of the host's mirror. */
export const egressReadServices: readonly EgressGitService[] = ["info-refs", "upload-pack"];
/** A push's services: only a clone session's own branch is pushed this way. */
export function egressPushService(service: EgressGitService): service is "receive-refs" | "receive-pack" {
  return service === "receive-refs" || service === "receive-pack";
}
/** Git LFS downloads; uploads are never relayed. */
export function egressLfsService(service: EgressGitService): service is "lfs-batch" | "lfs-object" {
  return service === "lfs-batch" || service === "lfs-object";
}

/**
 * Git LFS through the relay. The proxy turns git-lfs's batch API into these requests, and the control plane answers
 * them with the session owner's own credential; the provider's download URLs and their headers never reach the host.
 */
export const lfsLimits = {
  /** Objects in one batch request: git-lfs asks for 100 at a time by default. */
  batchObjects: 100,
  /** One LFS object; GitHub's own limit is 5 GiB on its largest plans. */
  objectBytes: 8 * 1024 * 1024 * 1024,
} as const;
/** One object of an `lfs-batch` request, or the object an `lfs-object` request downloads. */
export interface LfsObject { oid: string; size: number }
export interface LfsBatchRequest { objects: LfsObject[]; ref?: string }
/** The control plane's answer to `lfs-batch`: for each requested object, whether it can be downloaded or why not. */
export interface LfsBatchResult {
  objects: (LfsObject & { download: boolean; error?: { code: number; message: string } })[];
}

/** A Git LFS object id: the SHA-256 of its content, in lowercase hex. */
export function validLfsOid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function validLfsSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= lfsLimits.objectBytes;
}
/** An `lfs-object` request, or a batch's object; throws on anything else. */
export function parseLfsObject(value: unknown): LfsObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Git LFS object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "oid" && key !== "size") || !validLfsOid(input.oid) || !validLfsSize(input.size)) {
    throw new Error("Invalid Git LFS object");
  }
  return { oid: input.oid, size: input.size };
}
/** An `lfs-batch` request; throws on anything else. The ref is only passed on, as git-lfs sends it. */
export function parseLfsBatchRequest(value: unknown): LfsBatchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Git LFS batch request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "objects" && key !== "ref")) throw new Error("Invalid Git LFS batch request");
  if (!Array.isArray(input.objects) || !input.objects.length || input.objects.length > lfsLimits.batchObjects) {
    throw new Error(`A Git LFS batch names 1 to ${lfsLimits.batchObjects} objects`);
  }
  const objects = input.objects.map(parseLfsObject);
  if (input.ref !== undefined && (typeof input.ref !== "string" || !/^refs\/[\x21-\x7e]{1,250}$/.test(input.ref))) throw new Error("Invalid Git LFS ref");
  return { objects, ...(input.ref !== undefined ? { ref: input.ref } : {}) };
}
