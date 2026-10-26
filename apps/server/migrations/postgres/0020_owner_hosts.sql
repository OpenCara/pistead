-- Postgres translation of sqlite/0027_owner_hosts.sql.

-- A host belongs to its owner, not to the workspace it was paired into: connect every active host, for its owner's
-- private use, to every workspace its owner belongs to, and offer its models there. Sharing is unchanged.
INSERT INTO connector_workspaces (connector_id, workspace_id, created_at)
  SELECT c.id, m.workspace_id, m.created_at FROM connectors c
  JOIN workspace_members m ON m.user_id = c.owner_id
  WHERE c.revoked_at IS NULL
  ON CONFLICT (connector_id, workspace_id) DO NOTHING;

INSERT INTO models (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
  SELECT replace(gen_random_uuid()::text, '-', ''), cw.workspace_id, local.value #>> '{name}',
    local.value #>> '{provider}', local.value #>> '{modelId}', cw.created_at, c.id, c.owner_id, 1
  FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
  JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
  CROSS JOIN jsonb_array_elements(c.models_json::jsonb) AS local(value)
  WHERE c.revoked_at IS NULL
  ON CONFLICT (workspace_id, connector_id, provider, model_id) DO NOTHING;
