-- Four tiers of workspace member below the owner: viewer (follows shared sessions read-only, creates none), member
-- (creates sessions, follows others read-only by default), collaborator (creates sessions and sends messages to any
-- shared session) and admin (a collaborator who also manages the workspace). Existing members and admins keep their role.
-- SQLite cannot change a CHECK constraint in place, so workspace_members is rebuilt with the same rows; no table
-- references it, so dropping the old one cascades nothing.
CREATE TABLE workspace_members_v2 (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'collaborator', 'member', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO workspace_members_v2 (workspace_id, user_id, role, created_at)
  SELECT workspace_id, user_id, role, created_at FROM workspace_members;
DROP TABLE workspace_members;
ALTER TABLE workspace_members_v2 RENAME TO workspace_members;
CREATE INDEX workspace_members_user ON workspace_members(user_id, workspace_id);
