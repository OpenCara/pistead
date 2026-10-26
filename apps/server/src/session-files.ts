import type { Hono } from 'hono';
import type { ConnectorCapabilities } from '../../../packages/shared/src/connector.js';
import { redactSecrets } from '../../../packages/shared/src/redaction.js';
import { fileBrowserLimits, type FileEntry, type SessionFiles } from '../../../packages/shared/src/types.js';
import { requireSession } from './db.js';
import { fail, identifier } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import type { Env, SessionRow, WorkerEnv } from './types.js';

const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const entryTypes: readonly FileEntry['type'][] = ['directory', 'file', 'symlink', 'other'];

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

/** The host's answer, checked for shape before it reaches a browser; anything else is an invalid runner response. */
function checkedFiles(value: unknown, path: string): SessionFiles {
  const invalid = (): never => fail(502, 'invalid_runner_response', 'The runner returned an invalid file listing.');
  const files = value as Record<string, unknown> | null;
  if (!files || typeof files !== 'object' || files.path !== path) invalid();
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (files!.type === 'directory') {
    const { entries, total, truncated } = files!;
    if (!Array.isArray(entries) || entries.length > fileBrowserLimits.entries || !count(total) || typeof truncated !== 'boolean') invalid();
    return { path, type: 'directory', total: total as number, truncated: truncated as boolean, entries: (entries as unknown[]).map(item => {
      const entry = item as Record<string, unknown> | null;
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.includes('/') || !entryTypes.includes(entry.type as FileEntry['type'])
        || (entry.size !== undefined && !count(entry.size))) invalid();
      return { name: entry!.name as string, type: entry!.type as FileEntry['type'], ...(count(entry!.size) ? { size: entry!.size } : {}) };
    }) };
  }
  if (files!.type !== 'file' || !count(files!.size) || typeof files!.truncated !== 'boolean') invalid();
  const base = { path, type: 'file' as const, size: files!.size as number, truncated: files!.truncated as boolean };
  if (typeof files!.text === 'string') {
    // Like the transcript: what looks like a secret is hidden from everyone who views it.
    const text = redactSecrets(files!.text);
    return { ...base, text, ...(text !== files!.text ? { redacted: true } : {}) };
  }
  const image = files!.image as Record<string, unknown> | undefined;
  if (image) {
    if (typeof image.mimeType !== 'string' || !imageTypes.includes(image.mimeType) || typeof image.data !== 'string'
      || image.data.length > Math.ceil(fileBrowserLimits.imageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) invalid();
    return { ...base, image: { mimeType: image.mimeType as string, data: image.data as string } };
  }
  return { ...base, binary: true };
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
