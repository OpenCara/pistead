import { HTTPException } from 'hono/http-exception';
import type { GitProvider, SessionRepository } from '../../../../packages/shared/src/repositories.js';
import { repositoryPath } from '../../../../packages/shared/src/repositories.js';
import type { GitPushOperation, HostPushCredential, PushCompletionResult, PushCredential, PushOutcome } from '../../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../../packages/shared/src/policy.js';
import type { AppContext, Env, PushCredentialRow, SessionAccess, SessionRow } from '../types.js';
import { auditStatement, requireNoMigration, requireUnfrozen, sessionAccess } from '../db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from '../http.js';
import { parseOperation } from '../operations.js';
import { decryptToken, encryptToken } from '../vault.js';
import { requireCallbackScope } from '../connectors.js';
import { requireBrokerReview, requireOperationTool } from '../approval-reviews.js';
import { cloneSessionRepository, recheckAccess, repositoryAccess } from '../repositories.js';
import { mintPushToken, revokePushToken, type MintedToken, type PushRevocation } from './mint.js';
import { branchTip, openPullRequest, pushTarget } from './targets.js';

const outcomes: readonly PushOutcome[] = ['pushed', 'up-to-date', 'failed', 'unknown'];
/** Automatic credentials one auto-approve admission may mint. */
const automaticPushesPerAdmission = 20;

