import { useEffect, useState } from "react";

/**
 * The unsent text of each session's chat box, kept in this browser's localStorage until it is sent, so switching to
 * another session (or reloading) and back finds it where it was left. Also how a first message that could not be sent
 * from the new-session screen reaches its session's chat box.
 */
const key = (sessionId: string) => `pistead.draft.${sessionId}`;

/** Chat boxes open in this tab, told when a draft of theirs was sent and forgotten. */
const listeners = new Map<string, Set<(sent: string) => void>>();

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
 * Forgets a draft that was just sent, unless it has been edited since, and empties any chat box open on that session
 * that still shows it. Done here, not through the sending box's state: that box may have unmounted (another session
 * opened, maybe this one again) while the message was in flight.
 */
export function forgetSentDraft(sessionId: string, sent: string) {
  try {
    if (localStorage.getItem(key(sessionId)) === sent) localStorage.removeItem(key(sessionId));
  } catch { /* Storage unavailable: nothing was remembered. */ }
  for (const listener of listeners.get(sessionId) ?? []) listener(sent);
}

/**
 * A session's chat box text: starts from its draft, is remembered as it changes, and drops a sent text when
 * forgetSentDraft says so, here or (through the storage event) in another tab.
 */
export function useDraft(sessionId: string) {
  const [initial] = useState(() => readDraft(sessionId));
  const [content, setContent] = useState(initial);
  // Listening starts before the text is remembered, so a send that finished in between is seen, not written back over.
  useEffect(() => {
    const drop = (sent: string) => setContent(current => current === sent ? "" : current);
    const own = listeners.get(sessionId) ?? new Set();
    own.add(drop);
    listeners.set(sessionId, own);
    const fromOtherTab = (event: StorageEvent) => {
      if (event.key === key(sessionId) && event.newValue === null && event.oldValue) drop(event.oldValue);
    };
    window.addEventListener("storage", fromOtherTab);
    // A send that finished between this box reading its draft and listening: catch up with what is stored now.
    const stored = readDraft(sessionId);
    if (stored !== initial) setContent(current => current === initial ? stored : current);
    return () => {
      own.delete(drop);
      if (!own.size) listeners.delete(sessionId);
      window.removeEventListener("storage", fromOtherTab);
    };
  }, [sessionId, initial]);
  useEffect(() => { writeDraft(sessionId, content); }, [sessionId, content]);
  return [content, setContent] as const;
}
