import type { GitRepinOperation, HostCommandOperation } from "./types.js";

// Declared next to their operations, by interface merging, so the base capability list stays as it was.
declare module "./connector.js" {
  interface ConnectorCapabilities {
    /** The connector runs host_bash commands outside the sandbox, each approved by the host's owner. Absent on older connectors. */
    hostCommands?: boolean;
  }
}

/** What deciding a session's operations needs to know of the session: its owner, its host's owner, and where it runs. */
export interface HostCommandSession {
  ownerId?: string;
  /** The owner of the session's host; absent where none is recorded. */
  connectorOwnerId?: string | null;
  /** The session runs directly on its host (SessionRecord.hostEnvironment), not in the sandbox. */
  hostEnvironment?: boolean;
}

/**
 * Whether a command without the resource limits the session's host lacks (ApprovalRecord.unbounded) runs there on the
 * strength of the session owner's host command grant: in a session whose owner isn't the host's owner, who lets their
 * own commands run so with a permission request. A member the host's owner granted host commands can already run any
 * command on the host itself, so theirs may run in the sandbox without limits too, as host commands do: only while they
 * hold the grant, decided only by someone with host command authority (see decidedAsHostCommand), and without approval
 * only for a member holding automatic host commands.
 */
export function grantedShell(session: HostCommandSession): boolean {
  return session.connectorOwnerId !== session.ownerId;
}

/**
 * Whether deciding `operation` takes host command authority on the session's host: its owner's, or a member's its owner
 * or one of its admins granted host commands, as the control plane reports it (hostAuthority). Those are host_bash and
 * every command of a session that runs directly on its host, which run outside the sandbox, and a command without the
 * limits the host lacks (`unbounded`) that runs on the strength of a grant (see grantedShell), which still runs in the
 * sandbox, as the session's owner. The control plane, the host and the apps all decide by this one rule, so none of
 * them offers or takes a decision another refuses. Such an operation runs without approval only for a session owner
 * who holds automatic host commands there.
 */
export function decidedAsHostCommand(operation: { kind: string }, session: HostCommandSession, unbounded = false): boolean {
  if (operation.kind === "host.bash") return true;
  return operation.kind === "bash" && (session.hostEnvironment === true || (unbounded && grantedShell(session)));
}

export function validRepinRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !/[\s\x00-\x1f\x7f\\~^:?*\[]/.test(value) && !/[\uD800-\uDFFF]/u.test(value)
    && value !== "@" && !value.includes("..") && !value.includes("@{") && !value.endsWith(".")
    && !value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

export function validHostOperation(value: unknown): value is HostCommandOperation | GitRepinOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  if (op.kind === "host.bash") return Object.keys(op).sort().join() === "command,kind,timeoutSeconds"
    && typeof op.command === "string" && !!op.command.trim() && op.command.length <= 8192 && !op.command.includes("\0")
    && Number.isSafeInteger(op.timeoutSeconds) && Number(op.timeoutSeconds) >= 1 && Number(op.timeoutSeconds) <= 3600;
  return op.kind === "git.repin" && Object.keys(op).sort().join() === "kind,ref,repository"
    && typeof op.repository === "string" && op.repository.length <= 512
    && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,63}$/.test(op.repository)
    && !op.repository.split("/").some(part => [".", "..", ".git"].includes(part.toLowerCase())) && validRepinRef(op.ref);
}
