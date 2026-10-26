-- Workspace repository bindings are immutable; whether sessions may download a repository's Git LFS objects lives
-- beside them, like the push policy. No row means off.
CREATE TABLE repository_lfs_settings (
  binding_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
