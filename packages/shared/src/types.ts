import type { GitProvider, SessionRepository } from "./repositories.js";

export const permissions = ["read", "ask", "write", "approve", "manage"] as const;
export type Permission = (typeof permissions)[number];
export type WorkspaceRole = "owner" | "admin" | "member";
export const toolNames = ["identity", "list_files", "read_file", "write_file", "git_status", "git_commit", "bash", "github_comment", "git_push"] as const;
export type ToolName = (typeof toolNames)[number];
export interface UserProfile {
  id: string;
  githubId: string | null;
  githubLogin: string | null;
  displayName: string;
  gitName: string;
  gitEmail: string;
  env: Record<string, string>;
  githubConnected: boolean;
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
  // Control-plane viewing policy; absent on legacy records means private.
  visibility?: "private" | "workspace";
  // Present only on single-session reads: the pinned host explicitly runs without isolation.
  hostUnsandboxed?: boolean;
}
export interface SessionGrant {
  userId: string;
  permissions: Permission[];
}
export interface RunnerBinding {
  session: SessionRecord;
  owner: UserProfile;
  agent: AgentVersion;
  model: ModelDefinition;
}
export type RunnerAction = "create" | "view" | "events" | "submit" | "ask" | "operations" | "approve" | "backup" | "restart" | "restore";
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
}
export interface AuthorizationResult {
  allowed: boolean;
  policyVersion: number;
  ownerId: string;
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
 * Key order is canonical: kind, repository, branch, commit, pullRequest (title, body, base).
 */
export interface GitPushOperation {
  kind: "git.push";
  repository: string;
  branch: string;
  commit: string;
  pullRequest?: PullRequestRequest;
}
export type Operation =
  | { kind: "git.commit"; message: string }
  | { kind: "bash"; command: string }
  | { kind: "github.comment"; repository: string; issue: number; body: string }
  | GitPushOperation;
/** A short-lived push credential minted by the control plane for exactly one approved push. Never persisted by the runner. */
export interface PushCredential {
  /** Control-plane ledger id; echoed back when the push completes so the credential is revoked. */
  credentialId: string;
  /** HTTPS smart-HTTP repository URL without credentials, e.g. https://github.com/owner/repo.git */
  remote: string;
  /** Complete Authorization header value for requests to `remote` only. */
  authorization: string;
  expiresAt: string;
}
export type PushOutcome = "pushed" | "up-to-date" | "failed";
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
  /** The commit now at refs/heads/<branch>; required unless the outcome is "failed". */
  tip?: string;
}
/** How a workspace push identity mints its short-lived tokens. */
export const pushIdentityKinds = ["github-app", "entra-federation", "bitbucket-client-credentials", "oauth-refresh", "forgejo-integration"] as const;
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
}
export interface SessionView {
  sessionId: string;
  owner: Pick<UserProfile, "id" | "displayName" | "gitName" | "gitEmail" | "githubLogin">;
  entries: EntryView[];
  approvals: ApprovalRecord[];
  conversations: { id: string; mode: "write" | "ask"; actorId?: string }[];
  busy: boolean;
  queue?: { submissionId: string; actorId: string; mode: "write" | "ask"; status: string }[];
  /** The shared conversation's current model and reasoning level. */
  agent?: { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
  /** Access mode of the latest shared-conversation submission; absent means "approval". */
  access?: AccessMode;
}
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
/** read: inspect only, no edits or commands. approval: every command and commit needs a human decision. auto: the owner's commands and commits run immediately. */
export const accessModes = ["read", "approval", "auto"] as const;
export type AccessMode = (typeof accessModes)[number];
/** Per-message choices. Omitted model/thinkingLevel keep the conversation's current ones; omitted access means "approval". */
export interface ChatOptions {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  access?: AccessMode;
}
export interface SubmitInput {
  content: string;
  requestId: string;
  admissionId?: string;
  options?: ChatOptions;
}
export interface SubmitResult {
  submissionId: string;
  conversationId: string;
  status: string;
  queuePosition?: number;
}
