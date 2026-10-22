import type { RepinResult } from '../../../packages/shared/src/types.js';
import type { SessionRepository } from '../../../packages/shared/src/repositories.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import type { AppContext, SessionRow } from './types.js';
import { auditStatement, sessionAccess } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { parseOperation } from './operations.js';
import { requireCallbackScope } from './connectors.js';
import { requireBrokerReview, requireOperationTool } from './approval-reviews.js';
import { resolveWorkspaceRepositories } from './repositories.js';
import { bindingForSession } from './sessions.js';
import { requireNoRestore } from './push/broker.js';

type Receipt = { target_session_id: string; operation_json: string; admission_id: string | null };

/** Resolve on the control plane, not in the offline sandbox. A successor leaves all source state immutable. */
export async function repinSession(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 16384);
  if (Object.keys(input).some(key => !['sessionId', 'approvalId', 'actorId', 'operation', 'capability', 'admissionId'].includes(key))) {
    fail(400, 'invalid_repin', 'Unexpected repin field.');
  }
  const sessionId = identifier(input.sessionId, 'sessionId');
  const approvalId = identifier(input.approvalId, 'approvalId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const operation = parseOperation(input.operation);
  if (operation.kind !== 'git.repin') fail(400, 'invalid_repin', 'Expected a repin operation.');
  if ((input.capability === undefined) === (input.admissionId === undefined)) fail(400, 'invalid_repin', 'Provide one approval capability or auto-approve admission.');
  const operationJSON = JSON.stringify(operation);
  const operationHash = await sha256(operationJSON);
  const admissionId = input.admissionId === undefined ? null : text(input.admissionId, 'admissionId', 128);
  const tokenHash = admissionId === null ? await sha256(text(input.capability, 'capability', 128)) : null;
  if (admissionId && !approvalId.startsWith('tool-')) fail(400, 'invalid_repin', 'Automatic repins must name a tool call.');
  const readReceipt = () => c.env.DB.query<Receipt>('SELECT target_session_id, operation_json, admission_id FROM session_repins WHERE session_id = ? AND approval_id = ?')
    .bind(sessionId, approvalId).first();
  // A retry of a call that already created its successor returns that session, so its capability must be the one
  // that call consumed; only a first attempt consumes an unused, unexpired capability.
  const existing = await readReceipt();
  let consumed = existing !== null;
  const authorize = async (): Promise<SessionRow> => {
    const owner = await sessionAccess(c.env, sessionId, actorId);
    if (!owner || owner.row.owner_id !== actorId || owner.row.status !== 'ready' || !hasPermission(owner.permissions, 'write')) {
      fail(403, 'owner_required', 'Repinning requires the owner of a ready session.');
    }
    await requireCallbackScope(c, owner.row, connectorId);
    await requireNoRestore(c, sessionId);
    if (tokenHash) {
      const cap = await c.env.DB.query<{ session_id: string; approval_id: string; actor_id: string; requested_by: string;
        operation_hash: string; expires_at: number; consumed_at: string | null }>('SELECT * FROM broker_capabilities WHERE token_hash = ?').bind(tokenHash).first();
      if (!cap || cap.session_id !== sessionId || cap.approval_id !== approvalId || cap.actor_id !== actorId || cap.operation_hash !== operationHash
        || (consumed ? !cap.consumed_at : !!cap.consumed_at) || (!consumed && cap.expires_at <= Math.floor(Date.now() / 1000))) {
        fail(403, 'invalid_capability', 'Repin approval is expired, consumed, or does not match.');
      }
      const writer = await sessionAccess(c.env, sessionId, cap.requested_by);
      if (!writer || !hasPermission(writer.permissions, 'write') || writer.row.policy_version !== owner.row.policy_version) {
        fail(403, 'requester_revoked', 'The repin requester is no longer authorized.');
      }
      await requireBrokerReview(c.env, owner.row, approvalId, cap.requested_by, operation);
    } else {
      const admission = await c.env.DB.query<{ id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number }>(
        'SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?').bind(admissionId).first();
      if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
        || admission.access !== 'auto' || admission.expires_at <= Math.floor(Date.now() / 1000)) {
        fail(403, 'repin_not_admitted', 'Repinning requires the owner\'s current auto-approve message.');
      }
      await requireOperationTool(c.env, owner.row, operation, approvalId, admission);
    }
    return owner.row;
  };
  const source = await authorize();
  const result = async (receipt: Receipt): Promise<Response> => {
    if (receipt.operation_json !== operationJSON || receipt.admission_id !== admissionId) fail(409, 'repin_conflict', 'This call already names a different repin.');
    const target = await c.env.DB.query<SessionRow>('SELECT * FROM sessions WHERE id = ? AND owner_id = ?').bind(receipt.target_session_id, actorId).first();
    if (!target) fail(409, 'repin_unavailable', 'Repinned session is unavailable.');
    const value: RepinResult = { sessionId: target.id, path: `/#/s/${target.id}`, repositories: JSON.parse(target.repositories_json ?? '[]') };
    return c.json(value);
  };
  if (existing) return result(existing);
  if (source.repository_mode === 'clone') fail(409, 'clone_session', 'This session clones its repositories with plain Git: switch branches with git checkout instead of repinning.');
  const pins = JSON.parse(source.repositories_json ?? '[]') as SessionRepository[];
  if (!pins.some(pin => pin.path === operation.repository)) fail(403, 'repository_not_pinned', 'Repin must name a pinned repository path.');
  const resolved = await resolveWorkspaceRepositories(c.env, source.workspace_id, source.owner_id, {
    gitProviders: true, repin: { pins, repository: operation.repository, ref: operation.ref },
  });
  // The successor keeps the owner, agent and host. Like a restored session, the owner's first message starts it through
  // the restart route, which provisions exactly these pins.
  await bindingForSession(c, source);
  const fresh = await authorize();
  if (fresh.policy_version !== source.policy_version || fresh.repositories_json !== source.repositories_json) fail(409, 'repin_changed', 'Session authority changed while resolving the ref.');
  if (tokenHash) {
    const used = await c.env.DB.query(`UPDATE broker_capabilities SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING token_hash`)
      .bind(now(), tokenHash, Math.floor(Date.now() / 1000)).first();
    if (!used) fail(409, 'capability_consumed', 'This repin was already attempted.');
    consumed = true;
  }
  await authorize();
  const targetId = id();
  const createdAt = now();
  // Creation and the unique receipt are one transaction. No overwritten files, no copied grants, no orphan on a racing retry.
  await c.env.DB.batch([
    // Serialize repins of this source on Postgres too, so retries and the per-message limit cannot race.
    c.env.DB.query('UPDATE sessions SET policy_version = policy_version WHERE id = ?').bind(sessionId),
    c.env.DB.query(`INSERT INTO sessions (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at,
        connector_id, connector_owner_id, repositories_json, visibility)
      SELECT ?, workspace_id, owner_id, agent_version_id, ?, 1, 'provisioning', ?, connector_id, connector_owner_id, ?, 'private'
      FROM sessions source WHERE source.id = ? AND source.owner_id = ? AND source.policy_version = ? AND source.status = 'ready'
        AND source.repositories_json = ?
        AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = source.workspace_id AND user_id = source.owner_id)
        AND NOT EXISTS (SELECT 1 FROM session_repins WHERE session_id = ? AND approval_id = ?)
        AND (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories WHERE workspace_id = source.workspace_id) = json(?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM github_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.user_id = source.owner_id AND t.ciphertext = ? AND u.github_id = ? AND u.auth_kind = 'github'))
        AND (SELECT COUNT(*) FROM json_each(?) used JOIN git_credentials credential
          ON credential.id = json_extract(used.value, '$.id') AND credential.ciphertext = json_extract(used.value, '$.ciphertext')
          AND credential.user_id = source.owner_id) = ?
        AND (source.connector_id IS NULL OR EXISTS (SELECT 1 FROM connectors host
          JOIN connector_workspaces association ON association.connector_id = host.id AND association.workspace_id = source.workspace_id
          JOIN workspace_members member ON member.workspace_id = source.workspace_id AND member.user_id = host.owner_id
          WHERE host.id = source.connector_id AND host.owner_id = source.connector_owner_id AND host.revoked_at IS NULL
            AND json_type(host.capabilities_json, '$.gitRepin') = 'true'
            AND (host.owner_id = source.owner_id OR EXISTS (SELECT 1 FROM connector_shares share WHERE share.connector_id = host.id AND share.workspace_id = source.workspace_id))))
        AND (? IS NULL OR (EXISTS (SELECT 1 FROM run_admissions a WHERE a.id = ? AND a.session_id = source.id
          AND a.actor_id = source.owner_id AND a.mode = 'write' AND a.access = 'auto' AND a.expires_at > ?)
          AND (SELECT COUNT(*) FROM session_repins WHERE admission_id = ?) < 5))`)
      .bind(targetId, `Repinned: ${source.title}`.slice(0, 200), createdAt, JSON.stringify(resolved.repositories),
        source.id, source.owner_id, source.policy_version, source.repositories_json ?? '[]', sessionId, approvalId, resolved.bindingIds,
        resolved.githubAuthority?.githubId ?? null, resolved.githubAuthority?.ciphertext ?? null, resolved.githubAuthority?.githubId ?? null,
        JSON.stringify(resolved.credentials), resolved.credentials.length, admissionId, admissionId, Math.floor(Date.now() / 1000), admissionId),
    c.env.DB.query(`INSERT INTO session_repins (session_id, approval_id, target_session_id, operation_json, admission_id, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`)
      .bind(sessionId, approvalId, targetId, operationJSON, admissionId, createdAt, targetId),
  ]);
  const receipt = await readReceipt();
  if (!receipt) fail(409, 'repin_changed', 'Repository access, host or session authority changed, or this message reached its limit of five repins.');
  if (receipt.target_session_id === targetId) await auditStatement(c.env, actorId, 'session.repinned', source.workspace_id, source.id,
    { approvalId, targetSessionId: targetId, repository: operation.repository, ref: operation.ref, repositories: resolved.repositories, automatic: admissionId !== null }).run();
  return result(receipt);
}
