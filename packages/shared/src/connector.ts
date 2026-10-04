import type { RunnerBinding, RunnerTicket, ThinkingLevel } from "./types.js";

export interface LocalModelSummary {
  provider: string;
  modelId: string;
  name: string;
  /** Reasoning levels the host's Pi supports for this model; absent from connectors older than chat options. */
  thinkingLevels?: ThinkingLevel[];
}

export interface ConnectorCapabilities {
  platform: string;
  sandbox: boolean;
  productionShell: boolean;
  /** Owner explicitly opted out of isolation: approved work runs directly as the host user. Absent means false. */
  unsandboxed?: boolean;
  /** The connector applies per-message model, reasoning and access choices. Absent on older connectors. */
  chatOptions?: boolean;
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
}

export interface RestoreInput {
  binding: RunnerBinding;
  restore: RestoreDescriptor;
}
