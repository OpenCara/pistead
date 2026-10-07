import type { DatabaseSync } from 'node:sqlite';
import { migrationsDirectory } from './migrations.js';
import { PostgresDatabase } from './postgres.js';
import { SqliteDatabase, sqlitePath } from './sqlite.js';
import type { Database } from './types.js';

export { ConstraintError } from './types.js';
export type { Database, DatabaseProviderName, ExecResult, Query, SqlValue, Transaction } from './types.js';

/**
 * Opens the provider named by the URL scheme: `sqlite:` (`sqlite::memory:`, `sqlite:///abs/path.sqlite`,
 * `sqlite:./relative.sqlite`) or `postgres:` / `postgresql:`. Call `migrate()` before serving requests.
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith('sqlite:')) return new SqliteDatabase(sqlitePath(url), migrationsDirectory('sqlite'));
  if (url.startsWith('postgres:') || url.startsWith('postgresql:')) return new PostgresDatabase(url, migrationsDirectory('postgres'));
  throw new Error('DATABASE_URL must start with sqlite:, postgres: or postgresql:.');
}

/** Test seam: the underlying `node:sqlite` connection of a SQLite database, for synchronous fixture setup and PRAGMA checks. */
export function sqliteHandle(db: Database): DatabaseSync {
  if (!(db instanceof SqliteDatabase)) throw new TypeError(`sqliteHandle() needs the sqlite provider, got ${db.provider}.`);
  return db.handle;
}
