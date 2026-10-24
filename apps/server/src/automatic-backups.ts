import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createBackup } from './backups.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';

/**
 * Automatic backups: a workspace whose owner connected a database of their own can have its sessions backed up there on
 * a schedule, instead of only when a session owner asks. A sweep (main.ts) runs every minute and backs up each session
 * that changed since its last automatic backup, once it is idle and its interval has passed:
 *
 * - Only into the workspace's database, never into the server's storage instead (createBackup refuses that).
 * - Only sessions whose owner is the workspace owner, or who gave their standing confirmation of that same database
 *   (workspace_database_consents); pointing the connection at another database asks them again.
 * - "Changed" comes from the host's activity reports: a session is marked when its agent starts working.
 */

/** How often a workspace owner may have its sessions backed up automatically, in minutes. */
export const automaticBackupIntervals = [15, 60, 360, 1440] as const;
export type AutomaticBackupInterval = (typeof automaticBackupIntervals)[number];

export function isAutomaticBackupInterval(value: unknown): value is AutomaticBackupInterval {
  return automaticBackupIntervals.includes(value as AutomaticBackupInterval);
}

/** A failed attempt is retried after this many minutes at the earliest, so an unreachable host isn't asked every minute. */
const retryMinutes = 15;
/** The most backups one sweep takes; the rest wait for the next one, oldest change first. */
const sweepLimit = 10;

type DueSession = SessionRow & { automatic_changed_at: string; automatic_database_id: string; automatic_minutes: number };

/** What one attempt did, for tests and logs: the backup it saved, or the error code it stopped at. */
export type AutomaticBackupOutcome = { sessionId: string; backupId: string } | { sessionId: string; error: string };

function minutesLater(from: number, minutes: number): string {
  return new Date(from + minutes * 60_000).toISOString();
}

/**
 * Runs `work` as the session's owner, with a request context of its own: every check a backup makes (membership, session
 * access, suspension, the host's ticket) applies as if the owner had asked. The owner gave that permission by owning the
 * workspace or by confirming its database for automatic backups.
 */
async function asSessionOwner<T>(env: Env, row: SessionRow, work: (c: AppContext) => Promise<T>): Promise<T> {
  const app = new Hono<WorkerEnv>();
  // A holder rather than a `let`: TypeScript doesn't see assignments made inside the handler.
  const result: { outcome?: { value: T } | { error: unknown } } = {};
  app.post('/', async c => {
    c.set('auth', { userId: row.owner_id, tokenHash: 'automatic-backup', csrfToken: '', client: 'native' });
    try {
      result.outcome = { value: await work(c) };
    } catch (error) {
      result.outcome = { error };
    }
    return c.body(null, 204);
  });
  await app.request('/', { method: 'POST' }, env);
  const { outcome } = result;
  if (!outcome) throw new Error('The automatic backup did not run.');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/** The error code an attempt stopped at: the API's own code for refusals, else 'internal_error'. */
async function errorCode(error: unknown): Promise<string> {
  if (error instanceof HTTPException) {
    try {
      const body = await error.getResponse().json() as { code?: unknown };
      if (typeof body.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code)) return body.code;
    } catch { /* not a JSON refusal */ }
  }
  return 'internal_error';
}

/** Backs up the sessions that are due now; see the top of this file. Safe to call at any time. */
export async function runAutomaticBackups(env: Env, at = Date.now()): Promise<AutomaticBackupOutcome[]> {
  // Off on this server: nothing is saved, and nothing falls back to the server's storage.
  if (!env.WORKSPACE_DATABASES) return [];
  const timestamp = new Date(at).toISOString();
  const due = await env.DB.query<DueSession>(`SELECT s.*, a.changed_at AS automatic_changed_at, d.id AS automatic_database_id,
      d.automatic_backup_minutes AS automatic_minutes
    FROM automatic_backups a
    JOIN sessions s ON s.id = a.session_id
    JOIN workspaces w ON w.id = s.workspace_id
    JOIN workspace_databases d ON d.workspace_id = s.workspace_id
    WHERE a.changed_at IS NOT NULL AND (a.due_at IS NULL OR a.due_at <= ?)
      AND d.automatic_backup_minutes IS NOT NULL
      AND s.status <> 'archived'
      AND (s.activity IS NULL OR s.activity NOT IN ('working', 'waiting'))
      AND (s.owner_id = w.owner_id OR EXISTS (SELECT 1 FROM workspace_database_consents c
        WHERE c.database_id = d.id AND c.user_id = s.owner_id))
    ORDER BY a.changed_at, a.session_id LIMIT ?`).bind(timestamp, sweepLimit).all();
  const outcomes: AutomaticBackupOutcome[] = [];
  for (const row of due) {
    // Claim the change before asking the host: a change reported while the snapshot is taken marks the session again.
    const claimed = await env.DB.query(`UPDATE automatic_backups SET changed_at = NULL, attempted_at = ?, due_at = ?
      WHERE session_id = ? AND changed_at = ?`)
      .bind(timestamp, minutesLater(at, row.automatic_minutes), row.id, row.automatic_changed_at).run();
    if (claimed.changes !== 1) continue;
    try {
      // The consent the query found is for this database id; createBackup refuses if the connection changed meanwhile.
      const { backup } = await asSessionOwner(env, row, c => createBackup(c, row, { automatic: true, trustedDatabaseId: row.automatic_database_id }));
      await env.DB.query('UPDATE automatic_backups SET backup_id = ?, error = NULL WHERE session_id = ?').bind(backup.id, row.id).run();
      outcomes.push({ sessionId: row.id, backupId: backup.id });
    } catch (error) {
      const code = await errorCode(error);
      // Still changed: try again later, keeping the earliest change.
      await env.DB.query(`UPDATE automatic_backups SET changed_at = COALESCE(changed_at, ?), due_at = ?, error = ? WHERE session_id = ?`)
        .bind(row.automatic_changed_at, minutesLater(at, Math.min(retryMinutes, row.automatic_minutes)), code, row.id).run();
      outcomes.push({ sessionId: row.id, error: code });
    }
  }
  return outcomes;
}
