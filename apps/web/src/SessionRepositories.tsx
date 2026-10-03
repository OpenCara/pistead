import type { SessionRecord } from "../../../packages/shared/src/types";
import { Empty } from "./ui";

export function RepositorySnapshotPolicy() {
  return <>
    <p className="muted">Repository-backed sessions use a private per-session cache with separate <code>owner/repo</code> directories under one sandbox Git baseline. These are commit-pinned source snapshots, not full Git clones or repository history. Submodules and Git LFS objects are not fetched.</p>
    <p className="muted">Private per-session storage is not hidden from the trusted host: its operator can read the repository files, including private repository content.</p>
    <p className="metadata">Configured storage template: <code>{"DATA_DIR/sessions/<id>/sandbox/worktree"}</code>. <code>DATA_DIR</code> is the runner's configured data directory; this template does not expose its actual host path. Repository cache roots are relative to this session worktree.</p>
  </>;
}

export function SessionRepositories({ session, refresh, selectWorkspace }: { session: SessionRecord; refresh: () => void; selectWorkspace: (id: string) => void }) {
  const repositories = session.repositories ?? [];
  return <section className="section" aria-label="Immutable session repositories">
    <div className="section-heading"><h2>Immutable repository pins</h2><span className="badge">{session.status}</span><button type="button" className="button secondary small" onClick={refresh}>Refresh repository status</button></div>
    <p className="muted">Repository access uses the immutable session owner's GitHub identity, not the host owner's, a workspace admin's, or a collaborator's. Configured refs are resolved to commits before a new session runs. Later workspace binding or branch changes do not change this session's pins.</p>
    {session.status === "provisioning" && <p className="notice" role="status">This session is still provisioning. Recorded pins are not confirmation that repository snapshots have been downloaded or that the cache is ready.</p>}
    {session.status === "error" && <p className="error" role="alert">This session is in an error state. Repository cache availability is not confirmed; recorded pins do not mean provisioning succeeded. Review the session error and host status, then refresh.</p>}
    {session.status === "archived" && <p className="notice">This session is archived. Its recorded pins do not confirm that repository files are still available on the host.</p>}
    {repositories.length ? <>
      <ul className="queue-list">{repositories.map(repository => <li key={repository.bindingId}>
        <h3>{repository.fullName}</h3>
        <p className="metadata">Configured ref at creation: <code>{repository.ref}</code></p>
        <p className="metadata">Immutable commit: <code>{repository.commit}</code></p>
        <p className="metadata">Repository cache root (relative to the session worktree): <code>{repository.path}/</code></p>
      </li>)}</ul>
      <p className="metadata">These pins record the source snapshot inputs, not a live cache availability check.</p>
    </> : <Empty title="No immutable repository pins recorded">{session.status === "provisioning" ? "Provisioning has not exposed any repository pins yet. Refresh to check progress; no repository cache is confirmed ready." : session.status === "error" ? "No repository pins are available for this session. Repository provisioning and cache readiness cannot be confirmed." : "This is a legacy session with no recorded repository pins. Do not assume it has a repository cache or commit-pinned source snapshots. Configure workspace repositories and start a new session to use pinned sources."}</Empty>}
    <p><a className="button secondary small" href="#workspaces" onClick={() => selectWorkspace(session.workspaceId)}>Manage repositories for future sessions</a></p>
    <RepositorySnapshotPolicy />
  </section>;
}
