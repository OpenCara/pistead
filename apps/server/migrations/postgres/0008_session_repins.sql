CREATE TABLE session_repins (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  operation_json TEXT NOT NULL,
  admission_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, approval_id)
);
CREATE INDEX session_repins_admission ON session_repins(admission_id);
