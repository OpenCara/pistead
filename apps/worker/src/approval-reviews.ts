import type { ApprovalRecord, Operation } from '../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import type { AppContext, Env, SessionRow } from './types.js';
import { fail, identifier, now, text, userIdentifier } from './http.js';
import { parseOperation } from './operations.js';

type ReviewRow = {
  session_id: string; approval_id: string; requested_by: string; operation_json: string;
  source: 'explicit' | 'model'; admission_id: string | null; review_hash: string; created_at: string;
};
type AdmissionRow = { id: string; session_id: string; actor_id: string; mode: string; expires_at: number };
const operationTools: Record<Operation['kind'], string> = { 'github.comment': 'github_comment', 'git.commit': 'git_commit', bash: 'bash', 'git.push': 'git_push' };
const statuses: readonly string[] = ['pending', 'approved', 'denied', 'executing', 'executed', 'interrupted', 'failed'];

async function toolsFor(env: Env, row: SessionRow): Promise<string[]> {
  const agent = await env.DB.prepare('SELECT tools_json FROM agent_versions WHERE id = ?').bind(row.agent_version_id).first<{ tools_json: string }>();
  if (!agent) fail(409, 'invalid_binding', 'The pinned agent is unavailable.');
  return JSON.parse(agent.tools_json) as string[];
}
export async function requireOperationTool(env: Env, row: SessionRow, operation: Operation): Promise<void> {
  if (!(await toolsFor(env, row)).includes(operationTools[operation.kind])) fail(403, 'tool_not_allowed', 'The pinned agent does not allow this operation.');
}
export async function reviewCommitment(sessionId: string, approvalId: string, requestedBy: string, operation: Operation): Promise<string> {
  return sha256(JSON.stringify({ sessionId, approvalId, requestedBy, operation }));
}
function unavailable(approval: ApprovalRecord): ApprovalRecord {
  if (!['pending', 'approved', 'executing'].includes(approval.status)) return approval;
  return { ...approval, status: 'interrupted', result: 'This approval has no current authorized write admission. Submit a new write request.' };
}
function activeAdmission(admission: AdmissionRow | undefined, row: SessionRow, actorId: string): boolean {
  return !!admission && admission.session_id === row.id && admission.actor_id === actorId && admission.mode === 'write' &&
    admission.expires_at > Math.floor(Date.now() / 1000);
}
async function requireProvenance(env: Env, row: SessionRow, review: ReviewRow): Promise<void> {
  if (review.source === 'explicit' && review.admission_id === null) return;
  if (review.source !== 'model' || !review.admission_id) fail(403, 'invalid_approval_provenance', 'The approval has no authorized write admission.');
  const admission = await env.DB.prepare('SELECT id, session_id, actor_id, mode, expires_at FROM run_admissions WHERE id = ?')
    .bind(review.admission_id).first<AdmissionRow>();
  if (!activeAdmission(admission ?? undefined, row, review.requested_by)) fail(409, 'approval_admission_expired', 'The write admission is unavailable or expired. Submit a new write request.');
}

