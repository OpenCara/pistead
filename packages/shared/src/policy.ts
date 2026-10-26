import { permissions, sessionRoles, type Permission, type SessionRole, type WorkspaceRole } from "./types.js";

export function hasPermission(grants: readonly Permission[], required: Permission): boolean {
  return grants.includes(required) || (required === "read" && grants.some((grant) => permissions.includes(grant)));
}

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > permissions.length) throw new Error("Select one or more valid permissions");
  if (input.some((value) => typeof value !== "string" || !permissions.includes(value as Permission))) throw new Error("Unknown permission");
  const result = new Set<Permission>(input as Permission[]);
  result.add("read");
  return permissions.filter((permission) => result.has(permission));
}

export function validateUserEnv(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Environment must be an object");
  const pairs = Object.entries(input);
  if (pairs.length > 32) throw new Error("At most 32 environment values are supported");
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of pairs) {
    if (!/^APP_[A-Z0-9_]{1,48}$/.test(key)) throw new Error("Personal environment names must start with APP_ and contain uppercase letters, digits or underscores");
    if (typeof value !== "string" || value.length > 2048 || value.includes("\0")) throw new Error("Environment values must be strings of at most 2048 characters without null bytes");
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/.test(key)) throw new Error("Credentials belong in connected accounts, not personal environment values");
    result[key] = value;
  }
  return result;
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== ".." && segment !== "." && segment.length > 0 && segment.toLowerCase() !== ".git");
}

/** Roles that may create (or restore into) a session of their own; viewers only follow other people's. */
export const sessionCreatorRoles: readonly WorkspaceRole[] = ["owner", "admin", "collaborator", "member"];
/** Roles that manage the workspace: its members, models, repositories and settings. */
export const workspaceManagerRoles: readonly WorkspaceRole[] = ["owner", "admin"];
/** Roles an admin (not only the owner) may assign, change or remove. */
export const adminManagedRoles: readonly WorkspaceRole[] = ["collaborator", "member", "viewer"];

/**
 * What a workspace role alone allows on a session shared with the workspace, one it doesn't own: collaborators,
 * admins and the owner send messages (write) and side asks; members and viewers follow it read-only.
 */
export function workspaceSessionPermissions(role: WorkspaceRole): Permission[] {
  return sharedSessionWriterRoles.includes(role) ? ["read", "ask", "write"] : ["read"];
}
/** Roles that send messages to any session shared with the workspace (see workspaceSessionPermissions). */
export const sharedSessionWriterRoles: readonly WorkspaceRole[] = ["owner", "admin", "collaborator"];
/** Roles whose explicit session grants are capped at read (see roleSessionCeiling). */
export const readOnlyRoles: readonly WorkspaceRole[] = ["viewer"];

/**
 * A role's ceiling on any session it doesn't own, whatever its explicit grants: a viewer only ever reads.
 * Null means no ceiling beyond the grants themselves.
 */
export function roleSessionCeiling(role: WorkspaceRole): readonly Permission[] | null {
  return readOnlyRoles.includes(role) ? ["read"] : null;
}

/** Whether a role may start sessions; a workspace listing without a role (an older server) counts as a member. */
export function canCreateSessions(role: WorkspaceRole | undefined): boolean {
  return sessionCreatorRoles.includes(role ?? "member");
}

/**
 * The four tiers of access a session's owner (or anyone who manages it) gives one workspace member, named after the
 * workspace roles they mirror. Each tier holds the permissions of the tiers below it:
 * - `viewer`: follows the session (read).
 * - `member`: also asks side questions (ask), without sending messages to the agent.
 * - `collaborator`: also sends messages and stops work (write), as a workspace collaborator does on shared sessions.
 * - `admin`: also decides approvals and manages the session's people (approve, manage).
 * A grant is stored as its permissions, so a grant from before tiers that matches none shows as custom.
 */
export const sessionRolePermissions: Readonly<Record<SessionRole, readonly Permission[]>> = {
  viewer: ["read"],
  member: ["read", "ask"],
  collaborator: ["read", "ask", "write"],
  admin: ["read", "ask", "write", "approve", "manage"],
};

/** The tier a grant's permissions are exactly, or null for a custom grant that matches none. */
export function sessionRoleOf(grants: readonly Permission[]): SessionRole | null {
  const held = new Set<Permission>(grants);
  if (held.size) held.add("read");
  return sessionRoles.find((role) => {
    const tier = sessionRolePermissions[role];
    return tier.length === held.size && tier.every((permission) => held.has(permission));
  }) ?? null;
}

/** Whether a member with this workspace role can hold a session tier: a viewer is capped at read (roleSessionCeiling). */
export function sessionRoleAllowed(role: SessionRole, workspaceRole: WorkspaceRole | undefined): boolean {
  const ceiling = workspaceRole ? roleSessionCeiling(workspaceRole) : null;
  return !ceiling || sessionRolePermissions[role].every((permission) => ceiling.includes(permission));
}

/** Whether someone holding `held` on a session can give a tier: nobody grants a permission they don't hold. */
export function sessionRoleGrantable(role: SessionRole, held: readonly Permission[]): boolean {
  return sessionRolePermissions[role].every((permission) => hasPermission(held, permission));
}
