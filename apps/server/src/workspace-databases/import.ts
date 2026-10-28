import { HTTPException } from 'hono/http-exception';
import { sessionExportFormat, workspaceExportFormat } from '../data-export.js';
import { auditStatement } from '../db.js';
import type { Database } from '../db/types.js';
import type { Env, WorkspaceRow } from '../types.js';
import { workspaceDatabaseTarget, type WorkspaceDatabaseRow } from './store.js';
import type { ImportedAuditEntry, ImportedSession, WorkspaceDatabaseProvider, WorkspaceImport } from './types.js';

/*
 * Imports a session or workspace dump (data-export.ts) into the database a workspace's owner connected. A dump is
 * untrusted input, checked before anything is written: it must belong to that workspace, its session records and
 * activity entries are checked field by field, and the workspace's settings (members, models, agents, repositories, push
 * identities, database connection) must be lists of objects, kept as JSON for the owner's reference. Only the workspace
 * database changes; the control plane records the import in the workspace's activity.
 */

/** The largest dump the web app uploads; the command line (`--import-dump`) takes larger ones. */
export const maxUploadedDumpBytes = 32 * 1024 * 1024;
/** Dumps nest a few levels; operation details a few more. */
const maxDepth = 64;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const detailKeys = ['grants', 'toolGrants', 'backups', 'restores', 'approvals', 'pushes'] as const;

/** The dump can't be imported; the message says why without repeating the dump's contents. */
export class DumpImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpImportError';
  }
}

export interface ImportSummary {
  format: 'session' | 'workspace';
  exportedAt: string;
  /** Session records written, with or without details. */
  sessions: number;
  /** Sessions whose grants, approvals, pushes, backups and restores came with the dump. */
  sessionDetails: number;
  auditEntries: number;
  workspaceSettings: boolean;
}

function invalid(message: string): never {
  throw new DumpImportError(message);
}

/**
 * A copy Postgres can store: text and JSONB can't hold NUL characters, so they become U+FFFD. Keys are defined as own
 * properties, so a "__proto__" key stays data, as JSON.parse leaves it. Nesting deeper than any dump is refused.
 */
function storable(value: unknown, depth = 0): unknown {
  if (depth > maxDepth) invalid('The dump is nested too deeply.');
  if (typeof value === 'string') return value.replaceAll('\u0000', '\uFFFD');
  if (Array.isArray(value)) return value.map(item => storable(item, depth + 1));
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key.replaceAll('\u0000', '\uFFFD'), { value: storable(item, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }
  return value;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`The dump's ${what} is not an object.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`The dump's ${what} is not a list.`);
  return value;
}

/** Workspace settings a dump carries: kept as they are, but only as a list of objects. */
function objects(value: unknown, what: string): unknown[] {
  const items = list(value, what);
  if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) invalid(`The dump's ${what} are not all objects.`);
  return items;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max) invalid(`The dump has an invalid ${what}.`);
  return value;
}

function identifier(value: unknown, what: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid(`The dump has an invalid ${what}.`);
  return value;
}

/** An ISO time between 1970 and 9999, as Postgres reads it. */
function timestamp(value: unknown, what: string): string {
  const time = typeof value === 'string' && value.length <= 64 ? Date.parse(value) : Number.NaN;
  const iso = Number.isFinite(time) && time >= 0 ? new Date(time).toISOString() : '';
  if (!/^\d{4}-\d\d-\d\dT/.test(iso)) invalid(`The dump has an invalid ${what}.`);
  return iso;
}

function sessionOf(value: unknown, workspaceId: string): Omit<ImportedSession, 'data'> {
  const session = object(value, 'session');
  if (session.workspaceId !== workspaceId) invalid("The dump holds a session of another workspace. Import it into that workspace's database.");
  // The exporter's permissions describe who exported it, not the session.
  const { permissions: _permissions, ...record } = session;
  return {
    id: identifier(session.id, 'session id'),
    ownerId: text(session.ownerId, 'session owner', 200),
    title: text(session.title, 'session title', 1000),
    status: text(session.status, 'session status', 40),
    visibility: session.visibility === undefined ? 'private' : text(session.visibility, 'session visibility', 40),
    createdAt: timestamp(session.createdAt, 'session creation time'),
    record,
  };
}

function auditEntry(value: unknown, sessionId: string | null): ImportedAuditEntry {
  const entry = object(value, 'activity entry');
  return {
    id: identifier(entry.id, 'activity entry id'),
    sessionId,
    actorId: entry.actorId === null || entry.actorId === undefined ? null : text(entry.actorId, 'activity actor', 200),
    action: text(entry.action, 'activity action', 200),
    detail: entry.detail === undefined || entry.detail === null ? {} : entry.detail,
    createdAt: timestamp(entry.createdAt, 'activity time'),
  };
}

/** Which workspace a dump belongs to; a DumpImportError when it is not a Pistead dump. */
export function dumpWorkspaceId(document: unknown): string {
  const dump = object(document, 'contents');
  if (dump.format === workspaceExportFormat) return identifier(object(dump.workspace, 'workspace').id, 'workspace id');
  if (dump.format === sessionExportFormat) return identifier(object(dump.session, 'session').workspaceId, 'session workspace');
  return invalid(`This is not a Pistead dump: its format is neither ${sessionExportFormat} nor ${workspaceExportFormat}.`);
}

