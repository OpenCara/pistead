import type { Hono } from 'hono';
import { accessModes, type AccessMode, type SessionView } from '../../../packages/shared/src/types.js';
import { hasPermission } from '../../../packages/shared/src/policy.js';
import {
  audienceTarget, crossSessionHeader, crossSessionLimits, cut, messageOutcome, sessionsBrokerActions, sessionsToolTarget, sessionsWriteActions,
  type CrossSessionMessage, type CrossSessionOutcome, type CrossSessionSummary, type SessionConnections, type SessionsBrokerAction, type SessionsToolResult,
} from '../../../packages/shared/src/cross-session.js';
import { asSessionOwner, errorCode } from './automatic-backups.js';
import { auditStatement, getUser, requireSession, requireSessionCreator, sessionAccess, sessionReaders, workspaceSessionAccess } from './db.js';
import { fail, id, identifier, jsonObject, now, text, userIdentifier } from './http.js';
import { requireCallbackScope } from './connectors.js';
import { requireToolCall, sessionsNeedGranted } from './approval-reviews.js';
import { archiveSession, createSession, stopSession, submitMessage } from './sessions.js';
import { isLinkShared } from './session-links.js';
import { sessionView, transcriptDisplay } from './view-feed.js';
import { usableModels } from './catalog.js';
import type { AppContext, Env, SessionAccess, SessionRow, WorkerEnv } from './types.js';

/**
 * Cross-session communication: the sessions tool (packages/shared/src/cross-session.ts), with which a session's agent
 * lists, reads, messages, starts, stops and archives the workspace's other sessions. See docs/design/cross-session.md.
 *
 * - Every action runs as the person whose message the call works on (the actor), never as the session's owner or
 *   anyone else: in each other session the actor has exactly their own permissions there, checked as if they had
 *   asked themselves (`asActor`), and everything they send goes through the same route as their chat box's.
 * - What the message's access allows caps what it passes on: a Read-only message lists, reads and asks, and changes
 *   another session only once the session owner allows it (`sessions:write`); only the owner's own Auto-approve message
 *   sends an auto-approved message, and only to a session they own too.
 * - Approvals never cross sessions: what a message runs elsewhere waits on that session's own cards, for its own people.
 * - Content passes between two sessions only when the same people can read both, or the origin's owner allowed it on
 *   a permission card (`sessions:audience`): a read or notification brings the target's content in, a message takes
 *   the origin's out.
 * - Each delivered message names its origin, its sender and its hop in its first line, and is recorded here
 *   (`session_messages`), where people see it (the session panel) and chains are bounded: a message at
 *   `crossSessionLimits.maxHops` sends nothing further, and none goes back to a session it came through.
 * - A message may ask for a notification: once its target finished it, a sweep (`runCrossSessionNotifications`) sends
 *   its outcome back to the origin, as the same person, while the origin is idle.
 */

interface MessageRow {
  id: string; workspace_id: string; origin_session_id: string; target_session_id: string; actor_id: string;
  kind: CrossSessionMessage['kind']; origin_admission_id: string | null; origin_call_id: string | null; submission_id: string; conversation_id: string;
  hops: number; chain_json: string; access: AccessMode | null; notify_status: NonNullable<CrossSessionMessage['notify']> | null; notify_error: string | null;
  notify_message_id: string | null; reply_to: string | null; created_at: string; updated_at: string;
}

type AdmissionRow = { id: string; session_id: string; actor_id: string; mode: string; access: string | null; request_id: string; expires_at: number };

/** Where a run's message sits in a chain of cross-session messages: none (0 hops) for one a person sent. */
interface Chain { hops: number; sessions: string[] }

const busyActivities = ['working', 'waiting'];

export function messageRecord(row: MessageRow): CrossSessionMessage {
  return {
    id: row.id, kind: row.kind, originSessionId: row.origin_session_id, targetSessionId: row.target_session_id, actorId: row.actor_id,
    submissionId: row.submission_id, conversationId: row.conversation_id, hops: Number(row.hops), ...(row.access ? { access: row.access } : {}),
    ...(row.notify_status ? { notify: row.notify_status } : {}), ...(row.notify_error ? { notifyError: row.notify_error } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}), createdAt: row.created_at,
  };
}

