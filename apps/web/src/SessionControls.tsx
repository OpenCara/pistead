import { useState, type FormEvent } from "react";
import { permissions, type ApprovalRecord, type Operation, type Permission, type SessionGrant, type SessionRecord, type UserProfile } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { BackupRestore, type Backup } from "./BackupRestore";
import { Feedback, ResourceState, Timestamp, useAction, useResource } from "./ui";

type Props = {
  session: SessionRecord;
  user: UserProfile;
  onChange: () => void;
  busy?: boolean;
  openSession?: (id: string) => void;
};
type AuditEvent = { id: string; actorId: string; action: string; detail: unknown; createdAt: string };

function detailText(detail: unknown): string {
  if (typeof detail === "string") {
    try { return JSON.stringify(JSON.parse(detail), null, 2); }
    catch { return detail; }
  }
  return JSON.stringify(detail, null, 2) ?? "";
}

export function SessionControls({ session, user, onChange, busy, openSession }: Props) {
  // Reset drafts and results when the session, identity, or explicit grants change.
  return <Controls key={JSON.stringify([session.id, session.ownerId, user.id, session.permissions])} session={session} user={user} onChange={onChange} busy={busy} openSession={openSession} />;
}

function Controls({ session, user, onChange, busy = false, openSession }: Props) {
  const ownPermissions = session.permissions ?? [];
  const isOwner = session.ownerId === user.id;
  const visibility = session.visibility ?? "private";
  const viewerOnly = !isOwner && !ownPermissions.some(permission => permission !== "read");
  const grantable = permissions.filter(permission => ownPermissions.includes(permission) || (permission === "read" && ownPermissions.length > 0));
  const canManage = ownPermissions.includes("manage");
  const canWrite = ownPermissions.includes("write");
  const base = `/api/sessions/${segment(session.id)}`;
  const grants = useResource<{ grants: SessionGrant[] }>(canManage ? `${base}/grants` : null);
  const audit = useResource<{ events: AuditEvent[] }>(`${base}/audit`);
  const action = useAction();
  const [userId, setUserId] = useState("");
  const [selected, setSelected] = useState<Permission[]>([]);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [approval, setApproval] = useState<Pick<ApprovalRecord, "id" | "status"> | null>(null);
  const [kind, setKind] = useState<Operation["kind"]>("git.commit");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [repository, setRepository] = useState("");
  const [issue, setIssue] = useState("");
  const [body, setBody] = useState("");
  const target = userId.trim();
  const ownerSelected = target === session.ownerId;
  const existing = grants.data?.grants.find(grant => grant.userId === target);
  const grantReady = canManage && !ownerSelected && Boolean(target) && selected.length > 0
    && selected.every(permission => grantable.includes(permission));
  const issueNumber = Number(issue);
  const operationReady = kind === "git.commit" ? Boolean(message.trim()) : kind === "bash" ? Boolean(command.trim())
    : /^[^/\s]+\/[^/\s]+$/.test(repository.trim()) && Number.isSafeInteger(issueNumber) && issueNumber > 0 && Boolean(body.trim());

  function chooseGrant(value: string) {
    setUserId(value);
    setSelected([...(grants.data?.grants.find(grant => grant.userId === value.trim())?.permissions ?? [])]);
  }

  function changed() {
    audit.refresh();
    onChange();
  }

  function changeVisibility() {
    if (!isOwner || action.busy) return;
    const nextVisibility = visibility === "workspace" ? "private" : "workspace";
    const confirmation = nextVisibility === "workspace"
      ? "Make this session workspace-visible? All workspace members will be able to view existing and future prompts and output, including tool output, repository content shown in the transcript, and side asks, which may contain sensitive information. This grants viewing only, not direct GitHub access, permission to run tools, or ask/control permissions. Continue?"
      : "Make this session private? Workspace membership will no longer grant viewing access. Existing explicit grants will remain in effect, and previously viewed or copied content cannot be recalled.";
    if (!window.confirm(confirmation)) return;
    void action.run(async () => {
      await api(base, { method: "PATCH", body: { visibility: nextVisibility } });
      changed();
    }, nextVisibility === "workspace"
      ? "Session is workspace-visible. Workspace members can view prompts and output."
      : "Session is private. Existing explicit grants still apply.");
  }

  function saveGrant(event: FormEvent) {
    event.preventDefault();
    if (!grantReady || action.busy) return;
    void action.run(async () => {
      await api(`${base}/grants`, {
        method: "POST", body: { userId: target, permissions: selected },
      });
      grants.refresh();
      changed();
    }, "Session grant saved.");
  }

  function revoke() {
    if (!canManage || ownerSelected || !existing || action.busy) return;
    const confirmation = visibility === "workspace"
      ? `Revoke the explicit grant for ${target}? They can still view prompts and output as a workspace member while this session is workspace-visible. Only the owner can make it private to remove workspace viewing.`
      : `Revoke the explicit session grant for ${target}?`;
    if (!window.confirm(confirmation)) return;
    void action.run(async () => {
      await api(`${base}/grants/${segment(target)}`, { method: "DELETE" });
      chooseGrant("");
      grants.refresh();
      changed();
    }, visibility === "workspace" ? "Explicit grant revoked. Workspace members can still view this session until the owner makes it private." : "Session grant revoked.");
  }

  function createBackup() {
    if (!isOwner || busy || action.busy) return;
    setBackup(null);
    void action.run(async () => {
      const result = await api<{ backup: Backup }>(`${base}/backup`, { method: "POST" });
      setBackup(result.backup);
      changed();
    }, "Backup created.");
  }

  function requestOperation(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !operationReady || action.busy) return;
    const operation: Operation = kind === "git.commit" ? { kind, message }
      : kind === "bash" ? { kind, command }
      : { kind, repository: repository.trim(), issue: issueNumber, body };
    setApproval(null);
    void action.run(async () => {
      const result = await api<{ approval: ApprovalRecord }>(`${base}/operations`, { method: "POST", body: operation });
      setApproval({ id: result.approval.id, status: result.approval.status });
      changed();
    }, "Operation requested. Review its approval in the session.");
  }

  return <section aria-label="Session controls">
    <section className="section">
      <h2>Session access</h2>
      <p>Your permissions: {ownPermissions.join(", ") || "None"}.</p>
      <p className="metadata">Workspace visibility grants read access only. Ask, write, approve, and manage remain separate permissions. The server authorizes every request.</p>
      {viewerOnly && <p className="notice">Viewer-only access: you can follow prompts and output, but cannot ask, write, approve, manage grants, or change visibility.</p>}
      <p>Owner: <span className="mono">{session.ownerId}</span> (owner access cannot be changed).</p>
      {!canManage && <p>Managing explicit grants requires manage permission.</p>}
      <p>Only the session owner can change visibility or create, list, download, and restore backups, even when another member has manage permission.</p>
    </section>
    <section className="section" aria-label="Session visibility">
      <h2>Visibility: {visibility === "workspace" ? "Workspace-visible" : "Private"}</h2>
      <p>{visibility === "workspace"
        ? "All workspace members can view existing and future prompts and output, including tool output, repository content shown in the transcript, and side asks. Viewing alone does not allow asking or controlling this session."
        : "Only the owner and members with explicit session grants can view prompts and output. Private does not mean owner-only when grants exist."}</p>
      <p className="metadata">Session visibility does not grant direct GitHub access or permission to run tools. It is separate from private host sharing and agent publication: it does not share the host or publish an agent.</p>
      {isOwner ? <>
        <p className="notice">{visibility === "workspace"
          ? "Making this session private removes workspace-wide viewing, but preserves explicit grants. It cannot recall content already viewed or copied."
          : "Before making this session workspace-visible, review existing prompts and output, including tool output, repository content shown in the transcript, and side asks, for secrets or sensitive information. All workspace members will gain access to existing and future content."}</p>
        <button type="button" className="button secondary" disabled={action.busy} onClick={changeVisibility}>
          {visibility === "workspace" ? "Make private" : "Make workspace-visible"}
        </button>
      </> : <p>Only the session owner can change visibility. Read access or manage permission does not allow you to change it.</p>}
    </section>
    <Feedback {...action} />
    {canManage && <section className="section">
        <div className="section-heading"><h2>Session grants</h2><button type="button" className="button secondary small" disabled={grants.loading} onClick={grants.refresh}>Refresh grants</button></div>
        <p>The user must already be a member of this workspace. Membership grants viewing only when the session is workspace-visible; other permissions require explicit grants.</p>
        <p className="notice">{visibility === "workspace"
          ? "Revoking an explicit grant does not stop workspace members from viewing prompts and output. The owner must also make the session private to remove workspace-wide viewing."
          : "Explicit grants allow access to this private session. If the owner makes it workspace-visible, revoking grants alone will no longer remove member viewing access."}</p>
        <ResourceState {...grants} retry={grants.refresh}>
          {grants.data && <>
            {!grants.data.grants.length && <p>No explicit member grants.</p>}
            <form onSubmit={saveGrant}>
              <fieldset disabled={action.busy}>
                <label className="field">Existing member grant
                  <select value={existing ? target : ""} onChange={event => chooseGrant(event.target.value)}>
                    <option value="">New grant</option>
                    {grants.data.grants.map(grant => <option key={grant.userId} value={grant.userId}>
                      {grant.userId}{grant.userId === session.ownerId ? " (owner, immutable)" : ""}: {grant.permissions.join(", ") || "None"}
                    </option>)}
                  </select>
                </label>
                <label className="field">Workspace member user ID
                  <input required autoComplete="off" value={userId} onChange={event => chooseGrant(event.target.value)} />
                </label>
                <fieldset disabled={ownerSelected}>
                  <legend>Grant permissions</legend>
                  {permissions.map(permission => <label className="check-label" key={permission}>
                    <input type="checkbox" checked={selected.includes(permission)} disabled={!grantable.includes(permission)}
                      onChange={event => setSelected(current => event.target.checked ? [...current, permission] : current.filter(value => value !== permission))} />
                    {permission}{!grantable.includes(permission) ? " (not yours to grant)" : ""}
                  </label>)}
                </fieldset>
                <p className="metadata">Grant only permissions you hold. Ask, write, approve, and manage each imply read, not one another.</p>
                {ownerSelected && <p>The owner's grant is immutable.</p>}
                <button className="button primary" disabled={!grantReady}>Save grant</button>
                {existing && !ownerSelected && <button type="button" className="button secondary" onClick={revoke}>Revoke grant</button>}
              </fieldset>
            </form>
          </>}
        </ResourceState>
      </section>}
    {isOwner && <section className="section">
        <h2>Backup</h2>
        <button type="button" className="button secondary" disabled={busy || action.busy} onClick={createBackup}>Create backup</button>
        {busy && <p role="status">Backup creation is unavailable while session work is queued or running, or live state cannot be confirmed.</p>}
        <p className="metadata">Only the session owner can create, list, download, or restore backups; manage permission is not enough. The server checks access and whether the session is idle.</p>
        {backup && <div role="status" style={{ overflowWrap: "anywhere" }}>
          <p>Backup created: <span className="mono">{backup.id}</span></p>
          <p>Session: {backup.sessionId}</p><p>Size: {backup.size} bytes</p>
          <p>SHA-256: <code>{backup.sha256}</code></p>
          <p>Created: <Timestamp value={backup.createdAt} /></p>
          <a className="button secondary" href={`${base}/backups/${segment(backup.id)}/download`}>Download backup</a>
        </div>}
      </section>}
    {isOwner && <BackupRestore sourceId={session.id} ownerId={session.ownerId} latestBackup={backup} openSession={openSession} />}
      <section className="section">
        <h2>Audit</h2>
        <button type="button" className="button secondary small" disabled={audit.loading} onClick={audit.refresh}>Refresh audit</button>
        <ResourceState {...audit} retry={audit.refresh}>
          {!audit.data?.events.length ? <p>No audit events.</p> : <ul className="row-list">
            {audit.data.events.map(event => <li key={event.id} style={{ overflowWrap: "anywhere" }}>
              <p><strong>{event.action}</strong> by {event.actorId}</p>
              <Timestamp value={event.createdAt} />
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detailText(event.detail)}</pre>
            </li>)}
          </ul>}
        </ResourceState>
      </section>
    {canWrite && <section className="section">
      <h2>Request an operation</h2>
      <p>Sensitive effects require separate approval. This form only requests an operation; it does not execute it. Approval decisions are handled in the session.</p>
      <p className="metadata">Do not include passwords, tokens, or other secrets.</p>
      <form onSubmit={requestOperation}>
        <fieldset disabled={action.busy}>
          <label className="field">Operation
            <select value={kind} onChange={event => setKind(event.target.value as Operation["kind"])}>
              <option value="git.commit">Git commit</option><option value="bash">Bash command</option><option value="github.comment">GitHub comment</option>
            </select>
          </label>
          {kind === "git.commit" && <label className="field">Commit message<textarea required autoComplete="off" value={message} onChange={event => setMessage(event.target.value)} /></label>}
          {kind === "bash" && <label className="field">Command<textarea required autoComplete="off" value={command} onChange={event => setCommand(event.target.value)} /></label>}
          {kind === "github.comment" && <>
            <label className="field">Repository (owner/name)<input required autoComplete="off" value={repository} onChange={event => setRepository(event.target.value)} /></label>
            <label className="field">Issue number<input required type="number" min="1" step="1" value={issue} onChange={event => setIssue(event.target.value)} /></label>
            <label className="field">Comment<textarea required autoComplete="off" value={body} onChange={event => setBody(event.target.value)} /></label>
          </>}
          <button className="button primary" disabled={!operationReady}>Request approval</button>
        </fieldset>
      </form>
      {approval && <p role="status">Approval {approval.id}: {approval.status}.</p>}
    </section>}
    {action.busy && <p role="status">Saving request...</p>}
  </section>;
}
