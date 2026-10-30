import type { SessionLink } from "../../../packages/shared/src/sharing";
import type { SessionRecord, UserProfile } from "../../../packages/shared/src/types";
import { api, segment } from "./api";
import { confirmDialog, useResource, type ActionState } from "./ui";

/**
 * A session's share link as its owner manages it; everyone else learns from `session.linkShared` that one exists. The
 * workspace's owner and admins, who manage every session there, can also turn it off.
 */
export interface SessionLinkActions {
  /** Undefined until it has loaded (and for everyone but the owner), null while link sharing is off. */
  link: SessionLink | null | undefined;
  linkLoading: boolean;
  linkError: string;
  /** Turns link sharing on once the owner confirms; resolves true when the session has a link. */
  shareLink: () => Promise<boolean>;
  unshareLink: () => void;
}

/**
 * `action` is the session's own action state, so link changes share its busy flag and show their notices with it.
 * `manages`: the user is its owner, or its workspace's owner or an admin (managesSession).
 */
export function useSessionLink({ session, user, manages, action, onChange }: { session: SessionRecord; user: UserProfile; manages: boolean; action: ActionState; onChange: () => void }): SessionLinkActions {
  const isOwner = session.ownerId === user.id;
  const resource = useResource<{ link: SessionLink | null }>(isOwner ? `/api/sessions/${segment(session.id)}/link` : null);
  const link = resource.data ? resource.data.link : undefined;

  async function shareLink(): Promise<boolean> {
    if (!isOwner || action.busy || session.status === "archived") return false;
    if (link) return true;
    const confirmed = await confirmDialog({
      title: "Share with anyone who has the link?",
      message: "Anyone with the link will be able to view existing and future prompts and output of the shared conversation, including tool output and repository content shown in it, without signing in. They can't send messages, or see side asks, approvals, who sent each message, or the host. The session title and your display name are shown with it. Values that look like passwords, tokens or keys are hidden, but anyone who has the link can pass it on, so check the transcript for other sensitive content first. You can turn the link off at any time.",
      confirmLabel: "Create link",
    });
    if (!confirmed) return false;
    let created = false;
    await action.run(async () => {
      const result = await api<{ link: SessionLink }>(`/api/sessions/${segment(session.id)}/link`, { method: "PUT" });
      resource.setData({ link: result.link });
      created = true;
      onChange();
    }, "Share link created. Anyone who has it can view the shared conversation.");
    return created;
  }

  async function unshareLink() {
    if (!manages || action.busy) return;
    const confirmed = await confirmDialog({
      title: "Turn off the share link?",
      message: `The link stops working at once, for everyone who has it. Content already viewed or copied can't be recalled. ${isOwner
        ? "Turning link sharing on again creates a new link." : "Only the session's owner can share it by link again, with a new link."}`,
      confirmLabel: "Turn off link",
      destructive: true,
    });
    if (!confirmed) return;
    await action.run(async () => {
      await api(`/api/sessions/${segment(session.id)}/link`, { method: "DELETE" });
      // Only the owner loads the link itself; for everyone else the refreshed session says it is gone.
      if (isOwner) resource.setData({ link: null });
      onChange();
    }, "Share link turned off. It no longer opens this session.");
  }

  return { link, linkLoading: resource.loading, linkError: resource.error, shareLink, unshareLink: () => void unshareLink() };
}
