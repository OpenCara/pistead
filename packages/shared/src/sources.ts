/**
 * Workspace sources: what a workspace's sessions work on (docs/design/external-sources.md). A Git repository is one kind,
 * kept in workspace_repositories with everything only Git has. Document sources (a Notion page, a Google Drive folder,
 * a Feishu/Lark folder or document) are the others: sessions read them with source_read, through the control plane,
 * with the session owner's own connected account. Every source of a workspace is in the grant of every session in it.
 */
export const sourceKinds = ["git", "notion", "google-drive", "feishu"] as const;
export type SourceKind = (typeof sourceKinds)[number];
/** The kinds sessions read with source_read; each has a connected account of the same name. */
export const documentKinds = ["notion", "google-drive", "feishu"] as const;
export type DocumentKind = (typeof documentKinds)[number];
export function documentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (documentKinds as readonly string[]).includes(value);
}
export const documentKindNames: Record<DocumentKind, string> = { notion: "Notion", "google-drive": "Google Drive", feishu: "Feishu / Lark" };

export const sourceLimits = {
  /** Document sources per workspace, all kinds together. */
  documents: 20,
  /** A bound item's title as stored and shown. */
  title: 300,
} as const;

/**
 * A connected account as its owner sees it; the secret never leaves the server.
 * - notion: an internal integration secret;
 * - google-drive: a service account's JSON key;
 * - feishu: a custom app's App ID and App Secret, on Feishu (open.feishu.cn) or Lark (open.larksuite.com).
 */
export interface SourceAccount {
  provider: DocumentKind;
  /** What the provider calls it: the Notion workspace, the service account's email, the app's id. */
  name: string;
  createdAt: string;
}
export interface SourceAccountList { accounts: SourceAccount[] }
export const feishuDomains = ["feishu", "lark"] as const;
export type FeishuDomain = (typeof feishuDomains)[number];
/** What a connect request carries, per provider. */
export type SourceAccountInput =
  | { provider: "notion"; token: string }
  | { provider: "google-drive"; key: string }
  | { provider: "feishu"; appId: string; appSecret: string; domain: FeishuDomain };

/**
 * What a document source's root, or an item under it, is. Pages and documents read as text; folders, databases and
 * wiki nodes list what is in them (a Notion page does both).
 */
export const documentItemTypes = ["page", "database", "folder", "document", "spreadsheet", "presentation", "file", "wiki"] as const;
export type DocumentItemType = (typeof documentItemTypes)[number];

/** A page, folder or document bound to a workspace. Sessions read it, and what is under it, with their owner's account. */
export interface WorkspaceDocumentSource {
  id: string;
  workspaceId: string;
  kind: DocumentKind;
  /** The provider's id of the bound item. */
  itemId: string;
  itemType: DocumentItemType;
  title: string;
  url: string;
  createdAt: string;
}
export interface WorkspaceSourceList {
  /** Sources other than Git repositories; those are listed by /repositories. */
  sources: WorkspaceDocumentSource[];
}

/** A document source as a session's grant names it, for the agent's instructions and source_read. */
export interface GrantSource { id: string; kind: DocumentKind; type: DocumentItemType; title: string }

/** One source_read call, as the runner asks the control plane for it within a write message. */
export interface SourceReadRequest {
  sessionId: string;
  actorId: string;
  admissionId: string;
  callId: string;
  /** The workspace source's id, as the grant lists it. */
  source: string;
  /** An item under the source (an id or a link from an earlier result); the source's own item when absent. */
  item?: string;
}

/** A child of a page or folder, or a row of a database: read it next with source_read {source, item: id}. */
export interface SourceReadEntry { id: string; type: DocumentItemType; title: string; url?: string; lastEdited?: string }
/** An item as source_read returns it, within sourceReadLimits.bytes of JSON. */
export interface SourceReadView {
  source: string;
  kind: DocumentKind;
  id: string;
  type: DocumentItemType;
  title: string;
  url: string;
  lastEdited: string;
  /** A page's or document's content: Markdown where the provider gives it (Notion, Google Docs), plain text or CSV otherwise. */
  content?: string;
  /** What is under the item: child pages and databases, a folder's files, a database's rows, a wiki node's children. */
  entries?: SourceReadEntry[];
  /** Why there is no content, such as a binary file. */
  note?: string;
  /** True when content or entries were cut to fit. */
  truncated: boolean;
}
export const sourceReadLimits = { bytes: 96 * 1024, entries: 200, ancestry: 16, item: 2048 } as const;
/** A source_read item as the runner passes it on: a bounded single line. The control plane parses it per kind. */
export function validSourceItem(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= sourceReadLimits.item && !/[\x00-\x1f\x7f]/.test(value);
}

/** Notion's limits on a page's walk (blocks read, nesting levels). */
export const notionReadLimits = { blocks: 1000, depth: 3 } as const;

/**
 * A Notion id from a page or database URL or a bare id (32 hex digits, dashed or not), in Notion's dashed lowercase
 * form; null otherwise.
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

const driveIdPattern = /^[A-Za-z0-9_-]{10,200}$/;
/**
 * A Google Drive file or folder id from a Drive or Docs link (…/folders/ID, …/file/d/ID, …/document/d/ID,
 * …/spreadsheets/d/ID, …/presentation/d/ID, ?id=ID) or a bare id; null otherwise.
 */
export function googleDriveId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  if (!/^https:\/\//i.test(text)) return driveIdPattern.test(text) ? text : null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.hostname !== "drive.google.com" && url.hostname !== "docs.google.com") return null;
  const path = url.pathname.match(/\/(?:folders|d)\/([A-Za-z0-9_-]+)/);
  const id = path?.[1] ?? url.searchParams.get("id");
  return id && driveIdPattern.test(id) ? id : null;
}

const feishuTokenPattern = /^[A-Za-z0-9]{10,64}$/;
export type FeishuItem = { type: "folder" | "document" | "wiki"; token: string };
/**
 * A Feishu/Lark item from its link (…/drive/folder/TOKEN, …/docx/TOKEN, …/wiki/TOKEN, on *.feishu.cn or
 * *.larksuite.com) or, for an id without a link, `folder:TOKEN`, `docx:TOKEN` or `wiki:TOKEN`; null otherwise.
 */
export function feishuItem(value: unknown): FeishuItem | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const text = value.trim();
  const prefixed = text.match(/^(folder|docx|wiki):([A-Za-z0-9]+)$/);
  if (prefixed) return feishuTokenPattern.test(prefixed[2]!) ? { type: prefixed[1] === "docx" ? "document" : prefixed[1] as "folder" | "wiki", token: prefixed[2]! } : null;
  if (!/^https:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname;
  if (!(host === "feishu.cn" || host.endsWith(".feishu.cn") || host === "larksuite.com" || host.endsWith(".larksuite.com"))) return null;
  const path = url.pathname.match(/\/(drive\/folder|docx|wiki)\/([A-Za-z0-9]+)/);
  if (!path || !feishuTokenPattern.test(path[2]!)) return null;
  return { type: path[1] === "docx" ? "document" : path[1] === "wiki" ? "wiki" : "folder", token: path[2]! };
}
