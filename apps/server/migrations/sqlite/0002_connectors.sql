-- D1 applies migrations in a transaction; defer references while replacing models.
PRAGMA defer_foreign_keys = ON;

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
  expires_at INTEGER NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX connector_pairings_owner ON connector_pairings(owner_id, expires_at);

CREATE TABLE connector_shares (
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, workspace_id)
);
CREATE INDEX connector_shares_workspace ON connector_shares(workspace_id, connector_id);

ALTER TABLE sessions ADD COLUMN connector_id TEXT REFERENCES connectors(id);
ALTER TABLE sessions ADD COLUMN connector_owner_id TEXT REFERENCES users(id);
CREATE TRIGGER sessions_connector_pair_insert BEFORE INSERT ON sessions
WHEN (NEW.connector_id IS NULL) != (NEW.connector_owner_id IS NULL) BEGIN
  SELECT RAISE(ABORT, 'session connector binding must be paired');
END;
CREATE TRIGGER sessions_connector_immutable BEFORE UPDATE OF connector_id, connector_owner_id ON sessions BEGIN
  SELECT RAISE(ABORT, 'session connector binding is immutable');
END;

-- Do not rename the old table: existing agent_versions FKs must keep naming models.
CREATE TABLE models_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  connector_id TEXT REFERENCES connectors(id),
  connector_owner_id TEXT REFERENCES users(id),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  CHECK ((connector_id IS NULL) = (connector_owner_id IS NULL))
);
INSERT INTO models_new (id, workspace_id, name, provider, model_id, created_at)
  SELECT id, workspace_id, name, provider, model_id, created_at FROM models;
DROP TABLE models;
ALTER TABLE models_new RENAME TO models;
CREATE UNIQUE INDEX models_connector_identity ON models(workspace_id, connector_id, provider, model_id);
CREATE TRIGGER models_identity_immutable BEFORE UPDATE OF workspace_id, provider, model_id, connector_id, connector_owner_id ON models BEGIN
  SELECT RAISE(ABORT, 'model identity is immutable');
END;

-- The replacement preserves every referenced key; clear deferred DROP bookkeeping.
PRAGMA defer_foreign_keys = OFF;