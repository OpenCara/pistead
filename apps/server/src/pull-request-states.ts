import type { PullRequestState } from '../../../packages/shared/src/types.js';
import { boundedJson } from './github-broker.js';
import { now } from './http.js';
import type { Env } from './types.js';
import { decryptToken } from './vault.js';

/*
 * Session lists show the state of the pull request a push recorded (draft, open, CI failed, changes requested, merged,
 * closed). The control plane reads it in the background with the session owner's GitHub account, as it opened the pull
 * request, and stops once it is merged or closed. Only github.com pull requests are read so far; others show no state.
 * Sessions on a host push with the host's own Git, so for them it also finds the pull request of each branch their host
 * reported (session-branches.ts).
 */

const githubApi = 'https://api.github.com';
const remoteTimeout = 20000;
const pageBytes = 4 * 1024 * 1024;
const perPage = 100;
/** Reviews and check runs are read up to this many pages each. */
const maxPages = 5;
/** How long a state stays fresh: shorter while the session is in use, longer once it is archived. */
const freshMs = 2 * 60_000;
const archivedFreshMs = 30 * 60_000;
/** Pull requests read per sweep, the least recently read first. */
const sweepLimit = 25;
/** The read time of a URL that names no github.com pull request: never stale, so no sweep selects it again. */
const neverStale = '9999-12-31T00:00:00.000Z';

/** owner/name and the number of a github.com pull request URL; undefined for anything else. */
export function githubPullRequest(url: string): { fullName: string; number: number } | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com') return undefined;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\/?$/.exec(parsed.pathname);
  if (!match) return undefined;
  return { fullName: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
const failedStatuses = new Set(['failure', 'error']);

export interface PullRequestFacts {
  /** GitHub's state: open or closed. */
  state: string;
  merged: boolean;
  draft: boolean;
  /** Reviews, oldest first. */
  reviews: { author: string | null; state: string }[];
  /** The head commit's latest check runs. */
  checkRuns: { status: string; conclusion: string | null }[];
  /** The head commit's latest commit status per context. */
  statuses: { state: string }[];
}

/**
 * Merged and closed win, then draft; then changes requested (some reviewer's latest decisive review asks for changes),
 * then failed CI (a check run or commit status failed); otherwise open.
 */
export function pullRequestState(facts: PullRequestFacts): PullRequestState {
  if (facts.merged) return 'merged';
  if (facts.state === 'closed') return 'closed';
  if (facts.draft) return 'draft';
  const decisions = new Map<string, string>();
  for (const review of facts.reviews) {
    // Comments don't change a reviewer's decision; a dismissed review withdraws it.
    if (review.author && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) decisions.set(review.author, review.state);
  }
  if ([...decisions.values()].includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (facts.checkRuns.some(run => run.status === 'completed' && failedConclusions.has(run.conclusion ?? ''))) return 'failing';
  if (facts.statuses.some(status => failedStatuses.has(status.state))) return 'failing';
  return 'open';
}

class ReadError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadError('unexpected GitHub response');
  return value as Record<string, unknown>;
}
const string = (value: unknown): string => typeof value === 'string' ? value : '';

async function githubGet(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${githubApi}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout), headers: {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCara-Agent-Workspace',
  } });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ReadError(`GitHub answered ${response.status}`);
  }
  return boundedJson(response, pageBytes);
}

/** Every item of a paged list, up to `maxPages` pages; `key` names the list inside an object response. */
async function pages(token: string, path: string, key?: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await githubGet(token, `${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`);
    const list = key === undefined ? body : object(body)[key];
    if (!Array.isArray(list)) throw new ReadError('unexpected GitHub response');
    items.push(...list.map(object));
    if (list.length < perPage) break;
  }
  return items;
}

