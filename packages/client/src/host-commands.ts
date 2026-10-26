import type { ConnectorInfo } from "../../shared/src/connector";
import type { Operation, SessionRecord } from "../../shared/src/types";

/**
 * Whether an operation runs outside the sandbox, on the session's host, as a host command: `host_bash`, or any command
 * of a session that runs directly on its host (SessionRecord.hostEnvironment). Only someone with host command authority
 * decides one (see `decidesHostCommands`); approve permission on the session isn't enough.
 */
export function isHostCommand(operation: Pick<Operation, "kind">, session: Pick<SessionRecord, "hostEnvironment">): boolean {
  return operation.kind === "host.bash" || (operation.kind === "bash" && session.hostEnvironment === true);
}

/**
 * Whether `userId` holds host command authority in the session, as the control plane checks it before a host command is
 * decided: they own the session's host, or its owner or one of its admins granted them host commands in the session's
 * workspace. `host` is the session's host as that workspace's host listing reports it to them (its `hostCommandAccess`);
 * before the listing loads, only the host's owner is known.
 */
export function decidesHostCommands(session: Pick<SessionRecord, "connectorOwnerId">, host: Pick<ConnectorInfo, "hostCommandAccess"> | undefined,
  userId: string): boolean {
  return (session.connectorOwnerId !== undefined && session.connectorOwnerId === userId) || host?.hostCommandAccess !== undefined;
}

/** What a host command's card says while it waits for someone who may decide it. */
export const HOST_COMMAND_WAITING = "Waiting for the host's owner, or a member granted host commands, with approve access to this session";
