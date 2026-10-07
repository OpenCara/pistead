CREATE TABLE run_admissions (
  id TEXT PRIMARY KEY CHECK (length(id) = 43),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('write', 'ask')),
  request_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 43),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, actor_id, request_id)
);
CREATE INDEX run_admissions_expiry ON run_admissions(session_id, actor_id, expires_at);
CREATE INDEX run_admissions_global_expiry ON run_admissions(expires_at);
CREATE INDEX run_admissions_actor_expiry ON run_admissions(actor_id, expires_at);
CREATE INDEX run_admissions_session_expiry ON run_admissions(session_id, expires_at);
CREATE INDEX sessions_admission_owner ON sessions(owner_id, id);
CREATE TRIGGER run_admissions_immutable BEFORE UPDATE ON run_admissions BEGIN
  SELECT RAISE(ABORT, 'run admissions are immutable');
END;

CREATE TABLE approval_reviews (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('explicit', 'model')),
  admission_id TEXT REFERENCES run_admissions(id),
  operation_json TEXT NOT NULL,
  review_hash TEXT NOT NULL CHECK (length(review_hash) = 43),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, approval_id),
  CHECK ((source = 'explicit' AND admission_id IS NULL) OR (source = 'model' AND admission_id IS NOT NULL))
);
CREATE TRIGGER approval_reviews_immutable_update BEFORE UPDATE ON approval_reviews BEGIN
  SELECT RAISE(ABORT, 'approval reviews are immutable');
END;
CREATE TRIGGER approval_reviews_immutable_delete BEFORE DELETE ON approval_reviews BEGIN
  SELECT RAISE(ABORT, 'approval reviews must be retained');
END;
