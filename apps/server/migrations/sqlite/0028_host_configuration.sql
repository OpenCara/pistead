-- How a host runs its sessions, set in Pistead by its owner and admins instead of connector options (HostConfig in
-- packages/shared/src/host-config.ts). No row means the defaults. Connectors that take their configuration from Pistead
-- (capability hostConfig) read it; older ones keep their options.
CREATE TABLE connector_configs (
  connector_id TEXT PRIMARY KEY NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  command_timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK (command_timeout_seconds BETWEEN 30 AND 3600),
  gpu INTEGER NOT NULL DEFAULT 0 CHECK (gpu IN (0, 1)),
  git_credentials INTEGER NOT NULL DEFAULT 0 CHECK (git_credentials IN (0, 1)),
  repository_cache TEXT NOT NULL DEFAULT 'off' CHECK (repository_cache IN ('off', 'host', 'owner')),
  -- Null for a configuration carried over from a host's connect options, below.
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- A host whose last connection was started with --git-credentials or --repo-cache keeps them once its connector takes
-- its configuration from Pistead. Capabilities don't say which cache scope it used: it keeps one for the whole host.
INSERT INTO connector_configs (connector_id, git_credentials, repository_cache, updated_by, updated_at)
  SELECT id,
    CASE WHEN json_extract(capabilities_json, '$.gitCredentials') = 1 THEN 1 ELSE 0 END,
    CASE WHEN json_extract(capabilities_json, '$.repositoryCache') = 1 THEN 'host' ELSE 'off' END,
    NULL, COALESCE(last_seen_at, created_at)
  FROM connectors
  WHERE json_extract(capabilities_json, '$.gitCredentials') = 1 OR json_extract(capabilities_json, '$.repositoryCache') = 1;
