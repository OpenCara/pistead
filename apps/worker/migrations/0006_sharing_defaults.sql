-- Existing sessions stay private; the creation API opts new sessions into workspace read access.
ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'workspace'));

-- Connecting a host to a workspace does not grant teammates runtime access.
CREATE TABLE connector_workspaces (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, workspace_id)
);
CREATE INDEX connector_workspaces_workspace ON connector_workspaces(workspace_id, connector_id);

-- Existing shares remain explicit grants and also establish an association.
INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
  SELECT connector_id, workspace_id, created_at FROM connector_shares;
