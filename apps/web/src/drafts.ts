/**
 * The unsent text of each session's chat box, kept in this browser's localStorage until it is sent, so switching to
 * another session (or reloading) and back finds it where it was left. Also how a first message that could not be sent
 * from the new-session screen reaches its session's chat box.
 */
const key = (sessionId: string) => `pistead.draft.${sessionId}`;

export function readDraft(sessionId: string): string {
  try {
    const stored = localStorage.getItem(key(sessionId));
    if (stored !== null) return stored;
    // A hand-over written by an earlier version of the app to sessionStorage: moved, never dropped, so a render React
    // discards cannot lose it.
    const legacy = sessionStorage.getItem(key(sessionId));
    if (legacy === null) return "";
    localStorage.setItem(key(sessionId), legacy);
    sessionStorage.removeItem(key(sessionId));
    return legacy;
  } catch { return ""; }
}

/** Remembers the text, or forgets it once the box is empty. */
export function writeDraft(sessionId: string, text: string) {
  try {
    if (text) localStorage.setItem(key(sessionId), text);
    else localStorage.removeItem(key(sessionId));
  } catch { /* Storage unavailable: the draft lives only while the session is open. */ }
}

/**
 * Forgets a draft that was just sent, unless it has been edited since. Done directly, not through the chat box's state:
 * the box may have unmounted (another session opened) while the message was in flight.
 */
export function forgetSentDraft(sessionId: string, sent: string) {
  try {
    if (localStorage.getItem(key(sessionId)) === sent) localStorage.removeItem(key(sessionId));
  } catch { /* Storage unavailable: nothing was remembered. */ }
}
