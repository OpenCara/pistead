import { useState, type FormEvent, type ReactNode } from "react";
import { sessionRoles, type ApprovalRecord, type EntryView, type GitHubMergeMethod, type GitHubMergeOperation, type GitPushOperation, type Operation, type PermissionNeed, type PermissionRequest, type SessionGrant, type SessionRecord, type SessionRole, type SessionView, type UserProfile, type WorkspaceRole } from "../../../packages/shared/src/types";
import { sessionRoleAllowed, sessionRoleGrantable, sessionRoleOf, sessionRolePermissions, workspaceSessionPermissions } from "../../../packages/shared/src/policy";
import { containsRedaction, REDACTED } from "../../../packages/shared/src/redaction";
import { useSessionLink } from "./session-link";
import { api, segment } from "./api";
import { BackupList, backupDatabaseLabel, backupDownloadHref, backupLocationLabel, type Backup, type BackupDatabase, type BackupListing, type BackupListingResource } from "./backups";
import { ConnectionStatus, HostCapabilities, type ConnectionsResource } from "./hosts";
import { MoveHostSection } from "./host-migration";
import { Icon } from "./icons";
import { Username, usePeople } from "./people";
import { RepositoryClonePolicy } from "./repositories";
import { FilesPanel } from "./session-files";
import { SchedulesPanel } from "./session-schedules";
import { href } from "./router";
import {
  Alert, Button, CardBody, Collapsible, confirmDialog, CopyField, EmptyState, Feedback, Field, LinkButton, Loading, RelativeTime,
  ResourceState, Row, Section, SegmentedControl, StatusBadge, Timestamp, useAction, useResource, type ActionState, type Tone,
} from "./ui";
import { userIdFromInput, usernameWithId, withUsernames, type Person } from "../../../packages/client/src/usernames";

