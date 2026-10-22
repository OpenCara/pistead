-- 'clone': the session has no pinned repositories; its agent clones the workspace's repositories with plain Git through
-- the host's egress proxy. NULL: repositories are pinned at creation (repositories_json).
ALTER TABLE sessions ADD COLUMN repository_mode TEXT CHECK (repository_mode IS NULL OR repository_mode = 'clone');
-- Like its pins, a session's repository mode is part of its immutable binding.
CREATE TRIGGER sessions_repository_mode_immutable BEFORE UPDATE OF repository_mode ON sessions BEGIN
  SELECT RAISE(ABORT, 'session repository mode is immutable');
END;
