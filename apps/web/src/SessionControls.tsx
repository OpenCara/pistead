import { useState, type FormEvent } from "react";
import { permissions, type ApprovalRecord, type Operation, type Permission, type SessionGrant, type SessionRecord, type UserProfile } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { BackupRestore, type Backup } from "./BackupRestore";
import { Details, Feedback, ResourceState, Timestamp, useAction, useResource } from "./ui";

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
    <Feedback {...action} />
    {action.busy && <p role="status">Saving request...</p>}
    <Details summary="People and access">
      <p>Your permissions: <strong>{ownPermissions.join(", ") || "none"}</strong>{viewerOnly ? " (view only)" : ""}.</p>
      <h3>Visibility: {visibility === "workspace" ? "Workspace-visible" : "Private"}</h3>
      <p>{visibility === "workspace"
        ? "All workspace members can view existing and future prompts and output, including tool output and side asks."
        : "Only the owner and people with a grant can view prompts and output."}</p>
      {isOwner ? <>
        <p className="metadata">{visibility === "workspace"
          ? "Making it private keeps explicit grants and can't recall content already viewed or copied."
          : "Before sharing, check existing prompts, tool output and side asks for secrets."}</p>
        <button type="button" className="button secondary" disabled={action.busy} onClick={changeVisibility}>
          {visibility === "workspace" ? "Make private" : "Make workspace-visible"}
        </button>
      </> : <p className="metadata">Only the session owner can change visibility.</p>}
      <h3>Grants</h3>
      {canManage ? <>
        <div className="actions"><button type="button" className="button secondary small" disabled={grants.loading} onClick={grants.refresh}>Refresh grants</button></div>
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
                {ownerSelected && <p>The owner's grant is immutable.</p>}
                <div className="actions">
                  <button className="button primary" disabled={!grantReady}>Save grant</button>
                  {existing && !ownerSelected && <button type="button" className="button secondary" onClick={revoke}>Revoke grant</button>}
                </div>
                {visibility === "workspace" && <p className="metadata">Revoking a grant doesn't stop workspace members from viewing; make the session private for that.</p>}
              </fieldset>
            </form>
          </>}
        </ResourceState>
      </> : <p className="metadata">Managing grants requires manage permission.</p>}
      <p className="metadata">The server checks every request. Workspace visibility only allows viewing; ask, write, approve and manage are separate grants that each include read. Grantees must be workspace members, and you can only grant permissions you hold. Visibility doesn't grant GitHub or tool access, share a host, or publish an agent. The owner's access can't be changed.</p>
    </Details>
    {isOwner && <Details summary="Backups">
      <p className="metadata">Only the session owner can create, download or restore backups. Backups need the session to be idle.</p>
      <button type="button" className="button secondary" disabled={busy || action.busy} onClick={createBackup}>Create backup</button>
      {busy && <p role="status">Unavailable while work is queued or running, or the live state can't be confirmed.</p>}
      {backup && <div className="notice" role="status">
        <p>Backup created <Timestamp value={backup.createdAt} />: {backup.size} bytes.</p>
        <p className="metadata">ID <code>{backup.id}</code>; SHA-256 <code>{backup.sha256}</code></p>
        <a className="button secondary" href={`${base}/backups/${segment(backup.id)}/download`}>Download backup</a>
      </div>}
      <BackupRestore sourceId={session.id} ownerId={session.ownerId} latestBackup={backup} openSession={openSession} />
    </Details>}
    {canWrite && <Details summary="Request an operation">
      <p className="metadata">This only requests the operation; it runs after approval in the session. Don't include passwords, tokens or other secrets.</p>
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
    </Details>}
    <Details summary="Audit log">
      <div className="actions"><button type="button" className="button secondary small" disabled={audit.loading} onClick={audit.refresh}>Refresh audit</button></div>
      <ResourceState {...audit} retry={audit.refresh}>
        {!audit.data?.events.length ? <p>No audit events.</p> : <ul className="queue-list">
          {audit.data.events.map(event => <li key={event.id}>
            <p><strong>{event.action}</strong> by {event.actorId}</p>
            <p className="metadata"><Timestamp value={event.createdAt} /></p>
            <pre>{detailText(event.detail)}</pre>
          </li>)}
        </ul>}
      </ResourceState>
    </Details>
  </section>;
}
