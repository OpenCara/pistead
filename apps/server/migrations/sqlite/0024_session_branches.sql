-- The branch a clone session pushes without approval, named for its work when it was created
-- (pistead/<title-slug>-<short id>). NULL: the session predates named branches, or started on a connector without them,
-- and pushes pistead/<session-id>. Like its repository mode, it is part of the session's immutable binding.
ALTER TABLE sessions ADD COLUMN branch TEXT;
CREATE UNIQUE INDEX sessions_branch ON sessions(branch) WHERE branch IS NOT NULL;
CREATE TRIGGER sessions_branch_immutable BEFORE UPDATE OF branch ON sessions
  WHEN OLD.branch IS NOT NEW.branch BEGIN
  SELECT RAISE(ABORT, 'session branch is immutable');
END;