export type AuditEvent = { id: string; actorId: string; action: string; detail: unknown; createdAt: string };
export type PanelTab = "details" | "approvals" | "files" | "schedules" | "activity";

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
  /** `conversationOnly`: keep the conversation without the session's files or clones. */
  createBackup: (options?: { conversationOnly?: boolean }) => void;
  /** The session's host can't back up its conversation only (an older connector). */
  conversationOnlyOff: boolean;
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
  const conversationOnlyOff = backups.data?.conversationOnlySupported === false;
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
  async function createBackup({ conversationOnly = false }: { conversationOnly?: boolean } = {}) {
    if (!session || !isOwner || backupBlocked || backupsOff || backupsPending || action.busy || (conversationOnly && conversationOnlyOff)) return;
    setBackup(null);
    const base = `/api/sessions/${segment(session.id)}`;
    let trustedDatabaseId: string | undefined;
    try {
      // A backup saved where someone else can read it waits for the owner's explicit confirmation of that database.
      const { workspaceDatabase } = await api<{ workspaceDatabase?: BackupDatabase }>(`${base}/backups`);
      if (workspaceDatabase?.confirm) {
        const confirmed = await confirmDialog({
          title: "Save to the workspace database?",
          message: `This backup is saved in ${backupDatabaseLabel(workspaceDatabase)}, the database the workspace owner connected. Whoever can read it can read this session: its prompts, output${conversationOnly ? "" : " and files"}, and your personal environment values.`,
          confirmLabel: "Save backup",
        });
        if (!confirmed) return;
        trustedDatabaseId = workspaceDatabase.id;
      }
    } catch { /* The backup request repeats the check and explains a refusal. */ }
    await action.run(async () => {
      const body = { ...(trustedDatabaseId ? { trustedDatabaseId } : {}), ...(conversationOnly ? { conversationOnly: true } : {}) };
      const result = await api<{ backup: Backup }>(`${base}/backup`, { method: "POST", ...(Object.keys(body).length ? { body } : {}) });
      setBackup(result.backup);
      onChange();
    }, conversationOnly ? "Conversation backup created" : "Backup created");
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
  return { action, backup, backups, backupsOff, backupsPending, backupBlocked, changeVisibility: () => void changeVisibility(),
    createBackup: options => void createBackup(options), conversationOnlyOff, rename,
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

/** Marks a transcript entry's tool calls whose commands ran under auto-approve, which have no approval card. */
export function AutoApprovedMarks({ calls }: { calls?: EntryView["autoApproved"] }) {
  if (!Array.isArray(calls) || !calls.length) return null;
  return <span className="approval-marks" title="Ran under the owner's auto-approve access, without a per-command decision">
    <StatusBadge tone="warning">Auto-approved</StatusBadge>
    {calls.some(call => call.unbounded) && <StatusBadge tone="warning">No resource limits</StatusBadge>}
    {/* Executed is the usual outcome; anything else (still running, failed, interrupted) is worth a look. */}
    {calls.filter(call => call.status !== "executed").map((call, index) =>
      <StatusBadge key={index} tone={approvalTone[call.status] ?? "neutral"} dot={call.status === "executing"}>{calls.length > 1 ? `${call.tool}: ${call.status}` : call.status}</StatusBadge>)}
  </span>;
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
        { value: "files", label: "Files" },
        { value: "schedules", label: "Schedules" },
        { value: "activity", label: "Activity" },
      ]} />
      <span className="spacer" />
      <Button variant="ghost" size="xs" icon="x" aria-label="Close panel" title="Close panel" onClick={onClose} />
    </div>
    <div className="session-panel-body">
      {tab === "details" && <PanelDetails key={JSON.stringify([props.session.id, props.session.ownerId, props.user.id, props.session.permissions])} {...props} />}
      {tab === "approvals" && (approvals.length
        ? <div className="stack">
          {[...approvals].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending")).map(approval => <ApprovalCard key={approval.id} approval={approval} />)}
          {!!view?.olderApprovals && <p className="muted small">{olderApprovalsText(view.olderApprovals)}</p>}
        </div>
        : view ? <EmptyState title="No approvals">{AUTO_APPROVED_NOTE}</EmptyState> : <Loading />)}
      {tab === "files" && <FilesPanel session={props.session} />}
      {tab === "schedules" && <SchedulesPanel key={props.session.id} session={props.session} changed={() => { audit.refresh(); props.refresh(); }} />}
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

/** Commands auto-approve ran have no card; the transcript marks their calls. */
const AUTO_APPROVED_NOTE = "Commands that ran under auto-approve are marked on their tool calls in the conversation.";
function olderApprovalsText(count: number): string {
  return `${count} older settled ${count === 1 ? "approval isn't" : "approvals aren't"} listed. ${AUTO_APPROVED_NOTE}`;
}

/** One approval record; decision controls, when allowed, come in as children. */
export function ApprovalCard({ approval, children }: { approval: ApprovalRecord; children?: ReactNode }) {
  const { operation } = approval;
  const allowed = (decidedBy: string, scope: ApprovalRecord["scope"]) =>
    <> · Allowed by <Username id={decidedBy} /> {scope === "session" ? "for the rest of the session" : "for this call"}</>;
  const decision = operation.kind === "permission" && approval.status === "approved" && approval.decidedBy
    ? allowed(approval.decidedBy, approval.scope)
    : <>{approval.permission && allowed(approval.permission.decidedBy, approval.permission.scope)}{approval.decidedBy && <> · Decision by <Username id={approval.decidedBy} /></>}</>;
  return <article className="approval-card card">
    <div className="approval-head">
      <span className="approval-kind">{operation.kind === "permission" ? "Permission" : operation.kind}</span><span className="spacer" />
      {approval.unbounded && <StatusBadge tone="warning">No resource limits</StatusBadge>}
      {containsRedaction(operation) && <StatusBadge tone="warning">Secret hidden</StatusBadge>}
      <ApprovalStatus approval={approval} />
    </div>
    {operation.kind === "permission" ? <PermissionSummary request={operation} pending={approval.status === "pending"} /> : <>
      {operation.kind === "host.bash" && <Alert variant="error" title="Runs outside the sandbox">This command runs as the host's OS user with access to their files, credentials and network, without CPU, memory or disk quotas. It runs in this session's files, which the agent can change, so builds, package scripts and Git hooks or settings there can run the agent's code on the host too. Only the host's owner, or a member granted host commands, can approve it. The time limit is {operation.timeoutSeconds} seconds.</Alert>}
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
  "unbounded-shell": "No resource limits: this host has none set up for commands. The command still runs in the sandbox, offline and for at most the host's command time limit, but with no cap on CPU, memory, processes or disk.",
};
/** Tools whose effect gets its own approval card after the permission, unless the message auto-approves. */
const approvedTools: readonly string[] = ["bash", "git_commit", "git_push", "github_comment", "github_merge", "github_issue", "host_bash", "git_repin"];

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
    {operation.tag !== undefined
      ? <><dt className="muted">New tag</dt><dd><code>{operation.tag}</code></dd><dt className="muted">On branch</dt><dd><code>{operation.branch}</code> (not moved)</dd></>
      : <><dt className="muted">Branch</dt><dd><code>{operation.branch}</code></dd></>}
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
    <TranscriptSection session={session} user={user} changed={changed} />
    {isOwner && session.status !== "archived" && <BackupsSection session={session} actions={actions} openSession={openSession} />}
    {isOwner && session.status !== "archived" && !session.frozen && session.connectorId && <MoveHostSection session={session} user={user} hosts={hosts} openSession={openSession} changed={changed} />}
    {canWrite && session.status !== "archived" && !session.frozen && <OperationSection session={session} changed={changed} />}
    {isOwner && <ExportSection session={session} />}
    <AccessSection session={session} view={view} user={user} />
  </div>;
}

/**
 * How the transcript shows: the session's own tool output (its owner's choice), and whether its workspace loads
 * transcripts latest first (the workspace's owners' and admins').
 */
function TranscriptSection({ session, user, changed }: { session: SessionRecord; user: UserProfile; changed: () => void }) {
  const action = useAction();
  const settings = useResource<{ settings: { paging: boolean } }>(`/api/workspaces/${segment(session.workspaceId)}/transcripts`);
  const full = session.toolOutput !== "brief";
  const editable = session.ownerId === user.id && session.status !== "archived";
  function setFull(next: boolean) {
    if (!editable || action.busy || next === full) return;
    void action.run(async () => {
      await api(`/api/sessions/${segment(session.id)}`, { method: "PATCH", body: { toolOutput: next ? "full" : "brief" } });
      changed();
    }, next ? "Full tool output is on for everyone viewing this session." : "Tool output is brief for everyone viewing this session: one line per tool result.");
  }
  const paging = settings.data?.settings.paging;
  return <Section title="Transcript" info={<div className="stack">
    <p>With full tool output on, the transcript shows everything each tool printed. Turned off, each tool result shows only its first line and long tool calls are cut short, for everyone viewing the session, its share link included. Long sessions then load much faster. The host keeps the whole output either way, and the agent still sees all of it. Only the session's owner can change this.</p>
    <p>Whether the transcript loads latest messages first is a workspace setting, under Settings → Workspaces.</p>
  </div>}>
    <Row title="Full tool output" hint={full ? "Every tool result in full" : "One line per tool result"} trailing={editable
      ? <input type="checkbox" className="checkbox" role="switch" aria-label="Full tool output" checked={full} disabled={action.busy} onChange={event => setFull(event.target.checked)} />
      : <StatusBadge tone="neutral">{full ? "On" : "Off"}</StatusBadge>} />
    <Row title="Loading" hint={paging === undefined ? (settings.error ? "Couldn't check the workspace setting" : <Loading>Checking</Loading>)
      : paging ? "Latest messages first; earlier ones load as you scroll up" : "The whole transcript at once"} />
    {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
  </Section>;
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
      {session.hostEnvironment && <Row leading={<Icon name="server" size={16} />} title="Runs on the host"
        hint="No sandbox: its commands run on the host owner's machine, as its user" trailing={<StatusBadge tone="danger">On host</StatusBadge>} />}
      {host && <HostCapabilities connector={host} />}
      {!hosts.loading && !host && !hosts.error && <Row title="Host not in your list" hint="It may be private to its owner, unshared, or revoked. Viewing a session doesn't let you use its host" />}
      <Row title="Connection ID" hint={<code>{session.connectorId}</code>} />
    </>}
    {hosts.error && <CardBody><Feedback error={hosts.error} /></CardBody>}
  </Section>;
}

function RepositoriesSection({ session, refresh }: { session: SessionRecord; refresh: () => void }) {
  const repositories = session.repositories ?? [];
  if (session.repositoryMode === "clone") return <Section title="Repositories" info={<RepositoryClonePolicy />} bare>
    <div className="card">
      <Row leading={<Icon name="git-branch" size={16} />} title="Cloned on demand" hint="Nothing is pinned: the agent clones and switches branches as it works" />
      <Row title="Manage repositories and network access" href={href({ name: "settings", section: "workspaces", id: session.workspaceId })} chevron />
    </div>
  </Section>;
  return <Section
    title={<>Repositories <span className="muted">{repositories.length}</span></>}
    info={<p>This session was created before sessions cloned their repositories: it holds snapshots of these commits, pinned when it started, and is read-only.</p>}
    action={<Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh repositories" title="Refresh" onClick={refresh} />}
    bare
  >
    <div className="stack">
      {session.status === "error" && <Alert variant="error" title="Snapshots not confirmed">This session is in an error state, so repository snapshots are not confirmed. Check the host, then refresh.</Alert>}
      {session.status === "archived" && <Alert title="Archived">Pinned files may no longer be on the host.</Alert>}
      <div className="card">
        {repositories.length ? repositories.map(repository => <Row
          key={repository.bindingId}
          leading={<Icon name="git-branch" size={16} />}
          title={repository.fullName}
          hint={<><span title={repository.commit}>{repository.ref}@{repository.commit.slice(0, 7)}</span> · <code>{repository.path}/</code></>}
        />) : <Row title="No repository pins" hint={session.status === "provisioning" ? "None recorded yet. Refresh to check progress" : session.status === "error" ? "None are available for this session" : "This older session has no pinned repositories"} />}
        <Row title="Manage repositories for future sessions" href={href({ name: "settings", section: "workspaces", id: session.workspaceId })} chevron />
      </div>
    </div>
  </Section>;
}

const sessionRoleLabel: Record<SessionRole, string> = { viewer: "Viewer", member: "Member", collaborator: "Collaborator", admin: "Admin" };
const sessionRoleHint: Record<SessionRole, string> = {
  viewer: "Follows the session: prompts, output and side asks",
  member: "Viewer, and asks side questions without messaging the agent",
  collaborator: "Member, and sends messages to the agent and stops its work",
  admin: "Collaborator, and decides approvals and manages who has access",
};
const workspaceRoleLabel: Record<WorkspaceRole, string> = { owner: "workspace owner", admin: "workspace admin", collaborator: "workspace collaborator", member: "workspace member", viewer: "workspace viewer" };

/** The session tier a grant is, or null for a custom grant from before tiers; an older server leaves it to compute. */
function grantRole(grant: SessionGrant): SessionRole | null {
  return grant.sessionRole === undefined ? sessionRoleOf(grant.permissions) : grant.sessionRole;
}

/** A grant's label: its session tier, or its permissions when it is a custom grant. */
function grantLabel(grant: SessionGrant): string {
  const role = grantRole(grant);
  return role ? sessionRoleLabel[role] : `Custom (${grant.permissions.join(", ") || "none"})`;
}

function PeopleSection({ session, user, actions, changed }: { session: SessionRecord; user: UserProfile; actions: SessionActions; changed: () => void }) {
  const form = useAction();
  const people = usePeople();
  const ownPermissions = session.permissions ?? [];
  const isOwner = session.ownerId === user.id;
  const visibility = session.visibility ?? "private";
  const viewerOnly = !isOwner && !ownPermissions.some(permission => permission !== "read");
  // The tier of what you hold here, from your session role and, on a workspace-visible session, your workspace role.
  const ownRole = sessionRoleOf(ownPermissions);
  const canManage = ownPermissions.includes("manage");
  // An archived session admits only read requests, so its grants can't be loaded or changed until it is unarchived.
  const archived = session.status === "archived";
  const base = `/api/sessions/${segment(session.id)}`;
  const grants = useResource<{ grants: SessionGrant[] }>(canManage && !archived ? `${base}/grants` : null);
  // The member field takes a username, "username(id)" or a user ID; `target` is the user ID it names.
  const [member, setMember] = useState("");
  const [selected, setSelected] = useState<SessionRole | null>(null);
  const target = userIdFromInput(member, people.list);
  const targetName = usernameWithId(people.person(target));
  const ownerSelected = target === session.ownerId;
  const existing = grants.data?.grants.find(grant => grant.userId === target);
  const existingRole = existing ? grantRole(existing) : null;
  // The grantee's workspace role, from their grant or the workspace's members; unknown for someone typed by a user ID
  // that isn't listed, whom the server checks.
  const targetRole: WorkspaceRole | undefined = existing?.workspaceRole ?? people.person(target).role;
  /** Why a tier can't be given to this member, or null when it can. */
  function tierBlocked(role: SessionRole): string | null {
    if (!sessionRoleGrantable(role, ownPermissions)) return "needs permissions you don't hold";
    if (!sessionRoleAllowed(role, targetRole)) return "workspace viewers can only be session viewers";
    return null;
  }
  // What their workspace role already gives them here while the session is shared with the workspace.
  const fromWorkspace = visibility === "workspace" && targetRole && !ownerSelected ? sessionRoleOf(workspaceSessionPermissions(targetRole)) : null;
  const grantReady = canManage && !ownerSelected && Boolean(target) && selected !== null && !tierBlocked(selected)
    && selected !== existingRole;

  /** Who the typed value names, when it isn't what was typed, and their workspace role. */
  function memberHint(): string | undefined {
    const named = targetName !== target && member.trim() !== targetName ? targetName : null;
    return [named, targetRole ? workspaceRoleLabel[targetRole] : null].filter(Boolean).join(" · ") || undefined;
  }

  function chooseGrant(value: string) {
    setMember(value);
    const userId = userIdFromInput(value, people.list);
    const grant = grants.data?.grants.find(item => item.userId === userId);
    setSelected(grant ? grantRole(grant) : null);
  }

  function saveGrant(event: FormEvent) {
    event.preventDefault();
    if (!grantReady || !selected || form.busy) return;
    void form.run(async () => {
      await api(`${base}/grants`, { method: "POST", body: { userId: target, role: selected } });
      grants.refresh();
      changed();
    }, `${targetName} is now a session ${sessionRoleLabel[selected].toLowerCase()}`);
  }

  async function revoke() {
    if (!canManage || ownerSelected || !existing || form.busy) return;
    const confirmed = await confirmDialog({
      title: "Remove session access?",
      message: visibility === "workspace"
        ? `Remove ${targetName}'s session role? They keep what their workspace role gives them while this session is workspace-visible. Only the owner can make it private to remove that.`
        : `Remove ${targetName}'s session role? They will no longer be able to open this private session.`,
      confirmLabel: "Remove access",
      destructive: true,
    });
    if (!confirmed) return;
    await form.run(async () => {
      await api(`${base}/grants/${segment(target)}`, { method: "DELETE" });
      chooseGrant("");
      grants.refresh();
      changed();
    }, visibility === "workspace" ? "Session role removed. Workspace members can still view this session until the owner makes it private." : "Session role removed");
  }

  const sharing = useSessionLink({ session, user, action: actions.action, onChange: changed });
  const link = sharing.link;
  // The owner's loaded link is current; until it loads, and for everyone else, the session says whether one exists.
  const linkShared = isOwner && link !== undefined ? link !== null : Boolean(session.linkShared);

  return <Section title="People" info={<><p>The server checks every request. You give a workspace member one of four session roles: a viewer follows the session; a member also asks side questions; a collaborator also sends messages to the agent; an admin also decides approvals and manages who has access. You can only give a role whose permissions you hold, and workspace viewers can only be session viewers. On a workspace-visible session, people also keep what their workspace role gives them there. Visibility doesn't grant GitHub or tool access, share a host, or publish an agent. The owner's access can't be changed.</p><p>The owner can also share a link: anyone who has it can view the shared conversation without signing in, but not side asks, approvals, who sent each message, or the host. It never grants anything else.</p></>}>
    <Row
      leading={<Icon name="user" size={16} />}
      title={isOwner ? "Owner" : ownRole ? `Session ${sessionRoleLabel[ownRole].toLowerCase()}` : "Custom access"}
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
    {canManage && !archived ? <Collapsible title="Session roles" hint={grants.data ? `${grants.data.grants.length} ${grants.data.grants.length === 1 ? "person" : "people"} with access` : undefined} leading={<Icon name="users" size={16} />} trailing={<Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh session roles" title="Refresh session roles" disabled={grants.loading} onClick={event => { event.preventDefault(); grants.refresh(); }} />}>
      <ResourceState {...grants} retry={grants.refresh}>
        {grants.data && <form onSubmit={saveGrant}>
          <fieldset disabled={form.busy} className="stack">
            <Field label="People with access" hint={grants.data.grants.length > 1 ? undefined : "Nobody else has a session role yet"}>
              <select className="select" value={existing ? target : ""} onChange={event => chooseGrant(event.target.value && usernameWithId(people.person(event.target.value)))}>
                <option value="">Add someone</option>
                {grants.data.grants.map(grant => <option key={grant.userId} value={grant.userId}>
                  {usernameWithId(people.person(grant.userId))}: {grant.userId === session.ownerId ? "Owner (immutable)" : grantLabel(grant)}
                </option>)}
              </select>
            </Field>
            {/* Shows who a typed username or user ID names, and their workspace role, before anything is given. */}
            <Field label="Workspace member" hint={ownerSelected ? "The owner's access is immutable" : target ? memberHint() : undefined}>
              <input className="input" required autoComplete="off" spellCheck={false} placeholder="Username or user ID" value={member} onChange={event => chooseGrant(event.target.value)} />
            </Field>
            <fieldset disabled={ownerSelected} className="stack session-permissions">
              <legend className="small muted">Session role</legend>
              {sessionRoles.map(role => {
                const blocked = tierBlocked(role);
                return <label className="check-row" key={role}>
                  <input className="radio" type="radio" name="session-role" value={role} checked={selected === role} disabled={Boolean(blocked)} onChange={() => setSelected(role)} />
                  <span>
                    {sessionRoleLabel[role]}{existingRole === role && <span className="muted"> (current)</span>}{blocked && <span className="muted"> ({blocked})</span>}
                    <span className="muted small session-role-hint">{sessionRoleHint[role]} · {sessionRolePermissions[role].join(", ")}</span>
                  </span>
                </label>;
              })}
            </fieldset>
            {existing && !ownerSelected && !existingRole && <p className="muted small">{targetName} has a custom grant ({existing.permissions.join(", ")}) from before session roles. Choose a role to replace it.</p>}
            {fromWorkspace && fromWorkspace !== "viewer" && targetRole && <p className="muted small">As a {workspaceRoleLabel[targetRole]}, {targetName} already has {sessionRolePermissions[fromWorkspace].join(", ")} on this workspace-visible session; a session role adds to that.</p>}
            <div className="inline">
              <Button type="submit" variant="secondary" size="sm" disabled={!grantReady}>{form.busy ? "Saving..." : existing ? "Change role" : "Give role"}</Button>
              {existing && !ownerSelected && <Button variant="outline" size="sm" onClick={() => void revoke()}>Remove access</Button>}
            </div>
            {visibility === "workspace" && <p className="muted small">Removing someone's session role doesn't stop workspace members from viewing; make the session private for that.</p>}
          </fieldset>
        </form>}
      </ResourceState>
    </Collapsible> : <Row leading={<Icon name="users" size={16} />} title="Session roles" hint={canManage ? "Unarchive the session to manage session roles" : "Managing session roles takes the session admin role"} />}
    {(form.error || form.notice) && <CardBody><Feedback {...form} /></CardBody>}
  </Section>;
}

function BackupsSection({ session, actions, openSession }: { session: SessionRecord; actions: SessionActions; openSession: (id: string) => void }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const { backup } = actions;
  return <Section
    title="Backups"
    info={<><p>Only the session owner can create, download or restore backups. Backups need the session to be idle.</p><p>A backup keeps the conversation, the session's files and each clone's local work. <strong>Conversation only</strong> keeps just the conversation: it's much smaller, and a session restored from it starts with an empty worktree, so the agent clones its repositories again.</p><p>Restore creates a new private session and never overwrites this one. It doesn't replay approvals or run operations, and needs the original host to be available. Listing and downloading work while offline.</p><p>Backups are saved in the database the workspace owner connected, if there is one, and otherwise in the server's backup storage. A server without backup storage keeps no backups.</p></>}
    action={<div className="inline">
      <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh backups" title="Refresh backups" onClick={() => setRefreshKey(value => value + 1)} />
      <Button variant="ghost" size="sm" disabled={actions.backupsOff || actions.backupsPending || actions.backupBlocked || actions.conversationOnlyOff || actions.action.busy}
        title={actions.backupsOff ? "Backups are off" : actions.conversationOnlyOff ? "Update this session's host connector to back up its conversation only" : "Back up the conversation without the session's files"}
        onClick={() => actions.createBackup({ conversationOnly: true })}>Conversation only</Button>
      <Button variant="outline" size="sm" disabled={actions.backupsOff || actions.backupsPending || actions.backupBlocked || actions.action.busy} title={actions.backupsOff ? "Backups are off" : undefined} onClick={() => actions.createBackup()}>{actions.action.busy ? "Working..." : "Create backup"}</Button>
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

type ManualKind = "bash" | "github.comment";

function OperationSection({ session, changed }: { session: SessionRecord; changed: () => void }) {
  const form = useAction();
  const [approval, setApproval] = useState<Pick<ApprovalRecord, "id" | "status"> | null>(null);
  const [kind, setKind] = useState<ManualKind>("bash");
  const [command, setCommand] = useState("");
  const [repository, setRepository] = useState("");
  const [issue, setIssue] = useState("");
  const [body, setBody] = useState("");
  const issueNumber = Number(issue);
  const operationReady = kind === "bash" ? Boolean(command.trim())
    : /^[^/\s]+\/[^/\s]+$/.test(repository.trim()) && Number.isSafeInteger(issueNumber) && issueNumber > 0 && Boolean(body.trim());

  function requestOperation(event: FormEvent) {
    event.preventDefault();
    if (!operationReady || form.busy) return;
    const operation: Operation = kind === "bash" ? { kind, command }
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
              <option value="bash">Bash command</option><option value="github.comment">GitHub comment</option>
            </select>
          </Field>
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
