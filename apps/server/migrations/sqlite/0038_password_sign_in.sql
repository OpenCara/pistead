-- pistead: foreign-keys-off
-- Accounts that sign in with a username and password (PASSWORD_AUTH=true), as `password:<username>`, next to GitHub's.
-- SQLite cannot change a CHECK constraint in place, so users is rebuilt with the same rows. Every other table references
-- it, so the runner applies this file with foreign keys off (the first line above) and checks them all before commit;
-- nothing referencing users is touched.
CREATE TABLE users_v2 (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  github_login TEXT,
  display_name TEXT NOT NULL,
  git_name TEXT NOT NULL,
  git_email TEXT NOT NULL,
  env_json TEXT NOT NULL DEFAULT '{}',
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('github', 'test', 'password')),
  created_at TEXT NOT NULL,
  suspended_at TEXT
);
INSERT INTO users_v2 (id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at, suspended_at)
  SELECT id, github_id, github_login, display_name, git_name, git_email, env_json, auth_kind, created_at, suspended_at FROM users;
DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

-- A password account's scrypt hash (`scrypt$N$r$p$salt$hash`, base64url), and its failed sign-ins: after a few in a
-- row, the account refuses sign-ins until locked_until (epoch ms), whatever password is tried.
CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
