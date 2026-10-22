import { useState, type FormEvent, type ReactNode } from "react";
import { permissions, type ApprovalRecord, type GitHubMergeMethod, type GitHubMergeOperation, type GitPushOperation, type Operation, type Permission, type PermissionNeed, type PermissionRequest, type SessionGrant, type SessionRecord, type SessionView, type UserProfile } from "../../../packages/shared/src/types";
import { containsRedaction, REDACTED } from "../../../packages/shared/src/redaction";
import { useSessionLink } from "./session-link";
import { api, segment } from "./api";
import { BackupList, backupDatabaseLabel, backupDownloadHref, backupLocationLabel, type Backup, type BackupDatabase, type BackupListing, type BackupListingResource } from "./backups";
import { ConnectionStatus, HostCapabilities, type ConnectionsResource } from "./hosts";
import { MoveHostSection } from "./host-migration";
import { Icon } from "./icons";
import { Username, usePeople } from "./people";
import { RepositorySnapshotPolicy } from "./repositories";
import { href } from "./router";
import {
  Alert, Button, CardBody, Collapsible, confirmDialog, CopyField, EmptyState, Feedback, Field, LinkButton, Loading, RelativeTime,
  ResourceState, Row, Section, SegmentedControl, StatusBadge, Timestamp, useAction, useResource, type ActionState, type Tone,
} from "./ui";
import { userIdFromInput, usernameWithId, withUsernames, type Person } from "../../../packages/client/src/usernames";

export type AuditEvent = { id: string; actorId: string; action: string; detail: unknown; createdAt: string };
export type PanelTab = "details" | "approvals" | "activity";

/** Session-level mutations reachable from both the header menu and the panel. */
export interface SessionActions {
  action: ActionState;
  backup: Backup | null;
  /** The session's backups and where a new one goes, loaded for its owner; the header menu and the panel share it. */
  backups: BackupListingResource;
  /** No new backup can be saved: the server has no backup storage, or the workspace's own database is turned off. */
  backupsOff: boolean;
  /** The listing hasn't arrived yet, so whether a backup can be saved isn't known; nothing is offered meanwhile. */
  backupsPending: boolean;
  /** Backups need an idle session whose live state is confirmed. */
  backupBlocked: boolean;
  changeVisibility: () => void;
  createBackup: () => void;
  /** Resolves true once the new title is saved. */
  rename: (title: string) => Promise<boolean>;
  archive: () => void;
  unarchive: () => void;
}

