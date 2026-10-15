import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import { resolveDatabaseHost, type HostLookup } from './hosts.js';
import {
  WorkspaceDatabaseError, type WorkspaceBackupRef, type WorkspaceBackupSave, type WorkspaceDatabaseFailure,
  type WorkspaceDatabaseProvider, type WorkspaceDatabaseTarget, type WorkspaceImport,
} from './types.js';

const { Client } = pg;

const connectTimeoutMs = 10_000;
const queryTimeoutMs = 30_000;
const endTimeoutMs = 2_000;
/** What a workspace database may send for anything but a snapshot: every other answer is a few small rows. */
const controlResponseBytes = 1024 * 1024;
/** Rows per statement when a dump is imported. */
const importChunk = 500;

/**
 * Pistead's tables in a workspace database, created when missing (in the first schema of the user's search_path); tables
 * created beforehand need these columns. Snapshots keep the exact backup bytes, canonical JSON:
 * `convert_from(snapshot, 'UTF8')::jsonb` reads one. `data` holds what an imported dump adds: a workspace's settings, or a
 * session's grants, approvals, pushes, backups and restores, as of `data_exported_at`.
 */
const tables: readonly { name: string; columns: readonly string[]; create: string }[] = [
  { name: 'pistead_workspaces', columns: ['id', 'name', 'owner_id', 'saved_at', 'data', 'data_exported_at'], create: `CREATE TABLE pistead_workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL,
    data JSONB,
    data_exported_at TIMESTAMPTZ
  )` },
  { name: 'pistead_sessions', columns: ['id', 'workspace_id', 'owner_id', 'title', 'status', 'visibility', 'created_at', 'record', 'saved_at',
    'data', 'data_exported_at'], create: `CREATE TABLE pistead_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    visibility TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    record JSONB NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL,
    data JSONB,
    data_exported_at TIMESTAMPTZ
  )` },
  { name: 'pistead_session_backups', columns: ['id', 'session_id', 'workspace_id', 'owner_id', 'format', 'sha256', 'size', 'snapshot', 'created_at'],
    create: `CREATE TABLE pistead_session_backups (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    format TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size BIGINT NOT NULL,
    snapshot BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX pistead_session_backups_session ON pistead_session_backups (session_id, created_at)` },
  { name: 'pistead_audit', columns: ['id', 'workspace_id', 'session_id', 'actor_id', 'action', 'detail', 'created_at'], create: `CREATE TABLE pistead_audit (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT,
    actor_id TEXT,
    action TEXT NOT NULL,
    detail JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX pistead_audit_session ON pistead_audit (session_id, created_at);
  CREATE INDEX pistead_audit_workspace ON pistead_audit (workspace_id, created_at)` },
];
/** Tables only a Pistead control plane has: such a database is never used as a workspace database. */
const controlPlaneTables = ['workspace_databases', 'schema_migrations', 'auth_sessions'];

/** pg's per-client Connection, which is not part of its typings. */
interface Wire {
  stream?: Duplex;
  on(event: 'sslconnect', listener: () => void): unknown;
}

function wire(client: pg.Client): Wire | undefined {
  return (client as unknown as { connection?: Wire }).connection;
}

/** Clients cut off for sending more than their limit: whatever error pg reports for the dropped connection, this is why. */
const oversized = new WeakSet<object>();

/**
 * pg keeps each server message in memory until it is complete, so a hostile server could send one of gigabytes. Count the
 * bytes pg reads (after TLS) and drop the connection past `limit`; the operation then fails with `response_too_large`.
 * This hooks pg's Connection: its `stream` is the socket until the TLS upgrade emits 'sslconnect', then the TLS socket.
 * Exported for tests.
 */
export function limitResponses(client: pg.Client, limit: number): void {
  const connection = wire(client);
  const plain = connection?.stream;
  if (!connection || !plain) return;
  let received = 0;
  const counter = (stream: Duplex) => (chunk: Buffer) => {
    received += chunk.byteLength;
    if (received <= limit) return;
    oversized.add(client);
    stream.destroy(new WorkspaceDatabaseError('response_too_large'));
  };
  const countPlain = counter(plain);
  plain.on('data', countPlain);
  connection.on('sslconnect', () => {
    plain.off('data', countPlain);
    const secure = connection.stream;
    if (secure && secure !== plain) secure.on('data', counter(secure));
  });
}

