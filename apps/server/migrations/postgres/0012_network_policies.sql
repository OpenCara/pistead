-- Postgres translation of sqlite/0019_network_policies.sql.
CREATE TABLE workspace_network_policies (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'allowlist', 'open')),
  domains_json TEXT NOT NULL DEFAULT '[]',
  package_registries BIGINT NOT NULL CHECK (package_registries IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
