-- Push access can also use the session owner's own account or the host's own Git credentials, for any provider.
-- SQLite cannot change a CHECK constraint in place, so push_identities is rebuilt with the same rows and ids.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE push_identities_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea')),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  -- Azure DevOps organization or Bitbucket workspace (lowercase); empty when the identity covers the whole host.
  scope TEXT NOT NULL DEFAULT '' CHECK (length(scope) <= 100),
  kind TEXT NOT NULL CHECK (
    (kind = 'github-app' AND provider IN ('github', 'github-enterprise')) OR
    (kind = 'entra-federation' AND provider = 'azure-devops') OR
    (kind = 'bitbucket-client-credentials' AND provider = 'bitbucket') OR
    (kind = 'oauth-refresh' AND provider IN ('gitlab', 'gitea')) OR
    (kind = 'forgejo-integration' AND provider = 'gitea') OR
    kind IN ('owner-account', 'host-credentials')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object' AND length(config_json) <= 4096),
  secret_ciphertext TEXT CHECK (secret_ciphertext IS NULL OR length(secret_ciphertext) <= 22000),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'authorization_required')),
  -- oauth-refresh only: serializes refresh-token rotation across concurrent pushes (unix seconds).
  lease_until INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, host, scope)
);
INSERT INTO push_identities_v2 (id, workspace_id, provider, host, scope, kind, config_json, secret_ciphertext, status, lease_until, created_by, created_at, updated_at)
  SELECT id, workspace_id, provider, host, scope, kind, config_json, secret_ciphertext, status, lease_until, created_by, created_at, updated_at FROM push_identities;

-- Dropping the old table runs its ON DELETE actions (pending OAuth authorizations cascade, ledger rows lose their
-- identity), so both are kept aside and restored once the rebuilt table carries the same ids.
CREATE TEMP TABLE saved_push_oauth_states AS SELECT state_hash, identity_id, user_id, verifier, expires_at, created_at FROM push_oauth_states;
CREATE TEMP TABLE saved_push_credential_identities AS SELECT id, identity_id FROM push_credentials WHERE identity_id IS NOT NULL;
DROP TABLE push_identities;
ALTER TABLE push_identities_v2 RENAME TO push_identities;
INSERT INTO push_oauth_states (state_hash, identity_id, user_id, verifier, expires_at, created_at)
  SELECT state_hash, identity_id, user_id, verifier, expires_at, created_at FROM temp.saved_push_oauth_states;
UPDATE push_credentials SET identity_id = (SELECT saved.identity_id FROM temp.saved_push_credential_identities saved WHERE saved.id = push_credentials.id)
  WHERE id IN (SELECT id FROM temp.saved_push_credential_identities);
DROP TABLE temp.saved_push_oauth_states;
DROP TABLE temp.saved_push_credential_identities;

-- The rebuilt table keeps every referenced id; clear deferred DROP bookkeeping.
PRAGMA defer_foreign_keys = OFF;
