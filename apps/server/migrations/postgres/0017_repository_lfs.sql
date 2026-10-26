-- Postgres translation of sqlite/0024_repository_lfs.sql.
CREATE TABLE repository_lfs_settings (
  binding_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled BIGINT NOT NULL CHECK (enabled IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