/** Checks a dump and shapes it for `workspace`'s database. */
export function importFromDump(document: unknown, workspace: { id: string; name: string; ownerId: string }): WorkspaceImport {
  if (dumpWorkspaceId(document) !== workspace.id) invalid("This dump is of another workspace. Import it into that workspace's database.");
  const dump = object(storable(document), 'contents');
  const exportedAt = timestamp(dump.exportedAt, 'export time');
  const sessions: ImportedSession[] = [];
  const audit: ImportedAuditEntry[] = [];
  // A full session: its record, details and activity (a session dump is one at its top level).
  const addFull = (value: unknown) => {
    const data = object(value, 'session');
    const session = sessionOf(data.session, workspace.id);
    const details: Record<string, unknown> = {};
    for (const key of detailKeys) details[key] = list(data[key], `session ${key}`);
    sessions.push({ ...session, data: details });
    for (const entry of list(data.audit, 'session activity')) audit.push(auditEntry(entry, session.id));
  };
  let workspaceData: Record<string, unknown> | null = null;
  if (dump.format === sessionExportFormat) addFull(dump);
  else {
    workspaceData = { members: objects(dump.members, 'members'), models: objects(dump.models, 'models'), agents: objects(dump.agents, 'agents'),
      repositories: objects(dump.repositories, 'repositories'), pushIdentities: objects(dump.pushIdentities, 'push identities'),
      database: dump.database === undefined || dump.database === null ? null : object(dump.database, 'database connection') };
    for (const entry of list(dump.sessions, 'sessions')) addFull(entry);
    // Sessions the exporter could only view come as records.
    for (const entry of list(dump.otherSessions, 'other sessions')) sessions.push({ ...sessionOf(entry, workspace.id), data: null });
    for (const entry of list(dump.audit, 'workspace activity')) audit.push(auditEntry(entry, null));
  }
  const ids = new Set<string>();
  for (const session of sessions) {
    if (ids.has(session.id)) invalid(`The dump lists session ${session.id} twice.`);
    ids.add(session.id);
  }
  // Activity entries never change: a repeated one is written once, like one already in the database.
  const seen = new Set<string>();
  const entries: ImportedAuditEntry[] = [];
  for (const entry of audit) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { workspace, exportedAt, workspaceData, sessions, audit: entries };
}

function summarize(data: WorkspaceImport): ImportSummary {
  return { format: data.workspaceData ? 'workspace' : 'session', exportedAt: data.exportedAt, sessions: data.sessions.length,
    sessionDetails: data.sessions.filter(session => session.data !== null).length, auditEntries: data.audit.length,
    workspaceSettings: data.workspaceData !== null };
}

/**
 * Imports a dump into the database `workspace`'s owner connected, and records the import in the workspace's activity
 * (`actorId` is null for the operator's command line). Throws DumpImportError for a dump that can't be imported and
 * WorkspaceDatabaseError when the database fails.
 */
export async function importDump(env: Env, provider: WorkspaceDatabaseProvider, workspace: WorkspaceRow, database: WorkspaceDatabaseRow,
  document: unknown, actorId: string | null): Promise<ImportSummary> {
  const data = importFromDump(document, { id: workspace.id, name: workspace.name, ownerId: workspace.owner_id });
  await provider.import(await workspaceDatabaseTarget(env, database), data);
  const summary = summarize(data);
  await auditStatement(env, actorId, 'workspace.database.imported', workspace.id, null, { databaseId: database.id, ...summary }).run();
  return summary;
}

/**
 * The operator's import (main.ts `--import-dump`): the dump names its workspace, which needs a connected database. Uses
 * the server's own settings: WORKSPACE_DATABASES, WORKSPACE_DATABASE_PRIVATE_HOSTS and the VAULT_KEY that reads the
 * password. `provider` replaces the Postgres connection in tests.
 */
export async function importDumpFromCommandLine(db: Database, processEnv: NodeJS.ProcessEnv, document: unknown,
  provider?: WorkspaceDatabaseProvider): Promise<{ summary: ImportSummary; database: WorkspaceDatabaseRow }> {
  const workspaceId = dumpWorkspaceId(document);
  const workspace = await db.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (!workspace) invalid(`Workspace ${workspaceId} is not on this server.`);
  const database = await db.query<WorkspaceDatabaseRow>('SELECT * FROM workspace_databases WHERE workspace_id = ?').bind(workspaceId).first();
  if (!database) invalid(`Workspace ${workspaceId} has no database connected; its owner connects one under Settings → Workspaces → Session database.`);
  let connection = provider;
  if (!connection) {
    if (processEnv.WORKSPACE_DATABASES !== 'true') invalid('Workspace databases are turned off on this server (WORKSPACE_DATABASES).');
    // Loaded only here: the routes import this module, and a server without workspace databases needs no Postgres driver.
    const { PostgresWorkspaceDatabases } = await import('./postgres.js');
    connection = new PostgresWorkspaceDatabases({ privateHosts: processEnv.WORKSPACE_DATABASE_PRIVATE_HOSTS === 'true' });
  }
  const env: Env = { DB: db, APP_ORIGIN: '', VAULT_KEY: processEnv.VAULT_KEY };
  try {
    return { summary: await importDump(env, connection, workspace, database, document, null), database };
  } catch (error) {
    // The only HTTP failure on this path is the vault's.
    if (error instanceof HTTPException) invalid('The database password could not be read: run with the VAULT_KEY this server uses.');
    throw error;
  }
}
