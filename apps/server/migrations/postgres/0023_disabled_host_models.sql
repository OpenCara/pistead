-- Postgres translation of sqlite/0030_disabled_host_models.sql.

-- Models a host's owner or one of its admins disabled. The host still advertises them (Pi decides that), but no session
-- starts from one and no message switches to one, in any workspace. Kept by provider and model id, apart from the
-- advertised list, so a model the host stops advertising for a while stays disabled when it comes back.
CREATE TABLE connector_disabled_models (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  disabled_by TEXT NOT NULL REFERENCES users(id),
  disabled_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, provider, model_id)
);
