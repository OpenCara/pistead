-- The branches a session that runs directly on a host has checked out in its clones of the workspace's github.com
-- repositories, as its host reports them (session-branches.ts). Such a session pushes and opens pull requests with the
-- host's own Git and credentials rather than through Pistead, so the control plane finds the pull request of each
-- branch on GitHub with the session owner's account, and reads its state, as for pull requests a push recorded.
-- Display state only.
CREATE TABLE session_branches (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- owner/name of the workspace repository, as the workspace binds it.
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  -- The newest pull request from the branch, opened since the session was created, once one is found.
  pull_request_url TEXT,
  pull_request_state TEXT
    CHECK (pull_request_state IS NULL OR pull_request_state IN ('draft', 'open', 'failing', 'changes_requested', 'merged', 'closed')),
  -- When that pull request was first found here: the session shows the one found last.
  pull_request_found_at TEXT,
  -- When GitHub was last asked about the branch.
  pull_request_checked_at TEXT,
  PRIMARY KEY (session_id, repository, branch)
);
CREATE INDEX session_branches_session_pull ON session_branches(session_id, pull_request_found_at) WHERE pull_request_url IS NOT NULL;