export async function requireNoRestore(c: AppContext, sessionId: string): Promise<void> {
  if (await c.env.DB.query("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(sessionId).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
  await requireNoMigration(c.env, sessionId);
}

/**
 * The workspace repository at the path the operation names, shaped like a pin. Pushes name a clone's directory; a
 * pinned session is read-only.
 */
async function pushPin(env: Env, row: SessionRow, operation: GitPushOperation): Promise<SessionRepository> {
  const path = operation.repository;
  if (row.repository_mode !== 'clone' || operation.directory === undefined) fail(400, 'invalid_operation', 'A session pushes a clone\'s directory.');
  const repository = await cloneSessionRepository(env, row, binding => repositoryPath({ provider: binding.provider, host: binding.host, fullName: binding.full_name }) === path);
  if (!repository) fail(403, 'repository_binding_mismatch', 'The push does not name a repository of this workspace.');
  return repository;
}
function pinProvider(pin: SessionRepository): { provider: GitProvider; host: string } {
  return 'provider' in pin ? { provider: pin.provider, host: pin.host } : { provider: 'github', host: 'github.com' };
}
/** The workspace binding still configured for the pin, with its default-branch policy; removed bindings stop pushes and GitHub merges. */
export async function requireBinding(c: AppContext, workspaceId: string, pin: SessionRepository): Promise<{ forbid_default_branch: number | null }> {
  const { provider, host } = pinProvider(pin);
  const binding = await c.env.DB.query<{ forbid_default_branch: number | null }>(`SELECT policy.forbid_default_branch FROM workspace_repositories binding
    LEFT JOIN repository_push_policies policy ON policy.binding_id = binding.id AND policy.workspace_id = binding.workspace_id
    WHERE binding.id = ? AND binding.workspace_id = ? AND binding.provider = ? AND binding.host = ? AND binding.repository_id = ?`)
    .bind(pin.bindingId, workspaceId, provider, host, String(pin.repositoryId)).first();
  if (!binding) fail(403, 'repository_binding_removed', 'This repository is no longer configured for the workspace.');
  return binding;
}
/**
 * Undoes a finished push's credential and forgets it, also when the record can't be read (only expiry is left then).
 * An owner's token that could not be reset yet keeps its record, for settlePushCredentials to retry.
 */
async function revokeStored(env: Env, credentialId: string, ciphertext: string | null): Promise<void> {
  if (!ciphertext) return;
  let settled = true;
  try {
    settled = await revokePushToken(env, JSON.parse(await decryptToken(env, `push-credential:${credentialId}`, ciphertext)) as PushRevocation);
  } catch { /* an unreadable record can't be retried */ }
  if (settled) await env.DB.query('UPDATE push_credentials SET revocation_ciphertext = NULL WHERE id = ? AND revocation_ciphertext = ?').bind(credentialId, ciphertext).run();
}

/**
 * Settles the push credentials no completion settled: closes those that expired unreported, since their host never said
 * whether it pushed, and retries owner-token resets that failed. Run periodically, it stops an owner's GitHub token from
 * working within about an hour of a push even when the host never reports back.
 */
export async function settlePushCredentials(env: Env): Promise<void> {
  const rows = await env.DB.query<{ id: string; revocation_ciphertext: string; completed_at: string | null; session_id: string; approval_id: string;
    requested_by: string; workspace_id: string }>(`SELECT c.id, c.revocation_ciphertext, c.completed_at, c.session_id, c.approval_id, c.requested_by, s.workspace_id
    FROM push_credentials c JOIN sessions s ON s.id = c.session_id
    WHERE c.revocation_ciphertext IS NOT NULL AND (c.completed_at IS NOT NULL OR c.expires_at <= ?) ORDER BY c.created_at LIMIT 100`)
    .bind(Math.floor(Date.now() / 1000)).all();
  for (const row of rows) {
    if (!row.completed_at) {
      const closed = await env.DB.query(`UPDATE push_credentials SET completed_at = ?, outcome = 'unknown' WHERE id = ? AND completed_at IS NULL RETURNING id`)
        .bind(now(), row.id).first();
      // A completion that arrived meanwhile revokes the credential itself.
      if (!closed) continue;
      await auditStatement(env, row.requested_by, 'git.push.completed', row.workspace_id, row.session_id, {
        approvalId: row.approval_id, credentialId: row.id, outcome: 'unknown',
      }).run();
    }
    await revokeStored(env, row.id, row.revocation_ciphertext);
  }
}

export async function pushCredential(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 131072);
  if (Object.keys(input).some(key => !['sessionId', 'approvalId', 'actorId', 'operation', 'capability', 'admissionId'].includes(key))) {
    fail(400, 'invalid_push_request', 'Unexpected push credential field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const approvalId = identifier(input.approvalId, 'approvalId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const operation = parseOperation(input.operation);
  if (operation.kind !== 'git.push') fail(400, 'invalid_operation', 'Only Git pushes are supported.');
  if ((input.capability === undefined) === (input.admissionId === undefined)) fail(400, 'invalid_push_request', 'Provide exactly one of capability or admissionId.');
  const automatic = input.admissionId !== undefined;
  const capability = automatic ? null : text(input.capability, 'capability', 128);
  const admissionId = automatic ? text(input.admissionId, 'admissionId', 128) : null;
  const tokenHash = capability ? await sha256(capability) : null;
  // Automatic pushes come only from the runner's own tool-call approvals.
  if (automatic && !approvalId.startsWith('tool-')) fail(400, 'invalid_push_request', 'Automatic pushes must name a tool-call approval.');
  let requestedBy = actorId;
  let consumedHere = false;
  const credentialId = id();

  // Every authority check, repeated after each await boundary that precedes an effect.
  const authorize = async (): Promise<SessionAccess> => {
    if (tokenHash) {
      const stored = await c.env.DB.query<{
          session_id: string; approval_id: string; actor_id: string; requested_by: string; operation_hash: string; expires_at: number; consumed_at: string | null;
        }>(`SELECT session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, consumed_at
        FROM broker_capabilities WHERE token_hash = ?`).bind(tokenHash).first();
      if (!stored || stored.session_id !== sessionId || stored.approval_id !== approvalId || stored.actor_id !== actorId ||
          !constantTimeEqual(stored.operation_hash, await sha256(JSON.stringify(operation)))) {
        fail(403, 'invalid_capability', 'This push does not match its approval capability.');
      }
      // After this request consumed the capability, only its single use remains authorized.
      if (consumedHere ? !stored.consumed_at : stored.consumed_at) fail(409, 'capability_consumed', 'This approved push has already been attempted; do not retry it.');
      if (!consumedHere && stored.expires_at <= Math.floor(Date.now() / 1000)) fail(403, 'capability_expired', 'The approval capability has expired.');
      requestedBy = stored.requested_by;
      const [approver, writer] = await Promise.all([sessionAccess(c.env, sessionId, actorId), sessionAccess(c.env, sessionId, stored.requested_by)]);
      if (!approver || !writer || approver.row.owner_id !== writer.row.owner_id || approver.row.policy_version !== writer.row.policy_version ||
          approver.row.status === 'archived' || !hasPermission(approver.permissions, 'approve') || !hasPermission(writer.permissions, 'write')) {
        fail(403, 'permission_revoked', 'The push requester or approver is no longer authorized.');
      }
      await requireCallbackScope(c, approver.row, connectorId);
      await requireBrokerReview(c.env, approver.row, approvalId, stored.requested_by, operation);
      return approver;
    }
    const owner = await sessionAccess(c.env, sessionId, actorId);
    if (!owner || owner.row.owner_id !== actorId || owner.row.status === 'archived' || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Automatic pushes require the session owner.');
    }
    const admission = await c.env.DB.query<{ session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>('SELECT session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?')
      .bind(admissionId).first();
    // The owner's Auto-approve message pushes without asking, as does any owner message once the owner allowed git_push
    // for the rest of the session.
    const sessionGrant = async () => !!await c.env.DB.query(`SELECT 1 AS granted FROM session_tool_grants
      WHERE session_id = ? AND tool = 'git_push' AND call_id = ''`).bind(sessionId).first();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write' ||
        admission.expires_at <= Math.floor(Date.now() / 1000) || (admission.access !== 'auto' && !await sessionGrant())) {
      fail(403, 'automatic_push_not_admitted', 'Automatic pushes require an unexpired write admission from the session owner, sent with auto-approve or after git_push was allowed for the session.');
    }
    await requireCallbackScope(c, owner.row, connectorId);
    await requireOperationTool(c.env, owner.row, operation, approvalId, admission);
    // This request's own ledger row does not count against it on the post-mint recheck.
    const used = await c.env.DB.query<{ count: number }>('SELECT COUNT(*) AS count FROM push_credentials WHERE admission_id = ? AND id <> ?')
      .bind(admissionId, credentialId).first();
    if ((used?.count ?? 0) >= automaticPushesPerAdmission) fail(429, 'automatic_push_limit', 'This message already used its automatic pushes.');
    return owner;
  };

  const authority = await authorize();
  const row = authority.row;
  requireUnfrozen(row);
  await requireNoRestore(c, sessionId);
  const pin = await pushPin(c.env, row, operation);
  const policy = await requireBinding(c, row.workspace_id, pin);
  const { provider, host } = pinProvider(pin);
  const access = await repositoryAccess(c.env, row.owner_id, provider, host, pin.fullName);
  const target = await pushTarget(access, pin, operation.branch, operation.tag);
  if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
  // A tag push moves no branch: it only creates a tag at a commit already on `branch`, which the runner checks against
  // the remote before it pushes. The default-branch policy is about moving that branch.
  if (operation.tag === undefined && policy.forbid_default_branch === 1 && operation.branch === target.defaultBranch) {
    fail(403, 'default_branch_push_forbidden', 'This workspace forbids pushes to the repository default branch.');
  }
  if (operation.tag !== undefined && operation.pullRequest) fail(400, 'invalid_pull_request', 'A tag push opens no pull request.');
  if (operation.pullRequest && (operation.pullRequest.base ?? target.defaultBranch) === operation.branch) {
    fail(400, 'invalid_pull_request', 'The pull request base must differ from the pushed branch.');
  }
  await recheckAccess(c.env, access);
  const fresh = await authorize();
  if (fresh.row.policy_version !== row.policy_version || fresh.row.repositories_json !== row.repositories_json) {
    fail(403, 'permission_revoked', 'Session authority changed.');
  }
  await requireNoRestore(c, sessionId);
  await requireBinding(c, row.workspace_id, pin);
  if (tokenHash) {
    // Consume before the effect. A failed mint is not permission to replay the approval.
    const consumed = await c.env.DB.query(`UPDATE broker_capabilities SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> ?)
      RETURNING token_hash`).bind(now(), tokenHash, Math.floor(Date.now() / 1000), sessionId, row.owner_id, row.policy_version, 'archived').first();
    if (!consumed) fail(409, 'capability_consumed', 'This capability was consumed, expired, or revoked. Do not retry the push.');
    consumedHere = true;
  }
  // The admission limit is enforced in the insert itself, so concurrent automatic pushes cannot exceed it.
  const inserted = await c.env.DB.query(`INSERT INTO push_credentials (id, session_id, approval_id, requested_by, identity_id, kind, binding_id,
      operation_json, automatic, admission_id, revocation_ciphertext, expires_at, created_at)
    SELECT ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, NULL, ?, ?
    WHERE ? IS NULL OR (SELECT COUNT(*) FROM push_credentials WHERE admission_id = ?) < ?
    ON CONFLICT (session_id, approval_id) DO NOTHING RETURNING id`)
    .bind(credentialId, sessionId, approvalId, requestedBy, pin.bindingId, JSON.stringify(operation), automatic ? 1 : 0, admissionId,
      Math.floor(Date.now() / 1000), now(), admissionId, admissionId, automaticPushesPerAdmission).first();
  if (!inserted) {
    if (await c.env.DB.query('SELECT 1 FROM push_credentials WHERE session_id = ? AND approval_id = ?').bind(sessionId, approvalId).first()) {
      fail(409, 'push_attempt_exists', 'This approval already has a push attempt. Inspect its outcome before requesting a new push.');
    }
    fail(429, 'automatic_push_limit', 'This message already used its automatic pushes.');
  }
  const closeFailed = () => c.env.DB.query("UPDATE push_credentials SET completed_at = ?, outcome = 'failed' WHERE id = ? AND completed_at IS NULL")
    .bind(now(), credentialId).run();
  let minted: MintedToken;
  try {
    minted = await mintPushToken(c.env, { workspaceId: row.workspace_id, sessionId, provider, host, fullName: pin.fullName,
      repositoryId: String(pin.repositoryId), branch: operation.branch, ...(operation.tag === undefined ? {} : { tag: operation.tag }),
      ownerId: row.owner_id, connectorId: row.connector_id ?? null, hostOwnerId: row.connector_owner_id ?? null, owner: access });
  } catch (error) {
    await closeFailed();
    throw error;
  }
  try {
    const revocation = minted.revocation ? await encryptToken(c.env, `push-credential:${credentialId}`, JSON.stringify(minted.revocation)) : null;
    await c.env.DB.query('UPDATE push_credentials SET kind = ?, identity_id = ?, expires_at = ?, revocation_ciphertext = ? WHERE id = ?')
      .bind(minted.kind, minted.identityId, minted.expiresAt, revocation, credentialId).run();
    await auditStatement(c.env, actorId, 'git.push.credential_issued', row.workspace_id, sessionId, {
      approvalId, credentialId, requestedBy, actingAs: row.owner_id, automatic, kind: minted.kind, branch: operation.branch,
      ...(operation.tag === undefined ? {} : { tag: operation.tag }),
    }).run();
    const latest = await authorize();
    if (latest.row.policy_version !== row.policy_version || latest.row.repositories_json !== row.repositories_json) {
      fail(403, 'permission_revoked', 'Session authority changed.');
    }
    await requireBinding(c, row.workspace_id, pin);
    await recheckAccess(c.env, access);
  } catch (error) {
    // Never hand out a credential whose ledger, audit or authority step failed: close the row and revoke an installation
    // token directly. The owner's token never left the server, so it needs no reset.
    try { await closeFailed(); } catch { /* the token is still revoked below */ }
    if (minted.revocation) {
      if (minted.revocation.kind === 'github-installation') await revokePushToken(c.env, minted.revocation);
      try { await c.env.DB.query('UPDATE push_credentials SET revocation_ciphertext = NULL WHERE id = ?').bind(credentialId).run(); } catch { /* expiry bounds it */ }
    }
    throw error;
  }
  const expiresAt = new Date(minted.expiresAt * 1000).toISOString();
  const result: PushCredential | HostPushCredential = minted.authorization === null
    ? { credentialId, remote: target.remote, hostCredentials: true, expiresAt }
    : { credentialId, remote: target.remote, authorization: minted.authorization, expiresAt };
  return c.json(result);
}

export async function pushComplete(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 4096);
  if (Object.keys(input).some(key => !['sessionId', 'approvalId', 'credentialId', 'outcome', 'tip'].includes(key))) {
    fail(400, 'invalid_push_request', 'Unexpected push completion field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const approvalId = identifier(input.approvalId, 'approvalId');
  const credentialId = identifier(input.credentialId, 'credentialId');
  if (!outcomes.includes(input.outcome as PushOutcome)) fail(400, 'invalid_push_request', 'Invalid push outcome.');
  const outcome = input.outcome as PushOutcome;
  if (input.tip !== undefined && (typeof input.tip !== 'string' || !/^[0-9a-f]{40}$/.test(input.tip))) fail(400, 'invalid_push_request', 'Invalid branch tip.');
  const tip = input.tip as string | undefined;
  if ((outcome === 'pushed' || outcome === 'up-to-date') && !tip) fail(400, 'invalid_push_request', 'A branch tip is required for a completed push.');

  const ledger = await c.env.DB.query<PushCredentialRow>('SELECT * FROM push_credentials WHERE id = ?').bind(credentialId).first();
  if (!ledger || ledger.session_id !== sessionId || ledger.approval_id !== approvalId) fail(403, 'invalid_push_credential', 'This completion does not match a push credential.');
  if (ledger.completed_at) fail(409, 'push_already_completed', 'This push was already completed.');
  const session = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!session) fail(404, 'not_found', 'Session not found.');
  try {
    await requireCallbackScope(c, session, connectorId);
  } catch (error) {
    // The connector lost its scope: the credential is closed and revoked anyway; only the pull request needs the scope.
    const closed = await c.env.DB.query<{ revocation_ciphertext: string | null }>(`UPDATE push_credentials SET completed_at = ?, outcome = 'failed', tip = NULL
      WHERE id = ? AND completed_at IS NULL RETURNING revocation_ciphertext`).bind(now(), credentialId).first();
    if (closed) {
      await revokeStored(c.env, credentialId, closed.revocation_ciphertext);
      await auditStatement(c.env, ledger.requested_by, 'git.push.completed', session.workspace_id, sessionId, {
        approvalId, credentialId, outcome: 'failed',
      }).run();
    }
    throw error;
  }
  const claimed = await c.env.DB.query<{ revocation_ciphertext: string | null }>(`UPDATE push_credentials SET completed_at = ?, outcome = ?, tip = ?
    WHERE id = ? AND completed_at IS NULL RETURNING revocation_ciphertext`)
    .bind(now(), outcome, tip ?? null, credentialId).first();
  if (!claimed) fail(409, 'push_already_completed', 'This push was already completed.');
  await revokeStored(c.env, credentialId, claimed.revocation_ciphertext);
  await auditStatement(c.env, ledger.requested_by, 'git.push.completed', session.workspace_id, sessionId, {
    approvalId, credentialId, outcome, ...(tip ? { tip } : {}),
  }).run();

  const operation = parseOperation(JSON.parse(ledger.operation_json)) as GitPushOperation;
  const result: PushCompletionResult = {};
  if ((outcome !== 'pushed' && outcome !== 'up-to-date') || !operation.pullRequest || !tip) return c.json(result);
  const pullRequestInput = operation.pullRequest;
  // Pull requests are opened as the owner, who must still hold the session and write access to the repository.
  const authorize = async (): Promise<SessionRow> => {
    const owner = await sessionAccess(c.env, sessionId, session.owner_id);
    if (!owner || owner.row.status === 'archived' || owner.row.policy_version !== session.policy_version ||
        owner.row.repositories_json !== session.repositories_json || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Session authority changed; the pull request was not opened.');
    }
    await requireCallbackScope(c, owner.row, connectorId);
    return owner.row;
  };
  try {
    const row = await authorize();
    const pin = await pushPin(c.env, row, operation);
    if (pin.bindingId !== ledger.binding_id) fail(403, 'repository_binding_mismatch', 'The pinned repository changed.');
    await requireBinding(c, row.workspace_id, pin);
    const { provider, host } = pinProvider(pin);
    const access = await repositoryAccess(c.env, row.owner_id, provider, host, pin.fullName);
    const target = await pushTarget(access, pin, operation.branch);
    if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
    if (await branchTip(access, pin, operation.branch) !== tip) fail(409, 'push_tip_mismatch', 'The pushed branch moved; the pull request was not opened.');
    const base = pullRequestInput.base ?? target.defaultBranch;
    if (base === operation.branch) fail(400, 'invalid_pull_request', 'The pull request base must differ from the pushed branch.');
    await recheckAccess(c.env, access);
    await authorize();
    await requireBinding(c, row.workspace_id, pin);
    const pullRequest = await openPullRequest(access, pin, { head: operation.branch, base, title: pullRequestInput.title, body: pullRequestInput.body },
      target.azureProjectId);
    // A push to a pull request this session already pushed to keeps showing its last read state until it is read again
    // (left unread, so the next sweep reads it first); merged and closed ones aren't carried over.
    await c.env.DB.query(`UPDATE push_credentials SET pull_request_url = ?, pull_request_checked_at = NULL, pull_request_state = (SELECT p.pull_request_state
      FROM push_credentials p WHERE p.session_id = ? AND p.pull_request_url = ? AND p.pull_request_state IS NOT NULL
        AND p.pull_request_state NOT IN ('merged', 'closed')
      ORDER BY p.completed_at DESC, p.created_at DESC, p.id DESC LIMIT 1) WHERE id = ?`).bind(pullRequest.url, sessionId, pullRequest.url, credentialId).run();
    await auditStatement(c.env, ledger.requested_by, 'git.push.pull_request', session.workspace_id, sessionId, {
      approvalId, credentialId, url: pullRequest.url, number: pullRequest.number, created: pullRequest.created, actingAs: row.owner_id,
    }).run();
    result.pullRequest = pullRequest;
  } catch (error) {
    let code = 'internal_error';
    if (error instanceof HTTPException && error.res) {
      // Read a clone: the shared error handler still sends the original body.
      try { code = String((await error.res.clone().json() as { code?: unknown }).code ?? code); } catch { /* keep the generic code */ }
    }
    await auditStatement(c.env, ledger.requested_by, 'git.push.pull_request_failed', session.workspace_id, sessionId, { approvalId, credentialId, code }).run();
    throw error;
  }
  return c.json(result);
}
