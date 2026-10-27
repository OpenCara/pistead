import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";

/**
 * Every connector of this version carries host_bash, honors host command grants, lets the host's owner decide host
 * commands in any session on it they can read, runs the session owner's GitHub effects under Auto-approve, and lets the
 * session panel browse a session's worktree read-only; the control plane still offers each per host and session. On
 * Linux, where restores can be published, it also accepts sessions moved to it from another host.
 */
export function withHostToolCapabilities(capabilities: ConnectorCapabilities): ConnectorCapabilities {
  return { ...capabilities, hostCommands: true, hostGrants: true, hostOwnerDecides: true, automaticGitHub: true, fileBrowser: true,
    ...(process.platform === "linux" ? { hostMigration: true } : {}) };
}