/** Reads a github.com pull request's state with `token`. */
export async function readPullRequestState(token: string, fullName: string, number: number): Promise<PullRequestState> {
  const base = `/repos/${fullName}`;
  const details = object(await githubGet(token, `${base}/pulls/${number}`));
  const facts: PullRequestFacts = { state: string(details.state), merged: details.merged === true, draft: details.draft === true, reviews: [], checkRuns: [], statuses: [] };
  if (facts.merged || facts.state === 'closed' || facts.draft) return pullRequestState(facts);
  const sha = string(object(details.head).sha);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReadError('unexpected GitHub pull request');
  const [reviews, runs, status] = await Promise.all([
    pages(token, `${base}/pulls/${number}/reviews`),
    pages(token, `${base}/commits/${sha}/check-runs?filter=latest`, 'check_runs'),
    githubGet(token, `${base}/commits/${sha}/status?per_page=${perPage}`),
  ]);
  const statuses = object(status).statuses;
  facts.reviews = reviews.map(review => {
    const user = review.user && typeof review.user === 'object' ? (review.user as Record<string, unknown>).login : null;
    return { author: typeof user === 'string' ? user : null, state: string(review.state) };
  });
  facts.checkRuns = runs.map(run => ({ status: string(run.status), conclusion: typeof run.conclusion === 'string' ? run.conclusion : null }));
  facts.statuses = Array.isArray(statuses) ? statuses.map(item => ({ state: string(object(item).state) })) : [];
  return pullRequestState(facts);
}

/**
 * The newest pull request from `branch` of github.com repository `fullName` (owner/name) opened at or after `since`, as
 * its URL and number, or undefined when there is none. Only pull requests from the repository itself are looked for,
 * not from forks.
 */
