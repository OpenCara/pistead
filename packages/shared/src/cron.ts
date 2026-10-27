import type { ScheduleToolRequest } from "./types.js";

/**
 * Cron schedules for scheduled prompts: the standard five fields (minute hour day-of-month month day-of-week), read in
 * an IANA time zone. Each field takes `*`, numbers, ranges (`1-5`), steps (`*\/15`, `0-30/10`, `5/20`) and lists of them;
 * months and weekdays also take names (`jan`, `mon`). Day of week 0 and 7 are both Sunday. As in cron, when both day
 * fields are restricted, a day matching either runs. `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` stand for
 * their usual expressions.
 *
 * A local time that a daylight-saving change skips doesn't run that day; a repeated one runs once.
 */

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** The day of month field is `*` (or `?`): only weekdays restrict the day. */
  anyDay: boolean;
  /** The day of week field is `*` (or `?`): only days of month restrict the day. */
  anyWeekday: boolean;
}

/** Runs are this many minutes apart at least: the minute field may not list values closer than this. */
export const MIN_CRON_INTERVAL_MINUTES = 5;

const macros: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export class CronError extends Error {}

function fieldValue(token: string, min: number, max: number, names?: string[], nameBase = 0): number {
  const lower = token.toLowerCase();
  const named = names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + nameBase;
  if (!/^\d{1,2}$/.test(token)) throw new CronError(`"${token}" is not a valid value.`);
  const value = Number(token);
  if (value < min || value > max) throw new CronError(`${value} is outside ${min}-${max}.`);
  return value;
}

function parseField(field: string, min: number, max: number, label: string, names?: string[], nameBase = 0): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  if (field === "*" || field === "?") {
    for (let value = min; value <= max; value++) values.add(value);
    return { values, any: true };
  }
  try {
    for (const part of field.split(",")) {
      const [range, stepText, extra] = part.split("/");
      if (extra !== undefined || !range) throw new CronError(`"${part}" is not a valid entry.`);
      let step = 1;
      if (stepText !== undefined) {
        if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) throw new CronError(`"${stepText}" is not a valid step.`);
        step = Number(stepText);
      }
      let low: number;
      let high: number;
      if (range === "*") { low = min; high = max; }
      else if (range.includes("-")) {
        const [from, to, more] = range.split("-");
        if (more !== undefined || !from || !to) throw new CronError(`"${range}" is not a valid range.`);
        low = fieldValue(from, min, max, names, nameBase);
        high = fieldValue(to, min, max, names, nameBase);
        if (low > high) throw new CronError(`"${range}" runs backwards.`);
      } else {
        low = fieldValue(range, min, max, names, nameBase);
        // `5/20` means from 5 to the end, every 20.
        high = stepText === undefined ? low : max;
      }
      for (let value = low; value <= high; value += step) values.add(value);
    }
  } catch (error) {
    if (error instanceof CronError) throw new CronError(`${label}: ${error.message}`);
    throw error;
  }
  return { values, any: false };
}

/** Parses a cron expression, or throws a CronError that says what is wrong with it. */
export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  const source = macros[trimmed.toLowerCase()] ?? trimmed;
  const fields = source.split(" ");
  if (fields.length !== 5) throw new CronError("A schedule has five fields: minute, hour, day of month, month and day of week.");
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, 0, 59, "Minute");
  const hours = parseField(hour, 0, 23, "Hour");
  const days = parseField(day, 1, 31, "Day of month");
  const months = parseField(month, 1, 12, "Month", monthNames, 1);
  const weekdays = parseField(weekday, 0, 7, "Day of week", weekdayNames);
  if (weekdays.values.delete(7)) weekdays.values.add(0);
  const sorted = [...minutes.values].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index++) {
    const next = index + 1 < sorted.length ? sorted[index + 1]! : sorted[0]! + 60;
    if (sorted.length > 1 && next - sorted[index]! < MIN_CRON_INTERVAL_MINUTES) {
      throw new CronError(`Runs must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes apart.`);
    }
  }
  return { minutes: minutes.values, hours: hours.values, days: days.values, months: months.values, weekdays: weekdays.values,
    anyDay: days.any, anyWeekday: weekdays.any };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Whether the runtime knows this IANA time zone ("UTC", "Europe/Berlin", ...). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try { formatter(value); return true; } catch { return false; }
}

/** The local wall-clock time in `timeZone` at instant `at`, as milliseconds of a UTC date with the same fields. */
function wallClock(at: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(at))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** The instant whose local time in `timeZone` is `wall`, or null when a daylight-saving change skips it. */
function instantOf(wall: number, timeZone: string): number | null {
  let guess = wall - (wallClock(wall, timeZone) - wall);
  guess = wall - (wallClock(guess, timeZone) - guess);
  return wallClock(guess, timeZone) === wall ? guess : null;
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const day = schedule.days.has(date.getUTCDate());
  const weekday = schedule.weekdays.has(date.getUTCDay());
  if (schedule.anyDay && schedule.anyWeekday) return true;
  if (schedule.anyDay) return weekday;
  if (schedule.anyWeekday) return day;
  return day || weekday;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The first time after `after` (milliseconds) that the schedule runs in `timeZone`, or null when it never runs within
 * the next five years (such as the 31st of February).
 */
export function nextCronTime(schedule: CronSchedule | string, timeZone: string, after: number): number | null {
  const cron = typeof schedule === "string" ? parseCron(schedule) : schedule;
  // The next whole minute, in local wall-clock time.
  let wall = Math.floor(wallClock(after, timeZone) / MINUTE) * MINUTE + MINUTE;
  const limit = wall + 5 * 366 * DAY;
  while (wall < limit) {
    const date = new Date(wall);
    if (!cron.months.has(date.getUTCMonth() + 1)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayMatches(cron, date)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!cron.hours.has(date.getUTCHours())) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
      continue;
    }
    if (cron.minutes.has(date.getUTCMinutes())) {
      const instant = instantOf(wall, timeZone);
      if (instant !== null && instant > after) return instant;
    }
    wall += MINUTE;
  }
  return null;
}

/** The longest target a schedule tool call shows on its permission card. */
const SCHEDULE_TARGET_LIMIT = 4000;

/**
 * What a schedule tool call does, as its permission card shows the session owner, and as the control plane checks a
 * one-call permission against: the runner and the control plane both build it from the call's own fields, so a grant
 * covers only the change the owner saw.
 */
export function scheduleToolTarget(request: Pick<ScheduleToolRequest, "action" | "scheduleId" | "name" | "cron" | "timeZone" | "content" | "access" | "enabled">): string {
  const parts: string[] = [request.action];
  if (request.scheduleId !== undefined) parts.push(request.scheduleId);
  if (request.cron !== undefined) parts.push(`cron ${request.cron}`);
  if (request.timeZone !== undefined) parts.push(`in ${request.timeZone}`);
  if (request.access !== undefined) parts.push(`access ${request.access}`);
  if (request.enabled !== undefined) parts.push(request.enabled ? "enabled" : "paused");
  if (request.name !== undefined) parts.push(`name ${JSON.stringify(request.name)}`);
  let target = parts.join(" ");
  if (request.content !== undefined) target += `: ${request.content}`;
  return target.length > SCHEDULE_TARGET_LIMIT ? `${target.slice(0, SCHEDULE_TARGET_LIMIT - 1)}…` : target;
}
