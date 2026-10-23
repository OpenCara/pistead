-- When an instance administrator (ADMIN_USER_IDS) suspended the account; NULL while it is active. A suspended account
-- can't sign in, its hosts are refused, and nobody can open the sessions it owns until it is unsuspended.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
