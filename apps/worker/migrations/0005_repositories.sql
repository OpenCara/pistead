ALTER TABLE sessions ADD COLUMN repositories_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(repositories_json) AND json_type(repositories_json) = 'array');
CREATE TRIGGER sessions_repositories_immutable BEFORE UPDATE OF repositories_json ON sessions BEGIN
  SELECT RAISE(ABORT, 'session repositories are immutable');
END;

CREATE TABLE workspace_repositories (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL CHECK (typeof(repository_id) = 'integer' AND repository_id > 0 AND repository_id <= 9007199254740991),
  full_name TEXT NOT NULL COLLATE NOCASE,
  ref TEXT NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, repository_id),
  UNIQUE (workspace_id, full_name)
);
-- SQLite serializes writers; enforce the cap in the same statement as the insert.
CREATE TRIGGER workspace_repositories_limit BEFORE INSERT ON workspace_repositories
WHEN (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = NEW.workspace_id) >= 5 BEGIN
  SELECT RAISE(ABORT, 'workspace repository limit reached');
END;
CREATE TRIGGER workspace_repositories_immutable BEFORE UPDATE ON workspace_repositories BEGIN
  SELECT RAISE(ABORT, 'workspace repository bindings are immutable');
END;

ALTER TABLE connector_pairings ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
