import type { ProviderRepository, TokenGitProvider } from '../../../../packages/shared/src/repositories.js';

/** A decrypted personal-access-token account. Never logged, returned to clients or forwarded across origins. */
export interface GitCredential {
  id: string;
  provider: TokenGitProvider;
  /** API host, e.g. gitlab.com, git.example.com:8443, dev.azure.com, bitbucket.org. */
  host: string;
  /** Azure DevOps organization; empty otherwise. */
  organization: string;
  /** Bitbucket Atlassian account email/username for Basic auth; null uses Bearer (workspace/repository access tokens). */
  username: string | null;
  token: string;
}

/** A pinned or bound repository on one provider. `id` is the provider-stable identity as a string. */
export interface RepositoryRef {
  id: string;
  fullName: string;
}

export interface RepositoryArchive {
  bytes: Uint8Array<ArrayBuffer>;
  /** tar.gz archives must already have exactly one top-level directory; zip archives are converted by the caller. */
  format: 'tar.gz' | 'zip';
}

/**
 * One provider's REST API. Every method throws an HTTPException via `fail()` with a fixed, credential-free message:
 *   401/403/404 from the provider -> 403 `git_repository_unavailable` (or `git_account_rejected` from verify())
 *   other non-2xx, malformed JSON or network errors -> 502 `git_provider_unavailable` / `invalid_git_response`
 * Requests use redirect: 'manual'; a redirect is followed only where the method documents it, and credentials are
 * never sent to a different origin. Bodies are bounded (JSON 512 KiB, archives repositoryLimits.archiveBytes).
 */
export interface GitProviderAdapter {
  /** Confirms the token works and returns the provider's account name. */
  verify(credential: GitCredential): Promise<{ login: string }>;
  /** Repositories the account can read, 30 per page, stable order. */
  list(credential: GitCredential, page: number): Promise<{ repositories: ProviderRepository[]; hasMore: boolean }>;
  /** Current canonical metadata. Callers compare `id` and `fullName` with the binding to detect renames/transfers. */
  repository(credential: GitCredential, repository: RepositoryRef): Promise<ProviderRepository>;
  /** Resolves a branch, tag or commit to an immutable 40-hex commit SHA. */
  commit(credential: GitCredential, repository: RepositoryRef, ref: string): Promise<string>;
  /** Snapshot of exactly `commit`. */
  archive(credential: GitCredential, repository: RepositoryRef, commit: string): Promise<RepositoryArchive>;
}