function summary(access: SessionAccess, selfId?: string): CrossSessionSummary {
  const { row } = access;
  return {
    id: row.id, title: row.title, ownerId: row.owner_id, status: row.status, ...(row.activity ? { activity: row.activity } : {}),
    visibility: row.visibility ?? 'private', permissions: access.permissions, ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.id === selfId ? { self: true as const } : {}), createdAt: row.created_at,
  };
}

/** Runs `work` as `actorId`, with a request context of their own, so every check is the one their own request gets. */
function asActor<T>(env: Env, actorId: string, work: (c: AppContext) => Promise<T>): Promise<T> {
  return asSessionOwner(env, { owner_id: actorId }, work, 'cross-session');
}

/** The chain the run's message is in, from its admission's request: delivered messages are sent as `xs:<message id>`. */
async function messageChain(env: Env, admission: AdmissionRow): Promise<Chain> {
  const match = /^xs:([A-Za-z0-9_-]{1,120})$/.exec(admission.request_id);
  if (!match) return { hops: 0, sessions: [] };
  const row = await env.DB.query<{ hops: number; chain_json: string; target_session_id: string }>(
    'SELECT hops, chain_json, target_session_id FROM session_messages WHERE id = ?').bind(match[1]).first();
  // Someone may have typed such a request id: it only ever counts as further down a chain, never less far.
  if (!row || row.target_session_id !== admission.session_id) return { hops: crossSessionLimits.maxHops, sessions: [] };
  const sessions = JSON.parse(row.chain_json) as unknown;
  return { hops: Number(row.hops), sessions: Array.isArray(sessions) ? sessions.filter((value): value is string => typeof value === 'string') : [] };
}

/** A session, or one about to be started, whose readers are known. */
type Party = { id: string } | { id: null; readers: Set<string> };

/**
 * Whether content may pass between `self` and `other` without the owner's consent: `in` brings `other`'s content into
 * `self`, so everyone who reads `self` must read `other`; `out` takes `self`'s to `other`, so the reverse. A session
 * anyone can open with its link is read by everyone.
 */
async function audienceCovered(env: Env, self: Party, other: Party, direction: 'in' | 'out'): Promise<boolean> {
  const [source, destination] = direction === 'in' ? [other, self] : [self, other];
  if (source.id !== null && source.id === destination.id) return true;
  if (source.id !== null && await isLinkShared(env, source.id)) return true;
  if (destination.id !== null && await isLinkShared(env, destination.id)) return false;
  const readers = (party: Party) => party.id === null ? Promise.resolve(party.readers) : sessionReaders(env, party.id);
  const [allowed, reading] = await Promise.all([readers(source), readers(destination)]);
  for (const reader of reading) if (!allowed.has(reader)) return false;
  return true;
}

const inputFields = ['sessionId', 'actorId', 'admissionId', 'callId', 'action', 'targetSessionId', 'message', 'access', 'notify', 'title', 'modelId', 'visibility', 'messageId', 'limit'];
/** Which actions take which fields, beyond the call's own. */
const actionFields: Record<SessionsBrokerAction, readonly string[]> = {
  list: [], read: ['targetSessionId', 'messageId', 'limit'], ask: ['targetSessionId', 'message', 'notify'], send: ['targetSessionId', 'message', 'access', 'notify'],
  create: ['message', 'access', 'notify', 'title', 'modelId', 'visibility'], stop: ['targetSessionId'], archive: ['targetSessionId'],
};

interface Call {
  c: AppContext; origin: SessionRow; actorId: string; admission: AdmissionRow; callId: string; chain: Chain; target: string;
}

/**
 * The sessions tool, for a tool call of a write message sent within the last hour (see the top of this file). The
 * runner asks the session owner for the tool, and for Read-only messages' changes, as for any tool; the control plane
 * checks both again, and the audience rule itself, answering `{ consent: 'audience' }` when the owner must allow it.
 */
