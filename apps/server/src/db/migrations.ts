import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseProviderName } from './types.js';

export interface MigrationFile { name: string; sql: string }

/**
 * `migrations/<provider>/` next to the code: `apps/server/migrations` when running from source
 * (`apps/server/src/db/` is two levels down) and `dist/server/migrations` when running the bundle,
 * which `pnpm build:server` copies there. `MIGRATIONS_DIR` overrides the parent directory.
 */
export function migrationsDirectory(provider: DatabaseProviderName): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR, provider);
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 3; depth++) {
    const candidate = join(directory, 'migrations', provider);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`No migrations directory for ${provider} near ${fileURLToPath(import.meta.url)}; set MIGRATIONS_DIR.`);
}

/** Every `*.sql` file in `directory`, sorted by name; the order migrations are applied in. */
export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async name => ({ name, sql: await readFile(join(directory, name), 'utf8') })));
}
