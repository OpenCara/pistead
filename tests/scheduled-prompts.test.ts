import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { app } from '../apps/server/src/index.js';
import type { Env } from '../apps/server/src/types.js';
import { runScheduledPrompts } from '../apps/server/src/scheduled-prompts.js';
import { CronError, nextCronTime, parseCron } from '../packages/shared/src/cron.js';
import { sessionStatus } from '../packages/client/src/session-status.js';
import type { SessionRecord, SessionSchedule } from '../packages/shared/src/types.js';
import { seedAgentVersion, testDatabase } from './helpers/control-plane.js';

const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const at = (value: string) => Date.parse(value);

test('cron expressions take numbers, ranges, steps, lists and names, and refuse what cron would not', () => {
  const every = parseCron('*/15 9-17 * * mon-fri');
  assert.deepEqual([...every.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...every.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...every.weekdays].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays], [0], 'Sunday is 0 and 7');
  assert.deepEqual([...parseCron('5/20 * * * *').minutes], [5, 25, 45]);
  assert.deepEqual([...parseCron('0 0 1 jan,jul *').months], [1, 7]);
  assert.deepEqual(parseCron('@daily'), parseCron('0 0 * * *'));
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '0,1 * * * *', '* * * * *']) {
    assert.throws(() => parseCron(bad), CronError, bad);
  }
  assert.throws(() => parseCron('*/2 * * * *'), /at least 5 minutes apart/);
  assert.doesNotThrow(() => parseCron('*/5 * * * *'));
  assert.doesNotThrow(() => parseCron('0,30 * * * *'));
});

test('the next run comes after the given time, in the schedule\'s time zone', () => {
  const monday = at('2026-03-02T08:30:00Z');
  assert.equal(iso(nextCronTime('0 9 * * *', 'UTC', monday)), '2026-03-02T09:00:00.000Z');
  assert.equal(iso(nextCronTime('0 9 * * *', 'UTC', at('2026-03-02T09:00:00Z'))), '2026-03-03T09:00:00.000Z', 'strictly after');
  assert.equal(iso(nextCronTime('0 9 * * 1-5', 'UTC', at('2026-03-06T10:00:00Z'))), '2026-03-09T09:00:00.000Z', 'Friday after nine: Monday');
  assert.equal(iso(nextCronTime('0 9 * * *', 'Asia/Tokyo', monday)), '2026-03-03T00:00:00.000Z', '09:00 in Tokyo is midnight UTC');
  assert.equal(iso(nextCronTime('0 0 1 * *', 'UTC', at('2026-01-31T12:00:00Z'))), '2026-02-01T00:00:00.000Z');
  // Both day fields restricted: either runs, as in cron.
  assert.equal(iso(nextCronTime('0 0 13 * fri', 'UTC', at('2026-03-01T00:00:00Z'))), '2026-03-06T00:00:00.000Z');
  assert.equal(nextCronTime('0 0 31 2 *', 'UTC', monday), null, 'never comes round');
  // Berlin moves to summer time at 02:00 on 29 March 2026: 02:30 doesn't exist that day, and 09:00 is 07:00 UTC after.
  assert.equal(iso(nextCronTime('30 2 * * *', 'Europe/Berlin', at('2026-03-28T12:00:00Z'))), '2026-03-30T00:30:00.000Z');
  assert.equal(iso(nextCronTime('0 9 * * *', 'Europe/Berlin', at('2026-03-28T12:00:00Z'))), '2026-03-29T07:00:00.000Z');
  // And back at 03:00 on 25 October: 02:30 comes twice, and runs once.
  const first = nextCronTime('30 2 * * *', 'Europe/Berlin', at('2026-10-24T12:00:00Z'))!;
  assert.equal(new Date(first).getUTCHours() === 0 || new Date(first).getUTCHours() === 1, true);
  assert.equal(iso(nextCronTime('30 2 * * *', 'Europe/Berlin', first)), '2026-10-26T01:30:00.000Z');
});

