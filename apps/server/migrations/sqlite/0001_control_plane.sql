PRAGMA foreign_keys = ON;

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
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
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
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('faux', 'openai', 'anthropic')),
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
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
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id),
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, version)
);
CREATE INDEX agent_versions_workspace ON agent_versions(workspace_id, author_id);
CREATE TRIGGER agent_versions_immutable_update BEFORE UPDATE ON agent_versions BEGIN
  SELECT RAISE(ABORT, 'agent versions are immutable');
END;
CREATE TRIGGER agent_versions_immutable_delete BEFORE DELETE ON agent_versions BEGIN
  SELECT RAISE(ABORT, 'agent versions are immutable');
END;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  agent_version_id TEXT NOT NULL REFERENCES agent_versions(id),
  title TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'error', 'archived')),
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_workspace ON sessions(workspace_id, owner_id);
CREATE TRIGGER sessions_owner_immutable BEFORE UPDATE OF owner_id, workspace_id, agent_version_id ON sessions BEGIN
  SELECT RAISE(ABORT, 'session binding is immutable');
END;
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
  expires_at INTEGER NOT NULL,
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
  size INTEGER NOT NULL,
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
