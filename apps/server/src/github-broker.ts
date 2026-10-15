import type { GitHubSessionRepository, SessionRepository } from '../../../packages/shared/src/repositories.js';
import { repositoryLimits } from '../../../packages/shared/src/repositories.js';
import type {
  GitHubCommentView, GitHubIssueView, GitHubMergeResult, GitHubPullRequestView, GitHubReviewCommentView, GitHubReviewView, Operation,
} from '../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import type { AppContext, Env, SessionRow } from './types.js';
import { auditStatement, getUser, sessionAccess } from './db.js';
import { fail, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { githubRepositoryName, issueNumber, parseOperation } from './operations.js';
import { decryptToken } from './vault.js';
import { requireCallbackScope } from './connectors.js';
import { requireBrokerReview, requireToolCall } from './approval-reviews.js';
import { recheckAccess, validPin, verifyRepository, type GitHubAccess } from './repositories.js';
import { requireBinding, requireNoRestore } from './push/broker.js';

/*
 * Agents reach GitHub only through these brokers, as the session owner: the owner's token stays in the control plane's
 * vault, and the sandbox stays offline. Comments and merges need a human approval each; reads need a live write message.
 */

const githubApi = 'https://api.github.com';
const remoteTimeout = 20000;
/** A github_read result stays within this many bytes of JSON (see `fit`). */
const readBytes = 96 * 1024;
/** One GitHub API response github_read reads. */
const pageBytes = 4 * 1024 * 1024;
/** Each list keeps its newest items; the check list its failing and pending checks first. */
const listItems = 100;
/** Check listings are read up to this many pages each, so a failing check on a later page still shows. */
const checkPages = 10;
const bodyCharacters = 16000;
const hunkCharacters = 1500;
const encoder = new TextEncoder();

function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCara-Agent-Workspace' };
}

/** The session owner's GitHub sign-in token, from the vault. */
async function ownerGitHub(env: Env, ownerId: string): Promise<GitHubAccess> {
  const owner = await getUser(env, ownerId);
  if (!owner || owner.auth_kind !== 'github' || !owner.github_id) fail(409, 'github_not_connected', 'The session owner has no real GitHub connection.');
  const vault = await env.DB.query<{ ciphertext: string }>('SELECT ciphertext FROM github_tokens WHERE user_id = ?').bind(owner.id).first();
  if (!vault) fail(409, 'github_not_connected', 'The session owner has no GitHub connection.');
  return { token: await decryptToken(env, owner.id, vault.ciphertext), ciphertext: vault.ciphertext, userId: owner.id, githubId: owner.github_id };
}

/** The session's pin of github.com repository `name` (owner/name, any case), while the workspace still configures it. */
async function pinnedGitHubRepository(c: AppContext, row: SessionRow, name: string): Promise<GitHubSessionRepository> {
  let repositories: SessionRepository[];
  try { repositories = JSON.parse(row.repositories_json ?? '[]'); } catch { return fail(409, 'invalid_binding', 'Session repository binding is invalid.'); }
  if (!Array.isArray(repositories) || repositories.length > repositoryLimits.repositories) fail(409, 'invalid_binding', 'Session repository binding is invalid.');
  const pin = repositories.find((item): item is GitHubSessionRepository => !!item && typeof item === 'object' && !('provider' in item)
    && typeof item.fullName === 'string' && item.fullName.toLowerCase() === name.toLowerCase());
  if (!pin || !validPin(pin)) fail(403, 'repository_not_pinned', `${name} is not a github.com repository pinned in this session.`);
  await requireBinding(c, row.workspace_id, pin);
  return pin;
}

/** The pin must still name the repository it was pinned to (renames and transfers fail closed), read with the owner's token. */
async function verifyPin(env: Env, github: GitHubAccess, pin: GitHubSessionRepository): Promise<void> {
  await verifyRepository({ provider: 'github', github }, { repositoryId: String(pin.repositoryId), fullName: pin.fullName });
  await recheckAccess(env, { provider: 'github', github });
}

type ApprovalInput = { sessionId: string; actorId: string; approvalId: string; capability: string };

/**
 * Authorizes one human-approved GitHub effect and consumes its single-use capability before the effect runs: the
 * capability must name this exact operation, its requester must still be able to write and its approver to approve, and
 * the host scope and the human review must hold. `prepare` adds its own checks before the capability is consumed. The
 * authority checks are repeated after consuming, since the audit write is an await boundary too.
 */
