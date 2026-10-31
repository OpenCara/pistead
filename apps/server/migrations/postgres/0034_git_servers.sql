-- Postgres translation of sqlite/0041_git_servers.sql.

-- Plain Git servers (provider 'git'): any HTTPS Git server without a forge API, connected with a user name and a password
-- or token. Accounts, repository bindings and push access may name it. The provider checks were declared inline, so their
-- names are Postgres' defaults; each is found by what it checks rather than by name. push_identities' kind check already
-- lets every provider use the owner's account or the host's Git credentials, the only push access a plain server has.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.conrelid::regclass::text AS relation, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN ('git_credentials'::regclass, 'workspace_repositories'::regclass, 'push_identities'::regclass)
      AND pg_get_constraintdef(c.oid) LIKE '%provider%gitea%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', item.relation, item.conname);
  END LOOP;
END
$$;
ALTER TABLE git_credentials ADD CONSTRAINT git_credentials_provider_check
  CHECK (provider IN ('github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git'));
ALTER TABLE workspace_repositories ADD CONSTRAINT workspace_repositories_provider_check
  CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git'));
ALTER TABLE push_identities ADD CONSTRAINT push_identities_provider_check
  CHECK (provider IN ('github', 'github-enterprise', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'git'));
