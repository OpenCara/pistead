CREATE TABLE restore_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  backup_id TEXT NOT NULL REFERENCES backups(id),
  target_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  request_title TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 43),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 25165824),
  binding_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  download_token_hash TEXT,
  download_expires_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (owner_id, request_id),
  CHECK (target_session_id <> source_session_id),
  CHECK (download_token_hash IS NULL OR length(download_token_hash) = 43)
);
CREATE INDEX restore_jobs_source ON restore_jobs(source_session_id, created_at);
CREATE TRIGGER restore_jobs_binding_immutable
BEFORE UPDATE OF id, request_id, owner_id, workspace_id, source_session_id, backup_id,
  target_session_id, request_title, sha256, size, binding_json, created_at ON restore_jobs BEGIN
  SELECT RAISE(ABORT, 'restore binding is immutable');
END;
CREATE TRIGGER restore_jobs_completed_immutable BEFORE UPDATE ON restore_jobs
WHEN OLD.status = 'completed' BEGIN
  SELECT RAISE(ABORT, 'completed restore receipt is immutable');
END;
CREATE TRIGGER restore_jobs_receipt_retained BEFORE DELETE ON restore_jobs BEGIN
  SELECT RAISE(ABORT, 'restore receipts must be retained');
END;