async function approvedEffect<T>(c: AppContext, connectorId: string | null, approval: ApprovalInput, operation: Operation,
  action: 'github.comment' | 'github.merge', prepare: (row: SessionRow, github: GitHubAccess) => Promise<T>): Promise<{ row: SessionRow; github: GitHubAccess; prepared: T }> {
  const { sessionId, actorId, approvalId } = approval;
  const tokenHash = await sha256(approval.capability);
  const stored = await c.env.DB.query<{
      session_id: string; approval_id: string; actor_id: string; requested_by: string; operation_hash: string; expires_at: number; consumed_at: string | null;
    }>(`SELECT session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, consumed_at
    FROM broker_capabilities WHERE token_hash = ?`).bind(tokenHash).first();
  if (!stored || stored.session_id !== sessionId || stored.approval_id !== approvalId || stored.actor_id !== actorId ||
      !constantTimeEqual(stored.operation_hash, await sha256(JSON.stringify(operation)))) {
    fail(403, 'invalid_capability', 'This operation does not match its approval capability.');
  }
  if (stored.consumed_at) fail(409, 'capability_consumed', 'This approved operation has already been attempted; do not retry the external effect.');
  if (stored.expires_at <= Math.floor(Date.now() / 1000)) fail(403, 'capability_expired', 'The approval capability has expired.');
  const [approver, writer] = await Promise.all([
    sessionAccess(c.env, sessionId, actorId), sessionAccess(c.env, sessionId, stored.requested_by),
  ]);
  if (!approver || !writer || approver.row.owner_id !== writer.row.owner_id || approver.row.policy_version !== writer.row.policy_version ||
      approver.row.status === 'archived' || !hasPermission(approver.permissions, 'approve') || !hasPermission(writer.permissions, 'write')) {
    fail(403, 'permission_revoked', 'The operation requester or approver is no longer authorized.');
  }
  await requireCallbackScope(c, approver.row, connectorId);
  await requireBrokerReview(c.env, approver.row, approvalId, stored.requested_by, operation);
  await requireNoRestore(c, sessionId);
  const github = await ownerGitHub(c.env, approver.row.owner_id);
  const prepared = await prepare(approver.row, github);
  await requireCallbackScope(c, approver.row, connectorId);
  // Consume before the network effect. A timeout is ambiguous, not permission to replay the effect.
  const consumed = await c.env.DB.query(`UPDATE broker_capabilities SET consumed_at = ?
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
    AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> ?)
    RETURNING token_hash`).bind(now(), tokenHash, Math.floor(Date.now() / 1000), sessionId, github.userId, approver.row.policy_version, 'archived').first();
  if (!consumed) fail(409, 'capability_consumed', 'This capability was consumed, expired, or revoked. Do not retry the external effect.');
  await auditStatement(c.env, actorId, `${action}.attempted`, approver.row.workspace_id, sessionId, { approvalId, requestedBy: stored.requested_by, actingAs: github.userId }).run();
  // An audit write is an await boundary too: refresh both human and host authority before the effect.
  const [freshApprover, freshWriter] = await Promise.all([
    sessionAccess(c.env, sessionId, actorId), sessionAccess(c.env, sessionId, stored.requested_by),
  ]);
  if (!freshApprover || !freshWriter || freshApprover.row.status === 'archived' ||
      freshApprover.row.policy_version !== approver.row.policy_version ||
      freshWriter.row.policy_version !== approver.row.policy_version ||
      !hasPermission(freshApprover.permissions, 'approve') || !hasPermission(freshWriter.permissions, 'write')) {
    fail(403, 'permission_revoked', 'Operation authority changed. The capability remains consumed.');
  }
  await requireCallbackScope(c, freshApprover.row, connectorId);
  await requireBrokerReview(c.env, freshApprover.row, approvalId, stored.requested_by, operation);
  return { row: approver.row, github, prepared };
}

