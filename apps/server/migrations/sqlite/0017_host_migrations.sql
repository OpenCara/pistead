-- Moving a session to another host while both hosts are connected: the source host's live snapshot is held here, not in
-- backup storage, until the target host has restored it into the successor session. Then (or on cancel) it is cleared.
CREATE TABLE host_migrations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  source_connector_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  target_connector_id TEXT NOT NULL,
  target_model_id TEXT NOT NULL,
  request_title TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 43),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 25165824),
  snapshot TEXT,
  binding_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  download_token_hash TEXT,
  download_expires_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (owner_id, request_id),
  CHECK (target_session_id <> source_session_id),
  CHECK (target_connector_id <> source_connector_id),
  CHECK (download_token_hash IS NULL OR length(download_token_hash) = 43),
  CHECK (status = 'pending' OR snapshot IS NULL)
);
CREATE INDEX host_migrations_source ON host_migrations(source_session_id, status);
CREATE INDEX host_migrations_target ON host_migrations(target_session_id, status);
-- One move in flight per session, also under concurrent READ COMMITTED transactions.
CREATE UNIQUE INDEX host_migrations_pending_source ON host_migrations(source_session_id) WHERE status = 'pending';
CREATE TRIGGER host_migrations_binding_immutable
BEFORE UPDATE OF id, request_id, owner_id, workspace_id, source_session_id, source_connector_id, target_session_id,
  target_connector_id, target_model_id, request_title, sha256, size, binding_json, created_at ON host_migrations BEGIN
  SELECT RAISE(ABORT, 'host migration binding is immutable');
END;
CREATE TRIGGER host_migrations_settled_immutable BEFORE UPDATE ON host_migrations
WHEN OLD.status <> 'pending' BEGIN
  SELECT RAISE(ABORT, 'settled host migration receipt is immutable');
END;
CREATE TRIGGER host_migrations_receipt_retained BEFORE DELETE ON host_migrations BEGIN
  SELECT RAISE(ABORT, 'host migration receipts must be retained');
END;
