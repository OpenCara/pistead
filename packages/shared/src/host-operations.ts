import type { GitRepinOperation, HostCommandOperation } from "./types.js";

// Declared next to their operations, by interface merging, so the base capability list stays as it was.
declare module "./connector.js" {
  interface ConnectorCapabilities {
    /** The connector runs host_bash commands outside the sandbox, each approved by the host's owner. Absent on older connectors. */
    hostCommands?: boolean;
  }
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
