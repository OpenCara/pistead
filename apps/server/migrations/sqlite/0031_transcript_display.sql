-- How transcripts leave the control plane (packages/shared/src/transcript-display.ts). Display only: neither is part of a
-- session's runner binding or policy, and hosts keep sending whole transcripts.
-- 'brief': everyone viewing the session sees each tool result's first line and long tool calls cut short.
ALTER TABLE sessions ADD COLUMN tool_output TEXT NOT NULL DEFAULT 'full' CHECK (tool_output IN ('full', 'brief'));
-- 1: session views hold each conversation's latest entries, and clients read earlier ones as people scroll up.
ALTER TABLE workspaces ADD COLUMN transcript_paging INTEGER NOT NULL DEFAULT 0 CHECK (transcript_paging IN (0, 1));
