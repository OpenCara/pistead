import type { WorkspaceDatabase } from '../../../../packages/shared/src/types.js';
import type { Env } from '../types.js';
import { fail } from '../http.js';
import { decryptToken } from '../vault.js';
import {
  WorkspaceDatabaseError, type WorkspaceBackupRef, type WorkspaceDatabaseFailure, type WorkspaceDatabaseTarget,
} from './types.js';

export interface WorkspaceDatabaseRow {
  id: string; workspace_id: string; host: string; port: number; database_name: string; username: string;
  tls: WorkspaceDatabaseTarget['tls']; ca_certificate: string | null; password_ciphertext: string;
  created_by: string; created_at: string; updated_at: string;
}

/** Vault associated data for a workspace database password. */
export function databaseSecretContext(databaseId: string): string {
  return `workspace-database:${databaseId}`;
}

export function publicWorkspaceDatabase(row: WorkspaceDatabaseRow): WorkspaceDatabase {
  return { id: row.id, workspaceId: row.workspace_id, host: row.host, port: row.port, database: row.database_name,
    user: row.username, tls: row.tls, customCa: row.ca_certificate !== null, connectedBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function workspaceDatabaseRow(env: Env, workspaceId: string): Promise<WorkspaceDatabaseRow | null> {
  return env.DB.query<WorkspaceDatabaseRow>('SELECT * FROM workspace_databases WHERE workspace_id = ?').bind(workspaceId).first();
}

/** The connection settings with the password decrypted, for one operation. */
export async function workspaceDatabaseTarget(env: Env, row: WorkspaceDatabaseRow): Promise<WorkspaceDatabaseTarget> {
  return { host: row.host, port: row.port, database: row.database_name, user: row.username, tls: row.tls,
    caCertificate: row.ca_certificate, password: await decryptToken(env, databaseSecretContext(row.id), row.password_ciphertext) };
}

const explanations: Record<WorkspaceDatabaseFailure, string> = {
  host_not_allowed: 'The database host is on a private network, which this server does not connect to. Use a database reachable on the public internet.',
  host_not_found: 'The database host name could not be resolved.',
  tls_not_allowed: 'Unencrypted connections are only allowed to databases on private networks. Choose an encrypted connection.',
  unreachable: 'The database did not accept a connection in time. Check the host, the port and its firewall.',
  tls_failed: 'The encrypted connection to the database failed. Check its certificate, the TLS mode and the CA certificate.',
  authentication_failed: 'The database rejected the user name or password.',
  database_not_found: 'The database does not exist on that server.',
  permission_denied: "The database user can't create or write Pistead's tables (pistead_workspaces, pistead_sessions and pistead_session_backups).",
  pistead_database: "This is a Pistead server's own database. Connect a separate database.",
  response_too_large: 'The database sent more data than expected.',
  unavailable: 'The database could not complete the request.',
};

/**
 * Answers a failed workspace database operation with a fixed explanation, never driver details. `verify`: the owner is
 * saving new settings; `use`: a backup is being saved or read with the stored ones.
 */
export function workspaceDatabaseFailure(error: unknown, phase: 'verify' | 'use'): never {
  if (!(error instanceof WorkspaceDatabaseError)) throw error;
  const explanation = explanations[error.failure];
  if (phase === 'verify') {
    fail(['unreachable', 'response_too_large', 'unavailable'].includes(error.failure) ? 502 : 400, `workspace_database_${error.failure}`, explanation);
  }
  return fail(503, 'workspace_database_unavailable', `The workspace database could not be used. ${explanation} The workspace owner manages this connection.`);
}

/** The workspace keeps its session backups in its own database, but the operator turned workspace databases off. */
export function workspaceDatabasesDisabled(): never {
  return fail(503, 'workspace_databases_disabled', "This workspace keeps its session backups in its own database, which this server no longer connects to. The workspace owner can disconnect it to use the server's backup storage again.");
}

/** Reads a snapshot saved in the workspace's database; null when that database no longer has it. */
export async function loadWorkspaceBackup(env: Env, workspaceId: string, backup: WorkspaceBackupRef): Promise<{ body: Uint8Array; size: number } | null> {
  const provider = env.WORKSPACE_DATABASES;
  if (!provider) workspaceDatabasesDisabled();
  const row = await workspaceDatabaseRow(env, workspaceId);
  if (!row) fail(503, 'workspace_database_disconnected', 'This backup was saved in the workspace database, which is no longer connected.');
  const target = await workspaceDatabaseTarget(env, row);
  let body: Uint8Array | null;
  try {
    body = await provider.load(target, backup);
  } catch (error) {
    workspaceDatabaseFailure(error, 'use');
  }
  return body ? { body, size: body.byteLength } : null;
}
