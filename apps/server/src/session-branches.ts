import { validPushBranch, validRepositoryName } from '../../../packages/shared/src/repositories.js';
import type { AppContext, SessionRow } from './types.js';
import { requireCallbackScope } from './connectors.js';
import { fail, identifier, jsonObject, now } from './http.js';

/*
 * A session that runs directly on a host (SessionRecord.hostEnvironment, or any session of an unsandboxed host) pushes
 * and opens pull requests with the host's own Git and credentials, not through git_push, so no push records its pull
 * request. Instead its host reports the branches its clones of the workspace's github.com repositories have checked
 * out, and the control plane looks for each branch's pull request on GitHub with the session owner's account
 * (pull-request-states.ts), so that session lists show it and its state as they do for pushed ones.
 */

/** Branches one report may name: a session rarely has more than a few clones. */
export const sessionBranchLimit = 20;

/**
 * A connector reports the branches the clones of a session it serves have checked out, as { repository: owner/name,
 * branch }. The report replaces the last one: a branch no longer checked out is forgotten unless a pull request was
 * found for it, which the session keeps showing. Display state only: it bumps no policy version and leaves no audit
 * entry, and names only branches of the workspace's own github.com repositories.
 */
export async function reportSessionBranches(c: AppContext, connectorId: string): Promise<Response> {
  const input = await jsonObject(c, 16 * 1024);
  if (Object.keys(input).some(key => key !== 'sessionId' && key !== 'branches') || !Array.isArray(input.branches)
      || input.branches.length > sessionBranchLimit) fail(400, 'invalid_branches', 'Invalid session branches.');
  const reported = (input.branches as unknown[]).map(item => {
    const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (Object.keys(value).some(key => key !== 'repository' && key !== 'branch') || !validRepositoryName('github', value.repository)
        || !validPushBranch(value.branch)) fail(400, 'invalid_branches', 'Invalid session branches.');
    return { repository: value.repository as string, branch: value.branch as string };
  });
  const row = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(identifier(input.sessionId, 'sessionId')).first();
  if (!row) fail(404, 'not_found', 'Session not found.');
  await requireCallbackScope(c, row, connectorId);
  if (row.repository_mode !== 'clone') fail(409, 'clone_session_required', 'Only clone sessions report branches.');
  // GitHub names repositories case-insensitively; the workspace binding's name is the one kept.
  const bound = new Map((await c.env.DB.query<{ full_name: string }>(`SELECT full_name FROM workspace_repositories
    WHERE workspace_id = ? AND provider = 'github' AND host = 'github.com'`).bind(row.workspace_id).all())
    .map(binding => [binding.full_name.toLowerCase(), binding.full_name]));
  const branches = new Map<string, { repository: string; branch: string }>();
  for (const item of reported) {
    const repository = bound.get(item.repository.toLowerCase());
    if (repository) branches.set(`${repository}\n${item.branch}`, { repository, branch: item.branch });
  }
  const at = now();
  const statements = [...branches.values()].map(item => c.env.DB.query(`INSERT INTO session_branches (session_id, repository, branch, reported_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (session_id, repository, branch) DO UPDATE SET reported_at = excluded.reported_at`)
    .bind(row.id, item.repository, item.branch, at));
  // Branches no longer checked out are forgotten, unless they found a pull request. They're told apart by name rather
  // than by report time, which two reports in the same millisecond share.
  const keys = [...branches.keys()];
  statements.push(keys.length
    ? c.env.DB.query(`DELETE FROM session_branches WHERE session_id = ? AND pull_request_url IS NULL
      AND repository || ? || branch NOT IN (${keys.map(() => '?').join(', ')})`).bind(row.id, '\n', ...keys)
    : c.env.DB.query('DELETE FROM session_branches WHERE session_id = ? AND pull_request_url IS NULL').bind(row.id));
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
}