/** Ends the session, and drops the socket of a server that never answers the termination. */
async function dispose(client: pg.Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    client.end().catch(() => undefined),
    new Promise<void>(resolve => { timer = setTimeout(resolve, endTimeoutMs); }),
  ]);
  clearTimeout(timer);
  wire(client)?.stream?.destroy();
}

function errorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 2) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? errorCode(error.cause, depth + 1) : undefined;
}

const unreachableCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EADDRNOTAVAIL', '57P03'];

/** A failure this module raised, also when it arrives wrapped as another error's cause. */
function ownFailure(error: unknown, depth = 0): WorkspaceDatabaseError | undefined {
  if (error instanceof WorkspaceDatabaseError) return error;
  if (!error || typeof error !== 'object' || depth > 2 || !('cause' in error)) return undefined;
  return ownFailure(error.cause, depth + 1);
}

/**
 * Maps a driver, network or TLS error to a fixed failure; the original stays only as `cause`. For a client cut off for
 * its response size that is the failure, whichever error pg reported for the dropped connection (often its own
 * "Connection terminated unexpectedly", with no cause). Exported for tests.
 */
export function classify(error: unknown, client?: pg.Client): WorkspaceDatabaseError {
  if (client && oversized.has(client)) return new WorkspaceDatabaseError('response_too_large', { cause: error });
  const own = ownFailure(error);
  if (own) return own;
  const code = errorCode(error) ?? '';
  const message = error instanceof Error ? error.message : '';
  let failure: WorkspaceDatabaseFailure = 'unavailable';
  if (code === '28P01' || code === '28000') failure = 'authentication_failed';
  else if (code === '3D000') failure = 'database_not_found';
  else if (code === '42501') failure = 'permission_denied';
  else if (code === '42703' || code === '42P01') failure = 'schema_mismatch';
  else if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/.test(code) || /\bSSL\b/.test(message)) failure = 'tls_failed';
  else if (unreachableCodes.includes(code) || /timeout|timed out|Connection terminated/i.test(message)) failure = 'unreachable';
  return new WorkspaceDatabaseError(failure, { cause: error });
}

async function transaction(client: pg.Client, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** The columns of those of `names` that are tables the session sees through its search_path. */
async function visibleTables(client: pg.Client, names: readonly string[]): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: unknown; column_name: unknown }>(`SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND pg_catalog.pg_table_is_visible(c.oid)`, [names]);
  const present = new Map<string, Set<string>>();
  for (const { table_name: table, column_name: column } of rows) {
    if (typeof table !== 'string' || typeof column !== 'string') continue;
    const columns = present.get(table) ?? new Set<string>();
    present.set(table, columns.add(column));
  }
  return present;
}

/** Tables an owner created beforehand must have every column Pistead writes. */
function requireColumns(present: Map<string, Set<string>>): void {
  for (const table of tables) {
    const columns = present.get(table.name);
    if (columns && table.columns.some(column => !columns.has(column))) throw new WorkspaceDatabaseError('schema_mismatch');
  }
}

/**
 * Refuses a Pistead control plane's own database, then creates whichever of Pistead's tables are missing. Existing tables
 * are left alone, so an owner can create them beforehand and grant the connecting user only what saving needs.
 */
