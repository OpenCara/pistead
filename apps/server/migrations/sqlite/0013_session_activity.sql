-- What the session's agent is doing, as its host last reported it (SessionActivity); NULL until a host reports it.
ALTER TABLE sessions ADD COLUMN activity TEXT
  CHECK (activity IS NULL OR activity IN ('idle', 'working', 'waiting', 'done', 'failed'));