export async function agentSessions(c: AppContext, connectorId: string | null): Promise<Response> {
  const input = await jsonObject(c, 256 * 1024);
  if (Object.keys(input).some(key => !inputFields.includes(key))) fail(400, 'invalid_input', 'Unexpected sessions tool field.');
  const sessionId = identifier(input.sessionId, 'sessionId');
  const actorId = userIdentifier(input.actorId, 'actorId');
  const admissionId = text(input.admissionId, 'admissionId', 128);
  const callId = identifier(input.callId, 'callId');
  if (!sessionsBrokerActions.includes(input.action as SessionsBrokerAction)) fail(400, 'invalid_input', `Action is ${sessionsBrokerActions.join(', ')}.`);
  const action = input.action as SessionsBrokerAction;
  const extra = Object.keys(input).filter(key => !['sessionId', 'actorId', 'admissionId', 'callId', 'action'].includes(key));
  const unexpected = extra.find(key => !actionFields[action].includes(key));
  if (unexpected) fail(400, 'invalid_input', `A ${action} takes no ${unexpected}.`);
  const targetSessionId = input.targetSessionId === undefined ? undefined : identifier(input.targetSessionId, 'targetSessionId');
  if (['read', 'ask', 'send', 'stop', 'archive'].includes(action) && targetSessionId === undefined) fail(400, 'invalid_input', `A ${action} names the other session.`);
  // Room for the line naming its origin within a message's limit.
  const message = input.message === undefined ? undefined : text(input.message, 'message', 50_000);
  if ((action === 'ask' || action === 'send') && message === undefined) fail(400, 'invalid_input', `A ${action} carries a message.`);
  if (message !== undefined && !message.trim()) fail(400, 'invalid_input', 'The message is empty.');
  if (input.access !== undefined && !accessModes.includes(input.access as AccessMode)) fail(400, 'invalid_input', 'Access is read, approval or auto.');
  const access = input.access as AccessMode | undefined;
  if (input.notify !== undefined && typeof input.notify !== 'boolean') fail(400, 'invalid_input', 'Notify is true or false.');
  const notify = input.notify === true;
  if (notify && message === undefined) fail(400, 'invalid_input', 'Only a message is notified about.');
  if (access !== undefined && message === undefined) fail(400, 'invalid_input', 'Access is a message\'s.');
  const title = input.title === undefined ? undefined : text(input.title, 'title', 200).trim();
  if (title !== undefined && (!title || /[\r\n]/.test(title))) fail(400, 'invalid_input', 'The title is one non-empty line.');
  const modelId = input.modelId === undefined ? undefined : identifier(input.modelId, 'modelId');
  if (input.visibility !== undefined && input.visibility !== 'private' && input.visibility !== 'workspace') fail(400, 'invalid_input', 'Visibility is private or workspace.');
  const visibility = input.visibility as 'private' | 'workspace' | undefined;
  const messageId = input.messageId === undefined ? undefined : identifier(input.messageId, 'messageId');
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > crossSessionLimits.readEntries)) {
    fail(400, 'invalid_input', `The limit is 1 to ${crossSessionLimits.readEntries}.`);
  }
  const limit = (input.limit as number | undefined) ?? crossSessionLimits.defaultEntries;
  // What the permission card showed the owner, built from the call's own fields, as the runner does.
  const target = sessionsToolTarget({ action, targetSessionId, message, access, notify, title, modelId, visibility, messageId });

  const originAccess = await sessionAccess(c.env, sessionId, actorId);
  if (!originAccess || originAccess.row.status === 'archived' || !hasPermission(originAccess.permissions, 'write')) {
    fail(403, 'permission_revoked', 'The requester can no longer write to this session.');
  }
  const origin = originAccess.row;
  await requireCallbackScope(c, origin, connectorId);
  const admission = await c.env.DB.query<AdmissionRow>('SELECT id, session_id, actor_id, mode, access, request_id, expires_at FROM run_admissions WHERE id = ?')
    .bind(admissionId).first();
  if (!admission || admission.session_id !== sessionId || admission.actor_id !== actorId || admission.mode !== 'write'
    || admission.expires_at <= Math.floor(Date.now() / 1000)) {
    fail(403, 'sessions_not_admitted', 'The sessions tool needs a write message sent within the last hour.');
  }
  await requireToolCall(c.env, origin, 'sessions', { id: callId, requestedBy: actorId, admission, target });
  // A Read-only message changes no other session unless the owner allowed it, for this call or the session.
  if (sessionsWriteActions.includes(action) && admission.access === 'read'
    && !await sessionsNeedGranted(c.env, origin, 'write', { id: callId, requestedBy: actorId, admission, target })) {
    fail(403, 'write_not_allowed', 'This Read-only message changes no other session unless the session owner allows it.');
  }
  // Auto-approve passes on only from the owner's own Auto-approve message (and only to a session they own, see deliver).
  if (access === 'auto' && (admission.access !== 'auto' || actorId !== origin.owner_id)) {
    fail(403, 'automatic_message_not_admitted', 'Only a message the session owner sent with Auto-approve sends an auto-approved message. Use access approval.');
  }
  const call: Call = { c, origin, actorId, admission, callId, chain: await messageChain(c.env, admission), target };

  if (action === 'list') return c.json(await list(call));
  if (action === 'read') return c.json(await read(call, targetSessionId!, messageId, limit));
  if (action === 'ask' || action === 'send') {
    const other = await requireOther(call, targetSessionId!, action === 'ask' ? 'ask' : 'write');
    const consent = await audienceConsent(call, other, notify ? ['out', 'in'] : ['out']);
    if (consent) return c.json(consent);
    return c.json({ message: await deliver(call, other, action, message!, access, notify) } satisfies SessionsToolResult, 202);
  }
  if (action === 'create') return createChild(call, { message, access, notify, title, modelId, visibility });
  const other = await requireOther(call, targetSessionId!, action === 'stop' ? 'write' : 'manage');
  const audit = { crossSession: true, originSessionId: origin.id, callId };
  if (action === 'stop') {
    const stopped = await asActor(c.env, actorId, async inner => stopSession(inner, (await requireSession(inner, other.id, 'write')).row, audit));
    await auditStatement(c.env, actorId, 'session.cross_session.stopped', origin.workspace_id, origin.id, { targetSessionId: other.id, stopped, callId }).run();
    return c.json({ stopped } satisfies SessionsToolResult);
  }
  await asActor(c.env, actorId, inner => archiveSession(inner, other.id, audit));
  await auditStatement(c.env, actorId, 'session.cross_session.archived', origin.workspace_id, origin.id, { targetSessionId: other.id, callId }).run();
  return c.json({ archived: other.id } satisfies SessionsToolResult);
}

