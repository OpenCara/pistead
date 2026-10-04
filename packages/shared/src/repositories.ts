/**
 * Git hosting providers for workspace repositories. GitHub (github.com) uses the sign-in OAuth token; every other
 * provider uses a personal access token the user connects in Settings. Sign-in itself stays GitHub-only.
 */
export const gitProviders = ["github", "github-enterprise", "gitlab", "bitbucket", "azure-devops", "gitea"] as const;
export type GitProvider = (typeof gitProviders)[number];
/** Providers connected with a personal access token (everything except github.com OAuth). */
export type TokenGitProvider = Exclude<GitProvider, "github">;

export const gitProviderNames: Record<GitProvider, string> = {
  github: "GitHub",
  "github-enterprise": "GitHub Enterprise Server",
  gitlab: "GitLab",
  bitbucket: "Bitbucket Cloud",
  "azure-devops": "Azure DevOps",
  gitea: "Gitea / Forgejo",
};

/** Fixed API hosts. A null entry means the user supplies the host (self-hosted); GitLab defaults to gitlab.com. */
export const gitProviderHosts: Record<GitProvider, { fixed: string | null; default: string | null }> = {
  github: { fixed: "github.com", default: "github.com" },
  "github-enterprise": { fixed: null, default: null },
  gitlab: { fixed: null, default: "gitlab.com" },
  bitbucket: { fixed: "bitbucket.org", default: "bitbucket.org" },
  "azure-devops": { fixed: "dev.azure.com", default: "dev.azure.com" },
  gitea: { fixed: null, default: null },
};

/**
 * A self-hosted provider host: a public DNS name, optionally with a port, reached over HTTPS only.
 * IP literals, single-label and local/internal names are refused; the Worker never fetches private networks.
 */
export function validGitHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase()) return false;
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([1-9]\d{0,4}))?$/.exec(value);
  if (!match) return false;
  const name = match[1]!;
  if (match[2] !== undefined && Number(match[2]) > 65535) return false;
  if (/^[\d.]+$/.test(name) || /\.(?:local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(name) || name === "localhost") return false;
  return /[a-z]/.test(name.split(".").at(-1)!);
}

const segment = /^[A-Za-z0-9_.-]{1,100}$/;
/** Azure DevOps project and repository names may contain spaces and a few punctuation marks. */
const azureSegment = /^[A-Za-z0-9_.\- ()&'+,=@$!]{1,100}$/;

/** Canonical repository name per provider: owner/name, GitLab group paths, or Azure organization/project/repository. */
export function validRepositoryName(provider: GitProvider, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 400 || value !== value.trim()) return false;
  const parts = value.split("/");
  if (parts.some(part => [".", "..", ".git"].includes(part.toLowerCase()) || part.startsWith(" ") || part.endsWith(" "))) return false;
  switch (provider) {
    case "github":
    case "github-enterprise":
      return parts.length === 2 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]!) && segment.test(parts[1]!);
    case "bitbucket":
    case "gitea":
      return parts.length === 2 && parts.every(part => segment.test(part));
    case "gitlab":
      return parts.length >= 2 && parts.length <= 20 && parts.every(part => segment.test(part));
    case "azure-devops":
      return parts.length === 3 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/.test(parts[0]!) && azureSegment.test(parts[1]!) && azureSegment.test(parts[2]!);
  }
}

/** Provider-stable repository identity: GitHub numeric ids, or opaque strings (GitLab/Gitea numeric, Bitbucket and Azure UUIDs). */
export function validRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9{}_-]{1,100}$/.test(value);
}

/** One repository visible through a connected account, as offered by the repository picker. */
export interface ProviderRepository {
  /** Provider-stable identity; GitHub numeric ids are rendered as decimal strings. */
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** A connected Git account. The GitHub sign-in account has id "github"; token accounts have generated ids. */
export interface GitAccount {
  id: string;
  provider: GitProvider;
  host: string;
  /** Azure DevOps organization; empty for other providers. */
  organization: string;
  /** Account name reported by the provider when the token was verified. */
  login: string;
  createdAt: string | null;
}

export interface WorkspaceRepository {
  id: string;
  workspaceId: string;
  provider: GitProvider;
  host: string;
  repositoryId: string;
  fullName: string;
  ref: string;
  private: boolean;
  createdAt: string;
}

/**
 * Immutable session pin. GitHub pins keep their original shape (numeric repositoryId, no provider/host) so existing
 * sessions' persisted bindings stay byte-identical; every other provider adds provider and host and uses a string id.
 */
export type SessionRepository = GitHubSessionRepository | ProviderSessionRepository;
export interface GitHubSessionRepository {
  bindingId: string;
  repositoryId: number;
  fullName: string;
  ref: string;
  commit: string;
  path: string;
}
export interface ProviderSessionRepository {
  bindingId: string;
  provider: TokenGitProvider;
  host: string;
  repositoryId: string;
  fullName: string;
  ref: string;
  commit: string;
  path: string;
}

export function sessionRepositoryProvider(repository: SessionRepository): GitProvider {
  return "provider" in repository ? repository.provider : "github";
}

/**
 * Worktree directory of a pinned repository. GitHub keeps owner/name; other providers live under their host so names
 * from different providers never collide, with characters outside [A-Za-z0-9._-] replaced by "-".
 */
export function repositoryPath(repository: { provider?: GitProvider; host?: string; fullName: string }): string {
  if (!repository.provider || repository.provider === "github") return repository.fullName;
  const parts = [repository.host ?? "", ...repository.fullName.split("/")].map(part => part.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "-"));
  return parts.join("/");
}

// Extraction limits are aggregate across all repositories in one session.
export const repositoryLimits = {
  repositories: 5,
  archiveBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  // Real repositories vendor prebuilt binaries (multi-MiB dylibs/tools); the aggregate bounds above still apply.
  fileBytes: 8 * 1024 * 1024,
  entries: 10000,
} as const;
