import type { EntryView, SessionView } from "../../shared/src/types";
import { splitToolCalls } from "../../shared/src/transcript";

/**
 * What a shared-conversation entry offers besides copying it: going back to it (POST /api/sessions/:id/revert) and
 * forking a new session from it (/fork). The host takes the conversation back just before a user message, so it can be
 * sent again, or just after the agent's final reply of a turn; nowhere inside a turn, where tool calls would lose their
 * results. `before` marks a user message: going back to it leaves it out, and its text is handed back to send again.
 */
export type MessageCut = { entryId: string; before: boolean };

/** Entries the host wrote (`<conversation>:<entry>`); the view's own markers, such as a stopped run's, are not. */
const HOST_ENTRY = /^\d{1,15}:\d{1,15}$/;

/** Where `entry`, of the shared conversation, can be gone back to or forked from; undefined where it can't. */
export function messageCut(entry: EntryView): MessageCut | undefined {
  if (!HOST_ENTRY.test(entry.id)) return undefined;
  if (entry.role === "user") return { entryId: entry.id, before: true };
  if (entry.role !== "assistant" || splitToolCalls(entry.text).calls.length > 0) return undefined;
  return { entryId: entry.id, before: false };
}

/** Whether the view's host takes conversations back and forks them: hosts that predate it don't say so. */
export function rewindable(view: Pick<SessionView, "rewindable">): boolean {
  return view.rewindable === true;
}

/** A line the runner writes in place of an image it gave the model (`entryView`): the image itself stays on the host. */
const IMAGE_LINE = /^\[image [^\s\]]+\]$/;

/** The text of a user message to send again once the conversation went back before it: without its images' lines. */
export function resendText(entry: EntryView): string {
  return entry.text.split("\n").filter(line => !IMAGE_LINE.test(line)).join("\n").trim();
}

/** The text a copy of `entry` puts on the clipboard: what it says, without the tool call lines a reply may end with. */
export function copyText(entry: EntryView): string {
  return entry.role === "assistant" ? splitToolCalls(entry.text).prose.trim() : entry.text;
}
