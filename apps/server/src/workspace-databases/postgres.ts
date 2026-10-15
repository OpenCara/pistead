import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import { resolveDatabaseHost, type HostLookup } from './hosts.js';
import {
  WorkspaceDatabaseError, type WorkspaceBackupRef, type WorkspaceBackupSave, type WorkspaceDatabaseFailure,
  type WorkspaceDatabaseProvider, type WorkspaceDatabaseTarget,
} from './types.js';

const { Client } = pg;

const connectTimeoutMs = 10_000;
const queryTimeoutMs = 30_000;
const endTimeoutMs = 2_000;
/** What a workspace database may send for anything but a snapshot: every other answer is a few small rows. */
const controlResponseBytes = 1024 * 1024;

/**
 * Pistead's tables in a workspace database, created when missing (in the first schema of the user's search_path).
 * Snapshots keep the exact backup bytes, canonical JSON: `convert_from(snapshot, 'UTF8')::jsonb` reads one.
 */
const tables: readonly { name: string; create: string }[] = [
  { name: 'pistead_workspaces', create: `CREATE TABLE pistead_workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL
  )` },
  { name: 'pistead_sessions', create: `CREATE TABLE pistead_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    visibility TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    record JSONB NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL
  )` },
  { name: 'pistead_session_backups', create: `CREATE TABLE pistead_session_backups (
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

/**
 * pg keeps each server message in memory until it is complete, so a hostile server could send one of gigabytes. Count the
 * bytes pg reads (after TLS) and drop the connection past `limit`; the operation then fails with `response_too_large`.
 * This hooks pg's Connection: its `stream` is the socket until the TLS upgrade emits 'sslconnect', then the TLS socket.
 */
function limitResponses(client: pg.Client, limit: number): void {
  const connection = wire(client);
  const plain = connection?.stream;
  if (!connection || !plain) return;
  let received = 0;
  const counter = (stream: Duplex) => (chunk: Buffer) => {
    received += chunk.byteLength;
    if (received > limit) stream.destroy(new WorkspaceDatabaseError('response_too_large'));
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

/** Maps a driver, network or TLS error to a fixed failure; the original stays only as `cause`. */
function classify(error: unknown): WorkspaceDatabaseError {
  if (error instanceof WorkspaceDatabaseError) return error;
  const code = errorCode(error) ?? '';
  const message = error instanceof Error ? error.message : '';
  let failure: WorkspaceDatabaseFailure = 'unavailable';
  if (code === '28P01' || code === '28000') failure = 'authentication_failed';
  else if (code === '3D000') failure = 'database_not_found';
  else if (code === '42501') failure = 'permission_denied';
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

/** Which of `names` are tables the session sees through its search_path. */
async function visibleTables(client: pg.Client, names: readonly string[]): Promise<Set<string>> {
  const { rows } = await client.query<{ name: unknown }>(`SELECT c.relname AS name FROM pg_catalog.pg_class c
    WHERE c.relname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND pg_catalog.pg_table_is_visible(c.oid)`, [names]);
  return new Set(rows.map(row => row.name).filter((name): name is string => typeof name === 'string'));
}

/**
 * Refuses a Pistead control plane's own database, then creates whichever of Pistead's tables are missing. Existing tables
 * are left alone, so an owner can create them beforehand and grant the connecting user only what saving needs.
 */
async function provision(client: pg.Client): Promise<void> {
  const present = await visibleTables(client, [...controlPlaneTables, ...tables.map(table => table.name)]);
  if (controlPlaneTables.every(name => present.has(name))) throw new WorkspaceDatabaseError('pistead_database');
  if (tables.every(table => present.has(table.name))) return;
  await transaction(client, async () => {
    // Concurrent first saves serialize here instead of racing on CREATE TABLE.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pistead.workspace-database'))");
    const current = await visibleTables(client, tables.map(table => table.name));
    for (const table of tables) if (!current.has(table.name)) await client.query(table.create);
  });
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
      throw classify(error);
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
        AS allowed`);
      if (rows[0]?.allowed !== true) throw new WorkspaceDatabaseError('permission_denied');
    } catch (error) {
      throw classify(error);
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
        await client.query(`INSERT INTO pistead_workspaces (id, name, owner_id, saved_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_id = EXCLUDED.owner_id, saved_at = EXCLUDED.saved_at`,
        [workspace.id, workspace.name, workspace.ownerId, backup.createdAt]);
        await client.query(`INSERT INTO pistead_sessions (id, workspace_id, owner_id, title, status, visibility, created_at, record, saved_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, visibility = EXCLUDED.visibility,
            record = EXCLUDED.record, saved_at = EXCLUDED.saved_at`,
        [session.id, session.workspaceId, session.ownerId, session.title, session.status, session.visibility, session.createdAt,
          JSON.stringify(session.record), backup.createdAt]);
        await client.query(`INSERT INTO pistead_session_backups (id, session_id, workspace_id, owner_id, format, sha256, size, snapshot, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [backup.id, session.id, session.workspaceId, session.ownerId, backup.format, backup.sha256, backup.size,
          Buffer.from(save.snapshot.buffer, save.snapshot.byteOffset, save.snapshot.byteLength), backup.createdAt]);
      });
    } catch (error) {
      throw classify(error);
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
      throw classify(error);
    } finally {
      await dispose(client);
    }
  }
}
