/**
 * Workspace sources: what a workspace's sessions work on (docs/design/external-sources.md). A Git repository is one kind,
 * kept in workspace_repositories with everything only Git has; a Notion page or database is another. Every source of
 * a workspace is in the grant of every session in it, and each read uses the session owner's own account.
 */
export const sourceKinds = ["git", "notion"] as const;
export type SourceKind = (typeof sourceKinds)[number];

export const sourceLimits = {
  /** Notion pages and databases per workspace. */
  notion: 10,
  /** A bound Notion page's or database's title as stored and shown. */
  title: 300,
} as const;

/** The kinds of connected account other than Git (Git accounts are in repositories.ts). */
export const sourceAccountProviders = ["notion"] as const;
export type SourceAccountProvider = (typeof sourceAccountProviders)[number];

/** A connected Notion account as its owner sees it; the token never leaves the server. */
export interface SourceAccount {
  provider: SourceAccountProvider;
  /** The Notion workspace the integration belongs to, or the integration's name. */
  name: string;
  createdAt: string;
}
export interface SourceAccountList { accounts: SourceAccount[] }

export const notionObjects = ["page", "database"] as const;
export type NotionObject = (typeof notionObjects)[number];

/** A Notion page or database bound to a workspace. Sessions read it, and the pages under it, with their owner's Notion account. */
export interface WorkspaceNotionSource {
  id: string;
  workspaceId: string;
  kind: "notion";
  /** Notion's id of the page or database, in its dashed form. */
  notionId: string;
  object: NotionObject;
  title: string;
  url: string;
  createdAt: string;
}
export interface WorkspaceSourceList {
  /** Sources other than Git repositories; those are listed by /repositories. */
  sources: WorkspaceNotionSource[];
}

/** A non-Git source as a session's grant names it, for the agent's instructions and notion_read. */
export interface GrantSource { id: string; kind: "notion"; object: NotionObject; title: string }

/**
 * A Notion id from a page or database URL or a bare id (32 hex digits, dashed or not), in Notion's dashed lowercase
 * form; null otherwise. A URL's last 32-hex run is the id (`…/My-page-0123…`, `?p=` aside).
 */
export function notionId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  let candidate = text;
  let url = false;
  if (/^https:\/\//i.test(text)) {
    let parsed: URL;
    try { parsed = new URL(text); } catch { return null; }
    if (parsed.hostname !== "notion.so" && parsed.hostname !== "www.notion.so" && !parsed.hostname.endsWith(".notion.site")) return null;
    // A page opened from a database (?p=) is that page; otherwise the id ends the path's last segment.
    candidate = parsed.searchParams.get("p") ?? parsed.pathname.split("/").at(-1) ?? "";
    url = true;
  }
  const pattern = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;
  const match = candidate.match(pattern);
  // A bare id must be the whole input; a URL's segment may carry a title slug before it.
  if (!match || (!url && match[0] !== candidate) || (url && match.index! > 0 && candidate[match.index! - 1] !== "-")) return null;
  return match.slice(1).join("-").toLowerCase();
}
export function validNotionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** One notion_read call, as the runner asks the control plane for it within a write message. */
export interface NotionReadRequest {
  sessionId: string;
  actorId: string;
  admissionId: string;
  callId: string;
  /** The workspace source's id, as the grant lists it. */
  source: string;
  /** A page or database under the source (or the source itself); the source's own page or database when absent. */
  page?: string;
}

/** A page or database as notion_read returns it, within notionReadLimits.bytes of JSON. */
export interface NotionReadView {
  source: string;
  id: string;
  object: NotionObject;
  title: string;
  url: string;
  lastEdited: string;
  /** A page's content as Markdown. Child pages and databases are listed in `children` and linked by id. */
  markdown?: string;
  /** Pages and databases directly under a page, to read next with notion_read {source, page}. */
  children?: { id: string; object: NotionObject; title: string }[];
  /** A database's rows (the first notionReadLimits.rows), newest edit first. */
  rows?: { id: string; title: string; url: string; lastEdited: string }[];
  /** True when the content, children or rows were cut to fit. */
  truncated: boolean;
}
export const notionReadLimits = { bytes: 96 * 1024, blocks: 1000, depth: 3, rows: 200, ancestry: 16 } as const;
