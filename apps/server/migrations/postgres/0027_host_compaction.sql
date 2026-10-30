-- Postgres translation of sqlite/0034_host_compaction.sql.

-- When a host's long conversations are summarized, as its owner and admins set it in Pistead (HostConfig.compaction in
-- packages/shared/src/host-config.ts): token counts for every model and per model, as JSON, over the host's Pi
-- settings. '{}' keeps those.
ALTER TABLE connector_configs ADD COLUMN compaction_json TEXT NOT NULL DEFAULT '{}';
