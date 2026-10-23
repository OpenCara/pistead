-- Postgres translation of sqlite/0021_user_suspension.sql.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
