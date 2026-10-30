import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";

/**
 * Every connector of this version carries host_bash, honors host command grants (those that include sessions on the
 * host too, and the sandboxed commands of members holding one where the host has no resource limits), lets the host's
 * owner decide host commands in any session on it they can read, runs the session owner's GitHub effects under
 * Auto-approve, lets the session panel browse a session's worktree read-only, and carries the web tools (web_fetch,
 * web_search); the control plane still offers each per host and session. On Linux, where restores can be published, it also accepts sessions moved to it from another host.
 */
export function withHostToolCapabilities(capabilities: ConnectorCapabilities): ConnectorCapabilities {
  return { ...capabilities, hostCommands: true, hostGrants: true, hostSessionGrants: true, unboundedShellGrants: true, hostOwnerDecides: true,
    automaticGitHub: true, fileBrowser: true, web: true, ...(process.platform === "linux" ? { hostMigration: true } : {}) };
}
