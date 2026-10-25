-- Postgres translation of sqlite/0023_member_roles.sql.
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'collaborator', 'member', 'viewer'));
