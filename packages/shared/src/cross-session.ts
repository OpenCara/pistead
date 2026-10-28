import type { AccessMode, EntryView, Permission, SessionActivity, SessionRecord, SessionView } from "./types.js";

/**
 * Cross-session communication: the `sessions` tool lets a session's agent list, read, message, start, stop and archive
 * the workspace's other sessions, as the person whose message it is working on (never as anyone else), through the
 * control plane (apps/server/src/cross-session.ts). See docs/design/cross-session.md.
 *
 * `wait` is the runner's own loop of `read`s of one message's outcome; the control plane knows every other action.
 */
export const sessionsToolActions = ["list", "read", "ask", "send", "wait", "create", "stop", "archive"] as const;
export type SessionsToolAction = (typeof sessionsToolActions)[number];
export type SessionsBrokerAction = Exclude<SessionsToolAction, "wait">;
export const sessionsBrokerActions: readonly SessionsBrokerAction[] = ["list", "read", "ask", "send", "create", "stop", "archive"];
/** Actions that change another session, which a Read-only message does only once the session owner allows it. */
export const sessionsWriteActions: readonly SessionsToolAction[] = ["send", "create", "stop", "archive"];

export const crossSessionLimits = {
  /**
   * How far a chain of messages goes: a message sent by an agent working on a message that itself came from another
   * session is one hop further. A run at this many hops reads and lists, but messages, asks and starts nothing.
   */
  maxHops: 3,
  /** Messages, asks and new sessions one message's tool calls may send. */
  perMessage: 10,
  /** Sessions one session may start (its children), ever. */
  children: 20,
  /** Transcript entries a read returns, at most, and the default. */
  readEntries: 50,
  defaultEntries: 20,
  /** Characters of one entry's text a read returns. */
  entryChars: 2000,
  /** Characters of a message's reply a read or a notification carries. */
  replyChars: 16000,
  /** A notification that the target hasn't finished within this long is given up. */
  notifyHours: 24,
  /** The longest a wait blocks, in seconds, and its default. */
  waitSeconds: 1800,
  defaultWaitSeconds: 300,
} as const;

/** One session as the sessions tool shows it to an agent: no repository, host or audience details. */
export interface CrossSessionSummary {
  id: string;
  title: string;
  ownerId: string;
  status: SessionRecord["status"];
  activity?: SessionActivity;
  visibility: "private" | "workspace";
  /** What the requester may do there. */
  permissions: Permission[];
  /** The session that started it with the sessions tool. */
  parentSessionId?: string;
  /** The calling session itself. */
  self?: true;
  createdAt: string;
}

/** A message one session sent another through the sessions tool, or a notification of one's outcome. */
export interface CrossSessionMessage {
  /** Message ids appear in the delivered text as `xs:<id>`, which is how a reply is found in the target's transcript. */
  id: string;
  kind: "ask" | "send" | "create" | "notify";
  originSessionId: string;
  targetSessionId: string;
  actorId: string;
  submissionId: string;
  conversationId: string;
  hops: number;
  access?: AccessMode;
  /** A notification goes back to the origin once the target finishes the message: pending, delivered, failed or expired. */
  notify?: "pending" | "delivered" | "failed" | "expired";
  /** Why a notification failed, as an API error code. */
  notifyError?: string;
  /** For a notification: the message whose outcome it reports. */
  replyTo?: string;
  createdAt: string;
}

/**
 * What the session panel's Connected sessions shows (GET /api/sessions/:id/connections): the session's parent and
 * children, and its latest messages either way, as the control plane recorded them; only sessions the viewer can open.
 */
export interface SessionConnections {
  parent?: CrossSessionSummary;
  children: CrossSessionSummary[];
  messages: (CrossSessionMessage & { otherTitle: string })[];
}

/** A message's outcome in its target, as read from the target's view. */
export interface CrossSessionOutcome {
  /** The target's queue status of the message (queued, running, settled, interrupted, stopped, …), or unknown. */
  status: string;
  /** It ran to its end, whichever way. */
  done: boolean;
  /** The target's agent is waiting on an approval or permission card, which only people there decide. */
  waiting?: true;
  /** Its model request failed. */
  failed?: true;
  /** The target agent's last answer to it, cut to `crossSessionLimits.replyChars`. */
  reply?: string;
}

/** Runner -> control plane: one sessions tool call (any action but wait) of a write message. */
export interface SessionsToolRequest {
  /** The calling session. */
  sessionId: string;
  /** Who sent the message the call works on; every action runs as them, with their permissions in each session. */
  actorId: string;
  admissionId: string;
  callId: string;
  action: SessionsBrokerAction;
  /** The other session (read, ask, send, stop, archive). */
  targetSessionId?: string;
  /** What ask and send deliver, and create's opening message. */
  message?: string;
  /** send and create: the delivered message's access, approval by default. */
  access?: AccessMode;
  /** ask, send and create: deliver a notification back to this session once the target finishes the message. */
  notify?: boolean;
  /** create: the new session's title, model (one list returns) and visibility. */
  title?: string;
  modelId?: string;
  visibility?: "private" | "workspace";
  /** read: the outcome of this message, as ask, send or create returned it. */
  messageId?: string;
  /** read: how many of the latest transcript entries. */
  limit?: number;
}

