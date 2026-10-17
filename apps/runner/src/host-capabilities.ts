import type { ConnectorCapabilities } from "../../../packages/shared/src/connector.js";

/** Every connector of this version carries host_bash and git_repin; the control plane still offers each per host and session. */
export function withHostToolCapabilities(capabilities: ConnectorCapabilities): ConnectorCapabilities {
  return { ...capabilities, hostCommands: true, gitRepin: true };
}
