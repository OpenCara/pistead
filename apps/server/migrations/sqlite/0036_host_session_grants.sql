-- A host command grant may also let its member start their own sessions directly on the host, without the sandbox
-- (HostCommandGrant.hostSessions in packages/shared/src/connector.ts), where the host's configuration accepts those
-- (connector_configs.host_sessions). 0 keeps them in the sandbox, as every grant did before.
ALTER TABLE connector_host_grants ADD COLUMN host_sessions INTEGER NOT NULL DEFAULT 0 CHECK (host_sessions IN (0, 1));