export async function findBranchPullRequest(token: string, fullName: string, branch: string, since: string): Promise<{ url: string; number: number } | undefined> {
  const owner = fullName.split('/')[0]!;
  const list = await githubGet(token, `/repos/${fullName}/pulls?state=all&sort=created&direction=desc&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (!Array.isArray(list)) throw new ReadError('unexpected GitHub response');
  const sinceMs = Date.parse(since);
  for (const item of list.map(object)) {
    const number = item.number;
    const url = string(item.html_url);
    if (!Number.isSafeInteger(number) || Date.parse(string(item.created_at)) < sinceMs) continue;
    const pull = githubPullRequest(url);
    if (pull && pull.fullName.toLowerCase() === fullName.toLowerCase() && pull.number === number) return { url, number: number as number };
  }
  return undefined;
}

interface StaleRow { id: string; pull_request_url: string; owner_id: string; ciphertext: string }
interface StaleBranchRow { session_id: string; repository: string; branch: string; pull_request_url: string | null; owner_id: string; created_at: string; ciphertext: string }

/**
 * One sweep: reads the state of each session's newest recorded github.com pull request that isn't merged or closed and
 * wasn't read recently, with the session owner's GitHub sign-in token. A pull request that can't be read keeps its
 * last state and is tried again once that goes stale; owners without a GitHub connection, or suspended, are skipped.
 */
export async function refreshPullRequestStates(env: Env, limit = sweepLimit): Promise<void> {
  const at = Date.now();
  const rows = await env.DB.query<StaleRow>(`SELECT pc.id, pc.pull_request_url, s.owner_id, t.ciphertext FROM push_credentials pc
    INNER JOIN sessions s ON s.id = pc.session_id
    INNER JOIN users u ON u.id = s.owner_id
    INNER JOIN github_tokens t ON t.user_id = s.owner_id
    WHERE pc.pull_request_url LIKE 'https://github.com/%' AND u.auth_kind = 'github' AND u.suspended_at IS NULL
      AND pc.id = (SELECT pr.id FROM push_credentials pr WHERE pr.session_id = pc.session_id AND pr.pull_request_url IS NOT NULL
        ORDER BY pr.completed_at DESC, pr.created_at DESC, pr.id DESC LIMIT 1)
      AND (pc.pull_request_state IS NULL OR pc.pull_request_state NOT IN ('merged', 'closed'))
      AND (pc.pull_request_checked_at IS NULL OR pc.pull_request_checked_at < CASE WHEN s.status = 'archived' THEN ? ELSE ? END)
    ORDER BY (pc.pull_request_checked_at IS NOT NULL), pc.pull_request_checked_at, pc.id LIMIT ?`)
    .bind(new Date(at - archivedFreshMs).toISOString(), new Date(at - freshMs).toISOString(), limit).all();
  for (const row of rows) {
    const pull = githubPullRequest(row.pull_request_url);
    let state: PullRequestState | null = null;
    if (pull) {
      try {
        state = await readPullRequestState(await decryptToken(env, row.owner_id, row.ciphertext), pull.fullName, pull.number);
      } catch { /* keep the last state; tried again once it goes stale */ }
    }
    await env.DB.query('UPDATE push_credentials SET pull_request_state = COALESCE(?, pull_request_state), pull_request_checked_at = ? WHERE id = ?')
      .bind(state, pull ? now() : neverStale, row.id).run();
  }
  await refreshBranchPullRequests(env, at, limit);
}

/**
 * The same for the branches sessions on a host reported (session-branches.ts): each branch whose pull request isn't
 * merged or closed and wasn't looked at recently is looked up again, so the newest pull request opened from it since its
 * session was created is found, then its state read. Branches of archived sessions that found none are no longer looked
 * at. A lookup that fails keeps what was found, and is tried again once that goes stale.
 */
async function refreshBranchPullRequests(env: Env, at: number, limit: number): Promise<void> {
  const rows = await env.DB.query<StaleBranchRow>(`SELECT b.session_id, b.repository, b.branch, b.pull_request_url, s.owner_id, s.created_at, t.ciphertext
    FROM session_branches b
    INNER JOIN sessions s ON s.id = b.session_id
    INNER JOIN users u ON u.id = s.owner_id
    INNER JOIN github_tokens t ON t.user_id = s.owner_id
    WHERE u.auth_kind = 'github' AND u.suspended_at IS NULL
      AND (b.pull_request_state IS NULL OR b.pull_request_state NOT IN ('merged', 'closed'))
      AND (b.pull_request_url IS NOT NULL OR s.status <> 'archived')
      AND (b.pull_request_checked_at IS NULL OR b.pull_request_checked_at < CASE WHEN s.status = 'archived' THEN ? ELSE ? END)
    ORDER BY (b.pull_request_checked_at IS NOT NULL), b.pull_request_checked_at, b.session_id, b.repository, b.branch LIMIT ?`)
    .bind(new Date(at - archivedFreshMs).toISOString(), new Date(at - freshMs).toISOString(), limit).all();
  for (const row of rows) {
    let found: { url: string; number: number } | undefined;
    let state: PullRequestState | null = null;
    try {
      const token = await decryptToken(env, row.owner_id, row.ciphertext);
      found = await findBranchPullRequest(token, row.repository, row.branch, row.created_at);
      if (found) state = await readPullRequestState(token, row.repository, found.number);
    } catch { /* keep what was found; tried again once it goes stale */ }
    const checkedAt = now();
    if (found && found.url !== row.pull_request_url) {
      // A pull request found for the first time is the session's newest one.
      await env.DB.query(`UPDATE session_branches SET pull_request_url = ?, pull_request_state = ?, pull_request_found_at = ?, pull_request_checked_at = ?
        WHERE session_id = ? AND repository = ? AND branch = ?`).bind(found.url, state, checkedAt, checkedAt, row.session_id, row.repository, row.branch).run();
    } else {
      await env.DB.query(`UPDATE session_branches SET pull_request_state = COALESCE(?, pull_request_state), pull_request_checked_at = ?
        WHERE session_id = ? AND repository = ? AND branch = ?`).bind(state, checkedAt, row.session_id, row.repository, row.branch).run();
    }
  }
}
