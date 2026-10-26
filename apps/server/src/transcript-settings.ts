import type { Hono } from 'hono';
import type { WorkerEnv } from './types.js';
import { auditStatement, requireMember } from './db.js';
import { fail, identifier, jsonObject } from './http.js';

/** How a workspace's session transcripts load (transcript-display.ts). */
export interface TranscriptSettings {
  /** Views hold each conversation's latest entries; earlier ones load a page at a time as people scroll up. */
  paging: boolean;
}

export function registerTranscriptSettings(app: Hono<WorkerEnv>): void {
  // Every member may see how transcripts load; owners and admins change it.
  app.get('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    const row = await c.env.DB.query<{ transcript_paging: number }>('SELECT transcript_paging FROM workspaces WHERE id = ?').bind(workspaceId).first();
    if (!row) fail(404, 'not_found', 'Workspace not found.');
    return c.json({ settings: { paging: row.transcript_paging === 1 } satisfies TranscriptSettings });
  });
  app.put('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    if (Object.keys(input).some(key => key !== 'paging') || typeof input.paging !== 'boolean') fail(400, 'invalid_input', 'Set paging to true or false.');
    const settings: TranscriptSettings = { paging: input.paging };
    // Authority is checked again inside the write.
    const saved = await c.env.DB.query(`UPDATE workspaces SET transcript_paging = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))
      RETURNING id`).bind(settings.paging ? 1 : 0, workspaceId, workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    await auditStatement(c.env, actor, 'workspace.transcripts.updated', workspaceId, null, { ...settings }).run();
    return c.json({ settings });
  });
}
