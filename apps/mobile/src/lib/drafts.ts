/**
 * A first message that could not be sent after its session was created (or restarted) is handed to that session's chat
 * box, like the web's sessionStorage draft. Kept in memory only: unsent prompts never touch disk.
 */
const drafts = new Map<string, string>();

export function saveDraft(sessionId: string, text: string) {
  drafts.set(sessionId, text);
}

/** The handed-over text, once. */
export function takeDraft(sessionId: string): string {
  const text = drafts.get(sessionId) ?? "";
  drafts.delete(sessionId);
  return text;
}
