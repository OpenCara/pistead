import type { ProviderRepository, ProviderRepositoryList, TokenGitProvider } from '../../../../packages/shared/src/repositories.js';

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

/** A bound repository on one provider. `id` is the provider-stable identity as a string. */
export interface RepositoryRef {
  id: string;
  fullName: string;
}

/**
 * One provider's REST API. Every method throws an HTTPException via `fail()` with a fixed, credential-free message:
 *   401/403/404 from the provider -> 403 `git_repository_unavailable` (or `git_account_rejected` from verify())
 *   other non-2xx, malformed JSON or network errors -> 502 `git_provider_unavailable` / `invalid_git_response`
 * Requests use redirect: 'manual'; a redirect is followed only where the method documents it, and credentials are
 * never sent to a different origin. Bodies are bounded (JSON 512 KiB, repository list pages 2 MiB and Azure DevOps'
 * unpaged listing 4 MiB).
 */
export interface GitProviderAdapter {
  /** Confirms the token works and returns the provider's account name. */
  verify(credential: GitCredential): Promise<{ login: string }>;
  /** Every repository the account can read in a stable order, stopping at repositoryLimits.pickerRepositories. */
  list(credential: GitCredential): Promise<ProviderRepositoryList>;
  /** Current canonical metadata. Callers compare `id` and `fullName` with the binding to detect renames/transfers. */
  repository(credential: GitCredential, repository: RepositoryRef): Promise<ProviderRepository>;
  /** Resolves a branch, tag or commit to an immutable 40-hex commit SHA. */
  commit(credential: GitCredential, repository: RepositoryRef, ref: string): Promise<string>;
}
