import { gitProviderHosts, gitProviderNames, repositoryLimits, type GitAccount, type GitProvider, type WorkspaceRepositoryList } from "../../../packages/shared/src/repositories";
import { segment } from "./api";
import { useResource } from "./ui";

/** Condensed clone, access and host facts for an `info` tip about repositories. */
export function RepositoryClonePolicy() {
  return <div className="stack">
    <p>Each session starts with an empty worktree, and its agent clones the workspace repositories it needs with Git, through the session's relay: reads use the session owner's connected Git account and pushes go only to the session's own branches. On a host without a sandbox, the host owner's sessions clone with the host's own Git. Sessions created before sessions cloned keep their pinned snapshots, read-only.</p>
    <p>Binding a repository grants teammates no access to your Git accounts. Tokens stay on the server; only a push with your own account, where a workspace's push access uses it, sends yours to your own host. The operator of the host running a session can see its files and prompts, including private source.</p>
    <p className="muted small">Limit: {repositoryLimits.repositories} repositories per workspace.</p>
  </div>;
}

/** `required`: the signed-in user's sessions and hosts in this workspace need a repository (until loaded, assume so). */
export function useWorkspaceRepositories(workspaceId: string | null) {
  const resource = useResource<WorkspaceRepositoryList>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/repositories` : null);
  return { repositories: resource.data?.repositories ?? null, required: resource.data?.required ?? true, loading: resource.loading, error: resource.error, refresh: resource.refresh };
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
