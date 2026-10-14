-- The status a session had before its owner archived it, so unarchiving restores it exactly; NULL otherwise.
ALTER TABLE sessions ADD COLUMN archived_status TEXT
  CHECK (archived_status IS NULL OR archived_status IN ('provisioning', 'ready', 'error'));
