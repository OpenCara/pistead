import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { runCrossSessionNotifications } from '../apps/server/src/cross-session.js';
import {
  audienceTarget, crossSessionHeader, crossSessionLimits, messageOutcome, sessionsToolTarget, type CrossSessionMessage, type CrossSessionSummary, type SessionConnections,
} from '../packages/shared/src/cross-session.js';
import type { EntryView, SessionRecord, SessionView } from '../packages/shared/src/types.js';
import { nestSessions } from '../packages/client/src/session-tree.js';
import { seedAgentVersion, testDatabase } from './helpers/control-plane.js';

test('a delivered message names its origin and sender, and its outcome is the answer after it in its own conversation', () => {
  const header = crossSessionHeader({ id: 'm1', kind: 'send', hops: 2 }, { id: 'origin', title: 'Fix [auth]\nnow' }, { id: 'github:1', login: 'alice' });
  assert.equal(header, '[Pistead cross-session message xs:m1 · from session "Fix auth now" (origin) · sent by @alice through its agent · hop 2]');
  assert.match(crossSessionHeader({ id: 'm1-n', kind: 'notify', hops: 3 }, { id: 'target', title: 'Worker' }, { id: 'test:bob' }, { id: 'm1' }),
    /^\[Pistead notification xs:m1-n · session "Worker" \(target\) finished message xs:m1 · for test:bob · hop 3\]$/);
  const entry = (id: string, role: string, text: string, conversationId = '0', extra: Partial<EntryView> = {}): EntryView => ({ id, kind: 'message', role, text, conversationId, ...extra });
  const view = {
    entries: [entry('0:1', 'user', 'earlier'), entry('0:2', 'assistant', 'earlier answer'), entry('0:3', 'user', `${header}\n\nDo it`),
      entry('0:4', 'assistant', 'read_file({"path":"a"})'), entry('0:5', 'toolResult', 'contents'), entry('0:6', 'assistant', 'Done: it works.'),
      entry('0:7', 'user', 'a later message'), entry('0:8', 'assistant', 'later answer'), entry('1:9', 'assistant', 'another conversation', '1')],
    queue: [{ submissionId: 'sub-1', actorId: 'github:1', mode: 'write' as const, status: 'running' }], approvals: [],
  };
  const message = { id: 'm1', submissionId: 'sub-1', conversationId: '0' };
  assert.deepEqual(messageOutcome(view, message), { status: 'running', done: false, reply: 'Done: it works.' });
  view.queue[0]!.status = 'settled';
  assert.deepEqual(messageOutcome(view, message), { status: 'settled', done: true, reply: 'Done: it works.' });
  // A message id that is the prefix of another's never matches it.
  assert.equal(messageOutcome(view, { ...message, id: 'm' }).reply, undefined);
  // An older runner lists no queue: the message is done once an answer is the last thing after it, and no card waits.
  const older = { entries: view.entries.slice(0, 6), approvals: [] as SessionView['approvals'] };
  assert.deepEqual(messageOutcome(older, message), { status: 'unknown', done: true, reply: 'Done: it works.' });
  assert.equal(messageOutcome({ ...older, entries: view.entries.slice(0, 5) }, message).done, false, 'a tool result last: still at work');
  assert.equal(messageOutcome({ ...older, approvals: [{ status: 'pending' } as SessionView['approvals'][number]] }, message).done, false);
  // What a permission card shows stays within what the host and the control plane both keep whole.
  const long = sessionsToolTarget({ action: 'send', targetSessionId: 'b', message: 'x'.repeat(100_000) });
  assert.ok(long.length < 8192 && long.startsWith('send · session b · message:\n'));
  assert.equal(sessionsToolTarget({ action: 'read', targetSessionId: 'b', messageId: 'm1' }), 'read · session b · message m1');
});

const origin = 'http://localhost:8787';
const testSecret = 'cross-session-test-secret-not-for-deployment';

type Fake = { view: SessionView; submitted: { mode: string; body: Record<string, unknown> }[]; stopped: number };

