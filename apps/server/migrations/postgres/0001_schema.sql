-- Postgres translation of the SQLite migrations 0001..0008 (final shape, squashed).
-- Conventions: TEXT stays text, INTEGER becomes bigint (0/1 flags keep their CHECKs; never BOOLEAN),
-- COLLATE NOCASE columns are citext, GLOB checks are regexes, RAISE(ABORT, msg) triggers raise P0001 with the same message.

CREATE EXTENSION IF NOT EXISTS citext;

-- Every immutability trigger: RAISE EXCEPTION with the SQLite RAISE(ABORT, ...) message text.
CREATE FUNCTION pistead_raise() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END
$$;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  github_login TEXT,
  display_name TEXT NOT NULL,
  git_name TEXT NOT NULL,
  git_email TEXT NOT NULL,
  env_json TEXT NOT NULL DEFAULT '{}',
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('github', 'test')),
  created_at TEXT NOT NULL
);
CREATE TABLE github_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id, workspace_id);

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  connection_hash TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX connectors_owner ON connectors(owner_id);

CREATE TABLE connector_pairings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id)
);
CREATE INDEX connector_pairings_owner ON connector_pairings(owner_id, expires_at);

CREATE TABLE connector_shares (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, workspace_id)
);
CREATE INDEX connector_shares_workspace ON connector_shares(workspace_id, connector_id);

-- Connecting a host to a workspace does not grant teammates runtime access.
CREATE TABLE connector_workspaces (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, workspace_id)
);
CREATE INDEX connector_workspaces_workspace ON connector_workspaces(workspace_id, connector_id);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  connector_id TEXT REFERENCES connectors(id),
  connector_owner_id TEXT REFERENCES users(id),
  available BIGINT NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  CONSTRAINT models_connector_id_check CHECK ((connector_id IS NULL) = (connector_owner_id IS NULL))
);
CREATE UNIQUE INDEX models_connector_identity ON models(workspace_id, connector_id, provider, model_id);
CREATE TRIGGER models_identity_immutable BEFORE UPDATE OF workspace_id, provider, model_id, connector_id, connector_owner_id ON models
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('model identity is immutable');

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  version BIGINT NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id),
  created_at TEXT NOT NULL,
  -- Named: catalog.ts recognises a duplicate version by this constraint name.
  CONSTRAINT agent_versions_agent_id_version_key UNIQUE (agent_id, version)
);
CREATE INDEX agent_versions_workspace ON agent_versions(workspace_id, author_id);
CREATE TRIGGER agent_versions_immutable_update BEFORE UPDATE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('agent versions are immutable');
CREATE TRIGGER agent_versions_immutable_delete BEFORE DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('agent versions are immutable');

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  agent_version_id TEXT NOT NULL REFERENCES agent_versions(id),
  title TEXT NOT NULL,
  policy_version BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'error', 'archived')),
  created_at TEXT NOT NULL,
  connector_id TEXT REFERENCES connectors(id),
  connector_owner_id TEXT REFERENCES users(id),
  repositories_json TEXT NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(repositories_json::jsonb) = 'array'),
  -- Existing sessions stay private; the creation API opts new sessions into workspace read access.
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace'))
);
CREATE INDEX sessions_workspace ON sessions(workspace_id, owner_id);
CREATE INDEX sessions_admission_owner ON sessions(owner_id, id);
CREATE TRIGGER sessions_owner_immutable BEFORE UPDATE OF owner_id, workspace_id, agent_version_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('session binding is immutable');
CREATE TRIGGER sessions_connector_pair_insert BEFORE INSERT ON sessions
  FOR EACH ROW WHEN ((NEW.connector_id IS NULL) <> (NEW.connector_owner_id IS NULL))
  EXECUTE FUNCTION pistead_raise('session connector binding must be paired');
CREATE TRIGGER sessions_connector_immutable BEFORE UPDATE OF connector_id, connector_owner_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('session connector binding is immutable');
CREATE TRIGGER sessions_repositories_immutable BEFORE UPDATE OF repositories_json ON sessions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('session repositories are immutable');

