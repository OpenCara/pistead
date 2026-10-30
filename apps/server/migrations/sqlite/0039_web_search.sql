-- Whether a workspace's agents may search the web with web_search, through the search provider the server's operator
-- configured (WEB_SEARCH). Off by default: each query leaves for that provider. web_fetch needs no setting of its own: it
-- reaches what the workspace's network access lets sandboxed commands reach.
ALTER TABLE workspace_network_policies ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0 CHECK (web_search IN (0, 1));