export function useSessionActions({ session, user, backupBlocked, onChange }: { session: SessionRecord | null; user: UserProfile; backupBlocked: boolean; onChange: () => void }): SessionActions {
  const action = useAction();
  const [backup, setBackup] = useState<Backup | null>(null);
  const isOwner = session?.ownerId === user.id;
  // Only the owner lists backups, and an archived session admits read requests only.
  const backups = useResource<BackupListing>(session && isOwner && session.status !== "archived" ? `/api/sessions/${segment(session.id)}/backups` : null);
  const backupsOff = backups.data?.enabled === false;
  // A listing that failed leaves the server to explain a refusal; one still loading offers nothing yet.
  const backupsPending = !backups.data && !backups.error;
  async function changeVisibility() {
    if (!session || !isOwner || action.busy) return;
    const nextVisibility = (session.visibility ?? "private") === "workspace" ? "private" : "workspace";
    const confirmed = await confirmDialog(nextVisibility === "workspace" ? {
      title: "Make session workspace-visible?",
      message: "All workspace members will be able to view existing and future prompts and output, including tool output, repository content shown in the transcript, and side asks, which may contain sensitive information. This grants viewing only, not direct GitHub access, permission to run tools, or ask/control permissions.",
      confirmLabel: "Make workspace-visible",
    } : {
      title: "Make session private?",
      message: "Workspace membership will no longer grant viewing access. Existing explicit grants will remain in effect, and previously viewed or copied content cannot be recalled.",
      confirmLabel: "Make private",
    });
    if (!confirmed) return;
    await action.run(async () => {
      await api(`/api/sessions/${segment(session.id)}`, { method: "PATCH", body: { visibility: nextVisibility } });
      onChange();
    }, nextVisibility === "workspace"
      ? "Session is workspace-visible. Workspace members can view prompts and output."
      : "Session is private. Existing explicit grants still apply.");
  }
  async function createBackup() {
    if (!session || !isOwner || backupBlocked || backupsOff || backupsPending || action.busy) return;
    setBackup(null);
    const base = `/api/sessions/${segment(session.id)}`;
    let trustedDatabaseId: string | undefined;
    try {
      // A backup saved where someone else can read it waits for the owner's explicit confirmation of that database.
      const { workspaceDatabase } = await api<{ workspaceDatabase?: BackupDatabase }>(`${base}/backups`);
      if (workspaceDatabase?.confirm) {
        const confirmed = await confirmDialog({
          title: "Save to the workspace database?",
          message: `This backup is saved in ${backupDatabaseLabel(workspaceDatabase)}, the database the workspace owner connected. Whoever can read it can read this session: its prompts, output and files, and your personal environment values.`,
          confirmLabel: "Save backup",
        });
        if (!confirmed) return;
        trustedDatabaseId = workspaceDatabase.id;
      }
    } catch { /* The backup request repeats the check and explains a refusal. */ }
    await action.run(async () => {
      const result = await api<{ backup: Backup }>(`${base}/backup`, { method: "POST", ...(trustedDatabaseId ? { body: { trustedDatabaseId } } : {}) });
      setBackup(result.backup);
      onChange();
    }, "Backup created");
  }
  async function rename(title: string): Promise<boolean> {
    const next = title.trim();
    if (!session || !isOwner || action.busy || !next) return false;
    if (next === session.title) return true;
    let saved = false;
    await action.run(async () => {
      await api(`/api/sessions/${segment(session.id)}`, { method: "PATCH", body: { title: next } });
      saved = true;
      onChange();
    }, "Session renamed");
    return saved;
  }
  async function archive() {
    if (!session || !isOwner || action.busy || session.status === "archived") return;
    const confirmed = await confirmDialog({
      title: "Archive session?",
      message: "The session becomes read-only for everyone and is hidden from the sidebar. Its history stays viewable, and nothing is deleted. Pending approvals can't be decided while it's archived. You can unarchive it later.",
      confirmLabel: "Archive",
    });
    if (!confirmed) return;
    await action.run(async () => {
      await api(`/api/sessions/${segment(session.id)}/archive`, { method: "POST" });
      onChange();
    }, "Session archived");
  }
  function unarchive() {
    if (!session || !isOwner || action.busy || session.status !== "archived") return;
    void action.run(async () => {
      await api(`/api/sessions/${segment(session.id)}/unarchive`, { method: "POST" });
      onChange();
    }, "Session unarchived");
  }
  return { action, backup, backups, backupsOff, backupsPending, backupBlocked, changeVisibility: () => void changeVisibility(), createBackup: () => void createBackup(), rename,
    archive: () => void archive(), unarchive };
}

const approvalTone: Record<ApprovalRecord["status"], Tone> = {
  pending: "warning", approved: "info", executing: "running", executed: "success", denied: "neutral", interrupted: "warning", failed: "danger",
};

export function ApprovalStatus({ approval }: { approval: ApprovalRecord }) {
  return <>
    {approval.automatic && <StatusBadge tone="warning">Auto-approved</StatusBadge>}
    <StatusBadge tone={approvalTone[approval.status]} dot={approval.status === "executing"}>{approval.status}</StatusBadge>
  </>;
}

/** An audit detail as indented JSON, with the user IDs in it written as "username(id)". */
function detailText(detail: unknown, person: (id: string) => Person): string {
  let value = detail;
  if (typeof detail === "string") {
    try { value = JSON.parse(detail); }
    catch { return detail; }
  }
  return JSON.stringify(withUsernames(value, person), null, 2) ?? "";
}

type PanelProps = {
  session: SessionRecord;
  view: SessionView | null;
  user: UserProfile;
  /** The session's workspace connector listing, shared with the chat box. */
  hosts: ConnectionsResource;
  tab: PanelTab;
  setTab: (tab: PanelTab) => void;
  onClose: () => void;
  refresh: () => void;
  audit: { data: { events: AuditEvent[] } | null; loading: boolean; error: string; refresh: () => void };
  actions: SessionActions;
  openSession: (id: string) => void;
};

