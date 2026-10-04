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

-- Bindings name a provider and host; repository identities become opaque strings (GitHub ids as decimal text).
CREATE TABLE workspace_repositories_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github'
    CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea')),
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
INSERT INTO workspace_repositories_v2 (id, workspace_id, provider, host, repository_id, full_name, ref, private, created_at)
  SELECT id, workspace_id, 'github', 'github.com', CAST(repository_id AS TEXT), full_name, ref, private, created_at FROM workspace_repositories;
DROP TABLE workspace_repositories;
ALTER TABLE workspace_repositories_v2 RENAME TO workspace_repositories;

-- SQLite serializes writers; enforce the cap in the same statement as the insert.
CREATE TRIGGER workspace_repositories_limit BEFORE INSERT ON workspace_repositories
WHEN (SELECT COUNT(*) FROM workspace_repositories WHERE workspace_id = NEW.workspace_id) >= 5 BEGIN
  SELECT RAISE(ABORT, 'workspace repository limit reached');
END;
CREATE TRIGGER workspace_repositories_immutable BEFORE UPDATE ON workspace_repositories BEGIN
  SELECT RAISE(ABORT, 'workspace repository bindings are immutable');
END;