// Only this function may create review rows. Explicit operations use the authenticated request,
// while model candidates must carry an opaque admission minted by a real write submission.
export async function presentApprovals(c: AppContext, row: SessionRow, input: ApprovalRecord[], explicit?: { operation: Operation; requestedBy: string }): Promise<ApprovalRecord[]> {
  if (!Array.isArray(input) || input.length > 512 || (explicit && input.length !== 1)) fail(502, 'invalid_runner_response', 'The runtime returned invalid approvals.');
  if (!input.length) return [];
  const seen = new Set<string>();
  const normalized = input.map(raw => {
    if (!raw || typeof raw !== 'object' || raw.sessionId !== row.id || !statuses.includes(raw.status)) fail(502, 'invalid_runner_response', 'The runtime returned invalid approvals.');
    const approvalId = identifier(raw.id, 'approvalId');
    if (seen.has(approvalId)) fail(502, 'invalid_runner_response', 'The runtime returned duplicate approvals.');
    seen.add(approvalId);
    const requestedBy = userIdentifier(raw.requestedBy, 'requestedBy');
    const operation = parseOperation(raw.operation);
    const approval: ApprovalRecord = { id: approvalId, sessionId: row.id, requestedBy, operation, status: raw.status,
      createdAt: text(raw.createdAt, 'createdAt', 64),
      ...(raw.decidedBy === undefined ? {} : { decidedBy: userIdentifier(raw.decidedBy, 'decidedBy') }),
      ...(raw.result === undefined ? {} : { result: text(raw.result, 'result', 8192, 0) }) };
    // Only the owner's own commands, commits and pushes may run without a human decision, and never a GitHub comment.
    if (raw.automatic !== undefined) {
      if (raw.automatic !== true || explicit || requestedBy !== row.owner_id || approval.decidedBy !== row.owner_id
        || approval.status === 'pending' || operation.kind === 'github.comment') fail(502, 'invalid_runner_response', 'The runtime returned an invalid automatic approval.');
      approval.automatic = true;
    }
    if (explicit && (requestedBy !== explicit.requestedBy || JSON.stringify(operation) !== JSON.stringify(explicit.operation) || raw.admissionId !== undefined)) {
      fail(502, 'approval_changed', 'The runtime changed the explicitly requested operation.');
    }
    return { approval, admissionId: typeof raw.admissionId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw.admissionId) ? raw.admissionId : null };
  });
  const ids = JSON.stringify(normalized.map(item => item.approval.id));
  const readStored = () => c.env.DB.prepare(`SELECT * FROM approval_reviews WHERE session_id = ?
    AND approval_id IN (SELECT value FROM json_each(?))`).bind(row.id, ids).all<ReviewRow>();
  let stored = new Map((await readStored()).results.map(item => [item.approval_id, item]));
  const admissionIds = [...new Set(normalized.map(item => stored.get(item.approval.id)?.admission_id ?? item.admissionId).filter((value): value is string => value !== null))];
  const admissions = new Map<string, AdmissionRow>();
  if (admissionIds.length) {
    const result = await c.env.DB.prepare(`SELECT id, session_id, actor_id, mode, expires_at FROM run_admissions
      WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(row.id, JSON.stringify(admissionIds)).all<AdmissionRow>();
    for (const admission of result.results) admissions.set(admission.id, admission);
  }
  const tools = await toolsFor(c.env, row);
  const candidates: ReviewRow[] = [];
  const commitments = new Map<string, string>();
  for (const item of normalized) {
    const { approval, admissionId } = item;
    const hash = await reviewCommitment(row.id, approval.id, approval.requestedBy, approval.operation);
    commitments.set(approval.id, hash);
    const previous = stored.get(approval.id);
    if (previous) {
      if (!constantTimeEqual(previous.review_hash, hash) || previous.requested_by !== approval.requestedBy ||
          (previous.source === 'model' && previous.admission_id !== admissionId) || (previous.source === 'explicit' && admissionId !== null)) {
        fail(502, 'approval_changed', 'The runtime changed a previously reviewed operation or requester.');
      }
      continue;
    }
    if (!tools.includes(operationTools[approval.operation.kind])) continue;
    const admission = admissionId ? admissions.get(admissionId) : undefined;
    if (!explicit && !activeAdmission(admission, row, approval.requestedBy)) continue;
    candidates.push({ session_id: row.id, approval_id: approval.id, requested_by: explicit?.requestedBy ?? admission!.actor_id,
      operation_json: JSON.stringify(explicit?.operation ?? approval.operation), source: explicit ? 'explicit' : 'model',
      admission_id: explicit ? null : admissionId, review_hash: hash, created_at: now() });
  }
  if (candidates.length) {
    await c.env.DB.prepare(`INSERT INTO approval_reviews
      (session_id, approval_id, requested_by, operation_json, source, admission_id, review_hash, created_at)
      SELECT json_extract(value, '$.session_id'), json_extract(value, '$.approval_id'), json_extract(value, '$.requested_by'),
        json_extract(value, '$.operation_json'), json_extract(value, '$.source'), json_extract(value, '$.admission_id'),
        json_extract(value, '$.review_hash'), json_extract(value, '$.created_at') FROM json_each(?)
      WHERE json_extract(value, '$.source') = 'explicit' OR EXISTS (
        SELECT 1 FROM run_admissions a WHERE a.id = json_extract(value, '$.admission_id') AND a.mode = 'write'
        AND a.session_id = json_extract(value, '$.session_id') AND a.actor_id = json_extract(value, '$.requested_by') AND a.expires_at > ?)
      ON CONFLICT (session_id, approval_id) DO NOTHING`).bind(JSON.stringify(candidates), Math.floor(Date.now() / 1000)).run();
    stored = new Map((await readStored()).results.map(item => [item.approval_id, item]));
  }
  return normalized.map(({ approval, admissionId }) => {
    const review = stored.get(approval.id);
    if (!review) return unavailable(approval);
    if (review.review_hash !== commitments.get(approval.id) || review.admission_id !== admissionId || (explicit && review.source !== 'explicit')) {
      fail(502, 'approval_changed', 'The runtime changed a previously reviewed operation or requester.');
    }
    if (!tools.includes(operationTools[approval.operation.kind]) || (review.source === 'model' && !activeAdmission(admissions.get(review.admission_id!), row, review.requested_by))) return unavailable(approval);
    return { ...approval, requestedBy: review.requested_by, operation: parseOperation(JSON.parse(review.operation_json)), reviewHash: review.review_hash };
  });
}

export async function reviewedApproval(c: AppContext, row: SessionRow, approvalId: string, reviewHash: unknown): Promise<ReviewRow & { operation: Operation }> {
  if (typeof reviewHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reviewHash)) fail(409, 'approval_review_required', 'Refresh and review the exact operation before deciding.');
  const review = await c.env.DB.prepare('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first<ReviewRow>();
  if (!review || !constantTimeEqual(review.review_hash, reviewHash)) fail(409, 'approval_review_required', 'Refresh and review the exact operation before deciding.');
  const operation = parseOperation(JSON.parse(review.operation_json));
  await requireProvenance(c.env, row, review);
  await requireOperationTool(c.env, row, operation);
  return { ...review, operation };
}

export async function requireBrokerReview(env: Env, row: SessionRow, approvalId: string, requestedBy: string, operation: Operation): Promise<void> {
  const review = await env.DB.prepare('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first<ReviewRow>();
  if (!review || review.requested_by !== requestedBy || review.operation_json !== JSON.stringify(operation)) fail(403, 'invalid_approval_provenance', 'The operation has no matching human-reviewed write request.');
  await requireProvenance(env, row, review);
  await requireOperationTool(env, row, operation);
}