test('a session at rest with a schedule shows as scheduled, unless what its agent does says more', () => {
  const ready = { status: 'ready' as const, nextScheduledAt: '2026-03-02T09:00:00.000Z' };
  for (const activity of [undefined, 'idle', 'done'] as const) {
    assert.deepEqual(sessionStatus({ ...ready, activity }), { tone: 'info', label: 'Scheduled', icon: 'clock' }, String(activity));
  }
  assert.equal(sessionStatus({ ...ready, activity: 'working' }).label, 'In progress');
  assert.equal(sessionStatus({ ...ready, activity: 'waiting' }).label, 'Needs approval');
  assert.equal(sessionStatus({ ...ready, activity: 'failed' }).label, 'Failed');
  assert.equal(sessionStatus({ ...ready, status: 'archived' }).label, 'Archived');
  assert.equal(sessionStatus({ status: 'ready', activity: 'done' }).label, 'Done', 'no schedule');
  // An open session's live activity wins over the list's.
  assert.equal(sessionStatus({ ...ready, activity: 'done' }, 'working').label, 'In progress');
});

const origin = 'http://localhost:8787';
const testSecret = 'scheduled-prompts-test-secret-not-for-deployment';

async function fixture(t: TestContext) {
  const { db, sqlite, setBeforeQuery } = await testDatabase();
  t.after(() => db.close());
  const env: Env = { DB: db, APP_ORIGIN: origin, TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: testSecret,
    TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), RUNNER_SHARED_SECRET: 'scheduled-prompts-internal-secret',
    VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') };
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
  const owner = await client('schedule-owner');
  const collaborator = await client('schedule-collaborator');
  const workspace = (await (await owner.request('POST', '/api/workspaces', { name: 'scheduling' })).json() as { workspace: { id: string } }).workspace;
  await owner.request('POST', `/api/workspaces/${workspace.id}/members`, { userId: collaborator.user.id, role: 'collaborator' });
  const model = (await (await owner.request('POST', `/api/workspaces/${workspace.id}/models`, { name: 'faux', provider: 'faux', modelId: 'faux-1' })).json() as { model: { id: string } }).model;
  const agent = seedAgentVersion(sqlite, { authorId: owner.user.id, modelId: model.id, tools: ['identity'] });
  sqlite.prepare("INSERT INTO sessions (id,workspace_id,owner_id,agent_version_id,title,status,created_at,visibility) VALUES (?,?,?,?,?,?,?,'private')")
    .run('scheduled-session', workspace.id, owner.user.id, agent.id, 'scheduled', 'ready', new Date().toISOString());
  assert.equal((await owner.request('POST', '/api/sessions/scheduled-session/grants', { userId: collaborator.user.id, role: 'collaborator' })).status, 200);
  env.RUNNER_URL = 'https://runner.example.test';
  // The host: records what it is sent.
  const submitted: { path: string; body: Record<string, unknown> }[] = [];
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/submit')) {
      submitted.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ submissionId: `sub-${submitted.length}`, conversationId: '0', status: 'queued' });
    }
    return Response.json({ error: 'offline', code: 'connector_relay_error' }, { status: 503 });
  };
  const session = async (client: typeof owner) =>
    (await (await client.request('GET', '/api/sessions')).json() as { sessions: SessionRecord[] }).sessions.find(item => item.id === 'scheduled-session')!;
  return { env, sqlite, setBeforeQuery, owner, collaborator, submitted, session };
}

const base = '/api/sessions/scheduled-session/schedules';

