-- Postgres translation of sqlite/0029_pull_request_states.sql.
ALTER TABLE push_credentials ADD COLUMN pull_request_state TEXT
  CHECK (pull_request_state IS NULL OR pull_request_state IN ('draft', 'open', 'failing', 'changes_requested', 'merged', 'closed'));
ALTER TABLE push_credentials ADD COLUMN pull_request_checked_at TEXT;
