import { now } from './http.js';
import type { Env } from './types.js';

// Kept apart from automatic-backups.ts so the connector routes that call it don't import the backup machinery.

/** A host reported the agent of this session working: something new to back up. Keeps the first time since the last one. */
export async function markSessionChanged(env: Env, sessionId: string, at = now()): Promise<void> {
  await env.DB.query(`INSERT INTO automatic_backups (session_id, changed_at) VALUES (?, ?)
    ON CONFLICT (session_id) DO UPDATE SET changed_at = COALESCE(automatic_backups.changed_at, excluded.changed_at)`)
    .bind(sessionId, at).run();
}
