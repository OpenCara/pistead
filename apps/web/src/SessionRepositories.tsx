import type { SessionRecord } from "../../../packages/shared/src/types";
import { Details, Empty } from "./ui";

export function RepositorySnapshotPolicy() {
  return <Details summary="How repository snapshots work">
    <p>Each repository is a commit-pinned source snapshot in its own <code>owner/repo</code> folder, not a full clone: no history, submodules, or Git LFS objects.</p>
    <p>Snapshots live in private per-session storage, but the host operator can still read them, including private repository content.</p>
    <p className="metadata">Location: <code>{"DATA_DIR/sessions/<id>/sandbox/worktree"}</code>, where <code>DATA_DIR</code> is the runner's data directory (the actual host path is not shown).</p>
  </Details>;
}

export function SessionRepositories({ session, refresh, selectWorkspace }: { session: SessionRecord; refresh: () => void; selectWorkspace: (id: string) => void }) {
  const repositories = session.repositories ?? [];
  return <>
    {session.status === "error" && <p className="error" role="alert">This session is in an error state, so repository snapshots are not confirmed. Check the host, then refresh.</p>}
    <Details summary={<>Repositories <span className="badge">{repositories.length}</span></>}>
      {session.status === "provisioning" && <p className="notice" role="status">Still provisioning. Pins below don't mean snapshots are downloaded yet.</p>}
      {session.status === "archived" && <p className="notice">Archived. Pinned files may no longer be on the host.</p>}
      {repositories.length ? <ul className="queue-list">{repositories.map(repository => <li key={repository.bindingId}>
        <h3>{repository.fullName}</h3>
        <p className="metadata">Ref <code>{repository.ref}</code> at commit <code>{repository.commit}</code></p>
        <p className="metadata">Folder: <code>{repository.path}/</code></p>
      </li>)}</ul> : <Empty title="No repository pins">{session.status === "provisioning" ? "None recorded yet. Refresh to check progress." : session.status === "error" ? "None are available for this session." : "This older session has no pinned repositories. Start a new session to use them."}</Empty>}
      <p className="metadata">Pins are fixed at session start using the session owner's GitHub access, not the host owner's or a collaborator's. They record source inputs, not live cache status; later workspace changes don't affect them.</p>
      <div className="actions">
        <button type="button" className="button secondary small" onClick={refresh}>Refresh</button>
        <a className="button secondary small" href="#workspaces" onClick={() => selectWorkspace(session.workspaceId)}>Manage repositories for future sessions</a>
      </div>
      <RepositorySnapshotPolicy />
    </Details>
  </>;
}
