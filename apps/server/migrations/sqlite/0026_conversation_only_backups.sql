-- 1 for backups that keep only the session's conversation (Pi's SQLite and the runner's state), without its files or
-- clones; 0 for full backups. A restore of one starts with an empty worktree.
ALTER TABLE backups ADD COLUMN conversation_only INTEGER NOT NULL DEFAULT 0 CHECK (conversation_only IN (0, 1));
