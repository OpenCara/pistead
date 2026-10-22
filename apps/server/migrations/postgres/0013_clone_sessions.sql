-- Postgres translation of sqlite/0020_clone_sessions.sql.
ALTER TABLE sessions ADD COLUMN repository_mode TEXT CHECK (repository_mode IS NULL OR repository_mode = 'clone');
CREATE TRIGGER sessions_repository_mode_immutable BEFORE UPDATE OF repository_mode ON sessions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('session repository mode is immutable');
