-- How transcripts leave the control plane (packages/shared/src/transcript-display.ts). Display only: neither is part of a
-- session's runner binding or policy, and hosts keep sending whole transcripts.
-- 'brief': everyone viewing the session sees each tool result's first line and long tool calls cut short.
ALTER TABLE sessions ADD COLUMN tool_output TEXT NOT NULL DEFAULT 'full' CHECK (tool_output IN ('full', 'brief'));
-- A workspace's transcript settings, as its owners and admins chose them; no row: the defaults (paging off).
-- paging 1: session views hold each conversation's latest entries, and clients read earlier ones as people scroll up.
CREATE TABLE workspace_transcript_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  paging INTEGER NOT NULL DEFAULT 0 CHECK (paging IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
