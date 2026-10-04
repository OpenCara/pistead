import { repositoryLimits, type WorkspaceRepository } from "../../../packages/shared/src/repositories";
import { segment } from "./api";
import { useResource } from "./ui";

const mib = (bytes: number) => bytes / 1024 / 1024;

/** Condensed snapshot, access and limit facts for an `info` tip about repositories. */
export function RepositorySnapshotPolicy() {
  return <div className="stack">
    <p>Each new session pins exact commits, resolved with its owner's GitHub access, into a private per-session snapshot (no Git history, submodules or LFS), one <code>owner/repo</code> folder per repository. Existing sessions never follow later changes.</p>
    <p>Binding a repository grants teammates no GitHub access. GitHub tokens stay on the server. The operator of the host running a session can see its files and prompts, including private source.</p>
    <p className="muted small">Limits: {repositoryLimits.repositories} repositories; {mib(repositoryLimits.archiveBytes)} MiB compressed per archive, {mib(repositoryLimits.expandedBytes)} MiB expanded per session, {mib(repositoryLimits.fileBytes)} MiB per file, {repositoryLimits.entries.toLocaleString()} entries. Exceeding a limit fails rather than skipping files.</p>
  </div>;
}

export function useWorkspaceRepositories(workspaceId: string | null) {
  const resource = useResource<{ repositories: WorkspaceRepository[] }>(workspaceId ? `/api/workspaces/${segment(workspaceId)}/repositories` : null);
  return { repositories: resource.data?.repositories ?? null, loading: resource.loading, error: resource.error, refresh: resource.refresh };
}
