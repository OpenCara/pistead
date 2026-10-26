-- Postgres translation of the SQLite migration 0027_workspace_invites.sql.
-- A workspace's invite link: anyone signed in who opens it can ask to join the workspace. Asking only makes them a
-- pending member (workspace_join_requests), which grants nothing until an owner or admin accepts them with a role.
-- The token is looked up by its hash and kept vault-encrypted with 'workspace-invite:<workspace id>' as AAD so owners
-- and admins can copy the link again. Turning the link off deletes the row; turning it on again issues a new token.
CREATE TABLE workspace_invite_links (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 43),
  token_ciphertext TEXT NOT NULL CHECK (length(token_ciphertext) <= 4096),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Pending members: people who asked to join through an invite link. They are not workspace members, so they see and
-- do nothing in the workspace. Accepting moves them into workspace_members; declining deletes the row.
CREATE TABLE workspace_join_requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_join_requests_user ON workspace_join_requests(user_id, workspace_id);
