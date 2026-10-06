import type { GitProvider, SessionRepository } from '../../../../packages/shared/src/repositories.js';
import { repositoryLimits } from '../../../../packages/shared/src/repositories.js';
import type { GitPushOperation, PushCompletionResult, PushCredential, PushOutcome } from '../../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../../packages/shared/src/policy.js';
import type { AppContext, PushCredentialRow, SessionAccess, SessionRow } from '../types.js';
import { auditStatement, sessionAccess } from '../db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from '../http.js';
import { parseOperation } from '../operations.js';
import { decryptToken, encryptToken } from '../vault.js';
import { authenticateConnector, requireConnectorSession } from '../connectors.js';
import { requireBrokerReview, requireOperationTool } from '../approval-reviews.js';
import { recheckAccess, repositoryAccess, validPin } from '../repositories.js';
import { mintPushToken, revokePushToken, type MintedToken } from './mint.js';
import { branchTip, openPullRequest, pushTarget } from './targets.js';

const outcomes: readonly PushOutcome[] = ['pushed', 'up-to-date', 'failed'];

async function callbackScope(c: AppContext, row: SessionRow, connectorId: string | null): Promise<void> {
  if (connectorId) {
    const connector = await authenticateConnector(c);
    if (connector.id !== connectorId) fail(403, 'connector_binding_mismatch', 'Connector scope changed.');
    await requireConnectorSession(c.env, connectorId, row, connector.connection_hash!);
  } else if (row.connector_id) fail(403, 'connector_scope_required', 'Use the connector-scoped callback.');
}

async function requireNoRestore(c: AppContext, sessionId: string): Promise<void> {
  if (await c.env.DB.prepare("SELECT 1 FROM restore_jobs WHERE target_session_id = ? AND status <> 'completed'").bind(sessionId).first()) {
    fail(409, 'restore_pending', 'Session restoration is not complete.');
  }
}