test('only the session owner schedules prompts; everyone who can view the session sees them', async t => {
  const f = await fixture(t);
  const body = { cron: '0 9 * * *', timeZone: 'UTC', content: 'Run the nightly checks\nand report' };
  const refused = await f.collaborator.request('POST', base, body);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { code: string }).code, 'owner_required');
  for (const [bad, code] of [[{ ...body, cron: '* * * * *' }, 'invalid_cron'], [{ ...body, cron: '0 0 31 2 *' }, 'invalid_cron'],
    [{ ...body, timeZone: 'Mars/Olympus' }, 'invalid_time_zone'], [{ ...body, content: '' }, 'invalid_input'], [{ ...body, access: 'root' }, 'invalid_input'],
    [{ ...body, extra: 1 }, 'invalid_input']] as const) {
    const response = await f.owner.request('POST', base, bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal((await response.json() as { code: string }).code, code, JSON.stringify(bad));
  }
  // Read-only and auto-approve are options a host must take; this session's runner takes none.
  const unsupported = await f.owner.request('POST', base, { ...body, access: 'read' });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json() as { code: string }).code, 'options_unsupported');
  const created = await f.owner.request('POST', base, body);
  assert.equal(created.status, 201, await created.clone().text());
  const { schedule } = await created.json() as { schedule: SessionSchedule };
  assert.equal(schedule.name, 'Run the nightly checks', 'named for its first line');
  assert.equal(schedule.access, 'approval');
  assert.equal(schedule.enabled, true);
  assert.ok(schedule.nextRunAt && Date.parse(schedule.nextRunAt) > Date.now());
  assert.equal((await f.session(f.owner)).nextScheduledAt, schedule.nextRunAt, 'lists show when it wakes');
  assert.equal(sessionStatus(await f.session(f.collaborator)).label, 'Scheduled');

  const listed = await (await f.collaborator.request('GET', base)).json() as { schedules: SessionSchedule[]; canManage: boolean };
  assert.deepEqual(listed.schedules.map(item => item.id), [schedule.id]);
  assert.equal(listed.canManage, false);
  assert.equal((await f.collaborator.request('PATCH', `${base}/${schedule.id}`, { enabled: false })).status, 403);
  assert.equal((await f.collaborator.request('DELETE', `${base}/${schedule.id}`)).status, 403);

  // Paused: lists no longer show it waiting.
  const paused = await (await f.owner.request('PATCH', `${base}/${schedule.id}`, { enabled: false })).json() as { schedule: SessionSchedule };
  assert.equal(paused.schedule.nextRunAt, null);
  assert.equal((await f.session(f.owner)).nextScheduledAt, undefined);
  const resumed = await (await f.owner.request('PATCH', `${base}/${schedule.id}`, { enabled: true, cron: '30 8 * * *', name: 'Morning' })).json() as { schedule: SessionSchedule };
  assert.equal(resumed.schedule.name, 'Morning');
  assert.equal(new Date(resumed.schedule.nextRunAt!).getUTCMinutes(), 30);
  assert.equal((await f.owner.request('DELETE', `${base}/${schedule.id}`)).status, 204);
  assert.equal((await f.session(f.owner)).nextScheduledAt, undefined);
  const actions = f.sqlite.prepare("SELECT action FROM audit WHERE action LIKE 'session.schedule.%' ORDER BY rowid").all().map(row => row.action);
  assert.deepEqual(actions, ['session.schedule.created', 'session.schedule.updated', 'session.schedule.updated', 'session.schedule.deleted']);
});

