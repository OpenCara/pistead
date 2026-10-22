import type { RunnerBinding, RunnerTicket, ThinkingLevel } from "./types.js";

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
  /** The connector accepts repositories from providers other than github.com (provider/host pins). Absent on older connectors. */
  gitProviders?: boolean;
  /** The connector pushes session commits with control-plane minted credentials (git_push). Absent on older connectors. */
  gitPush?: boolean;
  /** The host's owner lets pushes in their own sessions use this host's Git credentials (connect --git-credentials). Absent means false. */
  gitCredentials?: boolean;
  /** The connector reads GitHub issues and pull requests and merges pull requests through the control plane (github_read, github_merge). Absent on older connectors. */
  github?: boolean;
  /**
   * The connector checks pinned repositories out of its host repository cache, fetched with the host's own Git
   * credentials after the control plane re-authorizes the session owner, instead of downloading archives. Absent on
   * older connectors and on hosts started with the cache turned off.
   */
  repositoryCache?: boolean;
  /**
   * The connector accepts sessions moved to it from another host: it restores the source host's live snapshot into a
   * successor session bound to this host and one of its models. Absent on older connectors.
   */
  hostMigration?: boolean;
  /**
   * Sandboxed sessions on this host can start without pinned repositories: the agent clones the workspace's repositories
   * with plain Git through the session's egress proxy, and git_push pushes a clone's commits. Absent on older connectors
   * and on hosts without the sandbox.
   */
  plainGit?: boolean;
}

export interface ConnectorInfo {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  online: boolean;
  models: LocalModelSummary[];
  // Explicit runtime shares, not the owner's private workspace associations.
  workspaceIds: string[];
  // Private associations are owner-scoped; shared listings expose only their workspace.
  connectedWorkspaceIds?: string[];
  capabilities: ConnectorCapabilities;
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