/** Another session of the origin's workspace the actor holds `permission` on; never the calling session itself. */
async function requireOther(call: Call, sessionId: string, permission: 'read' | 'ask' | 'write' | 'manage'): Promise<SessionRow> {
  if (sessionId === call.origin.id) fail(409, 'same_session', 'That is this session itself.');
  const access = await sessionAccess(call.c.env, sessionId, call.actorId);
  // Sessions of other workspaces, and those the actor can't see, are not found, as for a request of their own.
  if (!access || access.row.workspace_id !== call.origin.workspace_id) fail(404, 'not_found', 'Session not found.');
  if (!hasPermission(access.permissions, permission)) fail(403, 'forbidden', `Session ${permission} permission is required there.`);
  return access.row;
}

/**
 * The owner's consent this exchange with `other` still needs, or none: when its readers aren't the same people as the
 * origin's in a direction content would pass, a permission the owner allowed for this session or call (see the top).
 */
async function audienceConsent(call: Call, other: (SessionRow & Party) | { id: null; title: string; readers: Set<string> }, directions: ('in' | 'out')[]): Promise<SessionsToolResult | undefined> {
  const covered = (await Promise.all(directions.map(direction => audienceCovered(call.c.env, call.origin, other, direction)))).every(Boolean);
  if (covered) return undefined;
  const shown = audienceTarget({ id: other.id ?? 'new', title: other.title });
  if (await sessionsNeedGranted(call.c.env, call.origin, 'audience', { id: call.callId, requestedBy: call.actorId, admission: call.admission, target: shown })) return undefined;
  const reason = directions.includes('in') && directions.includes('out') ? 'Messages and replies would pass between this session and one whose readers aren\'t the same people.'
    : directions.includes('in') ? 'This session\'s readers include people who can\'t read that session.' : 'That session\'s readers include people who can\'t read this one.';
  return { consent: 'audience', target: shown, reason };
}

