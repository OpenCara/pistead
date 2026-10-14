-- Tools the session owner allowed beyond the pinned agent's through a permission request: for the rest of the session
-- (call_id '') or for one tool call, whose command approval is 'tool-<call_id>'. Commands, pushes and comments for a tool
-- outside the agent are presented and decided only with a grant, so a host can't use a tool the owner never allowed.
CREATE TABLE session_tool_grants (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool TEXT NOT NULL,
  call_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, tool, call_id)
);
