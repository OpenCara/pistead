import type { ApprovalRecord, Operation, ToolName } from '../../../packages/shared/src/types.js';
import { constantTimeEqual, sha256 } from '../../../packages/shared/src/crypto.js';
import type { AppContext, Env, SessionRow } from './types.js';
import { fail, identifier, now, text, userIdentifier } from './http.js';
import { parseOperation } from './operations.js';

type ReviewRow = {
  session_id: string; approval_id: string; requested_by: string; operation_json: string;
  source: 'explicit' | 'model'; admission_id: string | null; review_hash: string; created_at: string;
};
type AdmissionRow = { id: string; session_id: string; actor_id: string; mode: string; access: string | null; expires_at: number };
/** What decides whether an admission is the session owner's Auto-approve message. */
type AdmissionAccess = Pick<AdmissionRow, 'session_id' | 'actor_id' | 'mode' | 'access'>;
const operationTools: Record<Exclude<Operation['kind'], 'permission'>, ToolName> = {
  'github.comment': 'github_comment', 'github.merge': 'github_merge', 'git.commit': 'git_commit', bash: 'bash', 'git.push': 'git_push',
};
const statuses: readonly string[] = ['pending', 'approved', 'denied', 'executing', 'executed', 'interrupted', 'failed'];

async function toolsFor(env: Env, row: SessionRow): Promise<string[]> {
  const agent = await env.DB.query<{ tools_json: string }>('SELECT tools_json FROM agent_versions WHERE id = ?').bind(row.agent_version_id).first();
  if (!agent) fail(409, 'invalid_binding', 'The pinned agent is unavailable.');
  return JSON.parse(agent.tools_json) as string[];
}
/** The tool call a permission request `permission-<call>` waits in; its operation's approval is `tool-<call>`. */
export function permissionCall(approvalId: string): string | undefined {
  return /^permission-([A-Za-z0-9_-]+)$/.exec(approvalId)?.[1];
}
/**
 * Whether `admission` is a message the session owner sent with Auto-approve access. Its tool calls use any tool without
 * a permission card, as the runner lets them; what those calls do still follows its own rules (comments and merges wait
 * for a human, a command without limits runs only on the owner's host).
 */
function ownerAuto(row: SessionRow, admission: AdmissionAccess | undefined): boolean {
  return admission?.access === 'auto' && admission.mode === 'write' && admission.actor_id === row.owner_id && admission.session_id === row.id;
}
/**
 * Whether a session may use an operation's tool: its pinned agent's, one the owner allowed through a permission
 * request, for the session or for the one call whose approval is `tool-<call>`, or any tool for a call of the owner's
 * Auto-approve message (`admission`). A permission request asks for the tool itself, so it is presented whenever it
 * names its call (a one-call grant must never become a session one); only the owner can decide it.
 */
async function sessionTools(env: Env, row: SessionRow): Promise<(operation: Operation, approvalId: string, admission?: AdmissionAccess) => boolean> {
  const agentTools = await toolsFor(env, row);
  const grants = await env.DB.query<{ tool: string; call_id: string }>('SELECT tool, call_id FROM session_tool_grants WHERE session_id = ?').bind(row.id).all();
  return (operation, approvalId, admission) => {
    if (operation.kind === 'permission') return permissionCall(approvalId) !== undefined;
    const tool = operationTools[operation.kind];
    const call = approvalId.startsWith('tool-') ? approvalId.slice('tool-'.length) : undefined;
    return agentTools.includes(tool) || grants.some(grant => grant.tool === tool && (grant.call_id === '' || grant.call_id === call))
      || (call !== undefined && ownerAuto(row, admission));
  };
}
export async function requireOperationTool(env: Env, row: SessionRow, operation: Operation, approvalId = '', admission?: AdmissionAccess): Promise<void> {
  if (!(await sessionTools(env, row))(operation, approvalId, admission)) fail(403, 'tool_not_allowed', 'The pinned agent does not allow this operation.');
}
/**
 * Whether a tool call that reaches the control plane without an approval (github_read) may use `tool`: the pinned
 * agent's, any tool in the owner's Auto-approve message (`call.admission`, already checked as the requester's current
 * write admission), one the owner allowed for the session, or one the owner allowed for this call. A one-call grant
 * covers only the call its permission card showed: the same requester, message and target, so the call id can't be
 * reused for another target or a later message.
 */
