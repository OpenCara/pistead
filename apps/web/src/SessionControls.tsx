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
    if (!canManage || ownerSelected || !existing || action.busy || !window.confirm(`Revoke session access for ${target}?`)) return;
    void action.run(async () => {
      await api(`${base}/grants/${segment(target)}`, { method: "DELETE" });
      chooseGrant("");
      grants.refresh();
      changed();
    }, "Session grant revoked.");
  }

  function createBackup() {
    if (!canManage || busy || action.busy) return;
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
      <p className="metadata">Controls reflect explicit session permissions. The server authorizes every request.</p>
      <p>Owner: <span className="mono">{session.ownerId}</span> (owner access cannot be changed).</p>
      {!canManage && <p>Managing grants and creating backups requires manage permission.</p>}
    </section>
    <Feedback {...action} />
    {canManage && <>
      <section className="section">
        <div className="section-heading"><h2>Session grants</h2><button type="button" className="button secondary small" disabled={grants.loading} onClick={grants.refresh}>Refresh grants</button></div>
        <p>The user must already be a member of this workspace. Membership alone does not grant session access.</p>
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
      </section>
      <section className="section">
        <h2>Backup</h2>
        <button type="button" className="button secondary" disabled={busy || action.busy} onClick={createBackup}>Create backup</button>
        {busy && <p role="status">Backup creation is unavailable while session work is queued or running, or live state cannot be confirmed.</p>}
        <p className="metadata">Only the session owner can download or restore backups; the server checks access and whether the session is idle.</p>
        {backup && <div role="status" style={{ overflowWrap: "anywhere" }}>
          <p>Backup created: <span className="mono">{backup.id}</span></p>
          <p>Session: {backup.sessionId}</p><p>Size: {backup.size} bytes</p>
          <p>SHA-256: <code>{backup.sha256}</code></p>
          <p>Created: <Timestamp value={backup.createdAt} /></p>
          {user.id === session.ownerId && <a className="button secondary" href={`${base}/backups/${segment(backup.id)}/download`}>Download backup</a>}
        </div>}
      </section>
    </>}
    {user.id === session.ownerId && <BackupRestore sourceId={session.id} ownerId={user.id} latestBackup={backup} openSession={openSession} />}
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