export function SessionPanel(props: PanelProps) {
  const { tab, setTab, onClose, view, audit } = props;
  const people = usePeople();
  const approvals = view?.approvals ?? [];
  const pendingCount = approvals.filter(approval => approval.status === "pending").length;
  return <aside className="session-panel" aria-label="Session panel">
    <div className="session-panel-header">
      <SegmentedControl<PanelTab> size="xs" label="Panel" value={tab} onChange={setTab} options={[
        { value: "details", label: "Details" },
        { value: "approvals", label: pendingCount ? `Approvals ${pendingCount}` : "Approvals" },
        { value: "activity", label: "Activity" },
      ]} />
      <span className="spacer" />
      <Button variant="ghost" size="xs" icon="x" aria-label="Close panel" title="Close panel" onClick={onClose} />
    </div>
    <div className="session-panel-body">
      {tab === "details" && <PanelDetails key={JSON.stringify([props.session.id, props.session.ownerId, props.user.id, props.session.permissions])} {...props} />}
      {tab === "approvals" && (approvals.length
        ? <div className="stack">{[...approvals].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending")).map(approval => <ApprovalCard key={approval.id} approval={approval} />)}</div>
        : view ? <EmptyState title="No approvals" /> : <Loading />)}
      {tab === "activity" && <Section title="Audit log" action={<Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh activity" title="Refresh" disabled={audit.loading} onClick={audit.refresh} />} bare>
        <ResourceState {...audit} retry={audit.refresh}>
          {!audit.data?.events.length ? <EmptyState title="No activity" /> : <div className="card">
            {audit.data.events.map(event => <Collapsible key={event.id} title={event.action} hint={<>{usernameWithId(people.person(event.actorId))} · <RelativeTime value={event.createdAt} /></>}>
              <pre>{detailText(event.detail, people.person)}</pre>
            </Collapsible>)}
          </div>}
        </ResourceState>
      </Section>}
    </div>
  </aside>;
}

/** One approval record; decision controls, when allowed, come in as children. */
export function ApprovalCard({ approval, children }: { approval: ApprovalRecord; children?: ReactNode }) {
  const { operation } = approval;
  const decision = operation.kind === "permission" && approval.status === "approved" && approval.decidedBy
    ? <> · Allowed by <Username id={approval.decidedBy} /> {approval.scope === "session" ? "for the rest of the session" : "for this call"}</>
    : approval.decidedBy && <> · Decision by <Username id={approval.decidedBy} /></>;
  return <article className="approval-card card">
    <div className="approval-head">
      <span className="approval-kind">{operation.kind === "permission" ? "Permission" : operation.kind}</span><span className="spacer" />
      {approval.unbounded && <StatusBadge tone="warning">No resource limits</StatusBadge>}
      {containsRedaction(operation) && <StatusBadge tone="warning">Secret hidden</StatusBadge>}
      <ApprovalStatus approval={approval} />
    </div>
    {operation.kind === "permission" ? <PermissionSummary request={operation} pending={approval.status === "pending"} /> : <>
      {operation.kind === "host.bash" && <Alert variant="error" title="Runs outside the sandbox">This command runs as the host's OS user with access to their files, credentials and network, without CPU, memory or disk quotas. It runs in this session's files, which the agent can change, so builds, package scripts and Git hooks or settings there can run the agent's code on the host too. Only the host owner can approve it. The time limit is {operation.timeoutSeconds} seconds.</Alert>}
      {operation.kind === "git.repin" && <Alert title="Creates a new private session">Resolves <code>{operation.repository}</code> at <code>{operation.ref}</code>. Other repository pins stay unchanged. This session's files, commits and conversation stay here; they are not copied. Only the session owner can approve.</Alert>}
      {operation.kind === "git.push" && <GitPushSummary operation={operation} />}
      {operation.kind === "github.merge" && <GitHubMergeSummary operation={operation} />}
      <pre>{JSON.stringify(operation, null, 2)}</pre>
      {approval.status === "pending" && containsRedaction(operation) && <HiddenSecretNote />}
    </>}
    <p className="muted small">Requested by <Username id={approval.requestedBy} /> · <Timestamp value={approval.createdAt} />{approval.automatic ? <> · Ran under the owner's auto-approve access, without a per-command decision</> : decision}</p>
    {approval.result && <pre>{approval.result}</pre>}
    {operation.kind === "git.repin" && approval.status === "executed" && <RepinLink result={approval.result} />}
    {children}
  </article>;
}

function RepinLink({ result }: { result?: string }) {
  try {
    const value = JSON.parse(result ?? "null");
    if (typeof value?.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) return null;
    return <LinkButton variant="outline" size="sm" href={href({ name: "session", sessionId: value.sessionId })}>Open repinned session</LinkButton>;
  } catch { return null; }
}

const permissionNeedText: Record<PermissionNeed, string> = {
  tool: "A tool this agent doesn't include",
  write: "A change in a Read-only message",
  "unbounded-shell": "No resource limits: this host has none set up for commands. The command still runs in the sandbox, offline and for at most 30 seconds, but with no cap on CPU, memory, processes or disk.",
};
/** Tools whose effect gets its own approval card after the permission, unless the message auto-approves. */
const approvedTools: readonly string[] = ["bash", "git_commit", "git_push", "github_comment", "github_merge", "host_bash", "git_repin"];

function PermissionSummary({ request, pending }: { request: PermissionRequest; pending: boolean }) {
  return <>
    <p><code>{request.tool}</code> {pending ? "needs the session owner's permission for:" : "asked the session owner's permission for:"}</p>
    <ul className="permission-needs small">{request.needs.map(need => <li key={need}>{permissionNeedText[need]}</li>)}</ul>
    {request.target && <pre>{request.target}</pre>}
    {pending && containsRedaction(request.target) && <HiddenSecretNote />}
    {pending && approvedTools.includes(request.tool) && <p className="muted small">Allowing it doesn't run anything yet: the operation still gets its own approval, unless the message auto-approves.</p>}
  </>;
}

/** The server hides what looks like a secret from everyone; a decision still uses the real value. */
function HiddenSecretNote() {
  return <p className="small">Something that looks like a secret is shown as <code>{REDACTED}</code>. Allowing or approving this uses the real value, so make sure it belongs here.</p>;
}

function GitPushSummary({ operation }: { operation: GitPushOperation }) {
  return <dl className="small">
    <dt className="muted">Repository</dt><dd><code>{operation.repository}</code></dd>
    {operation.directory && <><dt className="muted">Clone</dt><dd><code>{operation.directory}/</code></dd></>}
    <dt className="muted">Branch</dt><dd><code>{operation.branch}</code></dd>
    <dt className="muted">Commit</dt><dd><code title={operation.commit}>{operation.commit.slice(0, 12)}</code></dd>
    {operation.pullRequest && <><dt className="muted">Pull request</dt><dd>{operation.pullRequest.title}{operation.pullRequest.base ? <> → <code>{operation.pullRequest.base}</code></> : " → default branch"}</dd></>}
  </dl>;
}

const mergeMethodLabels: Record<GitHubMergeMethod, string> = { merge: "Merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

function GitHubMergeSummary({ operation }: { operation: GitHubMergeOperation }) {
  return <dl className="small">
    <dt className="muted">Pull request</dt><dd><a href={`https://github.com/${operation.repository}/pull/${operation.pull}`} target="_blank" rel="noreferrer"><code>{operation.repository}#{operation.pull}</code></a></dd>
    <dt className="muted">Head commit</dt><dd><code title={operation.sha}>{operation.sha.slice(0, 12)}</code></dd>
    <dt className="muted">Method</dt><dd>{mergeMethodLabels[operation.method]}</dd>
  </dl>;
}

function PanelDetails({ session, view, user, hosts, refresh, audit, actions, openSession }: PanelProps) {
  const ownPermissions = session.permissions ?? [];
  const isOwner = session.ownerId === user.id;
  const canWrite = ownPermissions.includes("write");
  const changed = () => { audit.refresh(); refresh(); };
  return <div>
    <HostSection session={session} user={user} hosts={hosts} />
    <RepositoriesSection session={session} refresh={refresh} />
    <PeopleSection session={session} user={user} actions={actions} changed={changed} />
    {isOwner && session.status !== "archived" && <BackupsSection session={session} actions={actions} openSession={openSession} />}
    {isOwner && session.status !== "archived" && session.connectorId && <MoveHostSection session={session} user={user} hosts={hosts} openSession={openSession} changed={changed} />}
    {canWrite && session.status !== "archived" && <OperationSection session={session} changed={changed} />}
    {isOwner && <ExportSection session={session} />}
    <AccessSection session={session} view={view} user={user} />
  </div>;
}

function HostSection({ session, user, hosts }: { session: SessionRecord; user: UserProfile; hosts: ConnectionsResource }) {
  const host = hosts.data?.connectors.find(item => item.id === session.connectorId);
  return <Section title="Host" info={<p>Work runs as the session owner (<Username id={session.ownerId} you />), not the host owner. The host operator can access prompts and files processed on it. Sharing a host doesn't change who can view or control this session, and doesn't expose its owner's local history.</p>}>
    {!session.connectorId ? <Row leading={<Icon name="server" size={16} />} title="Operator-managed session" hint="No local host is pinned" /> : <>
      <Row
        leading={<Icon name="server" size={16} />}
        title={host?.name ?? "Pinned host"}
        hint={<>Hosted by {host?.ownerName ?? (session.connectorOwnerId ? <Username id={session.connectorOwnerId} /> : "unknown")}{session.connectorOwnerId === user.id ? " (you)" : ""}</>}
        trailing={hosts.loading ? <Loading>Checking</Loading> : host ? <ConnectionStatus connector={host} /> : session.hostUnsandboxed && <StatusBadge tone="danger">Unsandboxed</StatusBadge>}
      />
      {host && <HostCapabilities connector={host} />}
      {!hosts.loading && !host && !hosts.error && <Row title="Host not in your list" hint="It may be private to its owner, unshared, or revoked. Viewing a session doesn't let you use its host" />}
      <Row title="Connection ID" hint={<code>{session.connectorId}</code>} />
    </>}
    {hosts.error && <CardBody><Feedback error={hosts.error} /></CardBody>}
  </Section>;
}

function RepositoriesSection({ session, refresh }: { session: SessionRecord; refresh: () => void }) {
  const repositories = session.repositories ?? [];
  if (session.repositoryMode === "clone") return <Section title="Repositories" info={<p>
    The agent clones this workspace's repositories into the session with plain Git, through the host's egress proxy. Reads use the session owner's own Git accounts, which never reach the host; pushes go through approval.
  </p>} bare>
    <div className="card">
      <Row leading={<Icon name="git-branch" size={16} />} title="Cloned on demand" hint="Nothing is pinned: the agent clones and switches branches as it works" />
      <Row title="Manage repositories and network access" href={href({ name: "settings", section: "workspaces", id: session.workspaceId })} chevron />
    </div>
  </Section>;
  return <Section
    title={<>Repositories <span className="muted">{repositories.length}</span></>}
    info={<><RepositorySnapshotPolicy /><p>Pins are fixed at session start using the session owner's connected Git accounts, not the host owner's or a collaborator's. They record source inputs, not live cache status; later workspace changes don't affect them.</p></>}
    action={<Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh repositories" title="Refresh" onClick={refresh} />}
    bare
  >
    <div className="stack">
      {session.status === "error" && <Alert variant="error" title="Snapshots not confirmed">This session is in an error state, so repository snapshots are not confirmed. Check the host, then refresh.</Alert>}
      {session.status === "provisioning" && <Alert variant="info" role="status" title="Still provisioning">Pins below don't mean snapshots are downloaded yet.</Alert>}
      {session.status === "archived" && <Alert title="Archived">Pinned files may no longer be on the host.</Alert>}
      <div className="card">
        {repositories.length ? repositories.map(repository => <Row
          key={repository.bindingId}
          leading={<Icon name="git-branch" size={16} />}
          title={repository.fullName}
          hint={<><span title={repository.commit}>{repository.ref}@{repository.commit.slice(0, 7)}</span> · <code>{repository.path}/</code></>}
        />) : <Row title="No repository pins" hint={session.status === "provisioning" ? "None recorded yet. Refresh to check progress" : session.status === "error" ? "None are available for this session" : "This older session has no pinned repositories. Start a new session to use them"} />}
        <Row title="Manage repositories for future sessions" href={href({ name: "settings", section: "workspaces", id: session.workspaceId })} chevron />
      </div>
    </div>
  </Section>;
}

function PeopleSection({ session, user, actions, changed }: { session: SessionRecord; user: UserProfile; actions: SessionActions; changed: () => void }) {
  const form = useAction();
  const people = usePeople();
  const ownPermissions = session.permissions ?? [];
  const isOwner = session.ownerId === user.id;
  const visibility = session.visibility ?? "private";
  const viewerOnly = !isOwner && !ownPermissions.some(permission => permission !== "read");
  const grantable = permissions.filter(permission => ownPermissions.includes(permission) || (permission === "read" && ownPermissions.length > 0));
  const canManage = ownPermissions.includes("manage");
  // An archived session admits only read requests, so its grants can't be loaded or changed until it is unarchived.
  const archived = session.status === "archived";
  const base = `/api/sessions/${segment(session.id)}`;
  const grants = useResource<{ grants: SessionGrant[] }>(canManage && !archived ? `${base}/grants` : null);
  // The member field takes a username, "username(id)" or a user ID; `target` is the user ID it names.
  const [member, setMember] = useState("");
  const [selected, setSelected] = useState<Permission[]>([]);
  const target = userIdFromInput(member, people.list);
  const targetName = usernameWithId(people.person(target));
  const ownerSelected = target === session.ownerId;
  const existing = grants.data?.grants.find(grant => grant.userId === target);
  const grantReady = canManage && !ownerSelected && Boolean(target) && selected.length > 0
    && selected.every(permission => grantable.includes(permission));

  function chooseGrant(value: string) {
    setMember(value);
    const userId = userIdFromInput(value, people.list);
    setSelected([...(grants.data?.grants.find(grant => grant.userId === userId)?.permissions ?? [])]);
  }

  function saveGrant(event: FormEvent) {
    event.preventDefault();
    if (!grantReady || form.busy) return;
    void form.run(async () => {
      await api(`${base}/grants`, { method: "POST", body: { userId: target, permissions: selected } });
      grants.refresh();
      changed();
    }, "Session grant saved");
  }

  async function revoke() {
    if (!canManage || ownerSelected || !existing || form.busy) return;
    const confirmed = await confirmDialog({
      title: "Revoke session grant?",
      message: visibility === "workspace"
        ? `Revoke the explicit grant for ${targetName}? They can still view prompts and output as a workspace member while this session is workspace-visible. Only the owner can make it private to remove workspace viewing.`
        : `Revoke the explicit session grant for ${targetName}?`,
      confirmLabel: "Revoke grant",
      destructive: true,
    });
    if (!confirmed) return;
    await form.run(async () => {
      await api(`${base}/grants/${segment(target)}`, { method: "DELETE" });
      chooseGrant("");
      grants.refresh();
      changed();
    }, visibility === "workspace" ? "Explicit grant revoked. Workspace members can still view this session until the owner makes it private." : "Session grant revoked");
  }

  const sharing = useSessionLink({ session, user, action: actions.action, onChange: changed });
  const link = sharing.link;
  // The owner's loaded link is current; until it loads, and for everyone else, the session says whether one exists.
  const linkShared = isOwner && link !== undefined ? link !== null : Boolean(session.linkShared);

  return <Section title="People" info={<><p>The server checks every request. Workspace visibility only allows viewing; ask, write, approve and manage are separate grants that each include read. Grantees must be workspace members, and you can only grant permissions you hold. Visibility doesn't grant GitHub or tool access, share a host, or publish an agent. The owner's access can't be changed.</p><p>The owner can also share a link: anyone who has it can view the shared conversation without signing in, but not side asks, approvals, who sent each message, or the host. It never grants anything else.</p></>}>
    <Row
      leading={<Icon name="user" size={16} />}
      title={isOwner ? "Owner" : viewerOnly ? "Viewer" : "Collaborator"}
      hint={<>Your permissions: {ownPermissions.join(", ") || "none"}{viewerOnly ? ". You can follow committed work but can't ask, submit, approve, manage grants, change visibility, or use backups" : ""}</>}
    />
    <Row
      leading={<Icon name={visibility === "workspace" ? "globe" : "lock"} size={16} />}
      title={visibility === "workspace" ? "Workspace-visible" : "Private"}
      hint={<>{visibility === "workspace"
        ? "All workspace members can view existing and future prompts and output, including tool output, repository content in the transcript, and side asks"
        : "Only the owner and people with a grant can view prompts and output"}. {isOwner
        ? visibility === "workspace" ? "Making it private keeps explicit grants and can't recall content already viewed or copied" : "Before sharing, check existing prompts, tool output and side asks for secrets"
        : "Only the session owner can change visibility"}</>}
      trailing={isOwner && !archived && <Button variant="outline" size="sm" disabled={actions.action.busy} onClick={actions.changeVisibility}>{visibility === "workspace" ? "Make private" : "Make workspace-visible"}</Button>}
    />
    {(isOwner || linkShared) && <Row
      leading={<Icon name="link" size={16} />}
      title={linkShared ? "Anyone with the link can view" : "Link sharing off"}
      hint={!isOwner ? "The owner shared this session by link: anyone who has it can view the shared conversation without signing in, including messages you send to it. Side asks stay hidden"
        : linkShared ? "Without signing in, they can follow the shared conversation, but not side asks, approvals, who sent each message, or the host. Turning the link off stops it at once"
        : archived ? "Archived sessions can't get a new share link"
        : "Create a link that lets anyone who has it view the shared conversation, read-only, without signing in"}
      trailing={isOwner && (linkShared
        ? <Button variant="outline" size="sm" disabled={actions.action.busy} onClick={sharing.unshareLink}>Turn off</Button>
        : !archived && <Button variant="outline" size="sm" disabled={actions.action.busy || sharing.linkLoading} onClick={() => void sharing.shareLink()}>Create link</Button>)}
    />}
    {isOwner && link && <CardBody><Field label="Share link" hint={<>Created <RelativeTime value={link.createdAt} /></>}><CopyField value={link.url} label="Copy share link" /></Field></CardBody>}
    {isOwner && sharing.linkError && <CardBody><Feedback error={sharing.linkError} /></CardBody>}
    {canManage && !archived ? <Collapsible title="Grants" hint={grants.data ? `${grants.data.grants.length} explicit grant${grants.data.grants.length === 1 ? "" : "s"}` : undefined} leading={<Icon name="users" size={16} />} trailing={<Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh grants" title="Refresh grants" disabled={grants.loading} onClick={event => { event.preventDefault(); grants.refresh(); }} />}>
      <ResourceState {...grants} retry={grants.refresh}>
        {grants.data && <form onSubmit={saveGrant}>
          <fieldset disabled={form.busy} className="stack">
            <Field label="Existing member grant" hint={grants.data.grants.length ? undefined : "No explicit member grants"}>
              <select className="select" value={existing ? target : ""} onChange={event => chooseGrant(event.target.value && usernameWithId(people.person(event.target.value)))}>
                <option value="">New grant</option>
                {grants.data.grants.map(grant => <option key={grant.userId} value={grant.userId}>
                  {usernameWithId(people.person(grant.userId))}{grant.userId === session.ownerId ? " (owner, immutable)" : ""}: {grant.permissions.join(", ") || "None"}
                </option>)}
              </select>
            </Field>
            {/* Shows who a typed username or user ID names before anything is granted. */}
            <Field label="Workspace member" hint={ownerSelected ? "The owner's grant is immutable" : targetName !== target && member.trim() !== targetName ? targetName : undefined}>
              <input className="input" required autoComplete="off" spellCheck={false} placeholder="Username or user ID" value={member} onChange={event => chooseGrant(event.target.value)} />
            </Field>
            <fieldset disabled={ownerSelected} className="stack session-permissions">
              <legend className="small muted">Grant permissions</legend>
              {permissions.map(permission => <label className="check-row" key={permission}>
                <input className="checkbox" type="checkbox" checked={selected.includes(permission)} disabled={!grantable.includes(permission)}
                  onChange={event => setSelected(current => event.target.checked ? [...current, permission] : current.filter(value => value !== permission))} />
                <span>{permission}{!grantable.includes(permission) && <span className="muted"> (not yours to grant)</span>}</span>
              </label>)}
            </fieldset>
            <div className="inline">
              <Button type="submit" variant="secondary" size="sm" disabled={!grantReady}>{form.busy ? "Saving..." : "Save grant"}</Button>
              {existing && !ownerSelected && <Button variant="outline" size="sm" onClick={() => void revoke()}>Revoke grant</Button>}
            </div>
            {visibility === "workspace" && <p className="muted small">Revoking a grant doesn't stop workspace members from viewing; make the session private for that.</p>}
          </fieldset>
        </form>}
      </ResourceState>
    </Collapsible> : <Row leading={<Icon name="users" size={16} />} title="Grants" hint={canManage ? "Unarchive the session to manage grants" : "Managing grants requires manage permission"} />}
    {(form.error || form.notice) && <CardBody><Feedback {...form} /></CardBody>}
  </Section>;
}

function BackupsSection({ session, actions, openSession }: { session: SessionRecord; actions: SessionActions; openSession: (id: string) => void }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { backup } = actions;
  return <Section
    title="Backups"
    info={<><p>Only the session owner can create, download or restore backups. Backups need the session to be idle.</p><p>Restore creates a new private session and never overwrites this one. It doesn't replay approvals or run operations, and needs the original host to be available. Listing and downloading work while offline.</p><p>Backups are saved in the database the workspace owner connected, if there is one, and otherwise in the server's backup storage. A server without backup storage keeps no backups.</p></>}
    action={<div className="inline">
      <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh backups" title="Refresh backups" onClick={() => setRefreshKey(value => value + 1)} />
      <Button variant="outline" size="sm" disabled={actions.backupsOff || actions.backupsPending || actions.backupBlocked || actions.action.busy} title={actions.backupsOff ? "Backups are off" : undefined} onClick={actions.createBackup}>{actions.action.busy ? "Working..." : "Create backup"}</Button>
    </div>}
  >
    {actions.backupBlocked && !actions.backupsOff && <Row title="Backup unavailable right now" hint="Unavailable while work is queued or running, or the live state can't be confirmed" />}
    {backup && <Row
      leading={<Icon name="check" size={16} />}
      title={<>Backup created <Timestamp value={backup.createdAt} /></>}
      hint={<>{backup.size} bytes{backupLocationLabel(backup)} · ID <code>{backup.id}</code> · SHA-256 <code>{backup.sha256}</code></>}
      trailing={<LinkButton variant="outline" size="sm" href={backupDownloadHref(session.id, backup.id)}>Download</LinkButton>}
    />}
    <BackupList sourceId={session.id} ownerId={session.ownerId} backups={actions.backups} latestBackup={backup} refreshKey={refreshKey} openSession={openSession} />
  </Section>;
}

/** The owner's export of what the control plane keeps about the session; available while archived too. */
function ExportSection({ session }: { session: SessionRecord }) {
  return <Section title="Export" info={<p>Downloads this session's details, people, approvals, pushes, backup list and activity as JSON, without secrets. The conversation itself is in the session's backups. Only the session owner can export it.</p>}>
    <Row leading={<Icon name="archive" size={16} />} title="Session data" hint="JSON, without secrets" trailing={<LinkButton variant="outline" size="sm" href={`/api/sessions/${segment(session.id)}/export`} download>Export</LinkButton>} />
  </Section>;
}

type ManualKind = "git.commit" | "bash" | "github.comment";

function OperationSection({ session, changed }: { session: SessionRecord; changed: () => void }) {
  const form = useAction();
  const [approval, setApproval] = useState<Pick<ApprovalRecord, "id" | "status"> | null>(null);
  const [kind, setKind] = useState<ManualKind>("git.commit");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [repository, setRepository] = useState("");
  const [issue, setIssue] = useState("");
  const [body, setBody] = useState("");
  const issueNumber = Number(issue);
  const operationReady = kind === "git.commit" ? Boolean(message.trim()) : kind === "bash" ? Boolean(command.trim())
    : /^[^/\s]+\/[^/\s]+$/.test(repository.trim()) && Number.isSafeInteger(issueNumber) && issueNumber > 0 && Boolean(body.trim());

  function requestOperation(event: FormEvent) {
    event.preventDefault();
    if (!operationReady || form.busy) return;
    const operation: Operation = kind === "git.commit" ? { kind, message }
      : kind === "bash" ? { kind, command }
      : { kind, repository: repository.trim(), issue: issueNumber, body };
    setApproval(null);
    void form.run(async () => {
      const result = await api<{ approval: ApprovalRecord }>(`/api/sessions/${segment(session.id)}/operations`, { method: "POST", body: operation });
      setApproval({ id: result.approval.id, status: result.approval.status });
      changed();
    }, "Operation requested. Review its approval in the session.");
  }

  return <Section title="Operation request" info={<p>This only requests the operation; it runs after approval in the session. Don't include passwords, tokens or other secrets.</p>}>
    <CardBody>
      <form onSubmit={requestOperation}>
        <fieldset disabled={form.busy} className="stack">
          <Field label="Operation">
            <select className="select" value={kind} onChange={event => setKind(event.target.value as ManualKind)}>
              <option value="git.commit">Git commit</option><option value="bash">Bash command</option><option value="github.comment">GitHub comment</option>
            </select>
          </Field>
          {kind === "git.commit" && <Field label="Commit message"><textarea className="textarea" required autoComplete="off" value={message} onChange={event => setMessage(event.target.value)} /></Field>}
          {kind === "bash" && <Field label="Command"><textarea className="textarea mono" required autoComplete="off" value={command} onChange={event => setCommand(event.target.value)} /></Field>}
          {kind === "github.comment" && <>
            <Field label="Repository" hint="owner/name"><input className="input" required autoComplete="off" value={repository} onChange={event => setRepository(event.target.value)} /></Field>
            <Field label="Issue number"><input className="input" required type="number" min="1" step="1" value={issue} onChange={event => setIssue(event.target.value)} /></Field>
            <Field label="Comment"><textarea className="textarea" required autoComplete="off" value={body} onChange={event => setBody(event.target.value)} /></Field>
          </>}
          <div className="inline"><Button type="submit" variant="secondary" size="sm" disabled={!operationReady}>{form.busy ? "Requesting..." : "Request approval"}</Button></div>
          {approval && <p className="muted small" role="status">Approval <code>{approval.id}</code>: {approval.status}</p>}
        </fieldset>
      </form>
    </CardBody>
  </Section>;
}

function AccessSection({ session, view, user }: { session: SessionRecord; view: SessionView | null; user: UserProfile }) {
  const visibility = session.visibility ?? "private";
  return <Section title="Access" info={<><p>{visibility === "workspace"
    ? "Workspace-visible: all workspace members can view existing and future prompts and output, including tool output, repository content in the transcript, and side asks."
    : "Private: only the owner and members with a session grant can view prompts and output."}{session.linkShared ? " Anyone with the session's share link can also view the shared conversation, without signing in." : ""} Viewing doesn't grant ask, write, approve or manage permissions, access to Git accounts, or tool use. Only the owner can change visibility; it's separate from host sharing and agent publishing.</p>
    <p>Values that look like passwords, tokens or keys are shown as {REDACTED} to everyone, in the transcript, approvals and share links. The agent and the host still see the real values.</p></>}>
    {view ? <>
      <Row leading={<Icon name="user" size={16} />} title={<>Runs as {view.owner.displayName}{view.owner.id === user.id ? " (you)" : ""}</>} hint={view.owner.githubLogin ? `GitHub @${view.owner.githubLogin}` : "No GitHub login connected"} />
      <Row leading={<Icon name="git-branch" size={16} />} title="Commits as" hint={<>{view.owner.gitName} &lt;{view.owner.gitEmail}&gt;</>} />
    </> : <Row title={<Loading>Loading identity...</Loading>} />}
    <CardBody><Field label="Session ID"><CopyField value={session.id} label="Copy session ID" /></Field></CardBody>
  </Section>;
}