async function provision(client: pg.Client): Promise<void> {
  const present = await visibleTables(client, [...controlPlaneTables, ...tables.map(table => table.name)]);
  if (controlPlaneTables.every(name => present.has(name))) throw new WorkspaceDatabaseError('pistead_database');
  requireColumns(present);
  if (tables.every(table => present.has(table.name))) return;
  await transaction(client, async () => {
    // Concurrent first saves serialize here instead of racing on CREATE TABLE.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pistead.workspace-database'))");
    const current = await visibleTables(client, tables.map(table => table.name));
    requireColumns(current);
    for (const table of tables) if (!current.has(table.name)) await client.query(table.create);
  });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/** Postgres databases that workspace owners connect, reached over TLS and pinned to an address checked against the host policy. */
export class PostgresWorkspaceDatabases implements WorkspaceDatabaseProvider {
  readonly privateHosts: boolean;
  private readonly lookup: HostLookup | undefined;

  constructor(options: { privateHosts: boolean; lookup?: HostLookup }) {
    this.privateHosts = options.privateHosts;
    this.lookup = options.lookup;
  }

  private async connect(target: WorkspaceDatabaseTarget, responseLimit: number): Promise<pg.Client> {
    const resolved = await resolveDatabaseHost(target.host, { privateHosts: this.privateHosts, lookup: this.lookup });
    if (target.tls === 'disable' && resolved.public) throw new WorkspaceDatabaseError('tls_not_allowed');
    let ssl: false | ConnectionOptions = false;
    if (target.tls !== 'disable') {
      const options: ConnectionOptions = { rejectUnauthorized: target.tls === 'verify-full' };
      // The socket goes to the checked address, while SNI and the certificate check still use the host name.
      if (!isIP(target.host)) options.servername = target.host;
      if (target.tls === 'verify-full' && target.caCertificate) options.ca = target.caCertificate;
      ssl = options;
    }
    // Every setting is explicit, so nothing falls back to the server's PG* environment, a .pgpass file or a unix socket.
    const client = new Client({
      host: resolved.address, port: target.port, database: target.database, user: target.user, password: target.password, ssl,
      application_name: 'pistead', connectionTimeoutMillis: connectTimeoutMs, query_timeout: queryTimeoutMs,
      statement_timeout: queryTimeoutMs, keepAlive: false,
    });
    // pg also reports a lost connection as an 'error' event; the operation in flight rejects on its own.
    client.on('error', () => {});
    limitResponses(client, responseLimit);
    try {
      await client.connect();
    } catch (error) {
      wire(client)?.stream?.destroy();
      throw classify(error, client);
    }
    return client;
  }

  async verify(target: WorkspaceDatabaseTarget): Promise<void> {
    const client = await this.connect(target, controlResponseBytes);
    try {
      await provision(client);
      const { rows } = await client.query<{ allowed: unknown }>(`SELECT
        has_table_privilege('pistead_workspaces', 'SELECT') AND has_table_privilege('pistead_workspaces', 'INSERT')
          AND has_table_privilege('pistead_workspaces', 'UPDATE')
        AND has_table_privilege('pistead_sessions', 'SELECT') AND has_table_privilege('pistead_sessions', 'INSERT')
          AND has_table_privilege('pistead_sessions', 'UPDATE')
        AND has_table_privilege('pistead_session_backups', 'SELECT') AND has_table_privilege('pistead_session_backups', 'INSERT')
        AND has_table_privilege('pistead_audit', 'SELECT') AND has_table_privilege('pistead_audit', 'INSERT')
        AS allowed`);
      if (rows[0]?.allowed !== true) throw new WorkspaceDatabaseError('permission_denied');
    } catch (error) {
      throw classify(error, client);
    } finally {
      await dispose(client);
    }
  }

  async save(target: WorkspaceDatabaseTarget, save: WorkspaceBackupSave): Promise<void> {
    const client = await this.connect(target, controlResponseBytes);
    const { workspace, session, backup } = save;
    try {
      await provision(client);
      await transaction(client, async () => {
        // Records are as of their save or export: a newer one is never replaced by an older one.
        await client.query(`INSERT INTO pistead_workspaces (id, name, owner_id, saved_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_id = EXCLUDED.owner_id, saved_at = EXCLUDED.saved_at
            WHERE pistead_workspaces.saved_at <= EXCLUDED.saved_at`,
        [workspace.id, workspace.name, workspace.ownerId, backup.createdAt]);
        await client.query(`INSERT INTO pistead_sessions (id, workspace_id, owner_id, title, status, visibility, created_at, record, saved_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, visibility = EXCLUDED.visibility,
            record = EXCLUDED.record, saved_at = EXCLUDED.saved_at
            WHERE pistead_sessions.saved_at <= EXCLUDED.saved_at`,
        [session.id, session.workspaceId, session.ownerId, session.title, session.status, session.visibility, session.createdAt,
          JSON.stringify(session.record), backup.createdAt]);
        await client.query(`INSERT INTO pistead_session_backups (id, session_id, workspace_id, owner_id, format, sha256, size, snapshot, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [backup.id, session.id, session.workspaceId, session.ownerId, backup.format, backup.sha256, backup.size,
          Buffer.from(save.snapshot.buffer, save.snapshot.byteOffset, save.snapshot.byteLength), backup.createdAt]);
      });
    } catch (error) {
      throw classify(error, client);
    } finally {
      await dispose(client);
    }
  }

  async load(target: WorkspaceDatabaseTarget, backup: WorkspaceBackupRef): Promise<Uint8Array | null> {
    // A bytea arrives as hex text, two characters per byte, so the snapshot may take twice its size on the wire.
    const client = await this.connect(target, backup.size * 2 + controlResponseBytes);
    try {
      const { rows } = await client.query<{ snapshot: unknown }>(`SELECT snapshot FROM pistead_session_backups
        WHERE id = $1 AND session_id = $2 AND octet_length(snapshot) = $3`, [backup.id, backup.sessionId, backup.size]);
      const snapshot = rows[0]?.snapshot;
      if (snapshot === undefined) return null;
      if (!Buffer.isBuffer(snapshot) || snapshot.byteLength !== backup.size) throw new WorkspaceDatabaseError('unavailable');
      return new Uint8Array(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
    } catch (error) {
      // The owner dropped the table: the snapshot is simply gone.
      if (errorCode(error) === '42P01') return null;
      throw classify(error, client);
    } finally {
      await dispose(client);
    }
  }

  async import(target: WorkspaceDatabaseTarget, data: WorkspaceImport): Promise<void> {
    const client = await this.connect(target, controlResponseBytes);
    const { workspace, exportedAt } = data;
    try {
      await provision(client);
      await transaction(client, async () => {
        // The workspace's name and owner come from the control plane now; its settings from the dump, as of its export.
        await client.query(`INSERT INTO pistead_workspaces (id, name, owner_id, saved_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_id = EXCLUDED.owner_id, saved_at = EXCLUDED.saved_at
            WHERE pistead_workspaces.saved_at <= EXCLUDED.saved_at`,
        [workspace.id, workspace.name, workspace.ownerId, new Date().toISOString()]);
        if (data.workspaceData) {
          await client.query(`UPDATE pistead_workspaces SET data = $2::jsonb, data_exported_at = $3
            WHERE id = $1 AND (data_exported_at IS NULL OR data_exported_at <= $3)`, [workspace.id, JSON.stringify(data.workspaceData), exportedAt]);
        }
        // Records and details as of the export replace older ones only; activity entries never change, so they are added once.
        for (const sessions of chunks(data.sessions, importChunk)) {
          await client.query(`INSERT INTO pistead_sessions (id, workspace_id, owner_id, title, status, visibility, created_at, record, saved_at)
            SELECT s.id, $1, s.owner_id, s.title, s.status, s.visibility, s.created_at, s.record, $2
            FROM jsonb_to_recordset($3::jsonb) AS s(id text, owner_id text, title text, status text, visibility text, created_at timestamptz, record jsonb)
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, visibility = EXCLUDED.visibility,
              record = EXCLUDED.record, saved_at = EXCLUDED.saved_at
              WHERE pistead_sessions.saved_at <= EXCLUDED.saved_at`,
          [workspace.id, exportedAt, JSON.stringify(sessions.map(session => ({ id: session.id, owner_id: session.ownerId, title: session.title,
            status: session.status, visibility: session.visibility, created_at: session.createdAt, record: session.record })))]);
          const details = sessions.flatMap(session => session.data === null ? [] : [{ id: session.id, data: session.data }]);
          if (details.length) {
            await client.query(`UPDATE pistead_sessions AS s SET data = d.data, data_exported_at = $2
              FROM jsonb_to_recordset($1::jsonb) AS d(id text, data jsonb)
              WHERE s.id = d.id AND (s.data_exported_at IS NULL OR s.data_exported_at <= $2)`, [JSON.stringify(details), exportedAt]);
          }
        }
        for (const entries of chunks(data.audit, importChunk)) {
          await client.query(`INSERT INTO pistead_audit (id, workspace_id, session_id, actor_id, action, detail, created_at)
            SELECT a.id, $1, a.session_id, a.actor_id, a.action, a.detail, a.created_at
            FROM jsonb_to_recordset($2::jsonb) AS a(id text, session_id text, actor_id text, action text, detail jsonb, created_at timestamptz)
            ON CONFLICT (id) DO NOTHING`,
          [workspace.id, JSON.stringify(entries.map(entry => ({ id: entry.id, session_id: entry.sessionId, actor_id: entry.actorId,
            action: entry.action, detail: entry.detail, created_at: entry.createdAt })))]);
        }
      });
    } catch (error) {
      throw classify(error, client);
    } finally {
      await dispose(client);
    }
  }
}
