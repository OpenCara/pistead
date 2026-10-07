/** A bound parameter. Booleans are stored as 0/1 integers on every provider. */
export type SqlValue = string | number | null | Uint8Array;

export interface ExecResult {
  /** Rows changed by an INSERT, UPDATE or DELETE; 0 for reads. */
  changes: number;
}

export interface Query<T> {
  bind(...values: SqlValue[]): Query<T>;
  /** The first row, or `column`'s value from it; null when there is none. */
  first(): Promise<T | null>;
  first<K extends keyof T>(column: K): Promise<T[K] | null>;
  all(): Promise<T[]>;
  run(): Promise<ExecResult>;
}

/**
 * The control plane's SQL access. Statements are written once in SQLite syntax with `?`
 * placeholders; each provider translates them (`apps/server/src/db/sql.ts`) before execution.
 *
 * A `transaction` callback runs on one connection with the isolation the provider supports
 * (SQLite: a serialized write transaction; Postgres: READ COMMITTED on a dedicated connection).
 * `changes()` inside a transaction refers to the previous statement of that transaction.
 */
export interface Database {
  readonly provider: DatabaseProviderName;
  query<T = Record<string, SqlValue>>(sql: string): Query<T>;
  /** Runs all statements atomically and returns their results in order; the whole batch rolls back on any failure. */
  batch<T = Record<string, SqlValue>>(statements: Query<T>[]): Promise<{ results: T[]; changes: number }[]>;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Applies pending migrations from `apps/server/migrations/<provider>/`; safe to call on every start. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface Transaction {
  query<T = Record<string, SqlValue>>(sql: string): Query<T>;
}

export const databaseProviderNames = ['sqlite', 'postgres'] as const;
export type DatabaseProviderName = (typeof databaseProviderNames)[number];

/**
 * Raised for constraint violations (UNIQUE, CHECK, FOREIGN KEY, trigger RAISE(ABORT)) on every provider,
 * so callers test `error instanceof ConstraintError` instead of parsing driver messages.
 * `constraint` carries the provider's constraint or trigger message text for callers that must tell them apart.
 */
export class ConstraintError extends Error {
  constructor(message: string, readonly constraint: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConstraintError';
  }
}