CREATE TABLE session_grants (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX session_grants_user ON session_grants(user_id, session_id);

CREATE TABLE broker_capabilities (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  operation_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX broker_capabilities_approval ON broker_capabilities(session_id, approval_id);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX backups_session ON backups(session_id, created_at);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  session_id TEXT REFERENCES sessions(id),
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_workspace ON audit(workspace_id, created_at);
CREATE INDEX audit_session ON audit(session_id, created_at);

CREATE TABLE restore_jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  backup_id TEXT NOT NULL REFERENCES backups(id),
  target_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  request_title TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 43),
  size BIGINT NOT NULL CHECK (size > 0 AND size <= 25165824),
  binding_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  download_token_hash TEXT,
  download_expires_at BIGINT NOT NULL DEFAULT 0,
  lease_until BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (owner_id, request_id),
  CONSTRAINT restore_jobs_target_session_id_check CHECK (target_session_id <> source_session_id),
  CONSTRAINT restore_jobs_download_token_hash_check CHECK (download_token_hash IS NULL OR length(download_token_hash) = 43)
);
CREATE INDEX restore_jobs_source ON restore_jobs(source_session_id, created_at);
CREATE TRIGGER restore_jobs_binding_immutable
  BEFORE UPDATE OF id, request_id, owner_id, workspace_id, source_session_id, backup_id,
    target_session_id, request_title, sha256, size, binding_json, created_at ON restore_jobs
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('restore binding is immutable');
CREATE TRIGGER restore_jobs_completed_immutable BEFORE UPDATE ON restore_jobs
  FOR EACH ROW WHEN (OLD.status = 'completed')
  EXECUTE FUNCTION pistead_raise('completed restore receipt is immutable');
CREATE TRIGGER restore_jobs_receipt_retained BEFORE DELETE ON restore_jobs
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('restore receipts must be retained');

CREATE TABLE run_admissions (
  id TEXT PRIMARY KEY CHECK (length(id) = 43),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('write', 'ask')),
  request_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 43),
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  -- The owner's per-message access choice, so the control plane can confirm an automatic (auto-approve) push.
  access TEXT CHECK (access IS NULL OR access IN ('read', 'approval', 'auto')),
  UNIQUE (session_id, actor_id, request_id)
);
CREATE INDEX run_admissions_expiry ON run_admissions(session_id, actor_id, expires_at);
CREATE INDEX run_admissions_global_expiry ON run_admissions(expires_at);
CREATE INDEX run_admissions_actor_expiry ON run_admissions(actor_id, expires_at);
CREATE INDEX run_admissions_session_expiry ON run_admissions(session_id, expires_at);
CREATE TRIGGER run_admissions_immutable BEFORE UPDATE ON run_admissions
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('run admissions are immutable');

CREATE TABLE approval_reviews (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  approval_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('explicit', 'model')),
  admission_id TEXT REFERENCES run_admissions(id),
  operation_json TEXT NOT NULL,
  review_hash TEXT NOT NULL CHECK (length(review_hash) = 43),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, approval_id),
  CONSTRAINT approval_reviews_admission_id_check CHECK ((source = 'explicit' AND admission_id IS NULL) OR (source = 'model' AND admission_id IS NOT NULL))
);
CREATE TRIGGER approval_reviews_immutable_update BEFORE UPDATE ON approval_reviews
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('approval reviews are immutable');
CREATE TRIGGER approval_reviews_immutable_delete BEFORE DELETE ON approval_reviews
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('approval reviews must be retained');

-- Bindings name a provider and host; repository identities are opaque strings (GitHub ids as decimal text).
CREATE TABLE workspace_repositories (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github'
    CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea')),
  host TEXT NOT NULL DEFAULT 'github.com' CONSTRAINT workspace_repositories_host_check CHECK (length(host) BETWEEN 1 AND 253 AND (provider <> 'github' OR host = 'github.com')),
  repository_id TEXT NOT NULL CONSTRAINT workspace_repositories_repository_id_check CHECK (length(repository_id) BETWEEN 1 AND 100
    AND (provider <> 'github' OR (repository_id ~ '^[0-9]*$' AND repository_id !~ '^0' AND length(repository_id) <= 16))),
  full_name CITEXT NOT NULL,
  ref TEXT NOT NULL,
  private BIGINT NOT NULL CHECK (private IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, host, repository_id),
  UNIQUE (workspace_id, provider, host, full_name)
);
-- SQLite serializes writers; here the per-workspace advisory lock keeps the cap exact under concurrent inserts.
CREATE FUNCTION workspace_repositories_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('workspace_repositories:' || NEW.workspace_id));
  IF (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = NEW.workspace_id) >= 5 THEN
    RAISE EXCEPTION 'workspace repository limit reached';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspace_repositories_limit BEFORE INSERT ON workspace_repositories
  FOR EACH ROW EXECUTE FUNCTION workspace_repositories_limit();
