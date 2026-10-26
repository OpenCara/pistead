-- The state the control plane last read for the pull request a push recorded (pull-request-states.ts), with the session
-- owner's account, and when it last tried. Display state only, refreshed in the background until merged or closed.
ALTER TABLE push_credentials ADD COLUMN pull_request_state TEXT
  CHECK (pull_request_state IS NULL OR pull_request_state IN ('draft', 'open', 'failing', 'changes_requested', 'merged', 'closed'));
ALTER TABLE push_credentials ADD COLUMN pull_request_checked_at TEXT;
-- Each session's newest pull request, which session reads and the sweep look up per session.
CREATE INDEX push_credentials_session_pull ON push_credentials(session_id, completed_at, created_at, id) WHERE pull_request_url IS NOT NULL;
