import type { GitProvider, SessionRepository } from "./repositories.js";
import type { ChatImage } from "./chat-images.js";

export const permissions = ["read", "ask", "write", "approve", "manage"] as const;
export type Permission = (typeof permissions)[number];
/**
 * Workspace roles, from most to least authority. Beyond the workspace owner there are four tiers:
 * - `admin`: everything a collaborator can do, plus workspace management (members, models, repositories, settings).
 * - `collaborator`: creates sessions and can send messages to (ask, write) any session shared with the workspace.
 * - `member`: creates sessions, and follows the workspace's shared sessions read-only unless granted more.
 * - `viewer`: creates no sessions, and follows the workspace's shared sessions read-only, whatever it is granted.
 * Private sessions stay private: only their owner and explicit grants open them, whatever the role.
 */
export const workspaceRoles = ["owner", "admin", "collaborator", "member", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
/** The roles a workspace owner can assign; admins assign the ones below their own. */
export const assignableWorkspaceRoles = ["admin", "collaborator", "member", "viewer"] as const satisfies readonly WorkspaceRole[];
export type AssignableWorkspaceRole = (typeof assignableWorkspaceRoles)[number];
/** The four tiers of access to one session given to one member, least first; sessionRolePermissions (policy.ts) defines them. */
export const sessionRoles = ["viewer", "member", "collaborator", "admin"] as const;
export type SessionRole = (typeof sessionRoles)[number];
export const toolNames = ["identity", "list_files", "read_file", "write_file", "edit_file", "git_status", "git_commit", "bash", "github_read", "github_comment", "github_merge", "git_push", "git_repin", "host_bash", "github_issue"] as const;
export type ToolName = (typeof toolNames)[number];
/**
 * Tools of sessions that pinned their repositories, which are read-only now: still valid in stored agents and
 * approvals, but no session offers them (the agent uses Git itself in bash).
 */
export const retiredToolNames: readonly ToolName[] = ["git_status", "git_commit", "git_repin"];
export interface UserProfile {
  id: string;
  githubId: string | null;
  githubLogin: string | null;
  displayName: string;
  gitName: string;
  gitEmail: string;
  env: Record<string, string>;
  githubConnected: boolean;
  /** Present on the signed-in user's own profile when the server lists them in ADMIN_USER_IDS. */
  instanceAdmin?: true;
}
/** A native app (iOS, iPadOS, macOS) signed in as the user, listed so the user can revoke it from the web app. */
export interface SignedInDevice {
  id: string;
  /** The name the app reported when it signed in, e.g. the device's name; null when it sent none. */
  name: string | null;
  createdAt: string;
  expiresAt: string;
  /** This request came from that app. */
  current: boolean;
}
/** A native app's sign-in: its bearer token, until `expiresAt`. */
export interface NativeSignIn {
  token: string;
  expiresAt: string;
  user: UserProfile;
}
export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  role?: WorkspaceRole;
}
export interface ModelDefinition {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  modelId: string;
  connectorId?: string;
  connectorOwnerId?: string;
}
/**
 * A session's agent: the model it started on and the tools it uses without asking. Each new session gets its own, with
 * every tool its host carries and no instructions; sessions started from a saved agent, before agents were removed, keep
 * theirs, and moving a session copies its agent to the new host.
 */
export interface AgentVersion {
  id: string;
  agentId: string;
  authorId: string;
  workspaceId: string | null;
  version: number;
  name: string;
  description: string;
  instructions: string;
  tools: ToolName[];
  modelId: string;
  createdAt: string;
}
/**
 * What a session's agent is doing. `working`: a message is queued or running, or an approved operation runs.
 * `waiting`: a card (a permission request or an operation's approval) awaits a decision, holding the message whose call asked for it.
 * `done` and `failed`: how the latest shared message ended; `failed` when its model request failed, Pi ended it without
 * an answer, or it was stopped before it ran. `idle`: no shared message yet.
 */