async function list(call: Call): Promise<SessionsToolResult> {
  const { c, origin, actorId } = call;
  const sessions = (await workspaceSessionAccess(c.env, origin.workspace_id, actorId)).slice(0, 200).map(access => summary(access, origin.id));
  const models = (await usableModels(c.env, origin.workspace_id, actorId)).map(model => ({ id: model.id, name: model.name, provider: model.provider, modelId: model.model_id }));
  return { sessions, models };
}

async function read(call: Call, targetId: string, messageId: string | undefined, limit: number): Promise<SessionsToolResult> {
  const { c, origin, actorId } = call;
  const other = await requireOther(call, targetId, 'read');
  const consent = await audienceConsent(call, other, ['in']);
  if (consent) return consent;
  const message = messageId === undefined ? undefined : await c.env.DB.query<MessageRow>(
    'SELECT * FROM session_messages WHERE id = ? AND origin_session_id = ? AND target_session_id = ?').bind(messageId, origin.id, other.id).first();
  if (messageId !== undefined && !message) fail(404, 'not_found', 'This session sent that session no such message.');
  const view = await asActor(c.env, actorId, async inner => (await sessionView(inner, other, { display: await transcriptDisplay(inner, other) })).view);
  // Never answer with what was read after access was revoked.
  const fresh = await sessionAccess(c.env, other.id, actorId);
  if (!fresh || !hasPermission(fresh.permissions, 'read')) fail(403, 'permission_revoked', 'Session access is no longer authorized.');
  const shared = new Set(view.conversations.filter(conversation => conversation.mode === 'write').map(conversation => conversation.id));
  const entries = view.entries.filter(entry => entry.conversationId === undefined || shared.has(entry.conversationId)).slice(-limit)
    .map(entry => ({ id: entry.id, role: entry.role, kind: entry.kind, ...(entry.actorId ? { actorId: entry.actorId } : {}), text: cut(entry.text, crossSessionLimits.entryChars) }));
  const pendingApprovals = view.approvals.filter(approval => approval.status === 'pending').map(approval => ({ id: approval.id, kind: approval.operation.kind,
    ...(approval.operation.kind === 'permission' ? { tool: approval.operation.tool } : {}), requestedBy: approval.requestedBy }));
  const record = message ? messageRecord(message) : undefined;
  return { session: summary(fresh), busy: view.busy, entries, pendingApprovals, ...(record ? { message: record, outcome: messageOutcome(view, record) } : {}) };
}

/** Refuses a message one more hop down the chain can't send, or one back to a session it came through, or one too many. */
async function requireSendable(call: Call, targetId: string | null): Promise<void> {
  if (call.chain.hops >= crossSessionLimits.maxHops) {
    fail(403, 'hop_limit', `This message came through ${call.chain.hops} sessions already, so it sends nothing further. Reply in this session, or ask a person to continue.`);
  }
  if (targetId !== null && (targetId === call.origin.id || call.chain.sessions.includes(targetId))) {
    fail(409, 'session_loop', 'This message came from that session, directly or through others: answer it with a notification or a read instead.');
  }
  const sent = await call.c.env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_messages WHERE origin_admission_id = ?').bind(call.admission.id).first();
  if (Number(sent?.n ?? 0) >= crossSessionLimits.perMessage) {
    fail(429, 'cross_session_limit', `One message sends at most ${crossSessionLimits.perMessage} messages to other sessions.`);
  }
}

