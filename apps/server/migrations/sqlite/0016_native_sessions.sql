-- Native apps (iOS, iPadOS, macOS) sign in with a bearer token; browsers keep the session cookie. Each kind of session
-- is accepted only the way it was issued.
ALTER TABLE auth_sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'browser' CHECK (client IN ('browser', 'native'));
-- Native sessions are listed and revoked as devices: a public id (never the token hash) and the name the app reported.
ALTER TABLE auth_sessions ADD COLUMN device_id TEXT;
ALTER TABLE auth_sessions ADD COLUMN device_name TEXT;
CREATE UNIQUE INDEX auth_sessions_device ON auth_sessions(device_id) WHERE device_id IS NOT NULL;
-- A native sign-in keeps the app's PKCE challenge and state with GitHub's OAuth state until the callback.
ALTER TABLE oauth_states ADD COLUMN native_challenge TEXT;
ALTER TABLE oauth_states ADD COLUMN native_state TEXT;
-- One-use codes the app exchanges, with its PKCE verifier, for a native session.
CREATE TABLE native_auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