export const sessionActivities = ["idle", "working", "waiting", "done", "failed"] as const;
export type SessionActivity = (typeof sessionActivities)[number];
export interface SessionRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  agentVersionId: string;
  title: string;
  policyVersion: number;
  status: "provisioning" | "ready" | "error" | "archived";
  createdAt: string;
  permissions?: Permission[];
  connectorId?: string;
  connectorOwnerId?: string;
  repositories?: SessionRepository[];
  /**
   * "clone": the session has no pinned repositories; its agent clones the workspace's repositories with plain Git through
   * the host's egress proxy and pushes a clone's commits with git_push. Absent: repositories are pinned at creation.
   */
  repositoryMode?: "clone";
  /**
   * A clone session's own branch, named for its work when it was created (`pistead/<title-slug>-<short id>`; see
   * sessionBranchName). Absent: `pistead/<session-id>`, for sessions from before named branches or on older connectors.
   */
  branch?: string;
  /**
   * The session pinned its repositories when it started, as sessions did before they cloned them: it stays readable,
   * but runs nothing (no messages, approvals, backups, restores or moves).
   */
  frozen?: true;
  /** Present only on single-session reads of a clone session whose agent can't run shell commands here, so can't clone: why. */
  cloneUnavailable?: string;
  // Control-plane viewing policy; absent on legacy records means private.
  visibility?: "private" | "workspace";
  // Present only on single-session reads: the pinned host explicitly runs without isolation.
  hostUnsandboxed?: boolean;
  /** What its agent is doing, as its host last reported it; absent until a connector that reports activity opens it. */
  activity?: SessionActivity;
  /**
   * The pull request its newest git_push with a pull request opened, or found already open; absent until one does.
   * Display state, like activity: what the push recorded, not the pull request's live state.
   */
  pullRequest?: SessionPullRequest;
}
export interface SessionPullRequest {
  url: string;
  /** Parsed from the URL's last path segment; absent when it has none. */
  number?: number;
}
export interface SessionGrant {
  userId: string;
  permissions: Permission[];
  /** The grantee's workspace role (for the first entry, the session owner's); absent from older servers. */
  workspaceRole?: WorkspaceRole;
  /** The session tier the permissions are exactly (see sessionRoles in policy.ts); null for a custom grant. Absent from older servers. */
  sessionRole?: SessionRole | null;
}
export interface RunnerBinding {
  session: SessionRecord;
  owner: UserProfile;
  agent: AgentVersion;
  model: ModelDefinition;
}
export type RunnerAction = "create" | "view" | "events" | "submit" | "ask" | "operations" | "approve" | "backup" | "restart" | "restore" | "stop";
export interface RunnerTicket {
  aud: "runner";
  sessionId: string;
  actorId: string;
  ownerId: string;
  action: RunnerAction;
  policyVersion: number;
  iat: number;
  exp: number;
  jti: string;
  bodyHash: string;
  connectorId?: string;
}
export interface AuthorizationRequest {
  sessionId: string;
  actorId: string;
  permission: Permission;
  ownerId: string;
  /** Also report the actor's authority over host commands on the session's host (`hostCommands`). */
  host?: boolean;
}
/**
 * What a member may do with host_bash on a host: `approve` decides each host command; `auto` also runs the host
 * commands of their own Auto-approve messages without asking. The host's owner holds `auto`; anyone else holds what the
 * host's owner or one of its admins granted them (see HostCommandGrant).
 */
export const hostCommandLevels = ["approve", "auto"] as const;
export type HostCommandLevel = (typeof hostCommandLevels)[number];
export interface AuthorizationResult {
  allowed: boolean;
  policyVersion: number;
  ownerId: string;
  /** Present only when requested (`host`) and the actor holds some authority over the session's host commands. */
  hostCommands?: HostCommandLevel;
}
/** A pull request the control plane opens as the session owner after a successful push. `base` defaults to the default branch. */
export interface PullRequestRequest {
  title: string;
  body: string;
  base?: string;
}
/**
 * Pushes the session commits of one pinned repository, up to `commit`, to `branch` on its Git provider.
 * `repository` is the pin's worktree path; `commit` is the exact session commit that was approved.
 * With `tag`, no branch moves: the push creates the lightweight tag refs/tags/<tag> at `commit`, which must already be on
 * the remote's `branch` (a release tag on main, say). A tag is only ever created, never moved or deleted, and takes no
 * pull request.
 * Key order is canonical: kind, repository, directory, branch, tag, commit, pullRequest (title, body, base).
 */
