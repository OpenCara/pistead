-- pistead: foreign-keys-off
-- Plain Git servers (provider 'git'): any HTTPS Git server without a forge API, connected with a user name and a password
-- or token. Accounts, repository bindings and push access may name it. SQLite cannot change a CHECK constraint in place,
-- so the three tables are rebuilt with the same rows and ids. The runner applies this migration with foreign keys off
-- (the first line), so dropping a table runs no ON DELETE action on the rows that reference it, and checks every
-- reference before it commits.

CREATE TABLE git_credentials_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git')),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  organization TEXT NOT NULL DEFAULT '' CHECK (length(organization) <= 50),
  username TEXT CHECK (username IS NULL OR length(username) BETWEEN 1 AND 254),
  login TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider, host, organization)
);
INSERT INTO git_credentials_v2 (id, user_id, provider, host, organization, username, login, ciphertext, created_at, updated_at)
  SELECT id, user_id, provider, host, organization, username, login, ciphertext, created_at, updated_at FROM git_credentials;
DROP TABLE git_credentials;
ALTER TABLE git_credentials_v2 RENAME TO git_credentials;

-- The trigger on workspace_sources names workspace_repositories; it is dropped while that table is replaced.
DROP TRIGGER workspace_sources_git_binding;
CREATE TABLE workspace_repositories_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github'
    CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git')),
  host TEXT NOT NULL DEFAULT 'github.com' CHECK (length(host) BETWEEN 1 AND 253 AND (provider <> 'github' OR host = 'github.com')),
  -- TEXT affinity stores numeric input as decimal text.
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 100
    AND (provider <> 'github' OR (repository_id NOT GLOB '*[^0-9]*' AND repository_id NOT GLOB '0*' AND length(repository_id) <= 16))),
  full_name TEXT NOT NULL COLLATE NOCASE,
  ref TEXT NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, host, repository_id),
  UNIQUE (workspace_id, provider, host, full_name)
);
-- Copied before the triggers exist, so the rows don't add workspace sources again.
INSERT INTO workspace_repositories_v2 (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
  SELECT id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at FROM workspace_repositories;
DROP TABLE workspace_repositories;
ALTER TABLE workspace_repositories_v2 RENAME TO workspace_repositories;
CREATE TRIGGER workspace_repositories_limit BEFORE INSERT ON workspace_repositories
WHEN (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = NEW.workspace_id) >= 5 BEGIN
  SELECT RAISE(ABORT, 'workspace repository limit reached');
END;
CREATE TRIGGER workspace_repositories_immutable BEFORE UPDATE ON workspace_repositories BEGIN
  SELECT RAISE(ABORT, 'workspace repository bindings are immutable');
END;
CREATE TRIGGER workspace_repositories_source AFTER INSERT ON workspace_repositories BEGIN
  INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
    VALUES (NEW.id, NEW.workspace_id, 'git', NEW.id, NEW.created_at);
END;
CREATE TRIGGER workspace_sources_git_binding BEFORE INSERT ON workspace_sources
WHEN NEW.kind = 'git' AND NOT EXISTS (SELECT 1 FROM workspace_repositories
  WHERE id = NEW.repository_binding_id AND workspace_id = NEW.workspace_id) BEGIN
  SELECT RAISE(ABORT, 'a git source needs its workspace repository');
END;

-- A plain Git server has no app or bot identity: only the session owner's account or the host's Git credentials push.
CREATE TABLE push_identities_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git')),
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
DROP TABLE push_identities;
ALTER TABLE push_identities_v2 RENAME TO push_identities;
