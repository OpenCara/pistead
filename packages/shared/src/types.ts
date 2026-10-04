import type { SessionRepository } from "./repositories.js";

export const permissions = ["read", "ask", "write", "approve", "manage"] as const;
export type Permission = (typeof permissions)[number];
export type WorkspaceRole = "owner" | "admin" | "member";
export const toolNames = ["identity", "list_files", "read_file", "write_file", "git_status", "git_commit", "bash", "github_comment"] as const;
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
export type Operation =
  | { kind: "git.commit"; message: string }
  | { kind: "bash"; command: string }
  | { kind: "github.comment"; repository: string; issue: number; body: string };
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
