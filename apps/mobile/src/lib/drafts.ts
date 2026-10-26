/**
 * The unsent text of each session's chat box, kept until it is sent, so switching to another session and back finds it
 * where it was left. Also how a first message that could not be sent after its session was created (or restarted)
 * reaches that session's chat box, like the web's localStorage draft. Kept in memory only: unsent prompts never touch
 * disk, so they last until the app is closed.
 */
const drafts = new Map<string, string>();

/** Remembers the text, or forgets it once the box is empty. */
export function saveDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function readDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}
