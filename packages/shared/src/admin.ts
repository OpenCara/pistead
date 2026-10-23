/**
 * The instance administration API (`/api/admin/*`), open only to the user IDs the operator lists in ADMIN_USER_IDS.
 * It shows who uses the server and what they run it on, never what they run: no session titles, prompts, repository
 * names, models, environment values or credentials.
 */

/** Totals across the whole server. */
export interface AdminOverview {
  users: number;
  suspendedUsers: number;
  workspaces: number;
  /** Paired hosts that haven't been revoked or removed. */
  hosts: number;
  onlineHosts: number;
  sessions: number;
  /** Sessions that aren't archived. */
  activeSessions: number;
}

export interface AdminUser {
  id: string;
  githubLogin: string | null;
  displayName: string;
  createdAt: string;
  /** Listed in ADMIN_USER_IDS; such accounts can't be suspended from the panel. */
  instanceAdmin: boolean;
  suspendedAt: string | null;
  workspaces: number;
  hosts: number;
  sessions: number;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerGithubLogin: string | null;
  createdAt: string;
  members: number;
  repositories: number;
  hosts: number;
  sessions: number;
}

export interface AdminHost {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerGithubLogin: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
  /** Workspaces the host is connected to. */
  workspaces: number;
  sessions: number;
}

/** A list stops at `adminListLimit` entries, newest first; `truncated` says more exist. */
export interface AdminList<T> {
  items: T[];
  truncated: boolean;
}

export const adminListLimit = 1000;