/** An upstream body as JSON, read up to `limit` bytes; larger or malformed bodies throw. */
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('GitHub response too large');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function githubComment(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c);
  const approval: ApprovalInput = { sessionId: identifier(input.sessionId, 'sessionId'), actorId: userIdentifier(input.actorId, 'actorId'),
    approvalId: identifier(input.approvalId, 'approvalId'), capability: text(input.capability, 'capability', 128) };
  const operation = parseOperation({ kind: 'github.comment', repository: input.repository, issue: input.issue, body: input.body });
  if (operation.kind !== 'github.comment') fail(400, 'invalid_operation', 'Only GitHub comments are supported.');
  const { sessionId, actorId, approvalId } = approval;
  const { row, github } = await approvedEffect(c, connectorId, approval, operation, 'github.comment', async () => undefined);
  const [repositoryOwner, repositoryName] = operation.repository.split('/');
  const url = new URL(`${githubApi}/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/issues/${operation.issue}/comments`);
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout), headers: {
      ...githubHeaders(github.token), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ body: operation.body }) });
  } catch {
    await auditStatement(c.env, actorId, 'github.comment.ambiguous', row.workspace_id, sessionId, { approvalId }).run();
    fail(502, 'github_outcome_unknown', 'GitHub could not confirm the outcome. The capability remains consumed; inspect GitHub before making a new request.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    await auditStatement(c.env, actorId, 'github.comment.failed', row.workspace_id, sessionId, { approvalId, status: response.status }).run();
    fail(502, 'github_rejected', 'GitHub rejected the approved comment. The capability cannot be reused.');
  }
  let result: unknown;
  try { result = await response.json(); } catch { fail(502, 'github_outcome_unknown', 'GitHub returned an unreadable result. Inspect GitHub before retrying.'); }
  if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'number' || !('html_url' in result) || typeof result.html_url !== 'string') {
    fail(502, 'github_outcome_unknown', 'GitHub returned an unexpected result. Inspect GitHub before retrying.');
  }
  let resultURL: URL;
  try { resultURL = new URL(result.html_url); } catch { fail(502, 'github_outcome_unknown', 'GitHub returned an unexpected result.'); }
  if (resultURL.protocol !== 'https:' || resultURL.hostname !== 'github.com') fail(502, 'github_outcome_unknown', 'GitHub returned an unexpected result.');
  await auditStatement(c.env, actorId, 'github.comment.completed', row.workspace_id, sessionId, { approvalId, commentId: result.id, actingAs: github.userId }).run();
  // Never return the upstream body, headers, vault ciphertext, or plaintext credentials.
  return c.json({ id: result.id, url: resultURL.href });
}

/**
 * Merges one human-approved pull request of a pinned github.com repository, only while its head is still the approved
 * commit. GitHub's refusal (not mergeable, head moved, method not allowed, no access) is definite: nothing was merged, so it
 * comes back as 422 with GitHub's reason; anything else is ambiguous.
 */
export async function githubMerge(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  const approval: ApprovalInput = { sessionId: identifier(input.sessionId, 'sessionId'), actorId: userIdentifier(input.actorId, 'actorId'),
    approvalId: identifier(input.approvalId, 'approvalId'), capability: text(input.capability, 'capability', 128) };
  const operation = parseOperation({ kind: 'github.merge', repository: input.repository, pull: input.pull, sha: input.sha, method: input.method });
  if (operation.kind !== 'github.merge') fail(400, 'invalid_operation', 'Only GitHub merges are supported.');
  const { sessionId, actorId, approvalId } = approval;
  const { row, github, prepared: pin } = await approvedEffect(c, connectorId, approval, operation, 'github.merge', async (session, access) => {
    const pinned = await pinnedGitHubRepository(c, session, operation.repository);
    await verifyPin(c.env, access, pinned);
    return pinned;
  });
  const detail = { approvalId, repository: pin.fullName, pull: operation.pull };
  const ambiguous = async (): Promise<never> => {
    await auditStatement(c.env, actorId, 'github.merge.ambiguous', row.workspace_id, sessionId, detail).run();
    return fail(502, 'github_outcome_unknown', 'GitHub could not confirm the outcome. The capability remains consumed; inspect the pull request before requesting another merge.');
  };
  let response: Response;
  try {
    response = await fetch(`${githubApi}/repos/${pin.fullName}/pulls/${operation.pull}/merge`, { method: 'PUT', redirect: 'manual',
      signal: AbortSignal.timeout(remoteTimeout), headers: { ...githubHeaders(github.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: operation.sha, merge_method: operation.method }) });
  } catch { return ambiguous(); }
  let result: Record<string, unknown> | null = null;
  try {
    const value = await boundedJson(response, 65536);
    if (value && typeof value === 'object' && !Array.isArray(value)) result = value as Record<string, unknown>;
  } catch { /* An unreadable answer leaves only its status. */ }
  if (response.status === 200) {
    const sha = result?.sha;
    if (result?.merged !== true || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return ambiguous();
    await auditStatement(c.env, actorId, 'github.merge.completed', row.workspace_id, sessionId, { ...detail, sha, actingAs: github.userId }).run();
    return c.json({ sha, url: `https://github.com/${pin.fullName}/pull/${operation.pull}` } satisfies GitHubMergeResult);
  }
  if (response.status < 400 || response.status >= 500) return ambiguous();
  await auditStatement(c.env, actorId, 'github.merge.failed', row.workspace_id, sessionId, { ...detail, status: response.status }).run();
  // GitHub's own reason, as one bounded line: it names what blocks the merge, never a credential.
  const reason = typeof result?.message === 'string' ? result.message.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300).replace(/\.+$/, '') : '';
  return fail(422, 'github_merge_refused', `GitHub did not merge ${pin.fullName}#${operation.pull}: ${reason || `HTTP ${response.status}`}.`);
}

