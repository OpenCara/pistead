-- Postgres translation of sqlite/0035_workspace_tool_output.sql.

-- The tool output new sessions in a workspace start with (sessions.tool_output), as its owners and admins chose it.
-- Each session's owner can still change their own session's afterwards; existing sessions keep theirs.
ALTER TABLE workspace_transcript_settings ADD COLUMN tool_output TEXT NOT NULL DEFAULT 'full' CHECK (tool_output IN ('full', 'brief'));
