import type { ApprovalRecord, AutoApprovedCall } from "../../../packages/shared/src/types.js";

/** An approval as the host keeps it: with the model's id of the tool call it belongs to, when it has one. */
export type StoredApproval = ApprovalRecord & { callId?: string };

/** Whether a tool call waiting on `approval` can go on: a permission request once decided, an operation once it ran, failed or was denied. */
export function settled(approval: ApprovalRecord): boolean {
  return approval.operation.kind === "permission" ? approval.status !== "pending" : !["pending", "approved", "executing"].includes(approval.status);
}

/** Settled approvals a view lists, the newest ones; the host keeps them all. */
export const VIEW_SETTLED_APPROVALS = 50;
/** How much of a settled approval's result a view keeps: its start and its (usually decisive) end. */
export const VIEW_SETTLED_RESULT = 1000;

/**
 * Whether a view leaves `approval` to the transcript: a shell command that ran under the owner's auto-approve access.
 * Nobody decided it, and its call and result are already in the transcript, so a card would only repeat them; long
 * auto-approve sessions ran one per tool call and buried the decisions people made (#54). Automatic commits, pushes
 * and repins stay listed: they change repositories and sessions, and their results (a pull request, the repinned
 * session) are what people look for.
 */
function inTranscript(approval: ApprovalRecord): boolean {
  return approval.automatic === true && (approval.operation.kind === "bash" || approval.operation.kind === "host.bash");
}

/** The control plane rejects approval results above 8192 characters; an approval it gets keeps at most this much. */
export const CONTROL_PLANE_RESULT = 8000;

/**
 * `result` in at most `limit` characters: a quarter of them from its start and the rest from its (usually decisive)
 * end, around a note of how much was left out.
 */
export function excerpt(result: string, limit = VIEW_SETTLED_RESULT): string {
  if (result.length <= limit) return result;
  const room = limit - 100, head = Math.floor(room / 4), tail = room - head;
  return `${result.slice(0, head)}\n… ${result.length - head - tail} characters omitted …\n${result.slice(-tail)}`;
}

/** `approval` as the control plane accepts it, with a result short enough for it; the host keeps the longer one. */
export function forControlPlane<T extends ApprovalRecord>(approval: T): T {
  return approval.result === undefined ? approval : { ...approval, result: excerpt(approval.result, CONTROL_PLANE_RESULT) };
}

/**
 * The approvals a view lists, oldest first, and how many older settled ones it leaves out.
 *
 * - Cards still in play are always listed, in full: a pending decision, an approved operation that still runs, one at
 *   work.
 * - Commands auto-approve ran are left to the transcript (see `inTranscript`; `autoApprovedCalls` marks their calls).
 * - An allowed permission request is folded into its tool call's operation card, which shows what it let through.
 * - Only the newest settled cards are listed, with shortened results, so a view stays small however long the session
 *   runs and well below the 512 approvals the control plane accepts.
 */
export function viewApprovals(stored: readonly StoredApproval[]): { approvals: ApprovalRecord[]; olderApprovals: number } {
  const byId = new Map(stored.map(approval => [approval.id, approval]));
  const permissions = new Map<string, NonNullable<ApprovalRecord["permission"]>>();
  const folded = new Set<string>();
  for (const approval of stored) {
    const call = /^permission-(.+)$/.exec(approval.id)?.[1];
    const operation = call === undefined ? undefined : byId.get(`tool-${call}`);
    if (!operation || inTranscript(operation) || approval.operation.kind !== "permission" || approval.status !== "approved" || !approval.decidedBy) continue;
    permissions.set(operation.id, { decidedBy: approval.decidedBy, ...(approval.scope ? { scope: approval.scope } : {}) });
    folded.add(approval.id);
  }
  let keep = VIEW_SETTLED_APPROVALS;
  let olderApprovals = 0;
  const approvals: ApprovalRecord[] = [];
  for (let index = stored.length - 1; index >= 0; index--) {
    const { callId: _callId, ...approval } = stored[index]!;
    if (inTranscript(approval) || folded.has(approval.id)) continue;
    const done = settled(approval);
    if (done && keep === 0) { olderApprovals++; continue; }
    if (done) keep--;
    const permission = permissions.get(approval.id);
    approvals.push({ ...approval, ...(done && approval.result !== undefined ? { result: excerpt(approval.result) } : {}), ...(permission ? { permission } : {}) });
  }
  return { approvals: approvals.reverse(), olderApprovals };
}

/** How each command auto-approve ran (see `inTranscript`) went, by the model's id of its tool call, to mark the call. */
export function autoApprovedCalls(stored: readonly StoredApproval[]): Map<string, Omit<AutoApprovedCall, "tool">> {
  const calls = new Map<string, Omit<AutoApprovedCall, "tool">>();
  for (const approval of stored) {
    if (inTranscript(approval) && approval.callId) calls.set(approval.callId, { status: approval.status, ...(approval.unbounded ? { unbounded: true as const } : {}) });
  }
  return calls;
}
