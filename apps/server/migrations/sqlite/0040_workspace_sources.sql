-- What a workspace's sessions work on: its sources (docs/design/external-sources.md). A Git repository is one kind of
-- source; its details, push policy, LFS and cache stay in workspace_repositories. Every source of a workspace is in the
-- grant of every session in it. Workspace-level checks ("at least one source", "the sources didn't change before this
-- insert") read this table; Git-specific code keeps reading workspace_repositories.
--
-- A 'git' source has the id of its repository and references it, so removing the repository (or its workspace) removes
-- the source. The trigger below adds it with the repository, whichever path inserts one. Other kinds come with their
-- own detail tables and have no repository.
CREATE TABLE workspace_sources (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'notion', 'google-drive', 'feishu', 'dropbox', 'onedrive', 'tencent-docs')),
  repository_binding_id TEXT UNIQUE REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'git') = (repository_binding_id IS NOT NULL)),
  CHECK (kind <> 'git' OR repository_binding_id = id)
);
CREATE INDEX workspace_sources_workspace ON workspace_sources (workspace_id, id);

INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
  SELECT id, workspace_id, 'git', id, created_at FROM workspace_repositories;

CREATE TRIGGER workspace_repositories_source AFTER INSERT ON workspace_repositories BEGIN
  INSERT INTO workspace_sources (id, workspace_id, kind, repository_binding_id, created_at)
    VALUES (NEW.id, NEW.workspace_id, 'git', NEW.id, NEW.created_at);
END;
-- A 'git' source belongs to the workspace of its repository.
CREATE TRIGGER workspace_sources_git_binding BEFORE INSERT ON workspace_sources
WHEN NEW.kind = 'git' AND NOT EXISTS (SELECT 1 FROM workspace_repositories
  WHERE id = NEW.repository_binding_id AND workspace_id = NEW.workspace_id) BEGIN
  SELECT RAISE(ABORT, 'a git source needs its workspace repository');
END;
CREATE TRIGGER workspace_sources_immutable BEFORE UPDATE ON workspace_sources BEGIN
  SELECT RAISE(ABORT, 'workspace sources are immutable');
END;

-- Connected accounts of kinds other than Git (Git accounts are git_credentials and the GitHub sign-in): one per user and
-- provider. The secret (a Notion integration secret, a Google service account key, a Feishu/Lark app's id and secret)
-- is vault-encrypted with the user id as AAD, like Git tokens, and never leaves the server: sessions read their owner's
-- sources through the control plane (source_read).
CREATE TABLE source_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('notion', 'google-drive', 'feishu', 'dropbox', 'onedrive', 'tencent-docs')),
  ciphertext TEXT NOT NULL,
  -- What the provider calls the account (a Notion workspace, a service account's email, an app id), as verified.
  account_name TEXT NOT NULL CHECK (length(account_name) BETWEEN 1 AND 300),
  -- 'secret': pasted by the member; 'oauth': the member signed in to the provider, and the ciphertext holds its tokens.
  method TEXT NOT NULL DEFAULT 'secret' CHECK (method IN ('secret', 'oauth')),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, provider)
);

-- The item a document source binds: the detail of every source that isn't a Git repository. Sessions read it and what
-- is under it with their owner's own account of the same kind. Removing the source removes it.
CREATE TABLE document_sources (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_sources(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notion', 'google-drive', 'feishu', 'dropbox', 'onedrive', 'tencent-docs')),
  item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  item_type TEXT NOT NULL CHECK (item_type IN ('page', 'database', 'folder', 'document', 'spreadsheet', 'presentation', 'file', 'wiki')),
  title TEXT NOT NULL CHECK (length(title) <= 300),
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  created_by TEXT NOT NULL,
  UNIQUE (workspace_id, kind, item_id)
);
CREATE TRIGGER document_sources_kind BEFORE INSERT ON document_sources
WHEN NOT EXISTS (SELECT 1 FROM workspace_sources WHERE id = NEW.source_id AND workspace_id = NEW.workspace_id AND kind = NEW.kind) BEGIN
  SELECT RAISE(ABORT, 'a document source needs its workspace source');
END;
CREATE TRIGGER document_sources_immutable BEFORE UPDATE ON document_sources BEGIN
  SELECT RAISE(ABORT, 'workspace sources are immutable');
END;

-- A member's sign-in to a source provider under way: the state Pistead sent and its PKCE verifier, for one user and
-- provider, until the provider redirects back (at most 10 minutes). The browser carries the state in a cookie too.
CREATE TABLE source_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('notion', 'google-drive', 'dropbox', 'onedrive', 'tencent-docs')),
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