/** Sends `message` to `target` as the actor, opened by the line naming its origin (crossSessionHeader), and records it. */
async function deliver(call: Call, target: SessionRow, kind: 'ask' | 'send' | 'create', message: string, access: AccessMode | undefined, notify: boolean): Promise<CrossSessionMessage> {
  const { c, origin, actorId, admission, callId, chain } = call;
  await requireSendable(call, target.id);
  // Auto-approve is the owner's alone, there as here.
  if (access === 'auto' && target.owner_id !== actorId) fail(403, 'owner_required', 'Only the owner of that session sends it an auto-approved message.');
  const messageId = id();
  const hops = chain.hops + 1;
  const actor = await getUser(c.env, actorId);
  const content = `${crossSessionHeader({ id: messageId, kind, hops }, origin, { id: actorId, login: actor?.github_login })}\n\n${message}`;
  const result = await asActor(c.env, actorId, async inner => {
    const { row } = await requireSession(inner, target.id, kind === 'ask' ? 'ask' : 'write');
    // Like a scheduled prompt's, a shared message waits for nobody: a session at work or waiting on a card is busy.
    if (kind !== 'ask' && busyActivities.includes(row.activity ?? '')) {
      fail(409, 'session_busy', 'That session is working or waiting on an approval. Read it, or try again once it is done.');
    }
    return submitMessage(inner, row, kind === 'ask' ? 'ask' : 'submit', {
      content, requestId: `xs:${messageId}`, ...(access && access !== 'approval' ? { options: { access } } : {}),
    }, { crossSession: messageId, originSessionId: origin.id });
  });
  const at = now();
  const row: MessageRow = { id: messageId, workspace_id: origin.workspace_id, origin_session_id: origin.id, target_session_id: target.id, actor_id: actorId, kind,
    origin_admission_id: admission.id, origin_call_id: callId, submission_id: result.submissionId, conversation_id: result.conversationId, hops,
    chain_json: JSON.stringify([...chain.sessions, origin.id]), access: kind === 'ask' ? null : access ?? 'approval', notify_status: notify ? 'pending' : null,
    notify_error: null, notify_message_id: null, reply_to: null, created_at: at, updated_at: at };
  await c.env.DB.batch([
    c.env.DB.query(`INSERT INTO session_messages (id, workspace_id, origin_session_id, target_session_id, actor_id, kind, origin_admission_id, origin_call_id,
      submission_id, conversation_id, hops, chain_json, access, notify_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(row.id, row.workspace_id, row.origin_session_id, row.target_session_id, row.actor_id, row.kind, row.origin_admission_id, row.origin_call_id,
        row.submission_id, row.conversation_id, row.hops, row.chain_json, row.access, row.notify_status, row.created_at, row.updated_at),
    auditStatement(c.env, actorId, 'session.cross_session.sent', origin.workspace_id, origin.id, { messageId, kind, targetSessionId: target.id, hops, callId,
      ...(notify ? { notify: true } : {}) }),
  ]);
  return messageRecord(row);
}

async function createChild(call: Call, options: { message?: string; access?: AccessMode; notify: boolean; title?: string; modelId?: string; visibility?: 'private' | 'workspace' }): Promise<Response> {
  const { c, origin, actorId } = call;
  await requireSessionCreator(c.env, origin.workspace_id, actorId);
  const children = await c.env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = ?').bind(origin.id).first();
  if (Number(children?.n ?? 0) >= crossSessionLimits.children) fail(429, 'cross_session_limit', `A session starts at most ${crossSessionLimits.children} sessions.`);
  if (options.message !== undefined) await requireSendable(call, null);
  if (options.access === 'auto' && actorId !== origin.owner_id) fail(403, 'owner_required', 'Only the session owner sends an auto-approved message.');
  // A child is never shown to more people than its parent: its opening message comes from the parent's work.
  const parentVisibility = origin.visibility ?? 'private';
  const visibility = options.visibility ?? parentVisibility;
  if (visibility === 'workspace' && parentVisibility === 'private') fail(403, 'visibility_wider', 'A private session starts only private sessions.');
  const modelId = options.modelId ?? (await c.env.DB.query<{ model_id: string }>('SELECT model_id FROM agent_versions WHERE id = ?').bind(origin.agent_version_id).first())?.model_id;
  if (!modelId) fail(409, 'invalid_binding', 'This session\'s model is unavailable; name a model that list returns.');
  const model = await c.env.DB.query<{ connector_id: string | null; connector_owner_id: string | null }>('SELECT connector_id, connector_owner_id FROM models WHERE id = ? AND workspace_id = ?')
    .bind(modelId, origin.workspace_id).first();
  if (!model) fail(404, 'not_found', 'Model not found.');
  // The new session runs as the actor, with their Git accounts, on the model's host: one they own, or this session's
  // own host when it is theirs to trust (they started this session there). Any other host they acknowledge themselves.
  const trusted = model.connector_id && (model.connector_owner_id === actorId || (model.connector_id === origin.connector_id && actorId === origin.owner_id));
  if (model.connector_id && !trusted) {
    fail(403, 'connector_trust_required', 'A session started by the agent runs on your own host or on this session\'s host. Start one on another member\'s host yourself.');
  }
  if (options.message !== undefined && options.notify) {
    // Its outcome comes back here: everyone who reads this session must be able to read the new one, which only its
    // owner reads, or, shared with the workspace, every member does.
    const readers = visibility === 'private' ? new Set([actorId]) : new Set((await c.env.DB.query<{ user_id: string }>(`SELECT member.user_id FROM workspace_members member
      JOIN users u ON u.id = member.user_id WHERE member.workspace_id = ? AND u.suspended_at IS NULL`).bind(origin.workspace_id).all()).map(row => row.user_id));
    const consent = await audienceConsent(call, { id: null, title: options.title ?? 'new session', readers }, ['in']);
    if (consent) return c.json(consent);
  }
  const title = options.title ?? cut(`${origin.title} · sub-task`, 190).split('\n')[0]!;
  const { row } = await asActor(c.env, actorId, inner => createSession(inner, { workspaceId: origin.workspace_id, title, visibility, modelId,
    ...(model.connector_id ? { trustedConnectorId: model.connector_id } : {}) }, { parentSessionId: origin.id }));
  await auditStatement(c.env, actorId, 'session.cross_session.created', origin.workspace_id, origin.id, { childSessionId: row.id, callId: call.callId }).run();
  const created = await sessionAccess(c.env, row.id, actorId);
  if (!created) fail(409, 'policy_changed', 'The new session is no longer available.');
  const message = options.message === undefined ? undefined : await deliver(call, created.row, 'create', options.message, options.access, options.notify);
  return c.json({ session: summary(created), ...(message ? { message } : {}) } satisfies SessionsToolResult, 201);
}

/** What one pending notification did, for tests and logs. */
export type NotificationOutcome = { messageId: string; delivered: string } | { messageId: string; waiting: string } | { messageId: string; failed: string };

/** Errors a later sweep may get past: the host or runner away, or the origin busy. */
const transient = new Set(['connector_unavailable', 'connector_relay_error', 'runner_unavailable', 'runner_error', 'session_busy', 'admission_unavailable', 'restore_pending',
  'migration_pending', 'internal_error']);

/**
 * Sends each pending notification whose message its target finished, back to its origin as the same person, while the
 * origin is idle; see the top of this file. A notification left pending for `crossSessionLimits.notifyHours` expires.
 * Safe to call at any time.
 */
export async function runCrossSessionNotifications(env: Env, at = Date.now()): Promise<NotificationOutcome[]> {
  const pending = await env.DB.query<MessageRow>("SELECT * FROM session_messages WHERE notify_status = 'pending' ORDER BY updated_at, id LIMIT 20").all();
  const outcomes: NotificationOutcome[] = [];
  for (const message of pending) {
    const settle = (status: 'delivered' | 'failed' | 'expired', detail: { error?: string; notifyId?: string } = {}) => env.DB.query(
      "UPDATE session_messages SET notify_status = ?, notify_error = ?, notify_message_id = ?, updated_at = ? WHERE id = ? AND notify_status = 'pending'")
      .bind(status, detail.error ?? null, detail.notifyId ?? null, new Date(at).toISOString(), message.id).run();
    if (at - Date.parse(message.created_at) > crossSessionLimits.notifyHours * 3600_000) {
      await settle('expired');
      outcomes.push({ messageId: message.id, failed: 'expired' });
      continue;
    }
    try {
      const result = await notify(env, message);
      if ('waiting' in result) {
        // Read again after the others, not first in the next sweep.
        await env.DB.query('UPDATE session_messages SET updated_at = ? WHERE id = ?').bind(new Date(at).toISOString(), message.id).run();
        outcomes.push({ messageId: message.id, waiting: result.waiting });
        continue;
      }
      await settle('delivered', { notifyId: result.delivered });
      outcomes.push({ messageId: message.id, delivered: result.delivered });
    } catch (error) {
      const code = await errorCode(error);
      if (transient.has(code)) {
        await env.DB.query('UPDATE session_messages SET updated_at = ? WHERE id = ?').bind(new Date(at).toISOString(), message.id).run();
        outcomes.push({ messageId: message.id, waiting: code });
        continue;
      }
      await settle('failed', { error: code });
      outcomes.push({ messageId: message.id, failed: code });
    }
  }
  return outcomes;
}

async function notify(env: Env, message: MessageRow): Promise<{ delivered: string } | { waiting: string }> {
  const record = messageRecord(message);
  return asActor(env, message.actor_id, async c => {
    const { row: target } = await requireSession(c, message.target_session_id, 'read');
    const outcome: CrossSessionOutcome = messageOutcome((await sessionView(c, target, { display: await transcriptDisplay(c, target) })).view as SessionView, record);
    if (!outcome.done) return { waiting: outcome.waiting ? 'target_waiting' : 'target_working' };
    const { row: origin } = await requireSession(c, message.origin_session_id, 'write');
    if (busyActivities.includes(origin.activity ?? '')) return { waiting: 'session_busy' };
    // The audience may have changed since the message was sent; then only the owner's consent for that call still covers it.
    if (!await audienceCovered(env, origin, target, 'in')) {
      const granted = await env.DB.query("SELECT 1 FROM session_tool_grants WHERE session_id = ? AND tool = 'sessions:audience' AND (call_id = '' OR call_id = ?)")
        .bind(origin.id, message.origin_call_id ?? '').first();
      if (!granted) fail(403, 'audience_changed', 'The two sessions\' readers changed since the message was sent.');
    }
    // One notification per message, however many sweeps try: its id, and so its request id, comes from the message's.
    const notifyId = `${message.id}-n`;
    const actor = await getUser(env, message.actor_id);
    const header = crossSessionHeader({ id: notifyId, kind: 'notify', hops: Number(message.hops) + 1 }, target, { id: message.actor_id, login: actor?.github_login }, { id: message.id });
    const body = `Its ${message.kind === 'ask' ? 'side ask' : 'message'} ended: ${outcome.status}${outcome.failed ? ' (its model request failed)' : ''}.`
      + (outcome.reply ? `\n\nIts reply:\n\n${outcome.reply}` : '\n\nIt left no reply.');
    const submitted = await submitMessage(c, origin, 'submit', { content: `${header}\n\n${body}`, requestId: `xs:${notifyId}` }, { crossSessionNotification: message.id });
    const at = now();
    await env.DB.query(`INSERT INTO session_messages (id, workspace_id, origin_session_id, target_session_id, actor_id, kind, submission_id, conversation_id, hops,
      chain_json, reply_to, created_at, updated_at) VALUES (?,?,?,?,?,'notify',?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`)
      .bind(notifyId, message.workspace_id, target.id, origin.id, message.actor_id, submitted.submissionId, submitted.conversationId, Number(message.hops) + 1,
        message.chain_json, message.id, at, at).run();
    return { delivered: notifyId };
  });
}

export function registerCrossSession(app: Hono<WorkerEnv>): void {
  // Only what the viewer can read themselves: a linked session they can't open isn't named.
  app.get('/api/sessions/:id/connections', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const viewer = c.get('auth').userId;
    const readable = new Map<string, SessionAccess | null>();
    const open = async (sessionId: string) => {
      if (!readable.has(sessionId)) readable.set(sessionId, await sessionAccess(c.env, sessionId, viewer));
      return readable.get(sessionId) ?? null;
    };
    const parent = row.parent_session_id ? await open(row.parent_session_id) : null;
    const childIds = await c.env.DB.query<{ id: string }>('SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').bind(row.id).all();
    const children: CrossSessionSummary[] = [];
    for (const child of childIds) {
      const access = await open(child.id);
      if (access) children.push(summary(access));
    }
    const rows = await c.env.DB.query<MessageRow>(`SELECT * FROM session_messages WHERE origin_session_id = ? OR target_session_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 50`).bind(row.id, row.id).all();
    const messages: SessionConnections['messages'] = [];
    for (const message of rows) {
      const other = await open(message.origin_session_id === row.id ? message.target_session_id : message.origin_session_id);
      if (other) messages.push({ ...messageRecord(message), otherTitle: other.row.title });
    }
    return c.json({ ...(parent ? { parent: summary(parent) } : {}), children, messages } satisfies SessionConnections);
  });
}