export async function requireToolCall(env: Env, row: SessionRow, tool: ToolName,
  call: { id: string; requestedBy: string; admission: AdmissionRow; target: string }): Promise<void> {
  if ((await toolsFor(env, row)).includes(tool) || ownerAuto(row, call.admission)) return;
  const grants = await env.DB.query<{ call_id: string; approval_id: string }>(`SELECT call_id, approval_id FROM session_tool_grants
    WHERE session_id = ? AND tool = ? AND (call_id = '' OR call_id = ?)`).bind(row.id, tool, call.id).all();
  if (grants.some(grant => grant.call_id === '')) return;
  const review = grants[0] && await env.DB.query<ReviewRow>('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?')
    .bind(row.id, grants[0].approval_id).first();
  const request = review ? parseOperation(JSON.parse(review.operation_json)) : undefined;
  if (!review || request?.kind !== 'permission' || request.tool !== tool || request.target !== call.target
    || review.requested_by !== call.requestedBy || review.admission_id !== call.admission.id) {
    fail(403, 'tool_not_allowed', 'The pinned agent does not include this tool and the session owner has not allowed this call.');
  }
}
export async function reviewCommitment(sessionId: string, approvalId: string, requestedBy: string, operation: Operation): Promise<string> {
  return sha256(JSON.stringify({ sessionId, approvalId, requestedBy, operation }));
}
function unavailable(approval: ApprovalRecord): ApprovalRecord {
  // A decided permission request is final: its tool call already went ahead or failed, and nothing runs from it.
  if (!['pending', 'approved', 'executing'].includes(approval.status) || (approval.operation.kind === 'permission' && approval.status !== 'pending')) return approval;
  return { ...approval, status: 'interrupted', result: 'This approval has no current authorized write admission. Submit a new write request.' };
}
function activeAdmission(admission: AdmissionRow | undefined, row: SessionRow, actorId: string): boolean {
  return !!admission && admission.session_id === row.id && admission.actor_id === actorId && admission.mode === 'write' &&
    admission.expires_at > Math.floor(Date.now() / 1000);
}
/** The approval's write admission, current and its requester's; explicit operations have none. */
async function requireProvenance(env: Env, row: SessionRow, review: ReviewRow): Promise<AdmissionRow | undefined> {
  if (review.source === 'explicit' && review.admission_id === null) return undefined;
  if (review.source !== 'model' || !review.admission_id) fail(403, 'invalid_approval_provenance', 'The approval has no authorized write admission.');
  const admission = await env.DB.query<AdmissionRow>('SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions WHERE id = ?')
    .bind(review.admission_id).first();
  if (!activeAdmission(admission ?? undefined, row, review.requested_by)) fail(409, 'approval_admission_expired', 'The write admission is unavailable or expired. Submit a new write request.');
  return admission!;
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
    // Only the owner's own commands, commits and pushes may run without a human decision, and never a GitHub comment or merge.
    if (raw.automatic !== undefined) {
      if (raw.automatic !== true || explicit || requestedBy !== row.owner_id || approval.decidedBy !== row.owner_id || approval.status === 'pending'
        || operation.kind === 'github.comment' || operation.kind === 'github.merge' || operation.kind === 'permission') fail(502, 'invalid_runner_response', 'The runtime returned an invalid automatic approval.');
      approval.automatic = true;
    }
    // An allowed permission request says how far it reaches; only a command can run without resource limits.
    if (raw.scope !== undefined) {
      if ((raw.scope !== 'call' && raw.scope !== 'session') || operation.kind !== 'permission' || approval.status !== 'approved') fail(502, 'invalid_runner_response', 'The runtime returned an invalid permission scope.');
      approval.scope = raw.scope;
    }
    if (raw.unbounded !== undefined) {
      if (raw.unbounded !== true || operation.kind !== 'bash') fail(502, 'invalid_runner_response', 'The runtime returned an invalid unbounded command.');
      approval.unbounded = true;
    }
    if (explicit && (requestedBy !== explicit.requestedBy || JSON.stringify(operation) !== JSON.stringify(explicit.operation) || raw.admissionId !== undefined)) {
      fail(502, 'approval_changed', 'The runtime changed the explicitly requested operation.');
    }
    return { approval, admissionId: typeof raw.admissionId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw.admissionId) ? raw.admissionId : null };
  });
  const ids = JSON.stringify(normalized.map(item => item.approval.id));
  const readStored = () => c.env.DB.query<ReviewRow>(`SELECT * FROM approval_reviews WHERE session_id = ?
    AND approval_id IN (SELECT value FROM json_each(?))`).bind(row.id, ids).all();
  let stored = new Map((await readStored()).map(item => [item.approval_id, item]));
  const admissionIds = [...new Set(normalized.map(item => stored.get(item.approval.id)?.admission_id ?? item.admissionId).filter((value): value is string => value !== null))];
  const admissions = new Map<string, AdmissionRow>();
  if (admissionIds.length) {
    const result = await c.env.DB.query<AdmissionRow>(`SELECT id, session_id, actor_id, mode, access, expires_at FROM run_admissions
      WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(row.id, JSON.stringify(admissionIds)).all();
    for (const admission of result) admissions.set(admission.id, admission);
  }
  const allows = await sessionTools(c.env, row);
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
    const admission = admissionId ? admissions.get(admissionId) : undefined;
    if (!allows(approval.operation, approval.id, explicit ? undefined : admission)) continue;
    if (!explicit && !activeAdmission(admission, row, approval.requestedBy)) continue;
    candidates.push({ session_id: row.id, approval_id: approval.id, requested_by: explicit?.requestedBy ?? admission!.actor_id,
      operation_json: JSON.stringify(explicit?.operation ?? approval.operation), source: explicit ? 'explicit' : 'model',
      admission_id: explicit ? null : admissionId, review_hash: hash, created_at: now() });
  }
  if (candidates.length) {
    await c.env.DB.query(`INSERT INTO approval_reviews
      (session_id, approval_id, requested_by, operation_json, source, admission_id, review_hash, created_at)
      SELECT json_extract(value, '$.session_id'), json_extract(value, '$.approval_id'), json_extract(value, '$.requested_by'),
        json_extract(value, '$.operation_json'), json_extract(value, '$.source'), json_extract(value, '$.admission_id'),
        json_extract(value, '$.review_hash'), json_extract(value, '$.created_at') FROM json_each(?)
      WHERE json_extract(value, '$.source') = 'explicit' OR EXISTS (
        SELECT 1 FROM run_admissions a WHERE a.id = json_extract(value, '$.admission_id') AND a.mode = 'write'
        AND a.session_id = json_extract(value, '$.session_id') AND a.actor_id = json_extract(value, '$.requested_by') AND a.expires_at > ?)
      ON CONFLICT (session_id, approval_id) DO NOTHING`).bind(JSON.stringify(candidates), Math.floor(Date.now() / 1000)).run();
    stored = new Map((await readStored()).map(item => [item.approval_id, item]));
  }
  return normalized.map(({ approval, admissionId }) => {
    const review = stored.get(approval.id);
    if (!review) return unavailable(approval);
    if (review.review_hash !== commitments.get(approval.id) || review.admission_id !== admissionId || (explicit && review.source !== 'explicit')) {
      fail(502, 'approval_changed', 'The runtime changed a previously reviewed operation or requester.');
    }
    const admission = review.source === 'model' ? admissions.get(review.admission_id!) : undefined;
    if (!allows(approval.operation, approval.id, admission) || (review.source === 'model' && !activeAdmission(admission, row, review.requested_by))) return unavailable(approval);
    return { ...approval, requestedBy: review.requested_by, operation: parseOperation(JSON.parse(review.operation_json)), reviewHash: review.review_hash };
  });
}

export async function reviewedApproval(c: AppContext, row: SessionRow, approvalId: string, reviewHash: unknown): Promise<ReviewRow & { operation: Operation }> {
  if (typeof reviewHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reviewHash)) fail(409, 'approval_review_required', 'Refresh and review the exact operation before deciding.');
  const review = await c.env.DB.query<ReviewRow>('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first();
  if (!review || !constantTimeEqual(review.review_hash, reviewHash)) fail(409, 'approval_review_required', 'Refresh and review the exact operation before deciding.');
  const operation = parseOperation(JSON.parse(review.operation_json));
  await requireOperationTool(c.env, row, operation, approvalId, await requireProvenance(c.env, row, review));
  return { ...review, operation };
}

export async function requireBrokerReview(env: Env, row: SessionRow, approvalId: string, requestedBy: string, operation: Operation): Promise<void> {
  const review = await env.DB.query<ReviewRow>('SELECT * FROM approval_reviews WHERE session_id = ? AND approval_id = ?').bind(row.id, approvalId).first();
  if (!review || review.requested_by !== requestedBy || review.operation_json !== JSON.stringify(operation)) fail(403, 'invalid_approval_provenance', 'The operation has no matching human-reviewed write request.');
  await requireOperationTool(env, row, operation, approvalId, await requireProvenance(env, row, review));
}
