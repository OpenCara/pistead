import { permissions, type Permission } from "./types.js";

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
