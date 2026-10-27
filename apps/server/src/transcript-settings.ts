import type { Hono } from 'hono';
import type { Database } from './db/types.js';
import type { WorkerEnv } from './types.js';
import { auditStatement, requireMember } from './db.js';
import { fail, identifier, jsonObject, now } from './http.js';
import { toolOutputs, type ToolOutput } from '../../../packages/shared/src/transcript-display.js';

/** How a workspace's session transcripts load and show (transcript-display.ts). */
export interface TranscriptSettings {
  /** Views hold each conversation's latest entries; earlier ones load a page at a time as people scroll up. */
  paging: boolean;
  /**
   * The tool output each new session here starts with (`SessionRecord.toolOutput`). Its owner can change their session's
   * afterwards; changing this leaves existing sessions as they are.
   */
  toolOutput: ToolOutput;
}

/** Owner/admin authority, re-checked inside the write (binds workspace id, user id). */
const adminSql = `EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin'))`;

interface SettingsRow { paging: number; tool_output: string }

function settingsOf(row: SettingsRow | null | undefined): TranscriptSettings {
  return { paging: row?.paging === 1, toolOutput: row?.tool_output === 'brief' ? 'brief' : 'full' };
}

/** The workspace's transcript settings; the defaults until an owner or admin saves some. */
export async function workspaceTranscriptSettings(db: Database, workspaceId: string): Promise<TranscriptSettings> {
  const row = await db.query<SettingsRow>('SELECT paging, tool_output FROM workspace_transcript_settings WHERE workspace_id = ?').bind(workspaceId).first();
  return settingsOf(row);
}

/** The tool output a new session in the workspace starts with. */
export async function newSessionToolOutput(db: Database, workspaceId: string): Promise<ToolOutput> {
  return (await workspaceTranscriptSettings(db, workspaceId)).toolOutput;
}

export function registerTranscriptSettings(app: Hono<WorkerEnv>): void {
  // Every member may see how transcripts load; owners and admins change it.
  app.get('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    await requireMember(c.env, workspaceId, c.get('auth').userId);
    return c.json({ settings: await workspaceTranscriptSettings(c.env.DB, workspaceId) });
  });
  // Either setting or both; one left out keeps its value.
  app.put('/api/workspaces/:id/transcripts', async c => {
    const workspaceId = identifier(c.req.param('id'));
    const actor = c.get('auth').userId;
    await requireMember(c.env, workspaceId, actor, ['owner', 'admin']);
    const input = await jsonObject(c, 1024);
    const keys = Object.keys(input);
    if (!keys.length || keys.some(key => key !== 'paging' && key !== 'toolOutput')
      || ('paging' in input && typeof input.paging !== 'boolean')
      || ('toolOutput' in input && !toolOutputs.includes(input.toolOutput as ToolOutput))) {
      fail(400, 'invalid_input', 'Set paging to true or false, toolOutput to full or brief, or both.');
    }
    const paging = typeof input.paging === 'boolean' ? input.paging : undefined;
    const toolOutput = 'toolOutput' in input ? input.toolOutput as ToolOutput : undefined;
    // Only what was sent changes; a first save starts from the defaults.
    const updates = [...(paging !== undefined ? ['paging = excluded.paging'] : []), ...(toolOutput !== undefined ? ['tool_output = excluded.tool_output'] : []),
      'updated_by = excluded.updated_by', 'updated_at = excluded.updated_at'];
    const saved = await c.env.DB.query<SettingsRow>(`INSERT INTO workspace_transcript_settings (workspace_id, paging, tool_output, updated_by, updated_at)
      SELECT ?,?,?,?,? WHERE ${adminSql}
      ON CONFLICT (workspace_id) DO UPDATE SET ${updates.join(', ')}
      RETURNING paging, tool_output`).bind(workspaceId, paging ? 1 : 0, toolOutput ?? 'full', actor, now(), workspaceId, actor).first();
    if (!saved) fail(403, 'forbidden', 'Workspace administrator access is required.');
    const settings = settingsOf(saved);
    await auditStatement(c.env, actor, 'workspace.transcripts.updated', workspaceId, null,
      { ...(paging !== undefined ? { paging } : {}), ...(toolOutput !== undefined ? { toolOutput } : {}) }).run();
    return c.json({ settings });
  });
}