export type SessionsToolResult =
  | { sessions: CrossSessionSummary[]; models: { id: string; name: string; provider: string; modelId: string }[] }
  | { session: CrossSessionSummary; busy: boolean; entries: Pick<EntryView, "id" | "role" | "kind" | "actorId" | "text">[];
    pendingApprovals: { id: string; kind: string; tool?: string; requestedBy: string }[]; message?: CrossSessionMessage; outcome?: CrossSessionOutcome }
  | { message: CrossSessionMessage }
  | { session: CrossSessionSummary; message?: CrossSessionMessage }
  | { stopped: number }
  | { archived: string }
  /**
   * The call would show this session's audience what only a narrower audience can read now: the session owner must
   * allow that first, on a permission card that names the session it reads (`target`). Nothing was done.
   */
  | { consent: "audience"; target: string; reason: string };

/** What a sessions tool call's permission card shows: the action and what it touches, in the call's own words. */
export function sessionsToolTarget(request: { action: SessionsToolAction; targetSessionId?: string; message?: string; access?: AccessMode; notify?: boolean;
  title?: string; modelId?: string; visibility?: string; messageId?: string }): string {
  const parts: string[] = [request.action];
  if (request.targetSessionId) parts.push(`session ${request.targetSessionId}`);
  if (request.messageId) parts.push(`message ${request.messageId}`);
  if (request.title !== undefined) parts.push(`title ${JSON.stringify(request.title)}`);
  if (request.modelId) parts.push(`model ${request.modelId}`);
  if (request.visibility) parts.push(`visibility ${request.visibility}`);
  if (request.access) parts.push(`access ${request.access}`);
  if (request.notify) parts.push("notify");
  const head = parts.join(" · ");
  // Within what a permission card shows whole (8192 characters), so the host and the control plane compare the same text.
  if (request.message !== undefined) return `${head} · message:\n${cut(request.message, 7000 - head.length)}`;
  return head;
}

/**
 * The card target of an audience consent: transcript content would pass between this session and `target`, whose
 * readers aren't the same people (a read or a notification brings the target's in; a message takes this session's out).
 */
export function audienceTarget(target: { id: string; title: string }): string {
  return `exchange content with session ${target.id} ("${oneLine(target.title)}"), which not all the same people can read`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[[\]]/g, "").slice(0, 120);
}

/**
 * The line that opens every delivered message: who sent it, from which session, how far down a chain it is, and the
 * message id a reply is found by. The control plane writes it; the agent in the target reads it, and people see it in
 * the transcript. Who sent a message is also recorded by the control plane (the session panel's Connected sessions),
 * which, unlike this text, nobody can type.
 */
export function crossSessionHeader(message: { id: string; kind: CrossSessionMessage["kind"]; hops: number },
  origin: { id: string; title: string }, actor: { id: string; login?: string | null }, replyTo?: { id: string }): string {
  const by = actor.login ? `@${actor.login}` : actor.id;
  if (message.kind === "notify") {
    return `[Pistead notification xs:${message.id} · session "${oneLine(origin.title)}" (${origin.id}) finished message xs:${replyTo?.id ?? "?"} · for ${by} · hop ${message.hops}]`;
  }
  const what = message.kind === "ask" ? "side ask" : message.kind === "create" ? "opening message" : "message";
  return `[Pistead cross-session ${what} xs:${message.id} · from session "${oneLine(origin.title)}" (${origin.id}) · sent by ${by} through its agent · hop ${message.hops}]`;
}

const doneStatuses = new Set(["settled", "interrupted", "stopped", "images lost"]);

/**
 * A delivered message's outcome in its target's view: its queue status, and the target agent's last answer after the
 * message's own entry (found by its `xs:<id>`) and before the next message in that conversation.
 */
export function messageOutcome(view: Pick<SessionView, "entries" | "queue" | "approvals">, message: Pick<CrossSessionMessage, "id" | "submissionId" | "conversationId">): CrossSessionOutcome {
  const queued = view.queue?.find(item => item.submissionId === message.submissionId);
  const status = queued?.status ?? "unknown";
  const entries = view.entries.filter(entry => entry.conversationId === message.conversationId);
  const marker = `xs:${message.id} `;
  const start = entries.findIndex(entry => entry.role === "user" && entry.text.includes(marker));
  const after: EntryView[] = [];
  if (start >= 0) {
    for (const entry of entries.slice(start + 1)) {
      if (entry.role === "user") break;
      after.push(entry);
    }
  }
  const answers = after.filter(entry => entry.role === "assistant" && !entry.error && entry.text.trim());
  const failed = after.some(entry => entry.error !== undefined);
  // A message the view's queue doesn't list (an older runner, which lists none) is done once an answer is the last thing
  // after it and no card waits.
  const pendingCard = view.approvals.some(approval => approval.status === "pending");
  const done = doneStatuses.has(status)
    || (status === "unknown" && answers.length > 0 && after.at(-1) === answers.at(-1) && !pendingCard);
  const last = answers.at(-1)?.text;
  const waiting = !done && pendingCard;
  return { status, done, ...(waiting ? { waiting: true as const } : {}), ...(failed ? { failed: true as const } : {}),
    ...(last !== undefined ? { reply: cut(last, crossSessionLimits.replyChars) } : {}) };
}

/** `value` within `max` characters, saying how much was left out. */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} more characters`;
}
