import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AccessMode, SessionRecord, SessionSchedule } from "../../../packages/shared/src/types";
import { CronError, isTimeZone, MIN_CRON_INTERVAL_MINUTES, nextCronTime, parseCron } from "../../../packages/shared/src/cron";
import { api, segment } from "./api";
import { useApp } from "./app-context";
import { Icon } from "./icons";
import {
  Alert, Button, CardBody, confirmDialog, EmptyState, Feedback, Field, Loading, ResourceState, Row, Section, StatusBadge, Timestamp,
  useAction, useResource,
} from "./ui";

type ScheduleListing = { schedules: SessionSchedule[]; canManage: boolean };

/** Common schedules, offered before a custom expression. */
const presets: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "First of the month at 09:00", cron: "0 9 1 * *" },
];

const accessLabels: Record<AccessMode, string> = { read: "Read-only", approval: "Ask for approval", auto: "Auto-approve" };
const accessHints: Record<AccessMode, string> = {
  read: "The agent can look, but changes nothing",
  approval: "Commands and pushes wait for someone to approve them, as in the chat box",
  auto: "Commands run without asking, under your auto-approve. Nobody may be watching when it runs",
};

const errorLabels: Record<string, string> = {
  session_busy: "Skipped: the agent was busy or waiting for an approval",
  connector_offline: "The host was offline",
  connector_unavailable: "The host was unavailable",
  connector_relay_error: "The host didn't answer",
  forbidden: "You no longer have write access",
  session_frozen: "The session runs nothing",
};