export interface GitPushOperation {
  kind: "git.push";
  /** The workspace repository's path (`repositoryPath`): a pin's path, or in a clone session the repository the clone's origin names. */
  repository: string;
  /** Clone sessions only: the clone's directory in the worktree, whose commit is pushed as it is. */
  directory?: string;
  branch: string;
  /** Tag pushes only: the tag to create at `commit`, a commit already on `branch`. */
  tag?: string;
  commit: string;
  pullRequest?: PullRequestRequest;
}
/** What a tool call lacks: a tool the agent doesn't include, changes in a Read-only message, or a shell without resource limits. */
export const permissionNeeds = ["tool", "write", "unbounded-shell"] as const;
export type PermissionNeed = (typeof permissionNeeds)[number];
/**
 * A tool call that needs more than the session allows. The call waits while the session owner allows it once or for the
 * rest of the session, or denies it. `target` is what the call touches (a path or a command), shown on the card.
 */
export interface PermissionRequest {
  kind: "permission";
  tool: ToolName;
  target: string;
  /** In `permissionNeeds` order. */
  needs: PermissionNeed[];
}
export const githubMergeMethods = ["merge", "squash", "rebase"] as const;
export type GitHubMergeMethod = (typeof githubMergeMethods)[number];
/**
 * Merges pull request `pull` of a pinned github.com repository (`owner/name`) as the session owner, only while its head
 * is still `sha`. Key order is canonical: kind, repository, pull, sha, method.
 */
export interface GitHubMergeOperation {
  kind: "github.merge";
  repository: string;
  pull: number;
  sha: string;
  method: GitHubMergeMethod;
}
/** Bounds of a GitHub issue the agent opens, the same in the runner and the control plane. */
export const GITHUB_ISSUE_TITLE_LIMIT = 256;
export const GITHUB_ISSUE_BODY_LIMIT = 60000;
/**
 * Opens an issue with exactly this title and body in a github.com repository (`owner/name`) of the workspace, as the
 * session owner. The title is one line; the body may be empty. Key order is canonical: kind, repository, title, body.
 */
export interface GitHubIssueOperation {
  kind: "github.issue";
  repository: string;
  title: string;
  body: string;
}
/**
 * How a GitHub effect is authorized: `capability`, minted when a human approved it, or `admissionId`, the session owner's
 * Auto-approve message whose tool call it is (merges also need its `autoMerge`, which the apps send with every
 * Auto-approve message to a host with `automaticGitHub`). Exactly one is set.
 */
export type GitHubEffectAuthority = { capability: string; admissionId?: undefined } | { admissionId: string; capability?: undefined };
/** Runner -> control plane: open one issue, human-approved or under the owner's Auto-approve. */
export type GitHubIssueRequest = GitHubEffectAuthority & {
  sessionId: string;
  actorId: string;
  approvalId: string;
  repository: string;
  title: string;
  body: string;
};
/** The issue GitHub opened: its number and page. */
export interface GitHubIssueResult {
  number: number;
  url: string;
}
/** Runs outside isolation as the connector user; only the host owner, or a member they granted host commands to, may approve. */
export interface HostCommandOperation {
  kind: "host.bash";
  command: string;
  timeoutSeconds: number;
}
/** Creates a private successor session; never replaces the source worktree or its history. */
export interface GitRepinOperation {
  kind: "git.repin";
  repository: string;
  ref: string;
}
export interface RepinRequest {
  sessionId: string;
  approvalId: string;
  actorId: string;
  operation: GitRepinOperation;
  capability?: string;
  admissionId?: string;
}
export interface RepinResult {
  sessionId: string;
  path: string;
  repositories: SessionRepository[];
}
export type Operation =
  | { kind: "git.commit"; message: string }
  | { kind: "bash"; command: string }
  | { kind: "github.comment"; repository: string; issue: number; body: string }
  | GitHubMergeOperation
  | GitHubIssueOperation
  | GitPushOperation
  | GitRepinOperation
  | HostCommandOperation
  | PermissionRequest;
