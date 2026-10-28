-- Postgres translation of sqlite/0037_cross_session_messages.sql.

-- Cross-session communication (cross-session.ts): what one session's agent sent another with the sessions tool, as the
-- person whose message it worked on. Each row is one delivered message (a side ask, a shared message, a new session's
-- opening message) or a notification back to its origin once the target finished one.
CREATE TABLE session_messages (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  origin_session_id TEXT NOT NULL REFERENCES sessions(id),
  target_session_id TEXT NOT NULL REFERENCES sessions(id),
  -- The person it was sent as: the sender of the origin's message whose tool call sent it.
  actor_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'send', 'create', 'notify')),
  -- The origin message's write admission and tool call; null for notifications, which the server sends.
  origin_admission_id TEXT,
  origin_call_id TEXT,
  -- The target's submission and conversation, which its outcome is read from.
  submission_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- How far down a chain of messages it is (1: sent from a message a person sent), and the sessions it came through
  -- (a JSON array of session ids, oldest first), so a chain never loops back.
  hops BIGINT NOT NULL CHECK (hops >= 1),
  chain_json TEXT NOT NULL DEFAULT '[]',
  access TEXT CHECK (access IS NULL OR access IN ('read', 'approval', 'auto')),
  -- A notification goes back to the origin once the target finished it.
  notify_status TEXT CHECK (notify_status IS NULL OR notify_status IN ('pending', 'delivered', 'failed', 'expired')),
  notify_error TEXT,
  notify_message_id TEXT,
  -- For a notification: the message whose outcome it reports.
  reply_to TEXT REFERENCES session_messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX session_messages_origin ON session_messages (origin_session_id, created_at);
CREATE INDEX session_messages_target ON session_messages (target_session_id, created_at);
CREATE INDEX session_messages_admission ON session_messages (origin_admission_id);
-- The notification sweep's order.
CREATE INDEX session_messages_notify ON session_messages (updated_at, id) WHERE notify_status = 'pending';

-- The session whose agent started this one with the sessions tool; null for every other session. Immutable.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id);
CREATE INDEX sessions_parent ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;