function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** "in 5m", "in 3h", "in 2d". */
function untilText(value: string): string {
  const seconds = Math.max(0, (new Date(value).getTime() - Date.now()) / 1000);
  if (seconds < 60) return "in under a minute";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86400)}d`;
}

/** The next few runs of an expression being edited, or what is wrong with it, and in which field. */
function preview(cron: string, timeZone: string): { runs: string[] } | { error: string; field: "cron" | "timeZone" } {
  if (!isTimeZone(timeZone)) return { error: "Unknown time zone.", field: "timeZone" };
  try {
    const schedule = parseCron(cron);
    const runs: string[] = [];
    let after = Date.now();
    for (let index = 0; index < 3; index++) {
      const next = nextCronTime(schedule, timeZone, after);
      if (next === null) break;
      runs.push(new Date(next).toISOString());
      after = next;
    }
    return runs.length ? { runs } : { error: "This schedule never comes round.", field: "cron" };
  } catch (error) {
    return { error: error instanceof CronError ? error.message : "Invalid schedule.", field: "cron" };
  }
}

/** The session panel's Schedules tab: the owner's scheduled prompts, which wake the agent with a message on a cron schedule. */
export function SchedulesPanel({ session, changed }: { session: SessionRecord; changed: () => void }) {
  const base = `/api/sessions/${segment(session.id)}/schedules`;
  const listing = useResource<ScheduleListing>(base);
  const { refreshSessions } = useApp();
  const action = useAction();
  // null: the list; "new": a new schedule; otherwise the schedule being edited.
  const [editing, setEditing] = useState<SessionSchedule | "new" | null>(null);
  const canManage = Boolean(listing.data?.canManage) && !session.frozen;
  const after = () => { listing.refresh(); refreshSessions(); changed(); };
  // The agent changes schedules too (its schedule tool): read them again when the session's next run or what its agent
  // is doing changes, rather than only when asked.
  const watched = `${session.nextScheduledAt ?? ""}|${session.activity ?? ""}`;
  const seen = useRef(watched);
  const { refresh } = listing;
  useEffect(() => {
    if (seen.current === watched) return;
    seen.current = watched;
    refresh();
  }, [watched, refresh]);

  function toggle(schedule: SessionSchedule) {
    void action.run(async () => {
      await api(`${base}/${segment(schedule.id)}`, { method: "PATCH", body: { enabled: !schedule.enabled } });
      after();
    }, schedule.enabled ? `Paused ${schedule.name}` : `Resumed ${schedule.name}`);
  }
  function runNow(schedule: SessionSchedule) {
    void action.run(async () => {
      await api(`${base}/${segment(schedule.id)}/run`, { method: "POST" });
      after();
    }, `Sent ${schedule.name} to the agent`);
  }
  async function remove(schedule: SessionSchedule) {
    const confirmed = await confirmDialog({ title: "Delete schedule?", message: `${schedule.name} stops waking the agent. Messages it already sent stay in the conversation.`,
      confirmLabel: "Delete", destructive: true });
    if (!confirmed) return;
    await action.run(async () => {
      await api(`${base}/${segment(schedule.id)}`, { method: "DELETE" });
      after();
    }, `Deleted ${schedule.name}`);
  }

  if (editing) return <ScheduleForm base={base} schedule={editing === "new" ? null : editing} isOwner={canManage}
    onDone={saved => { setEditing(null); if (saved) after(); }} />;

  const schedules = listing.data?.schedules ?? [];
  return <Section title={<>Scheduled prompts {schedules.length > 0 && <span className="muted">{schedules.length}</span>}</>}
    info={<><p>A scheduled prompt sends the agent a message on a schedule, as the session owner, so the session wakes up and works on its own: a nightly check, a weekly report.</p>
      <p>A run that comes while the agent is working or waiting for an approval is skipped, not queued. Runs missed while the host or server was offline aren't caught up. The session's host must be online.</p>
      <p>Only the session owner manages its schedules; everyone who can view the session sees them.</p></>}
    action={<div className="inline">
      <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh schedules" title="Refresh" disabled={listing.loading} onClick={listing.refresh} />
      {canManage && <Button variant="outline" size="sm" icon="plus" onClick={() => setEditing("new")}>New</Button>}
    </div>}
    bare>
    <ResourceState {...listing} retry={listing.refresh}>
      {!schedules.length
        ? <EmptyState title="No scheduled prompts">{canManage ? "Wake the agent with a message every hour, day or week." : "The session owner hasn't scheduled any prompts."}</EmptyState>
        : <div className="stack">
          {schedules.map(schedule => <article key={schedule.id} className="card schedule-card">
            <Row
              leading={<Icon name="clock" size={16} />}
              title={schedule.name}
              hint={<><code>{schedule.cron}</code> · {schedule.timeZone} · {accessLabels[schedule.access]}</>}
              trailing={schedule.enabled
                ? schedule.nextRunAt ? <StatusBadge tone="info">Next {untilText(schedule.nextRunAt)}</StatusBadge> : <StatusBadge tone="warning">Never runs</StatusBadge>
                : <StatusBadge tone="neutral">Paused</StatusBadge>}
            />
            <CardBody>
              <pre className="schedule-content">{schedule.content}</pre>
              <p className="muted small">
                {schedule.enabled && schedule.nextRunAt && <>Next run <Timestamp value={schedule.nextRunAt} />. </>}
                {schedule.lastRunAt
                  ? <>Last run <Timestamp value={schedule.lastRunAt} />{schedule.lastError ? <>: <span className="session-status warning">{errorLabels[schedule.lastError] ?? schedule.lastError}</span></> : " sent its message"}.</>
                  : "Hasn't run yet."}
              </p>
              {canManage && <div className="inline">
                <Button variant="outline" size="sm" disabled={action.busy} onClick={() => toggle(schedule)}>{schedule.enabled ? "Pause" : "Resume"}</Button>
                <Button variant="ghost" size="sm" disabled={action.busy} title="Send its message now; its schedule stays as it is" onClick={() => runNow(schedule)}>Run now</Button>
                <Button variant="ghost" size="sm" icon="pencil" disabled={action.busy} onClick={() => setEditing(schedule)}>Edit</Button>
                <Button variant="ghost" size="sm" icon="trash" disabled={action.busy} aria-label={`Delete ${schedule.name}`} title="Delete" onClick={() => void remove(schedule)} />
              </div>}
            </CardBody>
          </article>)}
        </div>}
    </ResourceState>
    <Feedback error={action.error} notice={action.notice} />
  </Section>;
}

function ScheduleForm({ base, schedule, isOwner, onDone }: { base: string; schedule: SessionSchedule | null; isOwner: boolean; onDone: (saved: boolean) => void }) {
  const form = useAction();
  const [name, setName] = useState(schedule?.name ?? "");
  const [cron, setCron] = useState(schedule?.cron ?? "0 9 * * 1-5");
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? localTimeZone());
  const [content, setContent] = useState(schedule?.content ?? "");
  const [access, setAccess] = useState<AccessMode>(schedule?.access ?? "approval");
  const next = useMemo(() => preview(cron, timeZone), [cron, timeZone]);
  const preset = presets.find(item => item.cron === cron.trim())?.cron ?? "";
  const ready = isOwner && content.trim().length > 0 && "runs" in next;

  function save(event: FormEvent) {
    event.preventDefault();
    if (!ready || form.busy) return;
    void form.run(async () => {
      const body = { name: name.trim(), cron, timeZone, content, access };
      if (schedule) await api(`${base}/${segment(schedule.id)}`, { method: "PATCH", body: { ...body, ...(body.name ? {} : { name: schedule.name }) } });
      else await api(base, { method: "POST", body });
      onDone(true);
    });
  }

  return <Section title={schedule ? "Edit scheduled prompt" : "New scheduled prompt"} bare>
    <form className="card" onSubmit={save}>
      <CardBody>
        <fieldset disabled={form.busy} className="stack">
          <Field label="Message" hint="Sent to the agent as you, as if you typed it in the chat box">
            <textarea className="textarea" required autoFocus={!schedule} rows={4} value={content} onChange={event => setContent(event.target.value)}
              placeholder="Pull main, run the tests and summarise any failures" />
          </Field>
          <Field label="Name" hint="Optional; the message's first line otherwise">
            <input className="input" maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Nightly test run" />
          </Field>
          <Field label="Repeat">
            <select className="select" value={preset} onChange={event => { if (event.target.value) setCron(event.target.value); }}>
              {presets.map(item => <option key={item.cron} value={item.cron}>{item.label}</option>)}
              <option value="">Custom</option>
            </select>
          </Field>
          <Field label="Cron expression" hint={<>Minute, hour, day of month, month, day of week, as in crontab: <code>*/30 8-18 * * mon-fri</code>. Runs at least {MIN_CRON_INTERVAL_MINUTES} minutes apart.</>}
            error={"error" in next && next.field === "cron" ? next.error : undefined}>
            <input className="input mono" required spellCheck={false} autoComplete="off" value={cron} onChange={event => setCron(event.target.value)} />
          </Field>
          <Field label="Time zone" hint="IANA name, such as UTC or Europe/Berlin" error={"error" in next && next.field === "timeZone" ? next.error : undefined}>
            <input className="input" required spellCheck={false} autoComplete="off" value={timeZone} onChange={event => setTimeZone(event.target.value)} />
          </Field>
          {"runs" in next && <p className="muted small">Next runs: {next.runs.map((run, index) => <span key={run}>{index ? ", " : ""}<Timestamp value={run} /></span>)}</p>}
          <Field label="Access" hint={accessHints[access]}>
            <select className="select" value={access} onChange={event => setAccess(event.target.value as AccessMode)}>
              {(["approval", "read", "auto"] as const).map(mode => <option key={mode} value={mode}>{accessLabels[mode]}</option>)}
            </select>
          </Field>
          {access === "auto" && <Alert variant="error" title="Runs commands unattended">Every command this message's work runs is approved automatically, at times when nobody may be watching.</Alert>}
          <div className="inline">
            <Button type="submit" variant="default" size="sm" disabled={!ready}>{form.busy ? "Saving..." : schedule ? "Save" : "Create schedule"}</Button>
            <Button variant="ghost" size="sm" onClick={() => onDone(false)}>Cancel</Button>
          </div>
          <Feedback error={form.error} />
          {form.busy && <Loading>Saving</Loading>}
        </fieldset>
      </CardBody>
    </form>
  </Section>;
}
