import type { Hono } from 'hono';
import type { Database } from './db/types.js';
import type { WorkerEnv } from './types.js';
import { auditStatement, requireMember } from './db.js';
import { fail, identifier, jsonObject, now } from './http.js';

/** How a workspace's session transcripts load (transcript-display.ts). */
export interface TranscriptSettings {
  /** Views hold each conversation's latest entries; earlier ones load a page at a time as people scroll up. */
  paging: boolean;
}

/** Owner/admin authority, re-checked inside the write (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

/** The workspace's transcript settings; the defaults until an owner or admin saves some. */
export async function workspaceTranscriptSettings(db: Database, workspaceId: string): Promise<TranscriptSettings> {
  const row = await db.query<{ paging: number }>('SELECT paging FROM workspace_transcript_settings WHERE workspace_id = ?').bind(workspaceId).first();
  return { paging: row?.paging === 1 };
}

export function registerTranscriptSettings(app: Hono<WorkerEnv>): void {
  // Every member may see how transcripts load; owners and admins change it.
  app.get('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceTranscriptSettings(c.env.DB, workspaceId) });
  });
  app.put('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).some(key => key !== 'paging') || typeof input.paging !== 'boolean') fail(400, 'invalid_input', 'Set paging to true or false.');
    const settings: TranscriptSettings = { paging: input.paging };
    const saved = await c.env.DB.query(`INSERT INTO workspace_transcript_settings (workspace_id, paging, updated_by, updated_at)
      SELECT ?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET paging = excluded.paging, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING workspace_id`).bind(workspaceId, settings.paging ? 1 : 0, actor, now(), workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.transcripts.updated', workspaceId, null, { ...settings }).run();
    return c.json({ settings });
  });
}