/** Runner -> control plane: read an issue or pull request of a pinned github.com repository as the session owner. */
export interface GitHubReadRequest {
  sessionId: string;
  /** Who sent the message whose tool call reads; `admissionId` is that message's write admission. */
  actorId: string;
  admissionId: string;
  /** The reading tool call, so a one-call permission for github_read covers it. */
  callId: string;
  repository: string;
  issue: number;
}
/** Runner -> control plane: perform one merge, human-approved or under the owner's Auto-approve. */
export type GitHubMergeRequest = GitHubEffectAuthority & {
  sessionId: string;
  actorId: string;
  approvalId: string;
  repository: string;
  pull: number;
  sha: string;
  method: GitHubMergeMethod;
};
/** Runner -> control plane: post one comment, human-approved or under the owner's Auto-approve. */
export type GitHubCommentRequest = GitHubEffectAuthority & {
  sessionId: string;
  actorId: string;
  approvalId: string;
  repository: string;
  issue: number;
  body: string;
};
/** `sha` is the commit the merge created on the base branch; `url` the pull request. */
export interface GitHubMergeResult {
  sha: string;
  url: string;
}
export interface GitHubCommentView {
  id: number;
  author: string | null;
  createdAt: string;
  body: string;
  url: string;
}
export interface GitHubReviewView {
  id: number;
  author: string | null;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
  state: string;
  submittedAt: string | null;
  /** The head commit the review was submitted on. */
  commit: string | null;
  body: string;
  url: string;
}
export interface GitHubReviewCommentView {
  id: number;
  /** The comment this one replies to in its thread. */
  inReplyTo: number | null;
  author: string | null;
  createdAt: string;
  path: string;
  /** Line in the file at the pull request's head; null when the comment is outdated (see originalLine). */
  line: number | null;
  originalLine: number | null;
  commit: string;
  body: string;
  /** The end of the diff hunk the comment is on. */
  diffHunk: string;
  url: string;
}
export interface GitHubPullRequestView {
  draft: boolean;
  merged: boolean;
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  /** GitHub's mergeable_state, e.g. clean, blocked, behind, dirty, unstable. */
  mergeableState: string;
  head: { ref: string; sha: string; repository: string | null };
  base: { ref: string; sha: string };
  reviews: GitHubReviewView[];
  reviewComments: GitHubReviewCommentView[];
  /** Check runs and commit statuses of the head commit, failing and pending ones first. */
  checks: { name: string; status: string; conclusion: string | null }[];
}
/**
 * An issue or pull request as github_read returns it, within 96 KiB of JSON. Each thread list keeps its newest items;
 * long bodies end in a note of how much was cut.
 */
export interface GitHubIssueView {
  repository: string;
  number: number;
  url: string;
  title: string;
  state: string;
  author: string | null;
  createdAt: string;
  body: string;
  labels: string[];
  comments: GitHubCommentView[];
  pullRequest?: GitHubPullRequestView;
  /** How many items of each list were left out to keep the result within its bound: the oldest thread items, and checks after the kept ones. */
  omitted?: { comments?: number; reviews?: number; reviewComments?: number; checks?: number };
}
/**
 * The credential the control plane issued for exactly one approved push: a short-lived token minted from a workspace app
 * or bot identity, or the session owner's own token when push access uses their account. Never persisted by the runner.
 */
export interface PushCredential {
  /** Control-plane ledger id; echoed back when the push completes so the credential is revoked. */
  credentialId: string;
  /** HTTPS smart-HTTP repository URL without credentials, e.g. https://github.com/owner/repo.git */
  remote: string;
  /** Complete Authorization header value for requests to `remote` only. */
  authorization: string;
  expiresAt: string;
}
/** Push access uses the host's own Git credentials: the connector reads them for `remote` itself, so none is issued. */
export interface HostPushCredential {
  credentialId: string;
  remote: string;
  hostCredentials: true;
  expiresAt: string;
}
/** `unknown`: the push failed during or after the upload, so the remote branch may or may not have moved. */
export type PushOutcome = "pushed" | "up-to-date" | "failed" | "unknown";
export interface PushCompletionResult {
  pullRequest?: { url: string; number: number; created: boolean };
}
/** Runner -> control plane: mint the credential for one approved push. */
export interface PushCredentialRequest {
  sessionId: string;
  approvalId: string;
  /** The human approver (explicit approvals) or the session owner (automatic approvals). */
  actorId: string;
  operation: GitPushOperation;
  /** Explicit approvals: the single-use broker capability minted when the human approved. */
  capability?: string;
  /** Automatic approvals: the owner's write admission, issued with auto-approve access. */
  admissionId?: string;
}
/** Runner -> control plane: the push finished; revoke its credential and open the requested pull request. */
export interface PushCompleteRequest {
  sessionId: string;
  approvalId: string;
  credentialId: string;
  outcome: PushOutcome;
  /** The commit now at refs/heads/<branch> (refs/tags/<tag> for a tag push); required unless the outcome is "failed". */
  tip?: string;
}
/**
 * How a workspace push identity gets the credential for each push: a short-lived token minted from an app or bot
 * identity, the session owner's own account (`owner-account`), or the host's own Git credentials (`host-credentials`).
 * The last two serve only sessions running on the session owner's own host.
 */
