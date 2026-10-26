import type { Hono } from 'hono';
import { accessModes, type AccessMode, type SessionSchedule, type SubmitResult } from '../../../packages/shared/src/types.js';
import { CronError, isTimeZone, nextCronTime, parseCron } from '../../../packages/shared/src/cron.js';
import { asSessionOwner, errorCode } from './automatic-backups.js';
import { auditStatement, requireSession, requireUnfrozen } from './db.js';
import { fail, id, identifier, jsonObject, now, text } from './http.js';
import { submitMessage } from './sessions.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';

/**
 * Scheduled prompts: messages the server sends a session's agent on a cron schedule, so that a session can wake up and
 * do recurring work (a nightly check, a weekly report) without anyone at the keyboard.
 *
 * - Only the session's owner creates, changes or removes them, and they run as the owner: each run is the owner's
 *   message, with every check the chat box's message has (session access, suspension, the host and its models).
 *   Anyone who can view the session sees its schedules, as they see its messages.
 * - A sweep (main.ts) runs every minute and sends each schedule that is due. A run due while the agent is working or
 *   waits for an approval is skipped (`session_busy`), not queued, so a slow run never piles up behind it. Runs missed
 *   while the server was down, the session archived or not ready, are not caught up: the next sweep sends one and moves on.
 * - Each enabled schedule's next run is kept on the session (`next_scheduled_at`), which lists show as "Scheduled".
 */

/** The most schedules a session keeps. */
export const MAX_SCHEDULES_PER_SESSION = 20;
/** The most runs one sweep sends; the rest wait for the next one, the longest overdue first. */
const sweepLimit = 20;

interface ScheduleRow {
  id: string; session_id: string; created_by: string; name: string; cron: string; time_zone: string; content: string;
  access: AccessMode; enabled: number; next_run_at: string | null; last_run_at: string | null; last_submission_id: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}

export function scheduleRecord(row: ScheduleRow): SessionSchedule {
  return { id: row.id, sessionId: row.session_id, name: row.name, cron: row.cron, timeZone: row.time_zone, content: row.content,
    access: row.access, enabled: Number(row.enabled) === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastSubmissionId: row.last_submission_id, lastError: row.last_error, createdBy: row.created_by, createdAt: row.created_at,
    updatedAt: row.updated_at };
}

/** When a schedule runs next after `at`, as stored: null when it never comes round. */
function nextRun(cron: string, timeZone: string, at: number): string | null {
  const next = nextCronTime(cron, timeZone, at);
  return next === null ? null : new Date(next).toISOString();
}

/** Keeps the session's `next_scheduled_at` in step with its enabled schedules. */
export async function refreshNextScheduled(env: Env, sessionId: string): Promise<void> {
  await env.DB.query(`UPDATE sessions SET next_scheduled_at = (SELECT MIN(next_run_at) FROM session_schedules
      WHERE session_id = ? AND enabled = 1 AND next_run_at IS NOT NULL) WHERE id = ?`).bind(sessionId, sessionId).run();
}

function validCron(value: unknown): string {
  const cron = text(value, 'cron', 120);
  try { parseCron(cron); } catch (error) {
    if (error instanceof CronError) fail(400, 'invalid_cron', error.message);
    throw error;
  }
  return cron.trim().replace(/\s+/g, ' ');
}

function validTimeZone(value: unknown): string {
  if (!isTimeZone(value)) fail(400, 'invalid_time_zone', 'Choose a time zone such as UTC or Europe/Berlin.');
  return value;
}

function validAccess(value: unknown): AccessMode {
  if (!accessModes.includes(value as AccessMode)) fail(400, 'invalid_input', 'Access is read, approval or auto.');
  return value as AccessMode;
}

function validEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') fail(400, 'invalid_input', 'Enabled is true or false.');
  return value;
}

/** The session, for its owner to change its schedules: refused for anyone else, and for sessions that run nothing. */
async function ownSession(c: AppContext): Promise<SessionRow> {
  const { row } = await requireSession(c, identifier(c.req.param('id')), 'write');
  if (row.owner_id !== c.get('auth').userId) fail(403, 'owner_required', 'Only the session owner can schedule prompts.');
  requireUnfrozen(row);
  return row;
}

