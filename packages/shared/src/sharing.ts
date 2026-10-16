import type { EntryView, SessionRecord } from "./types.js";

/** The owner's share link: anyone who has it can view the session's shared conversation, read-only, without signing in. */
export interface SessionLink {
  url: string;
  createdAt: string;
}

/** What a share link shows about its session: nothing that names its workspace, host, repositories or collaborators. */
export interface SharedSession {
  title: string;
  status: SessionRecord["status"];
  createdAt: string;
  ownerName: string;
}

/** What a share link shows of the work: the shared conversation's entries, without side asks or who sent each message. */
export interface SharedSessionView {
  entries: EntryView[];
  busy: boolean;
}

// Link sharing keeps its types together here; this adds the one field it puts on every session read.
declare module "./types.js" {
  interface SessionRecord {
    // Present only on single-session reads: anyone with the session's share link can view its shared conversation.
    linkShared?: boolean;
  }
}