test('the sweep sends due prompts as the owner, once, skips a busy session, and moves each schedule on', async t => {
  const f = await fixture(t);
  const created = await (await f.owner.request('POST', base, { cron: '0 * * * *', timeZone: 'UTC', content: 'Check the build' })).json() as { schedule: SessionSchedule };
  const due = Date.parse(created.schedule.nextRunAt!);
  assert.deepEqual(await runScheduledPrompts(f.env, due - 1000), [], 'not yet');
  assert.equal(f.submitted.length, 0);

  const sent = await runScheduledPrompts(f.env, due + 5000);
  assert.deepEqual(sent, [{ scheduleId: created.schedule.id, sessionId: 'scheduled-session', submissionId: 'sub-1' }]);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0]!.body.content, 'Check the build');
  assert.equal(f.submitted[0]!.body.options, undefined, 'approval, the default, sends no options');
  assert.match(String(f.submitted[0]!.body.requestId), new RegExp(`^schedule:${created.schedule.id}:`));
  const audit = f.sqlite.prepare("SELECT actor_id, detail_json FROM audit WHERE action = 'session.submit'").get()!;
  assert.equal(audit.actor_id, f.owner.user.id, 'sent as the owner');
  assert.equal((JSON.parse(String(audit.detail_json)) as { scheduleId: string }).scheduleId, created.schedule.id);
  assert.deepEqual(await runScheduledPrompts(f.env, due + 10_000), [], 'once per run');

  const listed = (await (await f.owner.request('GET', base)).json() as { schedules: SessionSchedule[] }).schedules[0]!;
  assert.equal(listed.nextRunAt, new Date(due + 3600_000).toISOString(), 'moved on to the next hour');
  assert.equal(listed.lastSubmissionId, 'sub-1');
  assert.equal(listed.lastError, null);
  assert.equal((await f.session(f.owner)).nextScheduledAt, listed.nextRunAt);

  // Busy at the next run: skipped, not queued, and the schedule still moves on.
  f.sqlite.prepare("UPDATE sessions SET activity = 'working' WHERE id = 'scheduled-session'").run();
  const busy = await runScheduledPrompts(f.env, due + 3600_000);
  assert.deepEqual(busy, [{ scheduleId: created.schedule.id, sessionId: 'scheduled-session', error: 'session_busy' }]);
  assert.equal(f.submitted.length, 1);
  f.sqlite.prepare("UPDATE sessions SET activity = 'done' WHERE id = 'scheduled-session'").run();
  // Missed runs aren't caught up: a day later, one run, then the next hour from then.
  const late = due + 30 * 3600_000 + 60_000;
  assert.equal((await runScheduledPrompts(f.env, late)).length, 1);
  assert.equal(f.submitted.length, 2);
  const after = (await (await f.owner.request('GET', base)).json() as { schedules: SessionSchedule[] }).schedules[0]!;
  assert.equal(after.nextRunAt, new Date(due + 31 * 3600_000).toISOString());

  // An archived session sends nothing.
  f.sqlite.prepare("UPDATE sessions SET status = 'archived', archived_status = 'ready' WHERE id = 'scheduled-session'").run();
  assert.deepEqual(await runScheduledPrompts(f.env, due + 40 * 3600_000), []);
});

test('a refused run is recorded on its schedule, and Run now sends at once without moving it', async t => {
  const f = await fixture(t);
  const { schedule } = await (await f.owner.request('POST', base, { cron: '0 9 * * *', content: 'Report' })).json() as { schedule: SessionSchedule };
  const ran = await f.owner.request('POST', `${base}/${schedule.id}/run`);
  assert.equal(ran.status, 202, await ran.clone().text());
  const result = await ran.json() as { schedule: SessionSchedule; submission: { submissionId: string } };
  assert.equal(result.submission.submissionId, 'sub-1');
  assert.equal(result.schedule.nextRunAt, schedule.nextRunAt);
  assert.equal((await f.collaborator.request('POST', `${base}/${schedule.id}/run`)).status, 403);

  // The owner lost the session's host: the sweep records why nothing was sent.
  globalThis.fetch = async () => Response.json({ error: 'offline', code: 'connector_relay_error' }, { status: 503 });
  const [outcome] = await runScheduledPrompts(f.env, Date.parse(schedule.nextRunAt!) + 1000);
  assert.ok(outcome && 'error' in outcome, JSON.stringify(outcome));
  const listed = (await (await f.owner.request('GET', base)).json() as { schedules: SessionSchedule[] }).schedules[0]!;
  assert.equal(listed.lastError, outcome.error);
  assert.equal(listed.lastSubmissionId, null);
});

test('schedules due together for one session send one message; the rest find it busy', async t => {
  const f = await fixture(t);
  const first = (await (await f.owner.request('POST', base, { cron: '0 9 * * *', content: 'One' })).json() as { schedule: SessionSchedule }).schedule;
  const second = (await (await f.owner.request('POST', base, { cron: '0 9 * * *', content: 'Two' })).json() as { schedule: SessionSchedule }).schedule;
  assert.equal(first.nextRunAt, second.nextRunAt);
  const outcomes = await runScheduledPrompts(f.env, Date.parse(first.nextRunAt!) + 1000);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.filter(outcome => 'submissionId' in outcome).length, 1);
  assert.equal(outcomes.filter(outcome => 'error' in outcome && outcome.error === 'session_busy').length, 1);
  assert.equal(f.submitted.length, 1, 'not queued behind the first');
});