export const pushIdentityKinds = ["github-app", "entra-federation", "bitbucket-client-credentials", "oauth-refresh", "forgejo-integration", "owner-account", "host-credentials"] as const;
export type PushIdentityKind = (typeof pushIdentityKinds)[number];
/** Public view of a workspace push identity; secrets never leave the control plane. */
export interface PushIdentity {
  id: string;
  workspaceId: string;
  provider: GitProvider;
  host: string;
  /** Azure DevOps organization or Bitbucket workspace (lowercase); empty when the identity covers the whole host. */
  scope: string;
  kind: PushIdentityKind;
  /** Non-secret settings: appId/slug, tenantId/clientId, key, clientId/login, audience. */
  config: Record<string, string>;
  status: "ready" | "authorization_required";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * How the server connects to a workspace database: TLS that verifies the server certificate against the public roots or
 * the owner's CA (`verify-full`), TLS without verifying it (`require`), or no TLS (`disable`, private networks only).
 */
export const workspaceDatabaseTlsModes = ["verify-full", "require", "disable"] as const;
export type WorkspaceDatabaseTls = (typeof workspaceDatabaseTlsModes)[number];
/**
 * Public view of the Postgres database a workspace owner connected: session backups of the workspace are saved there
 * instead of the server's backup storage. The password never leaves the control plane.
 */
export interface WorkspaceDatabase {
  id: string;
  workspaceId: string;
  host: string;
  port: number;
  database: string;
  user: string;
  tls: WorkspaceDatabaseTls;
  /** The server certificate is verified against the owner's CA certificate instead of the public roots. */
  customCa: boolean;
  connectedBy: string;
  createdAt: string;
  updatedAt: string;
}
/** Where a backup's snapshot is kept: the server's backup storage, or the workspace owner's own database. */
export type BackupLocation = "server" | "workspace-database";
export interface ApprovalRecord {
  id: string;
  sessionId: string;
  requestedBy: string;
  operation: Operation;
  status: "pending" | "approved" | "denied" | "executing" | "executed" | "interrupted" | "failed";
  decidedBy?: string;
  result?: string;
  createdAt: string;
  admissionId?: string;
  /** Executed without a per-command human decision because the session owner chose auto-approve access. */
  automatic?: boolean;
  reviewHash?: string;
  /** A permission request the owner allowed: for that one call, or for the rest of the session. */
  scope?: "call" | "session";
  /** A shell command the host's owner allowed to run without resource limits, which this host lacks. */
  unbounded?: boolean;
  /**
   * The permission someone gave this operation's tool call first. Its own card is folded into this one in a view, as
   * the operation shows what the permission let through.
   */
  permission?: { decidedBy: string; scope?: "call" | "session" };
}
/**
 * A tool call whose shell command ran under the owner's auto-approve access. A view lists no card for it: the call and
 * its result are in the transcript, and this marks the call.
 */
export interface AutoApprovedCall {
  tool: string;
  status: ApprovalRecord["status"];
  /** It ran without resource limits, on the owner's own host. */
  unbounded?: true;
}
export interface EntryView {
  id: string;
  kind: string;
  role: string;
  text: string;
  actorId?: string;
  conversationId?: string;
  /** The model request behind this entry failed. Only the provider/model and HTTP status cross the boundary, never provider text. */
  error?: { provider?: string; modelId?: string; status?: number };
  /** How long the model took to write this reply, or the tool to run; absent for entries recorded before Pi 1.1.0. */
  durationMs?: number;
  /** This entry's tool calls whose commands ran under auto-approve, in call order; absent from older runners. */
  autoApproved?: AutoApprovedCall[];
}
/**
 * Phases of preparing one pinned repository on a host with a repository cache (connect --repo-cache): its turn, the
 * control plane re-checking the owner's access, the host's Git fetch (the remote's phases, then its own), the check of
 * the pinned tree, and the checkout. Only these structured values leave the host, never Git's or a remote's text.
 */
export const repositoryPreparationPhases = ["queued", "authorizing", "waiting", "connecting", "enumerating", "counting", "compressing",
  "receiving", "resolving", "verifying", "checking", "checking-out", "done"] as const;
export type RepositoryPreparationPhase = (typeof repositoryPreparationPhases)[number];
export interface RepositoryPreparationItem {
  path: string;
  phase: RepositoryPreparationPhase;
  /** Git's own progress in this phase, when it reports one. */
  percent: number | null;
  done: number | null;
  total: number | null;
  /** Pack bytes this host's fetch has received so far. */
  bytes: number;
}
/** Present while a cache host prepares the session's repositories, and after that failed until the session restarts. */
export interface RepositoryPreparationView {
  status: "preparing" | "failed";
  /** One per pinned repository, in pin order. */
  items: RepositoryPreparationItem[];
  /** Why it failed, in fixed and credential-free words. Restarting the session tries again. */
  error?: string;
}
export interface SessionView {
  sessionId: string;
  owner: Pick<UserProfile, "id" | "displayName" | "gitName" | "gitEmail" | "githubLogin">;
  entries: EntryView[];
  /**
   * Approvals people decide or follow: every one still in play and the newest settled ones. Commands that ran under
   * auto-approve are marked on their transcript entries instead (`EntryView.autoApproved`). Older runners list them all.
   */
  approvals: ApprovalRecord[];
  /** How many older settled approvals `approvals` leaves out; the host keeps them. */
  olderApprovals?: number;
  conversations: { id: string; mode: "write" | "ask"; actorId?: string }[];
  busy: boolean;
  /**
   * Every message, in order. `stopping` and `stopped` mark one someone stopped (see `stoppable`): stopping while the host
   * still ends its work, which holds the queue until it is done. `images lost` marks one that never ran because the host
   * no longer had the images it was sent with.
   */
  queue?: { submissionId: string; actorId: string; mode: "write" | "ask"; status: string }[];
  /** The host can stop the session's work: the message running and those queued behind it. Absent from older runners. */
  stoppable?: boolean;
  /** The shared conversation's current model and reasoning level. */
  agent?: { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
  /**
   * Access mode of the latest shared-conversation submission ("approval" when it named none). Absent before the first
   * one; older runners also leave it out when the latest one asked before acting.
   */
  access?: AccessMode;
  /** Repository preparation on a cache host; absent once the repositories are ready, and on every other host. */
  repositories?: RepositoryPreparationView;
  /** What the agent is doing now; absent from runners that predate activity reports. */
  activity?: SessionActivity;
}
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
/**
 * read: inspect only, no edits or commands. approval: every command and commit needs a human decision. auto: the owner's
 * commands, commits, pushes, GitHub comments, issues and merges run immediately.
 */
export const accessModes = ["read", "approval", "auto"] as const;
export type AccessMode = (typeof accessModes)[number];
/** Per-message choices. Omitted model/thinkingLevel keep the conversation's current ones; omitted access means "approval". */
export interface ChatOptions {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  access?: AccessMode;
  /**
   * With `access` auto only: the agent's GitHub merges run without asking too. Auto-approve covers merges, so the apps
   * send it with every Auto-approve message to a host with `automaticGitHub`, once its owner confirmed on that device
   * that Auto-approve merges (apps from when it was a separate Auto-merge option, only when chosen). The control plane
   * passes it on only to such hosts, whose connectors merge without asking only in a message that has it.
   */
  autoMerge?: boolean;
}
export interface SubmitInput {
  /** May be empty only when the message carries images. */
  content: string;
  requestId: string;
  admissionId?: string;
  options?: ChatOptions;
  /** Images pasted into the message, which the model gets after its text; only hosts with `chatImages` take them. */
  images?: ChatImage[];
}
export interface SubmitResult {
  submissionId: string;
  conversationId: string;
  status: string;
  queuePosition?: number;
}
