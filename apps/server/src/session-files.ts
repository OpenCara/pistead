import type { Hono } from 'hono';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { checkBrowseResult, InvalidBrowseResult, type BrowseResult } from '../../../packages/shared/src/file-browser.js';
import type { SessionFiles } from '../../../packages/shared/src/types.js';
import { requireSession } from './db.js';
import { fail, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { Env, SessionRow, WorkerEnv } from './types.js';

/**
 * A worktree path as the file browser asks for it: relative, with no empty, `.` or `..` segment; the worktree's root is
 * `.`. The host checks it again, symlinks included, before reading anything.
 */
export function worktreePath(value: string | undefined): string {
  const path = (value ?? '').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
  if (path.length > 1024 || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || (path !== '.' && path.split('/').some(part => part === '' || part === '.' || part === '..'))) {
    fail(400, 'invalid_path', 'Expected a path relative to the session worktree.');
  }
  return path;
}

/** Whether the session's host browses files; the configured external runner is trusted to. */
async function fileBrowserSupported(env: Env, row: SessionRow): Promise<boolean> {
  if (!row.connector_id) return true;
  const host = await env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ?').bind(row.connector_id).first();
  try { return (JSON.parse(host?.capabilities_json ?? '{}') as ConnectorCapabilities).fileBrowser === true; }
  catch { return false; }
}

/**
 * The host's answer, checked by the same rules as the runner that read it (checkBrowseResult) before it reaches a
 * browser, as the host isn't trusted to have run them; anything else is an invalid runner response.
 */
function checkedFiles(value: unknown, path: string): SessionFiles {
  const files = value as Record<string, unknown> | null;
  let result: BrowseResult;
  try {
    if (!files || typeof files !== 'object' || files.path !== path) throw new InvalidBrowseResult();
    result = checkBrowseResult(files);
  } catch (error) {
    if (error instanceof InvalidBrowseResult) fail(502, 'invalid_runner_response', 'The runner returned an invalid file listing.');
    throw error;
  }
  if (result.type === 'file' && result.text !== undefined) {
    // Like the transcript: what looks like a secret is hidden from everyone who views it.
    const text = redactSecrets(result.text);
    return { path, ...result, text, ...(text !== result.text ? { redacted: true } : {}) };
  }
  return { path, ...result };
}

export function registerSessionFiles(app: Hono<WorkerEnv>): void {
  /**
   * The session panel's file browser: one path of the session's worktree on its host, read-only. It takes `write`, as a
   * collaborator could already have the agent read any file there; viewers and share links see only the conversation.
   */
  app.get('/api/sessions/:id/files', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
    const path = worktreePath(c.req.query('path'));
    if (!await fileBrowserSupported(c.env, row)) {
      fail(409, 'files_unsupported', 'This session\'s host can\'t show its files yet. Its owner can update the pistead connector there.');
    }
    const result = await runnerJSON<{ files?: unknown }>(await runnerRequest(c, row, 'files', '', { path }));
    c.header('Cache-Control', 'no-store');
    return c.json({ files: checkedFiles(result?.files, path) });
  });
}
