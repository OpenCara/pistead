import type { WorkspaceRole } from "../../../packages/shared/src/types";

/** Someone the web app names: their user ID and, when known, their username (GitHub login). */
export interface Person {
  id: string;
  githubLogin?: string | null;
}

/** A workspace member as `GET /api/workspaces/:id/members` lists them. */
export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  displayName?: string;
  githubLogin?: string | null;
}

export function memberPerson(member: WorkspaceMember): Person {
  return { id: member.userId, githubLogin: member.githubLogin };
}

/** A person's username: their GitHub login, or their user ID when they have none. */
export function username(person: Person): string {
  return person.githubLogin || person.id;
}

/**
 * "username(id)", for where the exact person matters: usernames aren't unique once someone renames their GitHub
 * account. Just the user ID when there is no username.
 */
export function usernameWithId(person: Person): string {
  return person.githubLogin ? `${person.githubLogin}(${person.id})` : person.id;
}

/** Looks people up by user ID; anyone not listed is known only by their ID. */
export function peopleDirectory(people: readonly Person[]): (id: string) => Person {
  const byId = new Map(people.map(person => [person.id, person]));
  return id => byId.get(id) ?? { id };
}

/**
 * The user ID a typed or pasted value names: the ID in "username(id)", the ID of the one person in `people` with that
 * username (GitHub logins ignore case; a leading @ is allowed), or else the trimmed value itself, such as a user ID.
 * An ambiguous or unknown username comes back as typed, for the server to refuse.
 */
export function userIdFromInput(value: string, people: readonly Person[] = []): string {
  const text = value.trim();
  const labelled = /^@?[^\s()]*\s*\(\s*([^\s()]+)\s*\)$/.exec(text);
  if (labelled) return labelled[1];
  const login = text.replace(/^@/, "").toLowerCase();
  const matches = login ? people.filter(person => person.githubLogin?.toLowerCase() === login) : [];
  return matches.length === 1 ? matches[0].id : text;
}

/** A JSON value with every string that is a known person's user ID written as "username(id)", for showing details. */
export function withUsernames(value: unknown, person: (id: string) => Person): unknown {
  if (typeof value === "string") return usernameWithId(person(value));
  if (Array.isArray(value)) return value.map(item => withUsernames(item, person));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withUsernames(item, person)]));
  return value;
}
