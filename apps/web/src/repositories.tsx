import { gitProviderHosts, gitProviderNames, repositoryLimits, type GitAccount, type GitProvider, type WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { segment } from "./api";
import { useResource } from "./ui";

const mib = (bytes: number) => bytes / 1024 / 1024;

/** Condensed snapshot, access and limit facts for an `info` tip about repositories. */
export function RepositorySnapshotPolicy() {
  return <div className="stack">
    <p>Each new session pins exact commits, resolved with its owner's connected Git account, into a private per-session snapshot (no Git history, submodules or LFS), one folder per repository (<code>owner/repo</code> for GitHub, under the host name for other providers). Existing sessions never follow later changes.</p>
    <p>Binding a repository grants teammates no access to your Git accounts. Tokens stay on the server; only a push with your own account, where a workspace's push access uses it, sends yours to your own host. The operator of the host running a session can see its files and prompts, including private source.</p>
    <p className="muted small">Limits: {repositoryLimits.repositories} repositories; {mib(repositoryLimits.archiveBytes)} MiB compressed per archive, {mib(repositoryLimits.expandedBytes)} MiB expanded per session, {mib(repositoryLimits.fileBytes)} MiB per file, {repositoryLimits.entries.toLocaleString()} entries. Exceeding a limit fails rather than skipping files.</p>
  </div>;
}

export function useWorkspaceRepositories(workspaceId: string | null) {
  const resource = useResource<{ repositories: WorkspaceRepository[] }>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/repositories` : null);
  return { repositories: resource.data?.repositories ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

/** The caller's connected Git accounts: the GitHub sign-in account first (id "github") when connected, then token accounts. */
export function useGitAccounts(enabled = true) {
  const resource = useResource<{ accounts: GitAccount[] }>(enabled ? "/api/git/accounts" : null);
  return { accounts: resource.data?.accounts ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}

/** Provider name, plus the host when it differs from the provider's default (self-hosted instances). */
export function gitProviderLabel(provider: GitProvider, host: string): string {
  return host === gitProviderHosts[provider].default ? gitProviderNames[provider] : `${gitProviderNames[provider]} (${host})`;
}

/** Provider name with host and organization, for naming one connected account. */
export function gitAccountLabel(account: GitAccount): string {
  return `${gitProviderNames[account.provider]} · ${account.host}${account.organization ? `/${account.organization}` : ""}`;
}
