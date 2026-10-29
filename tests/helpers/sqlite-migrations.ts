import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/**
 * Applies SQLite migration files to `sqlite` one by one, as the server's runner does (apps/server/src/db/sqlite.ts): each
 * in its own transaction and, for a file whose first line is `-- pistead: foreign-keys-off`, with foreign keys off around
 * it and every reference checked before it commits.
 */
export function applySqliteMigrations(sqlite: DatabaseSync, directory: URL, files: readonly string[]): void {
  for (const file of files) {
    const sql = readFileSync(new URL(file, directory), "utf8");
    const keysOff = /^-- pistead: foreign-keys-off\r?\n/.test(sql);
    const keysWereOn = sqlite.prepare("PRAGMA foreign_keys").get()!.foreign_keys === 1;
    if (keysOff) sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(sql);
        if (keysOff && sqlite.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Migration ${file} left rows whose references don't hold.`);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    } finally {
      if (keysOff && keysWereOn) sqlite.exec("PRAGMA foreign_keys = ON");
    }
  }
}
