-- Postgres translation of the SQLite migration 0022_automatic_backups.sql.
-- Automatic backups into a workspace's own database. The workspace owner chooses how often (in minutes; NULL is never);
-- replacing the connection keeps the choice, and disconnecting the database ends it.
ALTER TABLE workspace_databases ADD COLUMN automatic_backup_minutes BIGINT
  CHECK (automatic_backup_minutes IS NULL OR automatic_backup_minutes IN (15, 60, 360, 1440));

-- A member's standing confirmation of one workspace database, for every backup of the sessions they own: automatic ones,
-- and manual ones without asking each time. It names the database by its id, so pointing the connection at another
-- database (which gets a new id) asks again, as a manual backup does. The workspace owner who connects it needs none.
CREATE TABLE workspace_database_consents (
  database_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (database_id, user_id)
);

-- Each session's automatic backup state. changed_at: when its host first reported it working since its last automatic
-- backup (NULL: nothing new to save). due_at: the earliest time the next attempt may run. error: why the last attempt
-- failed, as an error code; NULL after a success.
CREATE TABLE automatic_backups (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id),
  changed_at TEXT,
  due_at TEXT,
  attempted_at TEXT,
  backup_id TEXT,
  error TEXT CHECK (error IS NULL OR length(error) <= 64)
);
CREATE INDEX automatic_backups_changed ON automatic_backups(changed_at);

-- 1 for backups the server took on its own schedule, 0 for backups someone asked for.
ALTER TABLE backups ADD COLUMN automatic BIGINT NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1));
