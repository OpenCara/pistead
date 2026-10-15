-- Postgres translation of the SQLite migration 0013_workspace_databases.sql.
-- A Postgres database of the workspace owner's own. Session backups of the workspace are saved there, with the session's
-- record, instead of in the server's backup storage. The password is vault-encrypted with 'workspace-database:<id>' as AAD
-- and never leaves the control plane.
CREATE TABLE workspace_databases (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  port BIGINT NOT NULL CHECK (port BETWEEN 1 AND 65535),
  database_name TEXT NOT NULL CHECK (length(database_name) BETWEEN 1 AND 63),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 63),
  tls TEXT NOT NULL CHECK (tls IN ('verify-full', 'require', 'disable')),
  -- PEM certificates trusted instead of the public roots; only when the server certificate is verified.
  ca_certificate TEXT CHECK (ca_certificate IS NULL OR (tls = 'verify-full' AND length(ca_certificate) <= 262144)),
  password_ciphertext TEXT NOT NULL CHECK (length(password_ciphertext) <= 22000),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Backups whose snapshot was saved in their workspace's database. Backups without a row here are in the server's storage.
CREATE TABLE workspace_database_backups (
  backup_id TEXT PRIMARY KEY NOT NULL REFERENCES backups(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at TEXT NOT NULL
);