/** The pinned repository whose worktree path the operation names. */
function pushPin(row: SessionRow, path: string): SessionRepository {
  let repositories: SessionRepository[];
  try { repositories = JSON.parse(row.repositories_json ?? '[]'); } catch { return fail(409, 'invalid_binding', 'Session repository binding is invalid.'); }
  if (!Array.isArray(repositories) || repositories.length > repositoryLimits.repositories) fail(409, 'invalid_binding', 'Session repository binding is invalid.');
  const pin = repositories.find(item => item && typeof item === 'object' && item.path === path);
  if (!pin || !validPin(pin)) fail(403, 'repository_binding_mismatch', 'The push does not name a pinned session repository.');
  return pin;
}
function pinProvider(pin: SessionRepository): { provider: GitProvider; host: string } {
  return 'provider' in pin ? { provider: pin.provider, host: pin.host } : { provider: 'github', host: 'github.com' };
}
/** Best effort: the stored token is revoked and forgotten; decryption failures leave only expiry. */
async function revokeStored(c: AppContext, credentialId: string, ciphertext: string | null): Promise<void> {
  if (!ciphertext) return;
  try {
    const revocation = JSON.parse(await decryptToken(c.env, `push-credential:${credentialId}`, ciphertext)) as NonNullable<MintedToken['revocation']>;
    await revokePushToken(revocation);
  } catch { /* the token still expires on its own */ }
  await c.env.DB.prepare('UPDATE push_credentials SET revocation_ciphertext = NULL WHERE id = ?').bind(credentialId).run();
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
  let requestedBy = actorId;
  let consumedHere = false;

  // Every authority check, repeated after each await boundary that precedes an effect.
  const authorize = async (): Promise<SessionAccess> => {
    if (tokenHash) {
      const stored = await c.env.DB.prepare(`SELECT session_id, approval_id, actor_id, requested_by, operation_hash, expires_at, consumed_at
        FROM broker_capabilities WHERE token_hash = ?`).bind(tokenHash).first<{
          session_id: string; approval_id: string; actor_id: string; requested_by: string; operation_hash: string; expires_at: number; consumed_at: string | null;
        }>();
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
      await callbackScope(c, approver.row, connectorId);
      await requireBrokerReview(c.env, approver.row, approvalId, stored.requested_by, operation);
      return approver;
    }
    const owner = await sessionAccess(c.env, sessionId, actorId);
    if (!owner || owner.row.owner_id !== actorId || owner.row.status === 'archived' || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Automatic pushes require the session owner.');
    }
    const admission = await c.env.DB.prepare('SELECT session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?')
      .bind(admissionId).first<{ session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>();
    if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write' ||
        admission.access !== 'auto' || admission.expires_at <= Math.floor(Date.now() / 1000)) {
      fail(403, 'automatic_push_not_admitted', 'Automatic pushes require an unexpired auto-approve write admission from the session owner.');
    }
    await callbackScope(c, owner.row, connectorId);
    await requireOperationTool(c.env, owner.row, operation);
    return owner;
  };

  const authority = await authorize();
  const row = authority.row;
  await requireNoRestore(c, sessionId);
  const pin = pushPin(row, operation.repository);
  const { provider, host } = pinProvider(pin);
  const access = await repositoryAccess(c.env, row.owner_id, provider, host, pin.fullName);
  const target = await pushTarget(access, pin);
  if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
  const policy = await c.env.DB.prepare('SELECT forbid_default_branch FROM repository_push_policies WHERE binding_id = ? AND workspace_id = ?')
    .bind(pin.bindingId, row.workspace_id).first<{ forbid_default_branch: number }>();
  if (policy?.forbid_default_branch === 1 && operation.branch === target.defaultBranch) {
    fail(403, 'default_branch_push_forbidden', 'This workspace forbids pushes to the repository default branch.');
  }
  if (operation.pullRequest && (operation.pullRequest.base ?? target.defaultBranch) === operation.branch) {
    fail(400, 'invalid_pull_request', 'The pull request base must differ from the pushed branch.');
  }
  await recheckAccess(c.env, access);
  const fresh = await authorize();
  if (fresh.row.policy_version !== row.policy_version || fresh.row.repositories_json !== row.repositories_json) {
    fail(403, 'permission_revoked', 'Session authority changed.');
  }
  await requireNoRestore(c, sessionId);
  if (tokenHash) {
    // Consume before the effect. A failed mint is not permission to replay the approval.
    const consumed = await c.env.DB.prepare(`UPDATE broker_capabilities SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND owner_id = ? AND policy_version = ? AND status <> ?)
      RETURNING token_hash`).bind(now(), tokenHash, Math.floor(Date.now() / 1000), sessionId, row.owner_id, row.policy_version, 'archived').first();
    if (!consumed) fail(409, 'capability_consumed', 'This capability was consumed, expired, or revoked. Do not retry the push.');
    consumedHere = true;
  }
  const credentialId = id();
  const inserted = await c.env.DB.prepare(`INSERT INTO push_credentials (id, session_id, approval_id, requested_by, identity_id, kind, binding_id,
      operation_json, automatic, revocation_ciphertext, expires_at, created_at)
    VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?, ?, NULL, ?, ?) ON CONFLICT (session_id, approval_id) DO NOTHING RETURNING id`)
    .bind(credentialId, sessionId, approvalId, requestedBy, pin.bindingId, JSON.stringify(operation), automatic ? 1 : 0,
      Math.floor(Date.now() / 1000), now()).first();
  if (!inserted) fail(409, 'push_attempt_exists', 'This approval already has a push attempt. Inspect its outcome before requesting a new push.');
  let minted: MintedToken;
  try {
    minted = await mintPushToken(c.env, { workspaceId: row.workspace_id, sessionId, provider, host, fullName: pin.fullName,
      repositoryId: String(pin.repositoryId), branch: operation.branch });
  } catch (error) {
    await c.env.DB.prepare("UPDATE push_credentials SET completed_at = ?, outcome = 'failed' WHERE id = ? AND completed_at IS NULL").bind(now(), credentialId).run();
    throw error;
  }
  const revocation = minted.revocation ? await encryptToken(c.env, `push-credential:${credentialId}`, JSON.stringify(minted.revocation)) : null;
  await c.env.DB.prepare('UPDATE push_credentials SET kind = ?, identity_id = ?, expires_at = ?, revocation_ciphertext = ? WHERE id = ?')
    .bind(minted.kind, minted.identityId, minted.expiresAt, revocation, credentialId).run();
  await auditStatement(c.env, actorId, 'git.push.credential_issued', row.workspace_id, sessionId, {
    approvalId, credentialId, requestedBy, actingAs: row.owner_id, automatic, kind: minted.kind, branch: operation.branch,
  }).run();
  try {
    const latest = await authorize();
    if (latest.row.policy_version !== row.policy_version || latest.row.repositories_json !== row.repositories_json) {
      fail(403, 'permission_revoked', 'Session authority changed.');
    }
    await recheckAccess(c.env, access);
  } catch (error) {
    // Authority changed while minting: never hand out the credential, and revoke it now.
    await c.env.DB.prepare("UPDATE push_credentials SET completed_at = ?, outcome = 'failed' WHERE id = ? AND completed_at IS NULL").bind(now(), credentialId).run();
    await revokeStored(c, credentialId, revocation);
    throw error;
  }
  const result: PushCredential = { credentialId, remote: target.remote, authorization: minted.authorization,
    expiresAt: new Date(minted.expiresAt * 1000).toISOString() };
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
  if (outcome !== 'failed' && !tip) fail(400, 'invalid_push_request', 'A branch tip is required for a completed push.');

  const ledger = await c.env.DB.prepare('SELECT * FROM push_credentials WHERE id = ?').bind(credentialId).first<PushCredentialRow>();
  if (!ledger || ledger.session_id !== sessionId || ledger.approval_id !== approvalId) fail(403, 'invalid_push_credential', 'This completion does not match a push credential.');
  if (ledger.completed_at) fail(409, 'push_already_completed', 'This push was already completed.');
  const session = await c.env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first<SessionRow>();
  if (!session) fail(404, 'not_found', 'Session not found.');
  await callbackScope(c, session, connectorId);
  const claimed = await c.env.DB.prepare(`UPDATE push_credentials SET completed_at = ?, outcome = ?, tip = ?
    WHERE id = ? AND completed_at IS NULL RETURNING revocation_ciphertext`)
    .bind(now(), outcome, tip ?? null, credentialId).first<{ revocation_ciphertext: string | null }>();
  if (!claimed) fail(409, 'push_already_completed', 'This push was already completed.');
  await revokeStored(c, credentialId, claimed.revocation_ciphertext);
  await auditStatement(c.env, ledger.requested_by, 'git.push.completed', session.workspace_id, sessionId, {
    approvalId, credentialId, outcome, ...(tip ? { tip } : {}),
  }).run();

  const operation = parseOperation(JSON.parse(ledger.operation_json)) as GitPushOperation;
  const result: PushCompletionResult = {};
  if (outcome === 'failed' || !operation.pullRequest || !tip) return c.json(result);
  // Pull requests are opened as the owner, who must still hold the session and write access to the repository.
  const authorize = async (): Promise<SessionRow> => {
    const owner = await sessionAccess(c.env, sessionId, session.owner_id);
    if (!owner || owner.row.status === 'archived' || owner.row.policy_version !== session.policy_version ||
        owner.row.repositories_json !== session.repositories_json || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'permission_revoked', 'Session authority changed; the pull request was not opened.');
    }
    await callbackScope(c, owner.row, connectorId);
    return owner.row;
  };
  const row = await authorize();
  const pin = pushPin(row, operation.repository);
  if (pin.bindingId !== ledger.binding_id) fail(403, 'repository_binding_mismatch', 'The pinned repository changed.');
  const { provider, host } = pinProvider(pin);
  const access = await repositoryAccess(c.env, row.owner_id, provider, host, pin.fullName);
  const target = await pushTarget(access, pin);
  if (!target.canPush) fail(403, 'push_permission_required', 'The session owner cannot push to this repository.');
  if (await branchTip(access, pin, operation.branch) !== tip) fail(409, 'push_tip_mismatch', 'The pushed branch moved; the pull request was not opened.');
  const base = operation.pullRequest.base ?? target.defaultBranch;
  if (base === operation.branch) fail(400, 'invalid_pull_request', 'The pull request base must differ from the pushed branch.');
  await recheckAccess(c.env, access);
  await authorize();
  const pullRequest = await openPullRequest(access, pin, { head: operation.branch, base, title: operation.pullRequest.title, body: operation.pullRequest.body },
    target.azureProjectId);
  await c.env.DB.prepare('UPDATE push_credentials SET pull_request_url = ? WHERE id = ?').bind(pullRequest.url, credentialId).run();
  await auditStatement(c.env, ledger.requested_by, 'git.push.pull_request', session.workspace_id, sessionId, {
    approvalId, credentialId, url: pullRequest.url, number: pullRequest.number, created: pullRequest.created, actingAs: row.owner_id,
  }).run();
  result.pullRequest = pullRequest;
  return c.json(result);
}
