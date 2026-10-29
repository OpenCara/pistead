-- Postgres translation of sqlite/0038_password_sign_in.sql: Postgres changes the CHECK in place.
ALTER TABLE users DROP CONSTRAINT users_auth_kind_check;
ALTER TABLE users ADD CONSTRAINT users_auth_kind_check CHECK (auth_kind IN ('github', 'test', 'password'));

CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  failed_attempts BIGINT NOT NULL DEFAULT 0,
  locked_until BIGINT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
