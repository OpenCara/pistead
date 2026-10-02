import { sha256, verifyToken } from "../../../packages/shared/src/crypto.js";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import type { RunnerAction, RunnerBinding, RunnerTicket, Operation, Permission } from "../../../packages/shared/src/types.js";

export class RunnerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function assertId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new RunnerError(400, "Invalid identifier");
  return id;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function requestKey(actorId: string, mode: "write" | "ask", requestId: string): Promise<string> {
  return sha256(JSON.stringify([actorId, mode, requestId]));
}
export function permissionFor(action: RunnerAction): Permission {
  if (action === "submit" || action === "operations" || action === "create") return "write";
  if (action === "ask") return "ask";
  if (action === "approve") return "approve";
  if (action === "restart" || action === "backup" || action === "restore") return "manage";
  return "read";
}
export async function verifyRunnerTicket(token: string, secret: string, action: RunnerAction, sessionId: string, body: string, now = Date.now()): Promise<RunnerTicket> {
  const ticket = await verifyToken<RunnerTicket>(token, secret);
  if (!ticket || ticket.aud !== "runner" || ticket.action !== action || ticket.sessionId !== sessionId || ticket.bodyHash !== await sha256(body)
    || !Number.isSafeInteger(ticket.exp) || ticket.exp * 1000 <= now || !Number.isSafeInteger(ticket.iat) || ticket.iat * 1000 > now + 5000
    || ticket.exp <= ticket.iat || ticket.exp - ticket.iat > 60 || !Number.isSafeInteger(ticket.policyVersion)
    || typeof ticket.ownerId !== "string" || !ticket.ownerId || typeof ticket.actorId !== "string" || !ticket.actorId
    || typeof ticket.jti !== "string" || !ticket.jti) throw new RunnerError(401, "Ticket scope or expiry mismatch");
  return ticket;
}
export function validateBinding(value: unknown, id: string, allowNativeModels = false): RunnerBinding {
  const b = value as RunnerBinding;
  if (!b || b.session?.id !== id || b.session.ownerId !== b.owner?.id || b.session.agentVersionId !== b.agent?.id || b.agent.modelId !== b.model?.id
    || !Number.isSafeInteger(b.agent.version) || b.agent.version < 1 || !Number.isSafeInteger(b.session.policyVersion)
    || typeof b.model?.provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(b.model.provider)
    || (!["faux", "openai", "anthropic"].includes(b.model.provider) && !(allowNativeModels && b.session.connectorId))
    || typeof b.model.modelId !== "string" || !b.model.modelId || b.model.modelId.length > 200 || /[\0\r\n]/.test(b.model.modelId)
    || !Array.isArray(b.agent.tools) || typeof b.agent.instructions !== "string"
    || typeof b.owner.gitName !== "string" || typeof b.owner.gitEmail !== "string" || /[\r\n\0]/.test(b.owner.gitName + b.owner.gitEmail)
    || !b.owner.gitName || !b.owner.gitEmail) throw new RunnerError(400, "Invalid immutable runner binding");
  if (!b.owner.id || b.owner.id.length > 200) throw new RunnerError(400, "Invalid owner");
  if (b.session.workspaceId !== b.model.workspaceId || (b.agent.workspaceId !== null && b.agent.workspaceId !== b.session.workspaceId)
    || b.session.connectorId !== b.model.connectorId || b.session.connectorOwnerId !== b.model.connectorOwnerId)
    throw new RunnerError(400, "Invalid runner workspace or connector binding");
  if (b.session.connectorId !== undefined) assertId(b.session.connectorId);
  b.owner.env = validateUserEnv(b.owner.env ?? {});
  return JSON.parse(JSON.stringify(b));
}
export function validateOperation(value: unknown): Operation {
  if (!value || typeof value !== "object") throw new RunnerError(400, "Invalid operation");
  const op = value as Operation;
  const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
  if (op.kind === "git.commit" && text(op.message, 4000) && Object.keys(op).length === 2) return op;
  if (op.kind === "bash" && text(op.command, 8192) && Object.keys(op).length === 2) return op;
  if (op.kind === "github.comment" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(op.repository) && !op.repository.endsWith("/.") && !op.repository.endsWith("/..")
    && Number.isSafeInteger(op.issue) && op.issue > 0 && text(op.body, 60000) && Object.keys(op).length === 4) return op;
  throw new RunnerError(400, "Invalid operation");
}