/** One GitHub API read as the session owner: its JSON, and the last page its Link header names. */
async function githubGet(github: GitHubAccess, path: string): Promise<{ value: unknown; last: number | null }> {
  let response: Response;
  try {
    response = await fetch(`${githubApi}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(remoteTimeout), headers: githubHeaders(github.token) });
  } catch { return fail(502, 'github_unavailable', 'GitHub could not be reached. Try again later.'); }
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      fail(429, 'github_rate_limited', 'The session owner\'s GitHub rate limit is used up. Try again later.');
    }
    if (response.status === 404 || response.status === 410) fail(404, 'github_not_found', 'GitHub has no such issue or pull request in this repository.');
    if (response.status === 401 || response.status === 403) fail(403, 'github_repository_unavailable', 'The session owner\'s GitHub account cannot read this repository.');
    fail(502, 'github_unavailable', 'GitHub could not complete the read. Try again later.');
  }
  let value: unknown;
  try { value = await boundedJson(response, pageBytes); }
  catch { return fail(502, 'invalid_github_response', 'GitHub returned a response too large or malformed to read.'); }
  const last = /<[^>]*[?&]page=(\d{1,6})[^>]*>;\s*rel="last"/.exec(response.headers.get('link') ?? '');
  return { value, last: last ? Number(last[1]) : null };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(502, 'invalid_github_response', 'GitHub returned an unexpected response.');
  return value as Record<string, unknown>;
}

/** The newest `listItems` items of a paged GitHub list, oldest first, and how many older ones it left out. */
async function newest(github: GitHubAccess, path: string): Promise<{ items: Record<string, unknown>[]; omitted: number }> {
  const page = async (number: number) => {
    const result = await githubGet(github, `${path}?per_page=${listItems}&page=${number}`);
    if (!Array.isArray(result.value)) fail(502, 'invalid_github_response', 'GitHub returned an unexpected response.');
    return { items: result.value.map(record), last: result.last };
  };
  const first = await page(1);
  if (first.last === null || first.last <= 1) return { items: first.items, omitted: 0 };
  // The newest items are on the last page and, when it isn't full, the one before it.
  const [previous, last] = await Promise.all([first.last > 2 ? page(first.last - 1) : first, page(first.last)]);
  const items = [...previous.items, ...last.items].slice(-listItems);
  return { items, omitted: (first.last - 1) * listItems + last.items.length - items.length };
}

const string = (value: unknown): string => typeof value === 'string' ? value : '';
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const integer = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;
const login = (user: unknown): string | null => user && typeof user === 'object' ? nullableString((user as Record<string, unknown>).login) : null;
/** A body cut to `bodyCharacters`, with a note of how much was cut. */
function clip(value: unknown): string {
  const body = string(value);
  return body.length <= bodyCharacters ? body : `${body.slice(0, bodyCharacters)}\n… ${body.length - bodyCharacters} more characters`;
}

/** Whether a check passed, so it may give way to ones that need attention. */
const passed = (check: GitHubPullRequestView['checks'][number]) => check.status === 'completed' && ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '');

/** Every item of a paged check listing (an object with `total_count` and the list under `key`), up to `checkPages` pages. */
async function checkListing(github: GitHubAccess, path: string, key: string): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const page = async (number: number) => {
    const value = record((await githubGet(github, `${path}?per_page=${listItems}&page=${number}`)).value);
    const items = value[key];
    if (!Array.isArray(items)) fail(502, 'invalid_github_response', 'GitHub returned an unexpected response.');
    return { items: items.map(record), total: integer(value.total_count) ?? items.length };
  };
  const first = await page(1);
  const pages = Math.min(Math.ceil(first.total / listItems), checkPages);
  const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) }, (_, index) => page(index + 2)));
  return { items: [first, ...rest].flatMap(result => result.items), total: Math.max(first.total, first.items.length) };
}

/**
 * Check runs and commit statuses of one commit: failing and pending ones first, so none hides behind passing ones, then
 * the rest up to `listItems`; `omitted` counts the ones left out.
 */
async function checks(github: GitHubAccess, base: string, sha: string): Promise<{ checks: GitHubPullRequestView['checks']; omitted: number }> {
  const [runs, statuses] = await Promise.all([
    checkListing(github, `${base}/commits/${sha}/check-runs`, 'check_runs'), checkListing(github, `${base}/commits/${sha}/status`, 'statuses'),
  ]);
  const all = [
    ...runs.items.map(run => ({ name: string(run.name).slice(0, 200), status: string(run.status), conclusion: nullableString(run.conclusion) })),
    ...statuses.items.map(status => {
      const state = string(status.state);
      return { name: string(status.context).slice(0, 200), status: state === 'pending' ? 'pending' : 'completed', conclusion: state === 'pending' ? null : state };
    }),
  ];
  const kept = [...all.filter(check => !passed(check)), ...all.filter(passed)].slice(0, listItems);
  return { checks: kept, omitted: runs.total + statuses.total - kept.length };
}

/**
 * The view within `readBytes` of JSON: the oldest comments, reviews and review comments give way first, then the
 * description and the passing end of the check list. A view that still doesn't fit is refused rather than sent whole.
 */
function fit(view: GitHubIssueView): GitHubIssueView {
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
  let total = size(view);
  if (total <= readBytes) return view;
  const pull = view.pullRequest;
  const entries = [
    ...view.comments.map(item => ({ list: 'comments' as const, item, at: item.createdAt })),
    ...(pull?.reviews ?? []).map(item => ({ list: 'reviews' as const, item, at: item.submittedAt ?? '' })),
    ...(pull?.reviewComments ?? []).map(item => ({ list: 'reviewComments' as const, item, at: item.createdAt })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const dropped = new Set<object>();
  const omitted = { ...view.omitted };
  const drop = (entry: (typeof entries)[number]) => {
    dropped.add(entry.item);
    omitted[entry.list] = (omitted[entry.list] ?? 0) + 1;
  };
  const build = (): GitHubIssueView => ({ ...view, comments: view.comments.filter(item => !dropped.has(item)),
    ...(pull ? { pullRequest: { ...pull, reviews: pull.reviews.filter(item => !dropped.has(item)), reviewComments: pull.reviewComments.filter(item => !dropped.has(item)) } } : {}),
    omitted });
  // Estimate by item sizes first, then measure what is actually returned.
  let next = 0;
  for (; next < entries.length && total > readBytes; next++) {
    drop(entries[next]!);
    total -= size(entries[next]!.item) + 1;
  }
  let result = build();
  for (; next < entries.length && size(result) > readBytes; next++) {
    drop(entries[next]!);
    result = build();
  }
  for (let length = view.body.length; size(result) > readBytes && length > 0;) {
    length = Math.floor(length / 2);
    result.body = length ? `${view.body.slice(0, length)}\n… cut to fit the read limit` : '';
  }
  while (size(result) > readBytes && result.pullRequest?.checks.length) {
    result.pullRequest.checks = result.pullRequest.checks.slice(0, -1);
    omitted.checks = (omitted.checks ?? 0) + 1;
  }
  if (size(result) > readBytes) fail(502, 'github_response_too_large', 'This issue or pull request is too large to read.');
  return result;
}

async function readIssue(github: GitHubAccess, fullName: string, number: number): Promise<GitHubIssueView> {
  const base = `/repos/${fullName}`;
  const issue = record((await githubGet(github, `${base}/issues/${number}`)).value);
  const isPull = issue.pull_request !== undefined && issue.pull_request !== null;
  const [comments, details, reviews, reviewComments] = await Promise.all([
    newest(github, `${base}/issues/${number}/comments`),
    isPull ? githubGet(github, `${base}/pulls/${number}`).then(result => record(result.value)) : undefined,
    isPull ? newest(github, `${base}/pulls/${number}/reviews`) : undefined,
    isPull ? newest(github, `${base}/pulls/${number}/comments`) : undefined,
  ]);
  let pullRequest: GitHubPullRequestView | undefined;
  let checksOmitted = 0;
  if (details && reviews && reviewComments) {
    const head = record(details.head);
    const target = record(details.base);
    const sha = string(head.sha);
    if (!/^[0-9a-f]{40}$/.test(sha)) fail(502, 'invalid_github_response', 'GitHub returned an unexpected pull request.');
    const headRepository = head.repo && typeof head.repo === 'object' ? nullableString((head.repo as Record<string, unknown>).full_name) : null;
    const found = await checks(github, base, sha);
    checksOmitted = found.omitted;
    pullRequest = {
      draft: details.draft === true, merged: details.merged === true, mergeable: typeof details.mergeable === 'boolean' ? details.mergeable : null,
      mergeableState: string(details.mergeable_state),
      head: { ref: string(head.ref), sha, repository: headRepository }, base: { ref: string(target.ref), sha: string(target.sha) },
      reviews: reviews.items.map((item): GitHubReviewView => ({ id: integer(item.id) ?? 0, author: login(item.user), state: string(item.state),
        submittedAt: nullableString(item.submitted_at), commit: nullableString(item.commit_id), body: clip(item.body), url: string(item.html_url) })),
      reviewComments: reviewComments.items.map((item): GitHubReviewCommentView => {
        // The hunk's end is where the commented line is.
        const hunk = string(item.diff_hunk);
        return { id: integer(item.id) ?? 0, inReplyTo: integer(item.in_reply_to_id), author: login(item.user), createdAt: string(item.created_at),
          path: string(item.path), line: integer(item.line), originalLine: integer(item.original_line), commit: string(item.commit_id), body: clip(item.body),
          diffHunk: hunk.length <= hunkCharacters ? hunk : `… ${hunk.length - hunkCharacters} earlier characters\n${hunk.slice(-hunkCharacters)}`,
          url: string(item.html_url) };
      }),
      checks: found.checks,
    };
  }
  const omitted = { ...(comments.omitted ? { comments: comments.omitted } : {}), ...(reviews?.omitted ? { reviews: reviews.omitted } : {}),
    ...(reviewComments?.omitted ? { reviewComments: reviewComments.omitted } : {}), ...(checksOmitted ? { checks: checksOmitted } : {}) };
  const labels = Array.isArray(issue.labels) ? issue.labels.map(label => typeof label === 'string' ? label : string(record(label).name)) : [];
  return fit({
    repository: fullName, number, url: string(issue.html_url), title: string(issue.title), state: string(issue.state), author: login(issue.user),
    createdAt: string(issue.created_at), body: clip(issue.body), labels,
    comments: comments.items.map((item): GitHubCommentView => ({ id: integer(item.id) ?? 0, author: login(item.user), createdAt: string(item.created_at),
      body: clip(item.body), url: string(item.html_url) })),
    ...(pullRequest ? { pullRequest } : {}), ...(Object.keys(omitted).length ? { omitted } : {}),
  });
}

/**
 * Reads an issue or pull request of a pinned github.com repository with the session owner's account, for a tool call of
 * a write message the requester sent within the last hour: description, comments and, for a pull request, its merge
 * state, head commit, reviews, review comments and checks. Each read is audited.
 */
export async function githubRead(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'repository', 'issue'].includes(key))) {
    fail(400, 'invalid_input', 'Unexpected GitHub read field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  const repository = githubRepositoryName(input.repository);
  const number = issueNumber(input.issue);
  // Every authority check, repeated after the reads and before their result leaves the control plane.
  const authorize = async (): Promise<SessionRow> => {
    const access = await sessionAccess(c.env, sessionId, actorId);
    if (!access || access.row.status === 'archived' || !hasPermission(access.permissions, 'write')) {
      fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
    }
    await requireCallbackScope(c, access.row, connectorId);
    const admission = await c.env.DB.query<{ session_id: string; actor_id: string; mode: string; expires_at: number }>(
      'SELECT session_id, actor_id, mode, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
      || admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'github_read_not_admitted', 'GitHub reads need a write message from the requester sent within the last hour.');
    }
    // A one-call grant covers only the read its owner saw: this requester, message, repository and number.
    await requireToolCall(c.env, access.row, 'github_read', { id: callId, requestedBy: actorId, admissionId, target: `${repository}#${number}` });
    return access.row;
  };
  const row = await authorize();
  const pin = await pinnedGitHubRepository(c, row, repository);
  const github = await ownerGitHub(c.env, row.owner_id);
  await verifyPin(c.env, github, pin);
  const view = await readIssue(github, pin.fullName, number);
  await recheckAccess(c.env, { provider: 'github', github });
  await authorize();
  await auditStatement(c.env, actorId, 'github.read', row.workspace_id, sessionId, { repository: pin.fullName, issue: number, actingAs: github.userId }).run();
  return c.json(view);
}
