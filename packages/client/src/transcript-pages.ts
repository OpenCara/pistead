import type { EntryView, SessionView } from "../../shared/src/types";

/**
 * Earlier entries a client holds for a paged view (a workspace that loads transcripts latest first), per conversation,
 * oldest first. Each list ends with the entry just before that conversation's first entry in the view
 * (`previousEntryId`), so it and the view read as one transcript.
 */
export type EarlierEntries = ReadonlyMap<string, readonly EntryView[]>;

function entriesOf(view: SessionView | null, conversationId: string): EntryView[] {
  return (view?.entries ?? []).filter(entry => entry.conversationId === conversationId);
}

/**
 * The earlier entries to keep when `next` replaces `previous`: those held already, plus the entries that slid out of the
 * view's window as new ones arrived, so nothing a reader saw disappears from the top. A conversation whose entries no
 * longer join up with its window (after a compaction, say) starts again from its window alone.
 */
export function carryEarlier(earlier: EarlierEntries, previous: SessionView | null, next: SessionView): EarlierEntries {
  const kept = new Map<string, readonly EntryView[]>();
  for (const conversation of next.conversations ?? []) {
    const older = conversation.olderEntries ?? 0;
    if (older <= 0 || !conversation.previousEntryId) continue;
    const window = entriesOf(previous, conversation.id);
    const first = entriesOf(next, conversation.id)[0]?.id;
    const at = window.findIndex(entry => entry.id === first);
    const slid = at < 0 ? window : window.slice(0, at);
    const candidate = [...(earlier.get(conversation.id) ?? []), ...slid];
    if (!candidate.length || candidate.length > older || candidate.at(-1)!.id !== conversation.previousEntryId) continue;
    kept.set(conversation.id, candidate);
  }
  return kept;
}

/**
 * The view as a reader sees it: each conversation's earlier entries before its window, and `olderEntries` counting only
 * what is still to load (absent once nothing is). The view itself when there are none.
 */
export function withEarlier(view: SessionView, earlier: EarlierEntries): SessionView {
  if (!earlier.size) return view;
  const entries: EntryView[] = [];
  const placed = new Set<string>();
  for (const entry of view.entries) {
    const id = entry.conversationId;
    const held = id === undefined ? undefined : earlier.get(id);
    if (id !== undefined && held && !placed.has(id)) {
      entries.push(...held);
      placed.add(id);
    }
    entries.push(entry);
  }
  return {
    ...view, entries,
    conversations: view.conversations.map(conversation => {
      const held = earlier.get(conversation.id);
      if (!held) return conversation;
      const { olderEntries: _older, previousEntryId: _previous, ...rest } = conversation;
      const left = (conversation.olderEntries ?? 0) - held.length;
      return left > 0 ? { ...rest, olderEntries: left } : rest;
    }),
  };
}

/** The entry a page of `conversationId`'s earlier entries is read before: the first one the reader holds. */
export function firstHeld(view: SessionView, earlier: EarlierEntries, conversationId: string): string | undefined {
  return earlier.get(conversationId)?.[0]?.id ?? entriesOf(view, conversationId)[0]?.id;
}
