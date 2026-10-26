import type { HostCommandLevel, RunnerBinding, RunnerTicket, ThinkingLevel } from "./types.js";

export interface LocalModelSummary {
  provider: string;
  modelId: string;
  name: string;
  /** Reasoning levels the host's Pi supports for this model; absent from connectors older than chat options. */
  thinkingLevels?: ThinkingLevel[];
  /** The level Pi on the host starts this model at, one of `thinkingLevels`; absent from connectors older than 0.5.1. */
  thinkingLevel?: ThinkingLevel;
}

export interface ConnectorCapabilities {
  platform: string;
  sandbox: boolean;
  productionShell: boolean;
  /** Owner explicitly opted out of isolation: approved work runs directly as the host user. Absent means false. */
  unsandboxed?: boolean;
  /** The connector applies per-message model, reasoning and access choices. Absent on older connectors. */
  chatOptions?: boolean;
  /**
   * The connector gives the model the images pasted into a message. Absent on older connectors, which would drop them
   * and run the text alone, so they are never sent any.
   */
  chatImages?: boolean;
  /** The connector accepts repositories from providers other than github.com (provider/host pins). Absent on older connectors. */
  gitProviders?: boolean;
  /** The connector pushes session commits with control-plane minted credentials (git_push). Absent on older connectors. */
  gitPush?: boolean;
  /** The host's owner lets pushes in their own sessions use this host's Git credentials (connect --git-credentials). Absent means false. */
  gitCredentials?: boolean;
  /** The connector reads GitHub issues and pull requests and merges pull requests through the control plane (github_read, github_merge). Absent on older connectors. */
  github?: boolean;
  /** The connector opens GitHub issues through the control plane once a human approves each (github_issue). Absent on older connectors. */
  githubIssues?: boolean;
  /**
   * The connector keeps a mirror of each repository its sessions clone, which their clones borrow objects from (see
   * docs/design/repository-cache.md). Absent on older connectors and on hosts started with the cache turned off.
   */
  repositoryCache?: boolean;
  /**
   * The connector accepts sessions moved to it from another host: it restores the source host's live snapshot into a
   * successor session bound to this host and one of its models. Absent on older connectors.
   */
  hostMigration?: boolean;
  /**
   * Sessions on this host start without pinned repositories: the agent clones the workspace's repositories with plain
   * Git, through the session's egress proxy in the sandbox, or with the host's own Git where its owner runs the host
   * unsandboxed. Advertised by every connector of this version, whatever `sandbox` says (isolation is verified per
   * session); absent on older connectors, which can't run new sessions.
   */
  plainGit?: boolean;
  /**
   * Backups and moves of this host's clone sessions keep each clone's local work as a Git bundle, and restoring one
   * clones it again (see Sandbox.cloneBackup). A clone session moves only to a host that has it: an older connector
   * would restore its other files and drop the clones.
   */
  cloneBackups?: boolean;
  /**
   * The connector pushes a clone session's own branch under the name its binding carries (session.branch, named for the
   * session's work), not only `pistead/<session-id>`. Absent on older connectors, whose sessions keep the old name.
   */
  sessionBranches?: boolean;
  /**
   * The connector takes conversation-only backups: the session's Pi conversation and state, without its files or clones.
   * Absent on older connectors, which would take a full backup instead.
   */
  conversationBackups?: boolean;
  /**
   * The connector runs the session owner's GitHub comments and issues under Auto-approve, and merges when the message
   * also chose auto-merge, through the control plane with the message's admission. Absent on older connectors, which
   * still ask for each.
   */
  automaticGitHub?: boolean;
  /**
   * The connector lets members its owner granted host commands to (HostCommandGrant) approve them, or auto-approve
   * them in their own sessions, as the control plane reports. Absent on older connectors: only the owner decides them.
   */
  hostGrants?: boolean;
}

/** A member other than the owner who may manage the host's sharing: its workspace shares and host command grants. */
export interface ConnectorAdmin {
  userId: string;
  name: string;
  createdAt: string;
}

/**
 * Host command authority the host's owner or an admin gave in one workspace the host is shared with: to one member
 * (`userId`), or to every member of the workspace (`userId` null). Expired grants are not listed.
 */
export interface HostCommandGrant {
  workspaceId: string;
  userId: string | null;
  /** The member's display name; absent for a workspace-wide grant. */
  userName?: string;
  level: HostCommandLevel;
  /** When the grant lapses; null for no expiry. */
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ConnectorInfo {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  online: boolean;
  /** The models it offers: those it advertises, less any its owner or an admin disabled. */
  models: LocalModelSummary[];
  // Explicit runtime shares, not the owner's private workspace associations.
  workspaceIds: string[];
  // Private associations are owner-scoped; shared listings expose only their workspace.
  connectedWorkspaceIds?: string[];
  capabilities: ConnectorCapabilities;
  /** The viewer's part in managing it: its owner, or an admin of its sharing. Absent for everyone else. */
  role?: "owner" | "admin";
  /** Listed to its owner and admins. */
  admins?: ConnectorAdmin[];
  /** Listed to its owner and admins. */
  hostGrants?: HostCommandGrant[];
  /**
   * Models it advertises that its owner or an admin disabled (see HostModelSettings): no session starts from one and no
   * message switches to one. Listed to its owner and admins, who can enable them again.
   */
  disabledModels?: LocalModelSummary[];
  /**
   * The viewer's own authority over host commands on it in the listed workspace: owner, or a grant's level. Absent when
   * they hold none.
   */
  hostCommandAccess?: "owner" | HostCommandLevel;
}

/**
 * A host's models as its owner and admins manage them (PATCH /api/connectors/:id/models): what it offers, and what it
 * advertises but they disabled.
 */
export interface HostModelSettings {
  models: LocalModelSummary[];
  disabledModels: LocalModelSummary[];
}

export interface ConnectorPairing {
  id: string;
  code: string;
  expiresAt: string;
}

export interface ConnectorCredentials {
  connectorId: string;
  token: string;
  controlPlaneUrl: string;
}

export interface ConnectorRpcRequest {
  type: "request";
  id: string;
  method: "GET" | "POST";
  path: string;
  body: string;
  ticket: RunnerTicket;
}

export interface ConnectorRpcResponse {
  type: "response";
  id: string;
  status: number;
  body: string;
}

export interface ConnectorWelcome {
  type: "welcome";
  connectorId: string;
  connectionToken: string;
}

export type ConnectorMessage = ConnectorRpcRequest | ConnectorRpcResponse | ConnectorWelcome;

export const connectorLimits = {
  requestBytes: 1024 * 1024,
  responseBytes: 24 * 1024 * 1024,
  frameBytes: 30 * 1024 * 1024,
  bufferedBytes: 32 * 1024 * 1024,
  pendingRequests: 32,
  models: 200,
} as const;

export interface RestoreDescriptor {
  id: string;
  sourceSessionId: string;
  backupId: string;
  sha256: string;
  size: number;
  downloadToken: string;
  /**
   * Present (true) when the snapshot comes from another host: the target then runs its own agent and model on the
   * same owner, workspace and repository pins, instead of the source's exact binding. `backupId` is the migration id.
   */
  migration?: true;
}

export interface RestoreInput {
  binding: RunnerBinding;
  restore: RestoreDescriptor;
}
