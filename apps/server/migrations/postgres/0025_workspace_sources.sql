-- Postgres translation of sqlite/0032_workspace_sources.sql.

-- What a workspace's sessions work on: its sources (docs/design/external-sources.md). A Git repository is one kind of
-- source; its details, push policy, LFS and cache stay in workspace_repositories. Every source of a workspace is in the
-- grant of every session in it. Workspace-level checks ("at least one source", "the sources didn't change before this
-- insert") read this table; Git-specific code keeps reading workspace_repositories.
--
-- A 'git' source has the id of its repository and references it, so removing the repository (or its workspace) removes
-- the source. The trigger below adds it with the repository, whichever path inserts one. Other kinds come with their
-- own detail tables and have no repository.
CREATE TABLE workspace_sources (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('git')),
  repository_binding_id TEXT UNIQUE REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'git') = (repository_binding_id IS NOT NULL)),
  CHECK (kind <> 'git' OR repository_binding_id = id)
);
CREATE INDEX workspace_sources_workspace ON workspace_sources (workspace_id, id);

INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
  SELECT id, workspace_id, 'git', id, created_at FROM workspace_repositories;

CREATE FUNCTION workspace_repositories_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
    VALUES (NEW.id, NEW.workspace_id, 'git', NEW.id, NEW.created_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER workspace_repositories_source AFTER INSERT ON workspace_repositories
  FOR EACH ROW EXECUTE FUNCTION workspace_repositories_source();

-- A 'git' source belongs to the workspace of its repository.
CREATE FUNCTION workspace_sources_git_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'git' AND NOT EXISTS (SELECT 1 FROM workspace_repositories
      WHERE id = NEW.repository_binding_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'a git source needs its workspace repository';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspace_sources_git_binding BEFORE INSERT ON workspace_sources
  FOR EACH ROW EXECUTE FUNCTION workspace_sources_git_binding();
CREATE TRIGGER workspace_sources_immutable BEFORE UPDATE ON workspace_sources
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('workspace sources are immutable');
