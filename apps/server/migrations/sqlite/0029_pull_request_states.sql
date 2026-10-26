-- The state the control plane last read for the pull request a push recorded (pull-request-states.ts), with the session
-- owner's account, and when it last tried. Display state only, refreshed in the background until merged or closed.
ALTER TABLE push_credentials ADD COLUMN pull_request_state TEXT
  CHECK (pull_request_state IS NULL OR pull_request_state IN ('draft', 'open', 'failing', 'changes_requested', 'merged', 'closed'));
ALTER TABLE push_credentials ADD COLUMN pull_request_checked_at TEXT;
