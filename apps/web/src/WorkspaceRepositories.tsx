import { useState, type FormEvent } from "react";
import { repositoryLimits, type GitHubRepository, type WorkspaceRepository } from "../../../packages/shared/src/repositories";
import type { UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { Details, Empty, Feedback, ResourceState, useAction, useResource } from "./ui";

export function WorkspaceRepositories({ workspace, user, admin, repositories, loading, error, refresh }: { workspace: Workspace; user: UserProfile; admin: boolean; repositories: WorkspaceRepository[] | null; loading: boolean; error: string; refresh: () => void }) {
  const action = useAction();
  const [picking, setPicking] = useState(false);
  const full = (repositories?.length ?? 0) >= repositoryLimits.repositories;
  function remove(repository: WorkspaceRepository) {
    if (action.busy || !admin) return;
    const last = repositories?.length === 1;
    if (!window.confirm(`Remove ${repository.fullName} from ${workspace.name}? Existing sessions keep their pinned snapshots.${last ? " With no repositories, new sessions, pairing and sharing will be disabled until an owner or admin adds a repository." : " This changes new sessions only."}`)) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspace.id)}/repositories/${segment(repository.id)}`, { method: "DELETE" });
      refresh();
    }, "Repository removed. Existing sessions keep their pinned snapshots.");
  }
  const canAdd = admin && user.githubConnected && !full && !picking;
  return <section className="section" id="workspace-repositories" aria-label={`Repositories in ${workspace.name}`}>
    <div className="section-heading"><h2>Repositories</h2><span className="badge">{repositories ? `${repositories.length} / ${repositoryLimits.repositories}` : "Checking"}</span><button type="button" className="button secondary small" disabled={loading || action.busy} onClick={refresh}>Refresh</button>{canAdd && <button type="button" className="button primary small" disabled={loading || Boolean(error) || action.busy} onClick={() => setPicking(true)}>Add repository</button>}</div>
    <ResourceState loading={loading} error={error} retry={refresh}>
      {!repositories?.length ? <Empty title="No repositories yet">{admin ? "Add a GitHub repository to connect a Pi and start sessions." : "Ask a workspace owner or admin to bind a GitHub repository."}</Empty> : <div className="row-list">{repositories.map(repository => <article className="list-row" key={repository.id}><div className="row-main"><h3>{repository.fullName}</h3><p className="metadata"><span className="badge">{repository.private ? "Private" : "Public"}</span> <code>{repository.ref}</code></p></div>{admin && <button type="button" className="button danger small" disabled={action.busy} aria-label={`Remove ${repository.fullName}`} onClick={() => remove(repository)}>Remove</button>}</article>)}</div>}
    </ResourceState>
    <Feedback {...action} />
    {admin && !user.githubConnected && <p className="notice">Connect your GitHub account in <a href="#profile">Profile</a> before choosing repositories.</p>}
    {admin && user.githubConnected && full && <p className="notice">The workspace has reached its {repositoryLimits.repositories}-repository limit. Remove a binding to choose another.</p>}
    {admin && user.githubConnected && !full && picking && <RepositoryPicker key={workspace.id} workspace={workspace} repositories={repositories ?? []} disabled={loading || Boolean(error) || action.busy} refresh={refresh} close={() => setPicking(false)} />}
    <Details summary="How repositories, snapshots and access work">
      {!admin && <p>Only workspace owners and admins can add or remove repositories.</p>}
      <p>Changes apply to new sessions only; existing sessions keep their pinned commits and edits. To change a ref, remove and re-add the repository.</p>
      <p>Binding a repository grants teammates no GitHub access. Each new session resolves refs with its owner's GitHub access and pins exact commits into a private, per-session snapshot (no Git history, submodules or LFS), one <code>owner/repo</code> folder per repository.</p>
      <p>The operator of the Pi host running a session can see its repository files and prompts, including private source. GitHub tokens stay on the server, never in the browser or on the host.</p>
      <p className="metadata">Limits: {repositoryLimits.repositories} repositories; {repositoryLimits.archiveBytes / 1024 / 1024} MiB compressed per archive, {repositoryLimits.expandedBytes / 1024 / 1024} MiB expanded per session, {repositoryLimits.fileBytes / 1024 / 1024} MiB per file, {repositoryLimits.entries.toLocaleString()} entries. Exceeding a limit fails with an error rather than skipping files.</p>
    </Details>
  </section>;
}

function RepositoryPicker({ workspace, repositories, disabled, refresh, close }: { workspace: Workspace; repositories: WorkspaceRepository[]; disabled: boolean; refresh: () => void; close: () => void }) {
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState("");
  const [ref, setRef] = useState("");
  const resource = useResource<{ repositories: GitHubRepository[]; page: number; hasMore: boolean }>(`/api/github/repositories?page=${page}`);
  const action = useAction();
  const selected = resource.data?.repositories.find(repository => String(repository.id) === selectedId);
  const alreadyBound = (repository: GitHubRepository) => repositories.some(binding => binding.repositoryId === repository.id || binding.fullName.toLowerCase() === repository.fullName.toLowerCase());
  const blocked = disabled || action.busy || resource.loading || Boolean(resource.error) || !selected || alreadyBound(selected) || repositories.length >= repositoryLimits.repositories;
  function changePage(next: number) { setSelectedId(""); setRef(""); setPage(next); }
  function add(event: FormEvent) {
    event.preventDefault();
    if (blocked || !selected) return;
    void action.run(async () => {
      await api(`/api/workspaces/${segment(workspace.id)}/repositories`, { method: "POST", body: { repositoryId: selected.id, fullName: selected.fullName, ...(ref.trim() ? { ref: ref.trim() } : {}) } });
      refresh();
      close();
    });
  }
  return <form onSubmit={add} className="repository-picker"><h3>Add a GitHub repository</h3><p className="muted">Only repositories your GitHub account can access are listed. Never paste a token or clone URL.</p>
    <ResourceState {...resource} retry={resource.refresh}>
      {!resource.data?.repositories.length ? <Empty title="No repositories on this page">Check your GitHub account and organization access, or return to a previous page.</Empty> : <><label className="field">GitHub repository<select required value={selectedId} disabled={disabled || action.busy} onChange={event => { setSelectedId(event.target.value); setRef(""); }}><option value="">Choose a repository</option>{resource.data.repositories.map(repository => <option key={repository.id} value={repository.id} disabled={alreadyBound(repository)}>{repository.fullName} / {repository.private ? "Private" : "Public"}{alreadyBound(repository) ? " / Already configured" : ""}</option>)}</select></label><label className="field">Branch, tag or commit (optional)<input value={ref} onChange={event => setRef(event.target.value)} disabled={disabled || action.busy || !selected} autoComplete="off" spellCheck={false} maxLength={255} placeholder={selected?.defaultBranch ?? "Repository default branch"} /></label><p className="metadata">Leave blank to use {selected ? `the default branch, ${selected.defaultBranch}` : "the repository's default branch"}. New sessions resolve and pin this ref to a commit; existing sessions never follow branch changes.</p></>}
    </ResourceState>
    <div className="actions"><button type="button" className="button secondary small" disabled={page === 1 || resource.loading || action.busy} onClick={() => changePage(page - 1)}>Previous page</button><span className="metadata" role="status">GitHub page {page}</span><button type="button" className="button secondary small" disabled={!resource.data?.hasMore || resource.loading || Boolean(resource.error) || action.busy} onClick={() => changePage(page + 1)}>Next page</button></div>
    {resource.error && <p className="muted">Review your <a href="#profile">GitHub connection</a> and repository access, then retry. An owner or admin with access can also configure this workspace.</p>}
    <Feedback {...action} /><div className="actions"><button className="button primary" disabled={blocked}>{action.busy ? "Binding repository..." : "Bind repository"}</button><button type="button" className="button secondary" disabled={action.busy} onClick={close}>Cancel</button></div>
  </form>;
}