CREATE TRIGGER workspace_repositories_immutable BEFORE UPDATE ON workspace_repositories
  FOR EACH ROW EXECUTE FUNCTION pistead_raise('workspace repository bindings are immutable');

-- Personal access tokens for Git providers other than github.com (which keeps the sign-in OAuth token).
-- One account per user, provider, host and Azure DevOps organization; the token is vault-encrypted with the user id as AAD.
CREATE TABLE git_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea')),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  organization TEXT NOT NULL DEFAULT '' CHECK (length(organization) <= 50),
  username TEXT CHECK (username IS NULL OR length(username) BETWEEN 1 AND 254),
  login TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider, host, organization)
);

-- Workspace push identities: app or bot credentials, managed by workspace owners and admins, that mint short-lived
-- push tokens. Secrets are vault-encrypted with 'push-identity:<id>' as AAD and never leave the control plane.
CREATE TABLE push_identities (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea')),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  -- Azure DevOps organization or Bitbucket workspace (lowercase); empty when the identity covers the whole host.
  scope TEXT NOT NULL DEFAULT '' CHECK (length(scope) <= 100),
  kind TEXT NOT NULL CONSTRAINT push_identities_kind_check CHECK (
    (kind = 'github-app' AND provider IN ('github', 'github-enterprise')) OR
    (kind = 'entra-federation' AND provider = 'azure-devops') OR
    (kind = 'bitbucket-client-credentials' AND provider = 'bitbucket') OR
    (kind = 'oauth-refresh' AND provider IN ('gitlab', 'gitea')) OR
    (kind = 'forgejo-integration' AND provider = 'gitea')),
  config_json TEXT NOT NULL CHECK (jsonb_typeof(config_json::jsonb) = 'object' AND length(config_json) <= 4096),
  secret_ciphertext TEXT CHECK (secret_ciphertext IS NULL OR length(secret_ciphertext) <= 22000),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'authorization_required')),
  -- oauth-refresh only: serializes refresh-token rotation across concurrent pushes (unix seconds).
  lease_until BIGINT,
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
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);

-- Workspace repository bindings are immutable; their push policy lives beside them.
CREATE TABLE repository_push_policies (
  binding_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  forbid_default_branch BIGINT NOT NULL CHECK (forbid_default_branch IN (0, 1)),
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
  operation_json TEXT NOT NULL CHECK ((operation_json::jsonb) IS NOT NULL),
  automatic BIGINT NOT NULL CHECK (automatic IN (0, 1)),
  -- Automatic pushes only: the auto-approve run admission that authorized them (bounds pushes per admission).
  admission_id TEXT CONSTRAINT push_credentials_admission_id_check CHECK ((automatic = 1) = (admission_id IS NOT NULL)),
  -- Revocable tokens (GitHub installation tokens) are kept vault-encrypted with 'push-credential:<id>' as AAD until revoked.
  revocation_ciphertext TEXT,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  -- 'unknown': the push failed during or after upload, so the branch may have moved.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('pushed', 'up-to-date', 'failed', 'unknown')),
  tip TEXT CHECK (tip IS NULL OR (length(tip) = 40 AND tip ~ '^[0-9a-f]*$')),
  pull_request_url TEXT,
  UNIQUE (session_id, approval_id)
);
CREATE INDEX push_credentials_expiry ON push_credentials(expires_at) WHERE completed_at IS NULL;
CREATE INDEX push_credentials_admission ON push_credentials(admission_id) WHERE admission_id IS NOT NULL;
