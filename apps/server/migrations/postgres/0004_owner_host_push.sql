-- Push access can also use the session owner's own account or the host's own Git credentials, for any provider.
ALTER TABLE push_identities DROP CONSTRAINT push_identities_kind_check;
ALTER TABLE push_identities ADD CONSTRAINT push_identities_kind_check CHECK (
  (kind = 'github-app' AND provider IN ('github', 'github-enterprise')) OR
  (kind = 'entra-federation' AND provider = 'azure-devops') OR
  (kind = 'bitbucket-client-credentials' AND provider = 'bitbucket') OR
  (kind = 'oauth-refresh' AND provider IN ('gitlab', 'gitea')) OR
  (kind = 'forgejo-integration' AND provider = 'gitea') OR
  kind IN ('owner-account', 'host-credentials'));