async function fixture(t: TestContext) {
  const { db, sqlite } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'cross-session-internal-secret-0123456789',
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'), RUNNER_URL: 'https://runner.example.test' };
  async function client(name: string) {
    const login = await app.request('/api/auth/test', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${testSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, displayName: name, gitName: name, gitEmail: `${name}@example.test` }) }, env);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const user = (await login.json() as { user: { id: string } }).user;
    const csrf = (await (await app.request('/api/auth/csrf', { headers: { Cookie: cookie } }, env)).json() as { csrfToken: string }).csrfToken;
    return { user, async request(method: string, path: string, body?: unknown) {
      return app.request(path, { method, headers: { Cookie: cookie, Origin: origin, 'x-csrf-token': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    } };
  }
  const owner = await client('xs-owner');
  const collaborator = await client('xs-collaborator');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'cross-session' })).json() as { workspace: { id: string } }).workspace;
  await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: collaborator.user.id, role: 'collaborator' });
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'faux', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  // Agents from before the sessions tool: they lack it.
  const agent = seedAgentVersion(sqlite, { authorId: owner.user.id, modelId: model.id, tools: ['identity'] });
  const seed = (id: string, title: string, visibility = 'private') => sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,?,?,?,'clone')")
    .run(id, workspace.id, owner.user.id, agent.id, title, 'ready', new Date().toISOString(), visibility);
  seed('session-a', 'Coordinator');
  seed('session-b', 'Worker');
  // The host of each session: a view per session, recording what it is sent.
  const fakes = new Map<string, Fake>();
  const fake = (id: string): Fake => {
    let entry = fakes.get(id);
    if (!entry) fakes.set(id, entry = { submitted: [], stopped: 0, view: { sessionId: id, owner: { id: owner.user.id, displayName: 'xs-owner', gitName: 'xs-owner', gitEmail: 'o@example.test', githubLogin: null },
      entries: [], approvals: [], conversations: [{ id: '0', mode: 'write' }], busy: false, queue: [] } });
    return entry;
  };
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let submissions = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/sessions') return Response.json({ ok: true }, { status: 201 });
    const match = /^\/v1\/sessions\/([^/]+)\/(view|submit|ask|stop)/.exec(path);
    if (!match) return Response.json({ error: 'offline' }, { status: 503 });
    const session = fake(match[1]!);
    if (match[2] === 'view') return Response.json({ view: session.view });
    if (match[2] === 'stop') { session.stopped++; return Response.json({ stopped: 1 }); }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    session.submitted.push({ mode: match[2]!, body });
    const submissionId = `sub-${++submissions}`;
    const conversationId = match[2] === 'ask' ? `ask-${submissions}` : '0';
    session.view.queue!.push({ submissionId, actorId: 'x', mode: match[2] === 'ask' ? 'ask' : 'write', status: 'queued' });
    session.view.entries.push({ id: `${conversationId}:${submissions}`, kind: 'message', role: 'user', text: String(body.content), conversationId });
    return Response.json({ submissionId, conversationId, status: 'queued' });
  };
  const admit = (sessionId: string, actorId: string, options: { access?: string; requestId?: string } = {}) => {
    // A delivered message's own admission, as the control plane issued it with the message.
    const issued = options.requestId && sqlite.prepare('SELECT id FROM run_admissions WHERE session_id = ? AND actor_id = ? AND request_id = ?').get(sessionId, actorId, options.requestId);
    if (issued) return String(issued.id);
    const admission = randomBytes(32).toString('base64url');
    sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,access,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(admission, sessionId, actorId, 'write', options.access ?? null, options.requestId ?? `request-${admission}`, 'h'.repeat(43), Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
    return admission;
  };
  let calls = 0;
  const tool = async (sessionId: string, actorId: string, admissionId: string, body: Record<string, unknown>, callId = `call-${++calls}`) => {
    const response = await app.request('/api/internal/sessions', { method: 'POST', headers: { Authorization: `Bearer ${env.RUNNER_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, actorId, admissionId, callId, ...body }) }, env);
    return { status: response.status, body: await response.json() as Record<string, unknown> & { code?: string } };
  };
  const allow = (sessionId: string, tool: string, callId = '', approvalId = `permission-${callId || 'any'}`) => sqlite.prepare('INSERT INTO session_tool_grants (session_id,tool,call_id,approval_id,granted_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(sessionId, tool, callId, approvalId, owner.user.id, new Date().toISOString());
  const refused = async (result: Promise<{ status: number; body: { code?: string } }>, status: number, code: string) => {
    const { status: actual, body } = await result;
    assert.equal(actual, status, JSON.stringify(body));
    assert.equal(body.code, code, JSON.stringify(body));
  };
  return { env, sqlite, owner, collaborator, workspace, model, agent, fake, admit, tool, allow, refused, seed };
}

/** Views are shared about a second apart (view-feed.ts): a test that changes one waits for the next. */
const nextView = () => delay(1000);

test('an agent lists and reads the sessions its sender can see, and a read never shows people what they can\'t open', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const write = f.admit('session-a', ownerId);
  // The agent lacks the tool and the owner hasn't allowed it.
  await f.refused(f.tool('session-a', ownerId, write, { action: 'list' }), 403, 'tool_not_allowed');
  f.allow('session-a', 'sessions');
  for (const [body, code] of [[{ action: 'read' }, 'invalid_input'], [{ action: 'list', targetSessionId: 'session-b' }, 'invalid_input'],
    [{ action: 'send', targetSessionId: 'session-b' }, 'invalid_input'], [{ action: 'jump' }, 'invalid_input'], [{ action: 'read', targetSessionId: 'session-b', limit: 51 }, 'invalid_input'],
    [{ action: 'ask', targetSessionId: 'session-b', message: 'hi', access: 'auto' }, 'invalid_input']] as const) {
    await f.refused(f.tool('session-a', ownerId, write, body), 400, code);
  }
  // Another person's admission, an expired one, or one of another session admit nothing.
  await f.refused(f.tool('session-a', ownerId, f.admit('session-b', ownerId), { action: 'list' }), 403, 'sessions_not_admitted');
  await f.refused(f.tool('session-a', f.collaborator.user.id, write, { action: 'list' }), 403, 'permission_revoked');

  const listed = await f.tool('session-a', ownerId, write, { action: 'list' });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const sessions = listed.body.sessions as CrossSessionSummary[];
  assert.deepEqual(sessions.map(session => [session.id, session.self ?? false]).sort(), [['session-a', true], ['session-b', false]]);
  assert.deepEqual((listed.body.models as { id: string }[]).map(model => model.id), [f.model.id]);

  // The collaborator can open the coordinator, not the worker: a read of the worker into the coordinator needs the owner's consent.
  assert.equal((await f.owner.request('POST', '/api/sessions/session-a/grants', { userId: f.collaborator.user.id, role: 'collaborator' })).status, 200);
  const worker = f.fake('session-b');
  worker.view.entries.push({ id: '0:1', kind: 'message', role: 'user', text: 'Build it', conversationId: '0', actorId: ownerId },
    { id: '0:2', kind: 'message', role: 'assistant', text: 'y'.repeat(5000), conversationId: '0' },
    { id: '7:3', kind: 'message', role: 'assistant', text: 'a side answer', conversationId: '7' });
  worker.view.conversations.push({ id: '7', mode: 'ask' });
  worker.view.approvals.push({ id: 'permission-1', sessionId: 'session-b', requestedBy: ownerId, createdAt: new Date().toISOString(), status: 'pending',
    operation: { kind: 'permission', tool: 'bash', target: 'make', needs: ['tool'] },
    admissionId: f.admit('session-b', ownerId) } as SessionView['approvals'][number]);
  const consent = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-1');
  assert.deepEqual(consent.body, { consent: 'audience', target: audienceTarget({ id: 'session-b', title: 'Worker' }), reason: 'This session\'s readers include people who can\'t read that session.' });
  // The owner allows it for that call: the host records the card, and the control plane its decision.
  f.sqlite.prepare("INSERT INTO approval_reviews (session_id,approval_id,requested_by,operation_json,source,admission_id,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('session-a', 'permission-read-1_audience', ownerId, JSON.stringify({ kind: 'permission', tool: 'sessions', target: audienceTarget({ id: 'session-b', title: 'Worker' }), needs: ['audience'] }),
      'model', write, 'r'.repeat(43), new Date().toISOString());
  f.allow('session-a', 'sessions:audience', 'read-1', 'permission-read-1_audience');
  const read = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-1');
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!('consent' in read.body), JSON.stringify(read.body));
  const entries = read.body.entries as EntryView[];
  assert.deepEqual(entries.map(entry => entry.id), ['0:1', '0:2'], 'the shared conversation only');
  assert.ok(entries[1]!.text.length < 2100 && entries[1]!.text.endsWith('3000 more characters'));
  assert.deepEqual(read.body.pendingApprovals, [{ id: 'permission-1', kind: 'permission', tool: 'bash', requestedBy: ownerId }]);
  // The grant covers that call only.
  assert.ok('consent' in (await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b' }, 'read-2')).body);
  // Without the collaborator, the same people read both: no consent is needed.
  assert.equal((await f.owner.request('DELETE', `/api/sessions/session-a/grants/${f.collaborator.user.id}`)).status, 200);
  assert.equal((await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b', limit: 1 })).status, 200);

  // People reach only what they can open themselves, and never this session as another.
  await f.refused(f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-a' }), 409, 'same_session');
  await f.refused(f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'missing' }), 404, 'not_found');
});

test('messages go out as their sender, named, recorded and bounded: access, busy sessions, hops, loops and the per-message limit', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  f.allow('session-b', 'sessions');
  const write = f.admit('session-a', ownerId);
  const worker = f.fake('session-b');

  const sent = await f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'Run the tests' }, 'send-1');
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const message = sent.body.message as CrossSessionMessage;
  assert.deepEqual([message.kind, message.originSessionId, message.targetSessionId, message.actorId, message.hops, message.access, message.notify],
    ['send', 'session-a', 'session-b', ownerId, 1, 'approval', undefined]);
  const delivered = worker.submitted.at(-1)!;
  assert.equal(delivered.mode, 'submit');
  assert.equal(delivered.body.requestId, `xs:${message.id}`);
  assert.equal(delivered.body.content, `[Pistead cross-session message xs:${message.id} · from session "Coordinator" (session-a) · sent by test:xs-owner through its agent · hop 1]\n\nRun the tests`);
  assert.equal(delivered.body.options, undefined, 'approval, the default, sends no options');
  const audits = f.sqlite.prepare("SELECT action, session_id, actor_id, detail_json FROM audit WHERE action IN ('session.submit', 'session.cross_session.sent') ORDER BY rowid").all();
  assert.deepEqual(audits.map(row => [row.action, row.session_id, row.actor_id]), [['session.submit', 'session-b', ownerId], ['session.cross_session.sent', 'session-a', ownerId]]);
  assert.equal((JSON.parse(String(audits[0]!.detail_json)) as { crossSession: string }).crossSession, message.id);

  // Its outcome, read back by its id.
  worker.view.entries.push({ id: '0:90', kind: 'message', role: 'assistant', text: 'All 12 tests pass.', conversationId: '0' });
  worker.view.queue!.find(item => item.submissionId === message.submissionId)!.status = 'settled';
  await nextView();
  const outcome = await f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b', messageId: message.id, limit: 1 });
  assert.deepEqual(outcome.body.outcome, { status: 'settled', done: true, reply: 'All 12 tests pass.' });
  await f.refused(f.tool('session-a', ownerId, write, { action: 'read', targetSessionId: 'session-b', messageId: 'unknown' }), 404, 'not_found');

  // A session at work or waiting on a card is busy; a side ask still goes, read-only.
  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'session-b'").run();
  await f.refused(f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'More' }), 409, 'session_busy');
  const asked = await f.tool('session-a', ownerId, write, { action: 'ask', targetSessionId: 'session-b', message: 'How far along?' });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(worker.submitted.at(-1)!.mode, 'ask');
  f.sqlite.prepare("UPDATE sessions SET activity = 'done' WHERE id = 'session-b'").run();

  // Auto-approve passes on only from the owner's Auto-approve message; this runner takes no options at all.
  await f.refused(f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'Go', access: 'auto' }), 403, 'automatic_message_not_admitted');
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId, { access: 'auto' }), { action: 'send', targetSessionId: 'session-b', message: 'Go', access: 'auto' }), 400, 'options_unsupported');
  // A Read-only message changes nothing elsewhere until the owner allows it; reads and asks need nothing more.
  const readOnly = f.admit('session-a', ownerId, { access: 'read' });
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'send', targetSessionId: 'session-b', message: 'Go' }), 403, 'write_not_allowed');
  await f.refused(f.tool('session-a', ownerId, readOnly, { action: 'stop', targetSessionId: 'session-b' }), 403, 'write_not_allowed');
  assert.equal((await f.tool('session-a', ownerId, readOnly, { action: 'ask', targetSessionId: 'session-b', message: 'Status?' })).status, 202);
  f.allow('session-a', 'sessions:write');
  assert.equal((await f.tool('session-a', ownerId, readOnly, { action: 'send', targetSessionId: 'session-b', message: 'Go' })).status, 202);

  // The worker's agent, working on that message, can't send it back the way it came: notifications and reads answer it.
  const inWorker = f.admit('session-b', ownerId, { requestId: `xs:${message.id}` });
  await f.refused(f.tool('session-b', ownerId, inWorker, { action: 'send', targetSessionId: 'session-a', message: 'Back to you' }), 409, 'session_loop');
  f.seed('session-c', 'Third');
  const onward = await f.tool('session-b', ownerId, inWorker, { action: 'send', targetSessionId: 'session-c', message: 'Pass it on' });
  assert.equal(onward.status, 202, JSON.stringify(onward.body));
  const second = onward.body.message as CrossSessionMessage;
  assert.equal(second.hops, 2);
  assert.match(String(f.fake('session-c').submitted.at(-1)!.body.content), /from session "Worker" \(session-b\) · sent by test:xs-owner through its agent · hop 2\]/);
  // Two sessions down, the third still can't loop back to either.
  f.allow('session-c', 'sessions');
  const inThird = f.admit('session-c', ownerId, { requestId: `xs:${second.id}` });
  for (const back of ['session-a', 'session-b']) await f.refused(f.tool('session-c', ownerId, inThird, { action: 'send', targetSessionId: back, message: 'loop' }), 409, 'session_loop');
  // At the last hop a run reads, but sends nothing further; a request id typed to look like one counts as that far.
  f.sqlite.prepare('UPDATE session_messages SET hops = ? WHERE id = ?').run(crossSessionLimits.maxHops, second.id);
  f.seed('session-d', 'Fourth');
  await f.refused(f.tool('session-c', ownerId, inThird, { action: 'send', targetSessionId: 'session-d', message: 'further' }), 403, 'hop_limit');
  await f.refused(f.tool('session-c', ownerId, inThird, { action: 'create', message: 'further' }), 403, 'hop_limit');
  assert.equal((await f.tool('session-c', ownerId, inThird, { action: 'read', targetSessionId: 'session-d' })).status, 200);
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId, { requestId: 'xs:made-up' }), { action: 'send', targetSessionId: 'session-d', message: 'x' }), 403, 'hop_limit');

  // One message sends at most so many, even when its calls come at once.
  const busy = f.admit('session-a', ownerId);
  const burst = await Promise.all(Array.from({ length: crossSessionLimits.perMessage + 3 }, (_, index) =>
    f.tool('session-a', ownerId, busy, { action: 'ask', targetSessionId: 'session-d', message: `q${index}` })));
  assert.equal(burst.filter(result => result.status === 202).length, crossSessionLimits.perMessage);
  assert.deepEqual([...new Set(burst.filter(result => result.status !== 202).map(result => result.body.code))], ['cross_session_limit']);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE origin_admission_id = ?").get(busy)!.n, crossSessionLimits.perMessage);
  // A refused send gives its place back.
  const refusedOnce = f.admit('session-a', ownerId);
  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'session-d'").run();
  await f.refused(f.tool('session-a', ownerId, refusedOnce, { action: 'send', targetSessionId: 'session-d', message: 'busy' }), 409, 'session_busy');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM session_messages WHERE origin_admission_id = ?").get(refusedOnce)!.n, 0);
  f.sqlite.prepare("UPDATE sessions SET activity = NULL WHERE id = 'session-d'").run();

  // A collaborator's message acts with the collaborator's own access: none to a private session of the owner's.
  assert.equal((await f.owner.request('POST', '/api/sessions/session-a/grants', { userId: f.collaborator.user.id, role: 'collaborator' })).status, 200);
  const theirs = f.admit('session-a', f.collaborator.user.id);
  await f.refused(f.tool('session-a', f.collaborator.user.id, theirs, { action: 'send', targetSessionId: 'session-b', message: 'hi' }), 404, 'not_found');
  // What it starts is the collaborator's own session, linked to this one.
  const started = await f.tool('session-a', f.collaborator.user.id, theirs, { action: 'create', title: 'Their sub-task' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual([(started.body.session as CrossSessionSummary).ownerId, (started.body.session as CrossSessionSummary).parentSessionId], [f.collaborator.user.id, 'session-a']);
});

test('an agent stops and archives sessions as its sender may, and starts linked sessions never wider than its own', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  const write = f.admit('session-a', ownerId);
  const stopped = await f.tool('session-a', ownerId, write, { action: 'stop', targetSessionId: 'session-b' });
  assert.deepEqual([stopped.status, stopped.body], [200, { stopped: 1 }]);
  assert.equal(f.fake('session-b').stopped, 1);

  // A Read-only message starts a session once the owner allowed that very call, its title shown as the agent sent it.
  const readOnly = f.admit('session-a', ownerId, { access: 'read' });
  const spaced = { action: 'create', title: '  Spaced title  ' } as const;
  f.sqlite.prepare("INSERT INTO approval_reviews (session_id,approval_id,requested_by,operation_json,source,admission_id,review_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('session-a', 'permission-create-1', ownerId, JSON.stringify({ kind: 'permission', tool: 'sessions', target: sessionsToolTarget(spaced), needs: ['write'] }),
      'model', readOnly, 'r'.repeat(43), new Date().toISOString());
  f.allow('session-a', 'sessions:write', 'create-1', 'permission-create-1');
  const spacedChild = await f.tool('session-a', ownerId, readOnly, spaced, 'create-1');
  assert.equal(spacedChild.status, 201, JSON.stringify(spacedChild.body));
  assert.equal((spacedChild.body.session as CrossSessionSummary).title, 'Spaced title');
  await f.refused(f.tool('session-a', ownerId, readOnly, spaced, 'create-2'), 403, 'write_not_allowed');

  // A private session starts only private ones.
  await f.refused(f.tool('session-a', ownerId, write, { action: 'create', title: 'Wide', visibility: 'workspace' }), 403, 'visibility_wider');
  const created = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Write the docs', message: 'Document the API', notify: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const child = created.body.session as CrossSessionSummary;
  const opening = created.body.message as CrossSessionMessage;
  assert.deepEqual([child.title, child.parentSessionId, child.visibility, child.ownerId, child.status], ['Write the docs', 'session-a', 'private', ownerId, 'ready']);
  assert.deepEqual([opening.kind, opening.targetSessionId, opening.notify], ['create', child.id, 'pending']);
  assert.match(String(f.fake(child.id).submitted[0]!.body.content), /^\[Pistead cross-session opening message xs:\S+ · from session "Coordinator"/);
  // Lists show the link both ways.
  const record = (await (await f.owner.request('GET', `/api/sessions/${child.id}`)).json() as { session: SessionRecord }).session;
  assert.equal(record.parentSessionId, 'session-a');
  const connections = await (await f.owner.request('GET', '/api/sessions/session-a/connections')).json() as SessionConnections;
  assert.deepEqual(connections.children.map(item => item.id).sort(), [child.id, (spacedChild.body.session as CrossSessionSummary).id].sort());
  assert.deepEqual(connections.messages.map(item => [item.id, item.otherTitle]), [[opening.id, 'Write the docs']]);
  const fromChild = await (await f.owner.request('GET', `/api/sessions/${child.id}/connections`)).json() as SessionConnections;
  assert.equal(fromChild.parent?.id, 'session-a');

  // Archiving takes ownership, and never this session itself.
  await f.refused(f.tool('session-a', ownerId, write, { action: 'archive', targetSessionId: 'session-a' }), 409, 'same_session');
  const archived = await f.tool('session-a', ownerId, write, { action: 'archive', targetSessionId: child.id });
  assert.deepEqual([archived.status, archived.body], [200, { archived: child.id }]);
  assert.equal(f.sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(child.id)!.status, 'archived');
  const actions = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'session.cross_session.%' ORDER BY rowid").all().map(row => row.action);
  assert.deepEqual(actions, ['session.cross_session.stopped', 'session.cross_session.created', 'session.cross_session.created', 'session.cross_session.sent', 'session.cross_session.archived']);

  // Its outcome would come back to people the new session isn't shown to: the owner decides first, and nothing starts.
  assert.equal((await f.owner.request('POST', '/api/sessions/session-a/grants', { userId: f.collaborator.user.id, role: 'viewer' })).status, 200);
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n;
  const consent = await f.tool('session-a', ownerId, write, { action: 'create', title: 'Secret', message: 'Look', notify: true });
  assert.equal(consent.body.consent, 'audience', JSON.stringify(consent.body));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, before);

  // A session starts only so many.
  f.sqlite.prepare("UPDATE sessions SET parent_session_id = 'session-a' WHERE id = 'session-b'").run();
  for (let index = 3; index < crossSessionLimits.children; index++) {
    f.seed(`filler-${index}`, 'filler');
    f.sqlite.prepare("UPDATE sessions SET parent_session_id = 'session-a' WHERE id = ?").run(`filler-${index}`);
  }
  await f.refused(f.tool('session-a', ownerId, f.admit('session-a', ownerId), { action: 'create' }), 429, 'cross_session_limit');
});

test('the workspace\'s owner and admins read every session there, so content passes between private sessions only they and the owner read without asking', async t => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  const memberId = 'test:xs-member'; const adminId = 'test:xs-admin';
  for (const [id, role] of [[memberId, 'member'], [adminId, 'admin']] as const) {
    f.sqlite.prepare("INSERT INTO users (id,display_name,git_name,git_email,env_json,auth_kind,created_at) VALUES (?,?,?,?,'{}','test',?)").run(id, id, id, `${id}@example.test`, now);
    f.sqlite.prepare('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run(f.workspace.id, id, role, now);
  }
  const own = (id: string, ownerId: string) => {
    f.sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility,repository_mode) VALUES (?,?,?,?,?,'ready',?,'private','clone')")
      .run(id, f.workspace.id, ownerId, f.agent.id, id, now);
    f.fake(id).view.owner = { id: ownerId, displayName: ownerId, gitName: ownerId, gitEmail: `${ownerId}@example.test`, githubLogin: null };
    f.allow(id, 'sessions');
  };
  own('member-private', memberId);
  own('admin-private', adminId);

  // The admin's agent lists and reads the member's private session: everyone who reads the admin's private session (its
  // owner, and the workspace's owner and admins) reads that one too.
  const adminWrite = f.admit('admin-private', adminId);
  const listed = await f.tool('admin-private', adminId, adminWrite, { action: 'list' });
  assert.deepEqual((listed.body.sessions as CrossSessionSummary[]).find(item => item.id === 'member-private')?.permissions, ['read', 'ask', 'write', 'manage']);
  const read = await f.tool('admin-private', adminId, adminWrite, { action: 'read', targetSessionId: 'member-private' });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!('consent' in read.body), JSON.stringify(read.body));
  // Sending it the admin's session's content would show it to the member, who can't open the admin's: the admin's owner decides first.
  const sent = await f.tool('admin-private', adminId, adminWrite, { action: 'send', targetSessionId: 'member-private', message: 'Look at this' });
  assert.equal(sent.body.consent, 'audience', JSON.stringify(sent.body));
  assert.deepEqual(f.fake('member-private').submitted, []);
  // Once allowed, it goes as the admin's own message, which they may send to every session there, private ones included.
  f.allow('admin-private', 'sessions:audience');
  const delivered = await f.tool('admin-private', adminId, adminWrite, { action: 'send', targetSessionId: 'member-private', message: 'Look at this' });
  assert.equal(delivered.status, 202, JSON.stringify(delivered.body));
  assert.equal(f.fake('member-private').submitted.length, 1);
  assert.equal(f.sqlite.prepare("SELECT actor_id FROM run_admissions WHERE session_id = 'member-private' AND request_id LIKE 'xs:%'").get()!.actor_id, adminId);

  // The member's agent can't open the admin's session, and its own private sub-task is read by the same people as its
  // session, so its outcome comes back without asking.
  const memberWrite = f.admit('member-private', memberId);
  await f.refused(f.tool('member-private', memberId, memberWrite, { action: 'read', targetSessionId: 'admin-private' }), 404, 'not_found');
  const created = await f.tool('member-private', memberId, memberWrite, { action: 'create', title: 'Sub-task', message: 'Do it', notify: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const child = created.body.session as CrossSessionSummary;
  assert.deepEqual([child.visibility, child.ownerId, child.parentSessionId], ['private', memberId, 'member-private']);
});

test('a notification brings a finished message\'s outcome back to its origin, once, while the origin is idle', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  f.allow('session-a', 'sessions');
  const write = f.admit('session-a', ownerId);
  const sent = await f.tool('session-a', ownerId, write, { action: 'send', targetSessionId: 'session-b', message: 'Fix the flaky test', notify: true });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const message = sent.body.message as CrossSessionMessage;
  assert.equal(message.notify, 'pending');
  const coordinator = f.fake('session-a');
  const worker = f.fake('session-b');

  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, waiting: 'target_working' }]);
  assert.equal(coordinator.submitted.length, 0);
  worker.view.entries.push({ id: '0:50', kind: 'message', role: 'assistant', text: 'Fixed: the test waited on a timer.', conversationId: '0' });
  worker.view.queue![0]!.status = 'settled';
  await nextView();
  // The coordinator is at work: the notification waits for it.
  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'session-a'").run();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, waiting: 'session_busy' }]);
  f.sqlite.prepare("UPDATE sessions SET activity = 'done' WHERE id = 'session-a'").run();
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: message.id, delivered: `${message.id}-n` }]);
  assert.equal(coordinator.submitted.length, 1);
  assert.equal(coordinator.submitted[0]!.body.requestId, `xs:${message.id}-n`);
  assert.equal(coordinator.submitted[0]!.body.content, `[Pistead notification xs:${message.id}-n · session "Worker" (session-b) finished message xs:${message.id} · for test:xs-owner · hop 2]`
    + '\n\nIts message ended: settled.\n\nIts reply:\n\nFixed: the test waited on a timer.');
  assert.deepEqual(await runCrossSessionNotifications(f.env), [], 'once');
  const row = f.sqlite.prepare('SELECT notify_status, notify_message_id FROM session_messages WHERE id = ?').get(message.id)!;
  assert.deepEqual([row.notify_status, row.notify_message_id], ['delivered', `${message.id}-n`]);
  const notification = f.sqlite.prepare('SELECT kind, origin_session_id, target_session_id, hops, reply_to FROM session_messages WHERE id = ?').get(`${message.id}-n`)!;
  assert.deepEqual({ ...notification }, { kind: 'notify', origin_session_id: 'session-b', target_session_id: 'session-a', hops: 2, reply_to: message.id });

  // A run working on the notification can send the worker a follow-up: it came from there, but not as a loop.
  const followUp = f.admit('session-a', ownerId, { requestId: `xs:${message.id}-n` });
  const again = await f.tool('session-a', ownerId, followUp, { action: 'ask', targetSessionId: 'session-b', message: 'Which timer?' });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal((again.body.message as CrossSessionMessage).hops, 3);

  // One its sender can no longer deliver fails; one never finished expires.
  const pending = await f.tool('session-a', ownerId, write, { action: 'ask', targetSessionId: 'session-b', message: 'Anything else?', notify: true });
  const later = (pending.body.message as CrossSessionMessage).id;
  f.sqlite.prepare("UPDATE session_messages SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3600_000).toISOString(), later);
  assert.deepEqual(await runCrossSessionNotifications(f.env), [{ messageId: later, failed: 'expired' }]);
});

test('lists nest the sessions an agent started under the session that started them', () => {
  const sessions = [{ id: 'c', parentSessionId: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'd', parentSessionId: 'c' }, { id: 'e', parentSessionId: 'gone' },
    { id: 'x', parentSessionId: 'y' }, { id: 'y', parentSessionId: 'x' }];
  assert.deepEqual(nestSessions(sessions).map(({ session, depth }) => `${session.id}${depth}`), ['b0', 'a0', 'c1', 'd2', 'e0', 'x0', 'y1']);
});
