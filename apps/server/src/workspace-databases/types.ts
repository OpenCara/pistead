import type { WorkspaceDatabaseTls } from '../../../../packages/shared/src/types.js';

/** Connection settings with the decrypted password, for one operation; never logged, returned or stored in plaintext. */
export interface WorkspaceDatabaseTarget {
  /** Host name or IP address (IPv6 without brackets). */
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: WorkspaceDatabaseTls;
  /** PEM certificates trusted instead of the public roots (verify-full only). */
  caCertificate: string | null;
}

/** One session backup with the workspace's and the session's current records, written in one transaction. */
export interface WorkspaceBackupSave {
  workspace: { id: string; name: string; ownerId: string };
  session: {
    id: string; workspaceId: string; ownerId: string; title: string; status: string; visibility: string; createdAt: string;
    /** The session record as the API shows it, kept as JSON for the owner's own queries. */
    record: unknown;
  };
  backup: { id: string; format: string; sha256: string; size: number; createdAt: string };
  /** The exact backup bytes (canonical JSON) whose digest the control plane keeps. */
  snapshot: Uint8Array;
}

/** Identifies one saved snapshot; `size` is what the control plane recorded, so nothing larger is ever read. */
export interface WorkspaceBackupRef {
  id: string;
  sessionId: string;
  size: number;
}

/** A session as a dump describes it: its record, and with a full export its details (grants, approvals, pushes, backups). */
export interface ImportedSession {
  id: string; ownerId: string; title: string; status: string; visibility: string; createdAt: string;
  record: Record<string, unknown>;
  /** null for sessions a dump lists as records only. */
  data: Record<string, unknown> | null;
}

export interface ImportedAuditEntry {
  id: string;
  /** null for workspace activity. */
  sessionId: string | null;
  actorId: string | null;
  action: string;
  detail: unknown;
  createdAt: string;
}

/**
 * A session or workspace dump, checked and normalized for one workspace's database (see import.ts). Records and details
 * carry the dump's export time: newer ones replace older ones, whichever is imported (or saved) first.
 */
export interface WorkspaceImport {
  /** From the control plane, not the dump. */
  workspace: { id: string; name: string; ownerId: string };
  exportedAt: string;
  /** A workspace dump's settings: members, models, agents, repositories, push access and database connection. */
  workspaceData: Record<string, unknown> | null;
  sessions: ImportedSession[];
  audit: ImportedAuditEntry[];
}

export const workspaceDatabaseFailures = [
  'host_not_allowed', 'host_not_found', 'tls_not_allowed', 'unreachable', 'tls_failed', 'authentication_failed',
  'database_not_found', 'permission_denied', 'pistead_database', 'schema_mismatch', 'response_too_large', 'unavailable',
] as const;
export type WorkspaceDatabaseFailure = (typeof workspaceDatabaseFailures)[number];

/**
 * A workspace database operation failed. Driver, network and TLS messages can name hosts, roles or addresses, so they stay
 * in `cause` and never reach a response; `failure` picks a fixed explanation.
 */
export class WorkspaceDatabaseError extends Error {
  readonly failure: WorkspaceDatabaseFailure;

  constructor(failure: WorkspaceDatabaseFailure, options?: ErrorOptions) {
    super(`Workspace database operation failed: ${failure}`, options);
    this.name = 'WorkspaceDatabaseError';
    this.failure = failure;
  }
}

/**
 * Reaches the databases workspace owners connect: the Postgres implementation in production (`postgres.ts`), a double in
 * tests. Every call opens its own connection and closes it.
 */
export interface WorkspaceDatabaseProvider {
  /** Whether hosts on private networks, and unencrypted connections to them, are allowed. */
  readonly privateHosts: boolean;
  /** Connects, refuses a Pistead server's own database, creates Pistead's tables when missing and checks their privileges. */
  verify(target: WorkspaceDatabaseTarget): Promise<void>;
  save(target: WorkspaceDatabaseTarget, save: WorkspaceBackupSave): Promise<void>;
  /** The snapshot of `backup`, or null when the database has no backup with that id, session and exact size. */
  load(target: WorkspaceDatabaseTarget, backup: WorkspaceBackupRef): Promise<Uint8Array | null>;
  /** Writes a dump's sessions, details, activity and workspace settings in one transaction. */
  import(target: WorkspaceDatabaseTarget, data: WorkspaceImport): Promise<void>;
}
