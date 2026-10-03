import { useState, type FormEvent } from "react";
import { repositoryLimits, type GitHubRepository, type WorkspaceRepository } from "../../../packages/shared/src/repositories";
import type { UserProfile, Workspace } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { Empty, Feedback, ResourceState, useAction, useResource } from "./ui";

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
  return <section className="section" aria-label={`Repository setup for ${workspace.name}`}>
    <div className="section-heading"><span className="section-number">02</span><h2>Repositories in {workspace.name}</h2><span className="badge">{repositories ? `${repositories.length} / ${repositoryLimits.repositories}` : "Checking setup"}</span><button type="button" className="button secondary small" disabled={loading || action.busy} onClick={refresh}>Refresh repositories</button></div>
    <p>Bind the source repositories before connecting a Pi. Owners and admins configure this list; all workspace members can see its setup status.</p>
    <ResourceState loading={loading} error={error} retry={refresh}>
      {!repositories?.length ? <Empty title="Choose where the work begins">No repositories are configured. {admin ? "Choose an authorized GitHub repository below to connect your private Pi and start sessions. Host sharing is optional." : "Ask a workspace owner or admin to bind at least one GitHub repository before connecting a Pi or starting a session."}</Empty> : <><p className="notice" role="status">Repository setup is complete. Next: connect your Pi for your own use, then run a private agent without publishing. Sharing the Pi is optional.</p><div className="row-list">{repositories.map(repository => <article className="list-row" key={repository.id}><div className="row-main"><h3>{repository.fullName}</h3><p className="metadata">{repository.private ? "Private" : "Public"} / Ref: <code>{repository.ref}</code></p><p className="metadata">Snapshot folder: <code>{repository.fullName}/</code></p></div>{admin && <button type="button" className="button danger small" disabled={action.busy} aria-label={`Remove ${repository.fullName}`} onClick={() => remove(repository)}>Remove</button>}</article>)}</div></>}
    </ResourceState>
    <Feedback {...action} />
    <p className="muted">Configuration changes apply to new sessions only. Existing sessions keep their pinned commits and edits. To change a ref, remove and re-add the repository.</p>
    {admin ? !user.githubConnected ? <p className="notice">Connect your GitHub account in <a href="#profile">Profile</a> before choosing repositories.</p> : full ? <p className="notice">The workspace has reached its {repositoryLimits.repositories}-repository limit. Remove a binding to choose another.</p> : picking ? <RepositoryPicker key={workspace.id} workspace={workspace} repositories={repositories ?? []} disabled={loading || Boolean(error) || action.busy} refresh={refresh} close={() => setPicking(false)} /> : <div className="actions"><button type="button" className="button secondary" disabled={loading || Boolean(error) || action.busy} onClick={() => setPicking(true)}>Choose GitHub repository</button></div> : <p className="muted">Only workspace owners and admins can add or remove repositories.</p>}
    <details className="repository-policy"><summary>GitHub access, private snapshots and host trust</summary><p>The picker uses your current GitHub account. Binding a repository does not grant GitHub access to teammates. Every new session resolves these refs using its immutable session owner's GitHub access, never the workspace admin's or host owner's access.</p><p>Each session pins exact commits and prepares a private, session-specific source cache before the agent runs. These are commit-pinned source snapshots, not full Git clones or history. Multiple repositories live in separate <code>owner/repo</code> folders under one sandbox baseline. Submodules and Git LFS contents are not fetched.</p><p>A trusted Pi host's operator can see repository files and prompts processed on that machine, including private source. GitHub tokens stay on the server, not in the browser or on the Pi host. Private caches are separate between sessions, not hidden from their host operator.</p><p className="metadata">At most {repositoryLimits.repositories} repositories; {repositoryLimits.archiveBytes / 1024 / 1024} MiB compressed per archive, {repositoryLimits.expandedBytes / 1024 / 1024} MiB expanded across the session, {repositoryLimits.fileBytes / 1024 / 1024} MiB per file, and {repositoryLimits.entries.toLocaleString()} entries total. Unsupported archive contents or size limits fail with an error rather than silently skipping files.</p></details>
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
  return <form onSubmit={add} className="repository-picker"><h3>Choose from your GitHub repositories</h3><p className="muted">Only repositories accessible to your signed-in GitHub account are listed. Organization restrictions may require additional GitHub authorization. Never paste a token or clone URL here.</p>
    <ResourceState {...resource} retry={resource.refresh}>
      {!resource.data?.repositories.length ? <Empty title="No repositories on this page">Check your GitHub account and organization access, or return to a previous page.</Empty> : <><label className="field">GitHub repository<select required value={selectedId} disabled={disabled || action.busy} onChange={event => { setSelectedId(event.target.value); setRef(""); }}><option value="">Choose a repository</option>{resource.data.repositories.map(repository => <option key={repository.id} value={repository.id} disabled={alreadyBound(repository)}>{repository.fullName} / {repository.private ? "Private" : "Public"}{alreadyBound(repository) ? " / Already configured" : ""}</option>)}</select></label><label className="field">Branch, tag or commit (optional)<input value={ref} onChange={event => setRef(event.target.value)} disabled={disabled || action.busy || !selected} autoComplete="off" spellCheck={false} maxLength={255} placeholder={selected?.defaultBranch ?? "Repository default branch"} /></label><p className="metadata">Leave blank to use {selected ? `the default branch, ${selected.defaultBranch}` : "the repository's default branch"}. New sessions resolve and pin this ref to a commit; existing sessions never follow branch changes.</p></>}
    </ResourceState>
    <div className="actions"><button type="button" className="button secondary small" disabled={page === 1 || resource.loading || action.busy} onClick={() => changePage(page - 1)}>Previous page</button><span className="metadata" role="status">GitHub page {page}</span><button type="button" className="button secondary small" disabled={!resource.data?.hasMore || resource.loading || Boolean(resource.error) || action.busy} onClick={() => changePage(page + 1)}>Next page</button></div>
    {resource.error && <p className="muted">Review your <a href="#profile">GitHub connection</a> and repository access, then retry. An owner or admin with access can also configure this workspace.</p>}
    <Feedback {...action} /><div className="actions"><button className="button primary" disabled={blocked}>{action.busy ? "Binding repository..." : "Bind repository"}</button><button type="button" className="button secondary" disabled={action.busy} onClick={close}>Cancel</button></div>
  </form>;
}