/**
 * Read-only and auto-approve are message options, which only a host that takes them runs (see chatOptions in
 * sessions.ts): said when the schedule is saved, not at its first run. Approval is every message's default.
 */
async function requireAccessSupported(c: AppContext, row: SessionRow, access: AccessMode): Promise<void> {
  if (access === 'approval') return;
  if (!row.connector_id) fail(400, 'options_unsupported', 'This session\'s runner cannot change access; schedule it with approval.');
  const host = await c.env.DB.query<{ capabilities_json: string }>('SELECT capabilities_json FROM connectors WHERE id = ? AND revoked_at IS NULL')
    .bind(row.connector_id).first();
  if (!host) fail(409, 'connector_unavailable', 'The session\'s host is no longer available.');
  if ((JSON.parse(host.capabilities_json) as { chatOptions?: unknown }).chatOptions !== true) {
    fail(409, 'connector_update_required', 'Update the host\'s connector (npx pistead@latest connect) to schedule read-only or auto-approved prompts.');
  }
}

async function ownSchedule(c: AppContext, row: SessionRow): Promise<ScheduleRow> {
  const schedule = await c.env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE id = ? AND session_id = ?')
    .bind(identifier(c.req.param('scheduleId'), 'scheduleId'), row.id).first();
  if (!schedule) fail(404, 'not_found', 'Schedule not found.');
  // Postgres returns BIGINT columns as strings.
  return { ...schedule, enabled: Number(schedule.enabled) };
}

/** Sends the schedule's message now, as the session's owner; throws what refused it. */
async function send(env: Env, schedule: ScheduleRow, ownerId: string, at: number, trigger: 'schedule' | 'manual'): Promise<SubmitResult> {
  return asSessionOwner(env, { owner_id: ownerId }, async c => {
    // Every check of a message the owner sends, as of now: they may have lost access, or the session moved on.
    const { row } = await requireSession(c, schedule.session_id, 'write');
    return submitMessage(c, row, 'submit', {
      content: schedule.content,
      requestId: `schedule:${schedule.id}:${at}`,
      // Approval is every message's default, so older hosts that take no options run these too.
      ...(schedule.access === 'approval' ? {} : { options: { access: schedule.access } }),
    }, { scheduleId: schedule.id, trigger });
  }, 'scheduled-prompt');
}

/** What one due schedule did, for tests and logs. */
export type ScheduledPromptOutcome = { scheduleId: string; sessionId: string; submissionId: string } | { scheduleId: string; sessionId: string; error: string };

type DueSchedule = ScheduleRow & { owner_id: string };

/** Sends the scheduled prompts that are due now; see the top of this file. Safe to call at any time. */
export async function runScheduledPrompts(env: Env, at = Date.now()): Promise<ScheduledPromptOutcome[]> {
  const timestamp = new Date(at).toISOString();
  const due = await env.DB.query<DueSchedule>(`SELECT p.*, s.owner_id
    FROM session_schedules p JOIN sessions s ON s.id = p.session_id
    WHERE p.enabled = 1 AND p.next_run_at IS NOT NULL AND p.next_run_at <= ? AND s.status = 'ready'
    ORDER BY p.next_run_at, p.id LIMIT ?`).bind(timestamp, sweepLimit).all();
  const outcomes: ScheduledPromptOutcome[] = [];
  // Sessions this sweep sent a message: busy from then on, though the list above read them before it did.
  const sent = new Set<string>();
  for (const schedule of due) {
    // Claim the run before sending it, moving the schedule on, so that a sweep running beside this one doesn't send it too.
    const claimed = await env.DB.query(`UPDATE session_schedules SET next_run_at = ?, last_run_at = ?
      WHERE id = ? AND enabled = 1 AND next_run_at = ?`)
      .bind(nextRun(schedule.cron, schedule.time_zone, at), timestamp, schedule.id, schedule.next_run_at).run();
    if (claimed.changes !== 1) continue;
    let outcome: ScheduledPromptOutcome;
    // What the host reports now, not when the list was read: an earlier run, or someone in the chat box, woke it since.
    const activity = sent.has(schedule.session_id) ? 'working'
      : await env.DB.query<{ activity: string | null }>('SELECT activity FROM sessions WHERE id = ?').bind(schedule.session_id).first('activity');
    if (activity === 'working' || activity === 'waiting') {
      outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, error: 'session_busy' };
    } else {
      try {
        const result = await send(env, schedule, schedule.owner_id, at, 'schedule');
        sent.add(schedule.session_id);
        outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, submissionId: result.submissionId };
      } catch (error) {
        outcome = { scheduleId: schedule.id, sessionId: schedule.session_id, error: await errorCode(error) };
      }
    }
    await env.DB.query('UPDATE session_schedules SET last_submission_id = ?, last_error = ? WHERE id = ?')
      .bind('submissionId' in outcome ? outcome.submissionId : null, 'error' in outcome ? outcome.error : null, schedule.id).run();
    await refreshNextScheduled(env, schedule.session_id);
    outcomes.push(outcome);
  }
  return outcomes;
}

