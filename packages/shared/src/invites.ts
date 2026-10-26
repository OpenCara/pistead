/** A workspace's invite link, as its owner and admins see it: anyone signed in who opens it can ask to join. */
export interface WorkspaceInviteLink {
  url: string;
  createdAt: string;
}

/** Where the person opening an invite link stands: not yet asked, waiting for an owner or admin, or already a member. */
export type WorkspaceInviteStatus = "none" | "pending" | "member";

/** What an invite link shows the signed-in person who opens it: the workspace's name and their own standing, nothing else. */
export interface WorkspaceInvite {
  workspaceName: string;
  status: WorkspaceInviteStatus;
  /** Only once they are a member, so a link alone reveals no workspace id. */
  workspaceId?: string;
}

/** A pending member: someone who asked to join through the invite link and waits for an owner or admin to accept them. */
export interface WorkspaceJoinRequest {
  userId: string;
  displayName: string;
  githubLogin: string | null;
  createdAt: string;
}

/** At most this many people wait to join one workspace at a time. */
export const maxPendingMembers = 200;
