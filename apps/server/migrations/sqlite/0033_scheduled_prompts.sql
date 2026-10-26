-- Scheduled prompts (scheduled-prompts.ts): messages the server sends a session's agent on a cron schedule, as the
-- session's owner, who alone manages them. A sweep sends each one that is due while its session is idle.
CREATE TABLE session_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  -- A short label for lists; the message itself is `content`.
  name TEXT NOT NULL,
  -- Five-field cron expression (packages/shared/src/cron.ts), read in `time_zone` (IANA).
  cron TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  content TEXT NOT NULL,
  -- The message's access, as the chat box's: read-only, approval (the default) or the owner's auto-approve.
  access TEXT NOT NULL DEFAULT 'approval' CHECK (access IN ('read', 'approval', 'auto')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- When it runs next; null while it is paused, or for a schedule that never comes round (such as the 31st of February).
  next_run_at TEXT,
  last_run_at TEXT,
  -- The message its last run sent, or why that run sent none (an API error code, or session_busy).
  last_submission_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX session_schedules_session ON session_schedules (session_id);
CREATE INDEX session_schedules_due ON session_schedules (next_run_at) WHERE enabled = 1;

-- The earliest next_run_at of the session's enabled schedules, kept with the session so that lists can show that it
-- waits for one without reading its schedules.
ALTER TABLE sessions ADD COLUMN next_scheduled_at TEXT;
