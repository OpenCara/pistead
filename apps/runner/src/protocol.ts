import { validHostOperation } from "../../../packages/shared/src/host-operations.js";
import { sha256, verifyToken } from "../../../packages/shared/src/crypto.js";
import { validateUserEnv } from "../../../packages/shared/src/policy.js";
import type { RunnerAction, RunnerBinding, RunnerTicket, Operation, Permission } from "../../../packages/shared/src/types.js";
import { GITHUB_ISSUE_BODY_LIMIT, GITHUB_ISSUE_TITLE_LIMIT, githubMergeMethods, permissionNeeds, toolNames } from "../../../packages/shared/src/types.js";
import { gitProviderHosts, gitProviders, repositoryLimits, repositoryPath, validCloneDirectory, validGitHost, validPushBranch, validRepositoryId, validRepositoryName, type SessionRepository, type TokenGitProvider } from "../../../packages/shared/src/repositories.js";

export class RunnerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
/** Connector-authored setup failures with fixed text, safe to show the operator unlike SDK or HTTP errors. */
export class ConnectorSetupError extends Error {
  override name = "ConnectorSetupError";
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
  if (action === "submit" || action === "operations" || action === "create" || action === "stop") return "write";
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
const githubPinKeys = "bindingId,commit,fullName,path,ref,repositoryId";
const providerPinKeys = "bindingId,commit,fullName,host,path,provider,ref,repositoryId";
/**
 * Checks one immutable repository pin (legacy GitHub or token-provider shape) and returns its repository identity key,
 * or null when the pin is malformed. Callers enforce uniqueness of binding ids, lowercase paths and identity keys.
 */
export function repositoryPinIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pin = value as Record<string, unknown>;
  const keys = Object.keys(pin).sort().join(",");
  if (typeof pin.bindingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(pin.bindingId)
    || typeof pin.commit !== "string" || !/^[a-f0-9]{40}$/.test(pin.commit)
    || typeof pin.ref !== "string" || !pin.ref.trim() || pin.ref.length > 255 || /[\x00-\x20\x7f\\]/.test(pin.ref)) return null;
  if (keys === githubPinKeys) {
    if (!Number.isSafeInteger(pin.repositoryId) || (pin.repositoryId as number) < 1
      || !validRepositoryName("github", pin.fullName) || pin.path !== pin.fullName) return null;
    return `github:${pin.repositoryId}`;
  }
  if (keys !== providerPinKeys || typeof pin.provider !== "string" || pin.provider === "github"
    || !(gitProviders as readonly string[]).includes(pin.provider)) return null;
  const provider = pin.provider as TokenGitProvider;
  const fixed = gitProviderHosts[provider].fixed;
  if (typeof pin.host !== "string" || (fixed ? pin.host !== fixed : !validGitHost(pin.host))
    || !validRepositoryId(pin.repositoryId) || !validRepositoryName(provider, pin.fullName)
    || pin.path !== repositoryPath({ provider, host: pin.host, fullName: pin.fullName })) return null;
  const path = pin.path as string;
  if (path.length > 512 || path.split("/").some(part => !/^[A-Za-z0-9._-]+$/.test(part) || [".", "..", ".git"].includes(part.toLowerCase()))) return null;
  return `${provider}:${pin.host}:${pin.repositoryId}`;
}
export function validateRepositories(value: unknown): SessionRepository[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > repositoryLimits.repositories) throw new RunnerError(400, "Invalid immutable repository bindings");
  const ids = new Set<string>(), bindings = new Set<string>(), names = new Set<string>();
  return Array.from(value, repository => {
    const id = repositoryPinIdentity(repository);
    if (!id) throw new RunnerError(400, "Invalid immutable repository binding");
    const name = repository.path.toLowerCase();
    if (ids.has(id) || bindings.has(repository.bindingId) || names.has(name)) throw new RunnerError(400, "Duplicate immutable repository binding");
    ids.add(id); bindings.add(repository.bindingId); names.add(name);
    return { ...repository } as SessionRepository;
  });
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
  validateRepositories(b.session.repositories);
  if (b.session.repositoryMode !== undefined && (b.session.repositoryMode !== "clone" || b.session.repositories?.length))
    throw new RunnerError(400, "Invalid session repository mode");
  b.owner.env = validateUserEnv(b.owner.env ?? {});
  return JSON.parse(JSON.stringify(b));
}
export function validateOperation(value: unknown): Operation {
  if (validHostOperation(value)) return value;
  if (!value || typeof value !== "object") throw new RunnerError(400, "Invalid operation");
  const op = value as Operation;
  const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
  if (op.kind === "git.commit" && text(op.message, 4000) && Object.keys(op).length === 2) return op;
  if (op.kind === "bash" && text(op.command, 8192) && Object.keys(op).length === 2) return op;
  const githubRepository = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !value.endsWith("/.") && !value.endsWith("/..");
  if (op.kind === "github.comment" && githubRepository(op.repository)
    && Number.isSafeInteger(op.issue) && op.issue > 0 && text(op.body, 60000) && Object.keys(op).length === 4) return op;
  if (op.kind === "github.merge" && githubRepository(op.repository) && Number.isSafeInteger(op.pull) && op.pull > 0
    && typeof op.sha === "string" && /^[0-9a-f]{40}$/.test(op.sha) && githubMergeMethods.includes(op.method)
    && Object.keys(op).length === 5) return op;
  // The same bounds as the control plane's parseOperation: a one-line title, a body that may be empty.
  if (op.kind === "github.issue" && githubRepository(op.repository) && text(op.title, GITHUB_ISSUE_TITLE_LIMIT) && !/[\r\n]/.test(op.title)
    && typeof op.body === "string" && op.body.length <= GITHUB_ISSUE_BODY_LIMIT && !op.body.includes("\0") && Object.keys(op).length === 4) return op;
  if (op.kind === "git.push") {
    const keys = Object.keys(op);
    const request = op.pullRequest as Record<string, unknown> | undefined;
    const validRequest = request === undefined || (!!request && typeof request === "object" && !Array.isArray(request)
      && Object.keys(request).every(key => ["title", "body", "base"].includes(key))
      && text(request.title, 256) && !/[\r\n]/.test(request.title as string)
      && typeof request.body === "string" && request.body.length <= 60000 && !request.body.includes("\0")
      && (request.base === undefined || validPushBranch(request.base)));
    if (typeof op.repository === "string" && op.repository.length <= 512 && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,63}$/.test(op.repository)
      && !op.repository.split("/").some(part => [".", "..", ".git"].includes(part.toLowerCase()))
      && (op.directory === undefined || validCloneDirectory(op.directory))
      && validPushBranch(op.branch) && typeof op.commit === "string" && /^[0-9a-f]{40}$/.test(op.commit)
      && keys.every(key => ["kind", "repository", "directory", "branch", "commit", "pullRequest"].includes(key))
      && keys.length === 4 + (request === undefined ? 0 : 1) + (op.directory === undefined ? 0 : 1) && validRequest) return op;
  }
  if (op.kind === "permission") {
    const keys = Object.keys(op);
    // Needs are unique and in permissionNeeds order, so equal requests hash equally.
    if (keys.length === 4 && keys.every(key => ["kind", "tool", "target", "needs"].includes(key)) && toolNames.includes(op.tool)
      && typeof op.target === "string" && op.target.length <= 8192 && !op.target.includes("\0") && Array.isArray(op.needs) && op.needs.length > 0
      && op.needs.join() === permissionNeeds.filter(need => op.needs.includes(need)).join()) return op;
  }
  throw new RunnerError(400, "Invalid operation");
}
