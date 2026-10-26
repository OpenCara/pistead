-- Postgres translation of sqlite/0024_session_branches.sql.
ALTER TABLE sessions ADD COLUMN branch TEXT;
CREATE UNIQUE INDEX sessions_branch ON sessions(branch) WHERE branch IS NOT NULL;
CREATE TRIGGER sessions_branch_immutable BEFORE UPDATE OF branch ON sessions
  FOR EACH ROW WHEN (OLD.branch IS DISTINCT FROM NEW.branch) EXECUTE FUNCTION pistead_raise('session branch is immutable');
