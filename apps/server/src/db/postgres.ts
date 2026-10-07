import pg from 'pg';
import { readMigrations } from './migrations.js';
import { translateToPostgres } from './sql.js';
import { ConstraintError, type Database, type ExecResult, type Query, type SqlValue, type Transaction } from './types.js';

const { Pool, types } = pg;
// SQLite INTEGER columns are bigint in Postgres; the application reads them as JS numbers (all values are < 2^53).
types.setTypeParser(types.builtins.INT8, Number);

const MIGRATION_LOCK = 0x70697374; // 'pist'

/** Something that runs `$n` statements: the pool outside transactions, a checked-out client inside one. */
interface Executor {
  query(config: { text: string; values: unknown[] }): Promise<pg.QueryResult>;
}

interface Session {
  executor: Executor;
  /** Row count of the previous INSERT/UPDATE/DELETE in this transaction, what SQLite's `changes()` would return. */
  changes: number;
}

function mapError(error: unknown): unknown {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && (error.code.startsWith('23') || error.code === 'P0001')) {
    return new ConstraintError(error.message, error.message, { cause: error });
  }
  return error;
}

async function execute(session: Session, sql: string, values: SqlValue[]): Promise<{ rows: unknown[]; changes: number }> {
  const statement = translateToPostgres(sql);
  if (values.length !== statement.placeholders) {
    throw new RangeError(`Statement expects ${statement.placeholders} parameters but ${values.length} were bound.`);
  }
  const bound: unknown[] = values.map(value => value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value);
  if (statement.changes) bound.push(session.changes);
  let result: pg.QueryResult;
  try {
    result = await session.executor.query({ text: statement.text, values: bound });
  } catch (error) {
    throw mapError(error);
  }
  const write = result.command === 'INSERT' || result.command === 'UPDATE' || result.command === 'DELETE';
  const changes = write ? result.rowCount ?? 0 : 0;
  if (write) session.changes = changes;
  return { rows: result.rows, changes };
}

export class PostgresDatabase implements Database {
  readonly provider = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly session: Session;

  constructor(url: string, private readonly migrationsDirectory: string) {
    this.pool = new Pool({ connectionString: url });
    this.session = { executor: this.pool, changes: 0 };
  }

  query<T = Record<string, SqlValue>>(sql: string): Query<T> {
    return new PostgresQuery<T>(this.session, sql);
  }

  async batch<T = Record<string, SqlValue>>(statements: Query<T>[]): Promise<{ results: T[]; changes: number }[]> {
    const queries = statements.map(statement => {
      if (!(statement instanceof PostgresQuery)) throw new TypeError('batch() accepts statements created by this database.');
      return statement as PostgresQuery<T>;
    });
    return this.withClient(async session => {
      const results: { results: T[]; changes: number }[] = [];
      for (const query of queries) {
        const { rows, changes } = await execute(session, query.sql, query.values);
        results.push({ results: rows as T[], changes });
      }
      return results;
    });
  }

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.withClient(session => work({ query: <R = Record<string, SqlValue>>(sql: string) => new PostgresQuery<R>(session, sql) }));
  }

  async migrate(): Promise<void> {
    const files = await readMigrations(this.migrationsDirectory);
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const file of files) {
      await this.withClient(async ({ executor }) => {
        // Serialize concurrent starters; re-check once the lock is held.
        await executor.query({ text: 'SELECT pg_advisory_xact_lock($1)', values: [MIGRATION_LOCK] });
        const applied = await executor.query({ text: 'SELECT 1 FROM schema_migrations WHERE name = $1', values: [file.name] });
        if (applied.rowCount) return;
        await executor.query({ text: file.sql, values: [] });
        await executor.query({ text: 'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', values: [file.name, new Date().toISOString()] });
      });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** BEGIN … COMMIT on a dedicated client; ROLLBACK and rethrow (mapped) on any failure. */
  private async withClient<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      try {
        const result = await work({ executor: client, changes: 0 });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw mapError(error);
      }
    } finally {
      client.release(broken);
    }
  }
}

class PostgresQuery<T> implements Query<T> {
  constructor(private readonly session: Session, readonly sql: string, readonly values: SqlValue[] = []) {}

  bind(...values: SqlValue[]): Query<T> {
    return new PostgresQuery<T>(this.session, this.sql, values);
  }

  first(): Promise<T | null>;
  first<K extends keyof T>(column: K): Promise<T[K] | null>;
  async first<K extends keyof T>(column?: K): Promise<T | T[K] | null> {
    const row = (await execute(this.session, this.sql, this.values)).rows[0] as T | undefined;
    if (row == null) return null;
    return column === undefined ? row : row[column] ?? null;
  }

  async all(): Promise<T[]> {
    return (await execute(this.session, this.sql, this.values)).rows as T[];
  }

  async run(): Promise<ExecResult> {
    return { changes: (await execute(this.session, this.sql, this.values)).changes };
  }
}