test('an edit never brings back a run a sweep claimed while it was being saved', async t => {
  const f = await fixture(t);
  const { schedule } = await (await f.owner.request('POST', base, { cron: '0 9 * * *', content: 'Report' })).json() as { schedule: SessionSchedule };
  const claimed = new Date(Date.parse(schedule.nextRunAt!) + 86400_000).toISOString();
  // A sweep claims the run between the edit's read and its write.
  const claim = (sql: string) => {
    if (!sql.startsWith('UPDATE session_schedules SET name')) return;
    f.setBeforeQuery(undefined);
    f.sqlite.prepare('UPDATE session_schedules SET next_run_at = ? WHERE id = ?').run(claimed, schedule.id);
  };
  f.setBeforeQuery(claim);
  const renamed = await f.owner.request('PATCH', `${base}/${schedule.id}`, { name: 'Daily report', content: 'Report, briefly' });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await renamed.json() as { schedule: SessionSchedule }).schedule.nextRunAt, claimed, 'a rename leaves the next run alone');
  assert.equal(f.sqlite.prepare('SELECT next_run_at FROM session_schedules WHERE id = ?').get(schedule.id)!.next_run_at, claimed);

  // A change of when it runs replaces only the next run it read: here it read one the sweep has claimed since.
  f.setBeforeQuery(sql => { if (sql.startsWith('UPDATE session_schedules SET name')) { f.setBeforeQuery(undefined);
    f.sqlite.prepare('UPDATE session_schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.parse(claimed) + 86400_000).toISOString(), schedule.id); } });
  const moved = await f.owner.request('PATCH', `${base}/${schedule.id}`, { cron: '0 10 * * *' });
  assert.equal(moved.status, 409);
  assert.equal((await moved.json() as { code: string }).code, 'schedule_changed');
  assert.equal(f.sqlite.prepare('SELECT cron FROM session_schedules WHERE id = ?').get(schedule.id)!.cron, '0 9 * * *', 'nothing changed');
  assert.equal((await f.owner.request('PATCH', `${base}/${schedule.id}`, { cron: '0 10 * * *' })).status, 200, 'read again, it saves');
});

test('the owner\'s agent manages schedules with the schedule tool, for a live write message of the owner, never adding access', async t => {
  const f = await fixture(t);
  const ownerId = f.owner.user.id;
  const admit = (actorId: string, options: { mode?: 'write' | 'ask'; access?: string; expiresAt?: number } = {}) => {
    const admission = randomBytes(32).toString('base64url');
    f.sqlite.prepare('INSERT INTO run_admissions (id,session_id,actor_id,mode,access,request_id,content_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(admission, 'scheduled-session', actorId, options.mode ?? 'write', options.access ?? null, `request-${admission}`, 'h'.repeat(43),
        options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
    return admission;
  };
  const tool = async (admissionId: string, body: Record<string, unknown>, actorId = ownerId) => {
    const response = await app.request('/api/internal/schedules', { method: 'POST',
      headers: { Authorization: `Bearer ${f.env.RUNNER_SHARED_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'scheduled-session', actorId, admissionId, callId: 'call-1', ...body }) }, f.env);
    return { status: response.status, body: await response.json() as Record<string, unknown> & { code?: string } };
  };
  const refused = async (result: Promise<{ status: number; body: { code?: string } }>, status: number, code: string) => {
    const { status: actual, body } = await result;
    assert.equal(actual, status, JSON.stringify(body));
    assert.equal(body.code, code);
  };
  const create = { action: 'create', cron: '0 9 * * 1-5', timeZone: 'Europe/Berlin', content: 'Check the nightly build' };
  const write = admit(ownerId);

  // The agent was made without the tool, and the owner hasn't allowed it.
  await refused(tool(write, create), 403, 'tool_not_allowed');
  f.sqlite.prepare('INSERT INTO session_tool_grants (session_id,tool,call_id,approval_id,granted_by,created_at) VALUES (?,?,?,?,?,?)')
    .run('scheduled-session', 'schedule', '', 'permission-any', ownerId, new Date().toISOString());
  // A collaborator's message, an ask, an expired message or another's admission schedule nothing: schedules run as the owner.
  await refused(tool(admit(f.collaborator.user.id), create, f.collaborator.user.id), 403, 'owner_required');
  for (const admission of [admit(ownerId, { mode: 'ask' }), admit(ownerId, { expiresAt: Math.floor(Date.now() / 1000) - 1 }), admit(f.collaborator.user.id), 'unknown']) {
    await refused(tool(admission, create), 403, 'schedule_not_admitted');
  }
  for (const [bad, code] of [[{ ...create, cron: '* * * * *' }, 'invalid_cron'], [{ ...create, timeZone: 'Mars/Olympus' }, 'invalid_time_zone'],
    [{ ...create, extra: 1 }, 'invalid_input'], [{ ...create, action: 'run' }, 'invalid_input'], [{ action: 'update' }, 'invalid_input'],
    [{ action: 'list', cron: '0 9 * * *' }, 'invalid_input'], [{ ...create, enabled: 'yes' }, 'invalid_input']] as const) {
    await refused(tool(write, bad), 400, code);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_schedules').get()!.n, 0);

  const created = await tool(write, create);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const schedule = created.body.schedule as SessionSchedule;
  assert.deepEqual([schedule.name, schedule.cron, schedule.timeZone, schedule.access, schedule.enabled, schedule.createdBy],
    ['Check the nightly build', '0 9 * * 1-5', 'Europe/Berlin', 'approval', true, ownerId]);
  // The owner sees it in the Schedules tab, and the session list shows it waiting.
  const listed = await (await f.owner.request('GET', base)).json() as { schedules: SessionSchedule[] };
  assert.deepEqual(listed.schedules.map(item => item.id), [schedule.id]);
  assert.equal((await f.session(f.owner)).nextScheduledAt, schedule.nextRunAt);
  assert.deepEqual(((await tool(write, { action: 'list' })).body.schedules as SessionSchedule[]).map(item => item.id), [schedule.id]);

  const paused = await tool(write, { action: 'update', scheduleId: schedule.id, enabled: false, name: 'Build check' });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.deepEqual([(paused.body.schedule as SessionSchedule).name, (paused.body.schedule as SessionSchedule).nextRunAt], ['Build check', null]);
  await refused(tool(write, { action: 'update', scheduleId: 'missing', enabled: true }), 404, 'not_found');

  // Auto-approved schedules come only from the owner's Auto-approve message: not created, and not changed, by any other.
  await refused(tool(write, { ...create, access: 'auto' }), 403, 'automatic_schedule_not_admitted');
  await refused(tool(write, { action: 'update', scheduleId: schedule.id, access: 'auto' }), 403, 'automatic_schedule_not_admitted');
  // An Auto-approve message passes that check; this session's host takes no access options, so the schedule still can't be auto.
  await refused(tool(admit(ownerId, { access: 'auto' }), { ...create, access: 'auto' }), 400, 'options_unsupported');
  f.sqlite.prepare("UPDATE session_schedules SET access = 'auto' WHERE id = ?").run(schedule.id);
  await refused(tool(write, { action: 'update', scheduleId: schedule.id, content: 'Do anything' }), 403, 'automatic_schedule_not_admitted');

  // Deleting takes no more access than it had.
  const deleted = await tool(write, { action: 'delete', scheduleId: schedule.id });
  assert.deepEqual([deleted.status, deleted.body], [200, { deleted: schedule.id }]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM session_schedules').get()!.n, 0);
  const audits = f.sqlite.prepare("SELECT action, actor_id, detail_json FROM audit WHERE action LIKE 'session.schedule.%' ORDER BY rowid").all();
  assert.deepEqual(audits.map(row => row.action), ['session.schedule.created', 'session.schedule.updated', 'session.schedule.deleted']);
  for (const row of audits) {
    assert.equal(row.actor_id, ownerId);
    assert.deepEqual((({ agent, callId }) => ({ agent, callId }))(JSON.parse(String(row.detail_json)) as { agent: boolean; callId: string }), { agent: true, callId: 'call-1' });
  }
});
