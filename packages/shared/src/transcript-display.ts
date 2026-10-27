import { transcriptLines } from "./transcript.js";
import type { EntryView, SessionView } from "./types.js";

/**
 * How the control plane shows a session's transcript to the people viewing it. Hosts always send the whole transcript;
 * these change only what leaves the control plane, so they work with every connector.
 *
 * - Tool output (per session, `SessionRecord.toolOutput`, starting as its workspace sets for new sessions): "brief" shows
 *   each tool result as its first line and cuts long tool calls short.
 * - Paging (per workspace): views hold only each conversation's latest entries, and clients read earlier ones a page at
 *   a time as people scroll up.
 */
export type ToolOutput = "full" | "brief";
export const toolOutputs: readonly ToolOutput[] = ["full", "brief"];

export interface TranscriptDisplay {
  toolOutput: ToolOutput;
  paging: boolean;
}
export const fullTranscript: TranscriptDisplay = { toolOutput: "full", paging: false };

/** Characters of a brief tool result's line, and of a cut tool call's arguments. */
export const briefChars = 200;
/** Entries per conversation a paged view holds, entries one page reads, and the most one request may ask for. */
export const transcriptPage = { size: 50, max: 200 } as const;

/** How many characters (code points) `text` has, as people count them: an emoji is one, not two UTF-16 units. */
export function characters(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { count--; index++; }
    }
  }
  return count;
}

/** At most `limit` characters (whole code points) of `text`, with an ellipsis when cut. */
function cut(text: string, limit: number): string {
  // A code point is at most two UTF-16 units: only text longer than `limit` units can need cutting, and its first
  // `limit * 2 + 2` units hold more than `limit` code points whenever the whole text does.
  if (text.length <= limit) return text;
  const points = Array.from(text.slice(0, limit * 2 + 2));
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : text;
}

/**
 * The entry as a session with brief tool output shows it, or the entry itself when that shows it whole. A tool result
 * keeps its first non-blank line; an assistant message keeps its prose and each tool call's name and the start of its
 * arguments, still as a call line. Apply it after redaction, so a cut never splits a secret the redaction would hide.
 */
export function briefEntry(entry: EntryView): EntryView {
  const text = typeof entry.text === "string" ? entry.text : "";
  if (entry.role === "toolResult") {
    const lines = text.split("\n");
    const first = cut((lines.find(line => line.trim()) ?? "").trimEnd(), briefChars);
    if (first === text) return entry;
    return { ...entry, text: first, trimmed: { lines: lines.length, chars: characters(text) } };
  }
  if (entry.role !== "assistant") return entry;
  let changed = false;
  const shown = transcriptLines(text).map(({ line, tool }) => {
    if (tool === undefined) return line;
    // `name({...})`: the arguments' JSON is everything between the parentheses.
    const args = line.slice(tool.length + 1, -1);
    const short = cut(args, briefChars);
    if (short === args) return line;
    changed = true;
    // Still a call line (`name({…})`), so clients show it as a tool call, never as prose.
    return `${tool}(${short}})`;
  });
  return changed ? { ...entry, text: shown.join("\n"), trimmed: { lines: shown.length, chars: characters(text) } } : entry;
}

/** The conversations whose entries a paged view can hold back: only those the view lists. */
function listed(view: SessionView): Set<string> {
  return new Set((view.conversations ?? []).map(conversation => conversation.id));
}

/**
 * The view with each conversation's latest `size` entries only. A conversation with more says how many come before and
 * which entry is just before its first; the view itself is returned when every conversation fits.
 */
export function latestEntries(view: SessionView, size: number = transcriptPage.size): SessionView {
  const conversations = listed(view);
  const counts = new Map<string, number>();
  for (const entry of view.entries) {
    const id = entry.conversationId;
    if (id !== undefined && conversations.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (![...counts.values()].some(count => count > size)) return view;
  const seen = new Map<string, number>();
  const previous = new Map<string, string>();
  const entries = view.entries.filter(entry => {
    const id = entry.conversationId;
    if (id === undefined || !conversations.has(id)) return true;
    const index = seen.get(id) ?? 0;
    seen.set(id, index + 1);
    if (index >= counts.get(id)! - size) return true;
    previous.set(id, entry.id);
    return false;
  });
  return {
    ...view, entries,
    conversations: view.conversations.map(conversation => {
      const older = (counts.get(conversation.id) ?? 0) - size;
      return older > 0 ? { ...conversation, olderEntries: older, previousEntryId: previous.get(conversation.id)! } : conversation;
    }),
  };
}

/**
 * Up to `limit` of a conversation's entries just before `before`, oldest first, from the whole view, and how many come
 * before those. Null when the conversation has no entry `before`, e.g. after a compaction replaced its history.
 */
export function entriesBefore(view: SessionView, conversationId: string, before: string, limit: number): { entries: EntryView[]; older: number } | null {
  if (!listed(view).has(conversationId)) return null;
  const entries = view.entries.filter(entry => entry.conversationId === conversationId);
  const index = entries.findIndex(entry => entry.id === before);
  if (index < 0) return null;
  const start = Math.max(0, index - limit);
  return { entries: entries.slice(start, index), older: start };
}
