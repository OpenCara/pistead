-- A session's share link: anyone who has it can view the session's shared conversation, read-only, without signing in.
-- The token is looked up by its hash and kept vault-encrypted with 'session-link:<session id>' as AAD so the owner can
-- copy the link again. Turning link sharing off deletes the row; turning it on again issues a new token.
CREATE TABLE session_links (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 43),
  token_ciphertext TEXT NOT NULL CHECK (length(token_ciphertext) <= 4096),
  created_at TEXT NOT NULL
);
