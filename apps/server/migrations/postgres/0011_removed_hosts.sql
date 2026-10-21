-- Retain immutable session/model references after a host is removed.
ALTER TABLE connectors ADD COLUMN removed_at TEXT;
