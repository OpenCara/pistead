-- Workspace push identities: app or bot credentials, managed by workspace owners and admins, that mint short-lived
-- push tokens. Secrets are vault-encrypted with 'push-identity:<id>' as AAD and never leave the control plane.
CREATE TABLE push_identities (
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
    (kind = 'forgejo-integration' AND provider = 'gitea')),
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

-- Single-use OAuth authorization requests for oauth-refresh identities (PKCE verifier kept server-side).
CREATE TABLE push_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  identity_id TEXT NOT NULL REFERENCES push_identities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Workspace repository bindings are immutable; their push policy lives beside them.
CREATE TABLE repository_push_policies (
  binding_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  forbid_default_branch INTEGER NOT NULL CHECK (forbid_default_branch IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- One minted credential per approved push. The operation is stored so completion can open the requested pull request.
CREATE TABLE push_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  -- NULL when the operator's GitHub App minted the token.
  identity_id TEXT REFERENCES push_identities(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  -- Automatic pushes only: the auto-approve run admission that authorized them (bounds pushes per admission).
  admission_id TEXT CHECK ((automatic = 1) = (admission_id IS NOT NULL)),
  -- Revocable tokens (GitHub installation tokens) are kept vault-encrypted with 'push-credential:<id>' as AAD until revoked.
  revocation_ciphertext TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  -- 'unknown': the push failed during or after upload, so the branch may have moved.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('pushed', 'up-to-date', 'failed', 'unknown')),
  tip TEXT CHECK (tip IS NULL OR (length(tip) = 40 AND tip NOT GLOB '*[^0-9a-f]*')),
  pull_request_url TEXT,
  UNIQUE (session_id, approval_id)
);
CREATE INDEX push_credentials_expiry ON push_credentials(expires_at) WHERE completed_at IS NULL;
CREATE INDEX push_credentials_admission ON push_credentials(admission_id) WHERE admission_id IS NOT NULL;

-- The owner's per-message access choice, so the control plane can confirm an automatic (auto-approve) push.
ALTER TABLE run_admissions ADD COLUMN access TEXT CHECK (access IS NULL OR access IN ('read', 'approval', 'auto'));
