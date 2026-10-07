import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readMigrations, type MigrationFile } from './migrations.js';
import { statementShape } from './sql.js';
import { ConstraintError, type Database, type ExecResult, type Query, type SqlValue, type Transaction } from './types.js';

const SQLITE_CONSTRAINT = 19;

/** `sqlite::memory:`, `sqlite:///abs/path.sqlite` or `sqlite:./relative.sqlite` → the path `DatabaseSync` opens. */
export function sqlitePath(url: string): string {
  if (!url.startsWith('sqlite:')) throw new Error('SQLite URLs start with "sqlite:".');
  const rest = url.slice('sqlite:'.length);
  if (rest === ':memory:') return rest;
  if (rest.startsWith('///')) return rest.slice(2);
  if (rest.startsWith('//') || rest === '') throw new Error('Use sqlite::memory:, sqlite:///absolute/path.sqlite or sqlite:./relative.sqlite.');
  return rest;
}

function mapError(error: unknown): unknown {
  if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === SQLITE_CONSTRAINT) {
    return new ConstraintError(error.message, error.message, { cause: error });
  }
  return error;
}

const noop = (): void => {};

export class SqliteDatabase implements Database {
  readonly provider = 'sqlite' as const;
  readonly handle: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly changesStatement: StatementSync;
  /** Settles when every transaction started so far has finished. */
  private queue: Promise<void> = Promise.resolve();
  /** True while a transaction owns the connection; statements outside it wait. */
  private locked = false;
  private closed = false;

  constructor(path: string, private readonly migrationsDirectory: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.handle = new DatabaseSync(path);
    if (path !== ':memory:') this.handle.exec('PRAGMA journal_mode = WAL');
    this.handle.exec('PRAGMA foreign_keys = ON');
    this.handle.exec('PRAGMA busy_timeout = 5000');
    this.changesStatement = this.handle.prepare('SELECT changes() AS changes');
  }

  query<T = Record<string, SqlValue>>(sql: string): Query<T> {
    return new SqliteQuery<T>(this, sql, false);
  }

  async batch<T = Record<string, SqlValue>>(statements: Query<T>[]): Promise<{ results: T[]; changes: number }[]> {
    const queries = statements.map(statement => {
      if (!(statement instanceof SqliteQuery)) throw new TypeError('batch() accepts statements created by this database.');
      return statement as SqliteQuery<T>;
    });
    return this.transaction(async () => queries.map(query => this.execute<T>(query.sql, query.values)));
  }

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.locked = true;
      try {
        this.handle.exec('BEGIN IMMEDIATE');
        let result: T;
        try {
          result = await work({ query: <R = Record<string, SqlValue>>(sql: string) => new SqliteQuery<R>(this, sql, true) });
        } catch (error) {
          this.handle.exec('ROLLBACK');
          throw mapError(error);
        }
        this.handle.exec('COMMIT');
        return result;
      } finally {
        this.locked = false;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(noop, noop);
    return result;
  }

  async migrate(): Promise<void> {
    const files = await readMigrations(this.migrationsDirectory);
    await this.transaction(async () => {
      this.handle.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    });
    const applied = new Set(this.handle.prepare('SELECT name FROM schema_migrations').all().map(row => String(row.name)));
    for (const file of files) {
      if (!applied.has(file.name)) await this.transaction(async () => this.apply(file));
    }
  }

  private apply(file: MigrationFile): void {
    // PRAGMA foreign_keys inside a transaction is a no-op (already ON); PRAGMA defer_foreign_keys must run inside it.
    this.handle.exec(file.sql);
    this.handle.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file.name, new Date().toISOString());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    this.handle.close();
  }

  /** Resolves once no transaction owns the connection (statements inside the transaction skip this). */
  async ready(inTransaction: boolean): Promise<void> {
    while (this.locked && !inTransaction) await this.queue;
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.handle.prepare(sql);
      if (this.statements.size >= 1024) this.statements.clear();
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Runs a statement to completion and reports its rows and `changes()` (0 for reads). */
  execute<T>(sql: string, values: SqlValue[]): { results: T[]; changes: number } {
    try {
      const rows = this.prepare(sql).all(...values) as object[];
      const results = rows.map(row => ({ ...row }) as T);
      return { results, changes: statementShape(sql).write ? Number(this.changesStatement.get()?.changes ?? 0) : 0 };
    } catch (error) {
      throw mapError(error);
    }
  }

  run(sql: string, values: SqlValue[]): ExecResult {
    const shape = statementShape(sql);
    if (shape.returning) return { changes: this.execute(sql, values).changes };
    try {
      const result = this.prepare(sql).run(...values);
      return { changes: shape.write ? Number(result.changes) : 0 };
    } catch (error) {
      throw mapError(error);
    }
  }
}

class SqliteQuery<T> implements Query<T> {
  constructor(private readonly db: SqliteDatabase, readonly sql: string, private readonly inTransaction: boolean,
    readonly values: SqlValue[] = []) {}

  bind(...values: SqlValue[]): Query<T> {
    return new SqliteQuery<T>(this.db, this.sql, this.inTransaction, values);
  }

  first(): Promise<T | null>;
  first<K extends keyof T>(column: K): Promise<T[K] | null>;
  async first<K extends keyof T>(column?: K): Promise<T | T[K] | null> {
    await this.db.ready(this.inTransaction);
    const row = this.db.execute<T>(this.sql, this.values).results[0];
    if (row == null) return null;
    return column === undefined ? row : row[column] ?? null;
  }

  async all(): Promise<T[]> {
    await this.db.ready(this.inTransaction);
    return this.db.execute<T>(this.sql, this.values).results;
  }

  async run(): Promise<ExecResult> {
    await this.db.ready(this.inTransaction);
    return this.db.run(this.sql, this.values);
  }
}
