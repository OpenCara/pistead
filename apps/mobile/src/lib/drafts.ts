import { useEffect, useState } from "react";

/**
 * The unsent text of each session's chat box, kept until it is sent, so switching to another session and back finds it
 * where it was left. Also how a first message that could not be sent after its session was created (or restarted)
 * reaches that session's chat box, like the web's localStorage draft. Kept in memory only: unsent prompts never touch
 * disk, so they last until the app is closed.
 */
const drafts = new Map<string, string>();

/** Chat boxes open on a session, told when a draft of theirs was sent and forgotten. */
const listeners = new Map<string, Set<(sent: string) => void>>();

/** Remembers the text, or forgets it once the box is empty. */
export function saveDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function readDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? "";
}

/**
 * Forgets a draft that was just sent, unless it has been edited since, and empties any chat box open on that session
 * that still shows it. Done here, not through the sending box's state: that box may have unmounted (another session
 * opened, maybe this one again) while the message was in flight.
 */
export function forgetSentDraft(sessionId: string, sent: string) {
  if (drafts.get(sessionId) === sent) drafts.delete(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener(sent);
}

/** A session's chat box text: starts from its draft, is remembered as it changes, and drops a sent text when told. */
export function useDraft(sessionId: string) {
  const [initial] = useState(() => readDraft(sessionId));
  const [content, setContent] = useState(initial);
  // Listening starts before the text is remembered, so a send that finished in between is seen, not written back over.
  useEffect(() => {
    const drop = (sent: string) => setContent(current => current === sent ? "" : current);
    const own = listeners.get(sessionId) ?? new Set();
    own.add(drop);
    listeners.set(sessionId, own);
    // A send that finished between this box reading its draft and listening: catch up with what is stored now.
    const stored = readDraft(sessionId);
    if (stored !== initial) setContent(current => current === initial ? stored : current);
    return () => {
      own.delete(drop);
      if (!own.size) listeners.delete(sessionId);
    };
  }, [sessionId, initial]);
  useEffect(() => { saveDraft(sessionId, content); }, [sessionId, content]);
  return [content, setContent] as const;
}