export function registerScheduledPrompts(app: Hono<WorkerEnv>) {
  app.get('/api/sessions/:id/schedules', async c => {
    const { row } = await requireSession(c, identifier(c.req.param('id')), 'read');
    const rows = await c.env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE session_id = ? ORDER BY created_at, id').bind(row.id).all();
    return c.json({ schedules: rows.map(scheduleRecord), canManage: row.owner_id === c.get('auth').userId && row.status !== 'archived' });
  });

  app.post('/api/sessions/:id/schedules', async c => {
    const row = await ownSession(c);
    const input = await jsonObject(c);
    if (Object.keys(input).some(key => !['name', 'cron', 'timeZone', 'content', 'access', 'enabled'].includes(key))) fail(400, 'invalid_input', 'Unknown schedule field.');
    const cron = validCron(input.cron);
    const timeZone = input.timeZone === undefined ? 'UTC' : validTimeZone(input.timeZone);
    const content = text(input.content, 'content', 60000);
    const name = input.name === undefined || input.name === '' ? content.trim().split('\n')[0]!.slice(0, 80) || 'Scheduled prompt' : text(input.name, 'name', 100);
    const access = input.access === undefined ? 'approval' : validAccess(input.access);
    const enabled = input.enabled === undefined ? true : validEnabled(input.enabled);
    await requireAccessSupported(c, row, access);
    const at = Date.now();
    const nextRunAt = enabled ? nextRun(cron, timeZone, at) : null;
    if (enabled && nextRunAt === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
    const count = await c.env.DB.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_schedules WHERE session_id = ?').bind(row.id).first('n');
    if (Number(count) >= MAX_SCHEDULES_PER_SESSION) fail(409, 'too_many_schedules', `A session keeps at most ${MAX_SCHEDULES_PER_SESSION} schedules.`);
    const timestamp = now();
    const schedule: ScheduleRow = { id: id(), session_id: row.id, created_by: c.get('auth').userId, name, cron, time_zone: timeZone, content, access,
      enabled: enabled ? 1 : 0, next_run_at: nextRunAt, last_run_at: null, last_submission_id: null, last_error: null, created_at: timestamp, updated_at: timestamp };
    await c.env.DB.batch([
      c.env.DB.query(`INSERT INTO session_schedules (id, session_id, created_by, name, cron, time_zone, content, access, enabled, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(schedule.id, row.id, schedule.created_by, name, cron, timeZone, content, access, schedule.enabled,
        nextRunAt, timestamp, timestamp),
      auditStatement(c.env, c.get('auth').userId, 'session.schedule.created', row.workspace_id, row.id, { scheduleId: schedule.id, cron, timeZone, access, enabled }),
    ]);
    await refreshNextScheduled(c.env, row.id);
    return c.json({ schedule: scheduleRecord(schedule) }, 201);
  });

  app.patch('/api/sessions/:id/schedules/:scheduleId', async c => {
    const row = await ownSession(c);
    const current = await ownSchedule(c, row);
    const input = await jsonObject(c);
    if (Object.keys(input).some(key => !['name', 'cron', 'timeZone', 'content', 'access', 'enabled'].includes(key))) fail(400, 'invalid_input', 'Unknown schedule field.');
    const next: ScheduleRow = { ...current,
      ...(input.name !== undefined ? { name: text(input.name, 'name', 100) } : {}),
      ...(input.cron !== undefined ? { cron: validCron(input.cron) } : {}),
      ...(input.timeZone !== undefined ? { time_zone: validTimeZone(input.timeZone) } : {}),
      ...(input.content !== undefined ? { content: text(input.content, 'content', 60000) } : {}),
      ...(input.access !== undefined ? { access: validAccess(input.access) } : {}),
      ...(input.enabled !== undefined ? { enabled: validEnabled(input.enabled) ? 1 : 0 } : {}),
      updated_at: now() };
    if (next.access !== current.access) await requireAccessSupported(c, row, next.access);
    const timing = next.cron !== current.cron || next.time_zone !== current.time_zone || next.enabled !== current.enabled;
    if (timing) next.next_run_at = next.enabled ? nextRun(next.cron, next.time_zone, Date.now()) : null;
    if (next.enabled && next.next_run_at === null) fail(400, 'invalid_cron', 'This schedule never comes round.');
    // A sweep may claim a run, moving next_run_at on, while this request runs: an edit that doesn't change when it runs
    // leaves next_run_at alone, and one that does replaces only the next run it read, so a claimed run never comes back.
    const update = timing
      ? c.env.DB.query(`UPDATE session_schedules SET name = ?, cron = ?, time_zone = ?, content = ?, access = ?, enabled = ?, next_run_at = ?, updated_at = ?
          WHERE id = ? AND ${current.next_run_at === null ? 'next_run_at IS NULL' : 'next_run_at = ?'}`)
        .bind(next.name, next.cron, next.time_zone, next.content, next.access, next.enabled, next.next_run_at, next.updated_at, next.id,
          ...(current.next_run_at === null ? [] : [current.next_run_at]))
      : c.env.DB.query('UPDATE session_schedules SET name = ?, content = ?, access = ?, updated_at = ? WHERE id = ?')
        .bind(next.name, next.content, next.access, next.updated_at, next.id);
    const [updated] = await c.env.DB.batch([
      update,
      auditStatement(c.env, c.get('auth').userId, 'session.schedule.updated', row.workspace_id, row.id,
        { scheduleId: next.id, cron: next.cron, timeZone: next.time_zone, access: next.access, enabled: next.enabled === 1 }),
    ]);
    // Its next run moved on, or the schedule went, since it was read: nothing changed, and the editor reads it again.
    if (updated!.changes !== 1) fail(409, 'schedule_changed', 'This schedule ran or changed meanwhile. Reload it and try again.');
    await refreshNextScheduled(c.env, row.id);
    const saved = await c.env.DB.query<ScheduleRow>('SELECT * FROM session_schedules WHERE id = ?').bind(next.id).first();
    return c.json({ schedule: scheduleRecord(saved ?? next) });
  });

  app.delete('/api/sessions/:id/schedules/:scheduleId', async c => {
    const row = await ownSession(c);
    const schedule = await ownSchedule(c, row);
    await c.env.DB.batch([
      c.env.DB.query('DELETE FROM session_schedules WHERE id = ?').bind(schedule.id),
      auditStatement(c.env, c.get('auth').userId, 'session.schedule.deleted', row.workspace_id, row.id, { scheduleId: schedule.id }),
    ]);
    await refreshNextScheduled(c.env, row.id);
    return c.body(null, 204);
  });

  // Sends the schedule's message now, as a test of it; its next scheduled run stays as it was.
  app.post('/api/sessions/:id/schedules/:scheduleId/run', async c => {
    const row = await ownSession(c);
    const schedule = await ownSchedule(c, row);
    const at = Date.now();
    const timestamp = new Date(at).toISOString();
    try {
      const submission = await send(c.env, schedule, row.owner_id, at, 'manual');
      await c.env.DB.query('UPDATE session_schedules SET last_run_at = ?, last_submission_id = ?, last_error = NULL WHERE id = ?')
        .bind(timestamp, submission.submissionId, schedule.id).run();
      return c.json({ schedule: scheduleRecord({ ...schedule, last_run_at: timestamp, last_submission_id: submission.submissionId, last_error: null }), submission }, 202);
    } catch (error) {
      await c.env.DB.query('UPDATE session_schedules SET last_run_at = ?, last_submission_id = NULL, last_error = ? WHERE id = ?')
        .bind(timestamp, await errorCode(error), schedule.id).run();
      throw error;
    }
  });
}
