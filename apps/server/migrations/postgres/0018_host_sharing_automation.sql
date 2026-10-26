-- Postgres translation of sqlite/0025_host_sharing_automation.sql.

-- A message sent with Auto-approve may also merge without asking: a separate opt-in, recorded with its admission.
ALTER TABLE run_admissions ADD COLUMN auto_merge BIGINT NOT NULL DEFAULT 0 CHECK (auto_merge IN (0, 1));

-- One row per GitHub comment, issue or merge run under Auto-approve: inserting it consumes the tool call's single
-- attempt (as consuming a broker capability does for an approved one) and counts against its message's limit.
CREATE TABLE automatic_github_effects (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL,
  admission_id TEXT NOT NULL REFERENCES run_admissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('github.comment', 'github.issue', 'github.merge')),
  operation_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, approval_id)
);
CREATE INDEX automatic_github_effects_admission ON automatic_github_effects(admission_id);

-- Members other than the owner who manage a host's sharing: its workspace shares and host command grants.
CREATE TABLE connector_admins (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, user_id)
);
CREATE INDEX connector_admins_user ON connector_admins(user_id, connector_id);

-- Host command authority in one workspace the host is shared with, for one member or ('') every member of it.
-- approve: decides each host command; auto: also runs those of the member's own Auto-approve messages without asking.
CREATE TABLE connector_host_grants (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL CHECK (level IN ('approve', 'auto')),
  expires_at BIGINT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, workspace_id, user_id)
);
CREATE INDEX connector_host_grants_workspace ON connector_host_grants(workspace_id, connector_id);
