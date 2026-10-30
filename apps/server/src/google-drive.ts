import { createPrivateKey, createHash, sign } from 'node:crypto';
import { googleDriveId, sourceLimits, sourceReadLimits, type DocumentItemType, type SourceReadEntry } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { accountRejected, clean, json, notFound, outsideSource, rateLimited, textBody, upstream, type DocumentAdapter, type ItemView } from './document-http.js';

/**
 * Google Drive as a service account: its owner shares a folder or file with the account's email, as with a Notion
 * integration, and sessions read what is shared under the bound item (drive.readonly). The key is signed into a
 * short-lived token here; neither ever leaves the control plane. Google Docs read as Markdown, Sheets as CSV, Slides
 * as text, text files as they are; folders list their files.
 */
export const googleTokenUri = 'https://oauth2.googleapis.com/token';
export const driveApi = 'https://www.googleapis.com/drive/v3';
const scope = 'https://www.googleapis.com/auth/drive.readonly';
const share = 'the service account';
const folderType = 'application/vnd.google-apps.folder';
const fileFields = 'id,name,mimeType,parents,webViewLink,modifiedTime';
const textLimit = 512 * 1024;

type Json = Record<string, unknown>;
interface ServiceKey { client_email: string; private_key: string; private_key_id?: string }

function parseKey(secret: string): ServiceKey {
  return JSON.parse(secret) as ServiceKey;
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** Access tokens by key, until shortly before they expire; at most 100 kept. */
const tokens = new Map<string, { token: string; expires: number }>();

async function accessToken(secret: string): Promise<string> {
  const cacheKey = createHash('sha256').update(secret).digest('hex');
  const cached = tokens.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.token;
  const key = parseKey(secret);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope, aud: googleTokenUri, iat: now, exp: now + 3600 }));
  let signature: string;
  try { signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), createPrivateKey(key.private_key))); }
  catch { return fail(400, 'invalid_source_account', 'The service account key\'s private key could not be read.'); }
  const answer = await upstream('Google', googleTokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString() }, 64 * 1024);
  if (answer.status === 400 || answer.status === 401 || answer.status === 403) accountRejected('Google');
  if (answer.status === 429) rateLimited('Google');
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Google could not complete the request. Try again later.');
  const body = json('Google', answer);
  if (typeof body.access_token !== 'string') fail(502, 'invalid_source_response', 'Google returned an unexpected response.');
  const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  if (tokens.size >= 100) tokens.delete(tokens.keys().next().value!);
  tokens.set(cacheKey, { token: body.access_token, expires: Date.now() + Math.max(0, lifetime - 300) * 1000 });
  return body.access_token;
}

async function drive(secret: string, path: string, kind: 'json' | 'text' = 'json', limit = 1024 * 1024) {
  const token = await accessToken(secret);
  const answer = await upstream('Google Drive', `${driveApi}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: kind === 'json' ? 'application/json' : '*/*' } }, limit);
  if (answer.status === 401) accountRejected('Google Drive');
  if (answer.status === 429) rateLimited('Google Drive');
  return answer;
}

async function driveJson(secret: string, path: string): Promise<Json> {
  const answer = await drive(secret, path);
  if (answer.status === 403 || answer.status === 404) notFound('Google Drive', share);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Google Drive could not complete the request. Try again later.');
  return json('Google Drive', answer);
}

function itemType(mimeType: unknown): DocumentItemType {
  switch (mimeType) {
    case folderType: return 'folder';
    case 'application/vnd.google-apps.document': return 'document';
    case 'application/vnd.google-apps.spreadsheet': return 'spreadsheet';
    case 'application/vnd.google-apps.presentation': return 'presentation';
    default: return 'file';
  }
}

interface DriveFile { id: string; type: DocumentItemType; mimeType: string; title: string; url: string; lastEdited: string; parents: string[] }

function file(value: Json): DriveFile {
  if (typeof value.id !== 'string') fail(502, 'invalid_source_response', 'Google Drive returned an unexpected response.');
  const url = typeof value.webViewLink === 'string' && /^https:\/\/(drive|docs)\.google\.com\//.test(value.webViewLink) ? value.webViewLink.slice(0, 2048)
    : `https://drive.google.com/open?id=${encodeURIComponent(value.id)}`;
  return { id: value.id, type: itemType(value.mimeType), mimeType: typeof value.mimeType === 'string' ? value.mimeType : '', title: clean(value.name, sourceLimits.title) || 'Untitled',
    url, lastEdited: typeof value.modifiedTime === 'string' ? value.modifiedTime : '',
    parents: Array.isArray(value.parents) ? value.parents.filter((parent): parent is string => typeof parent === 'string') : [] };
}

async function metadata(secret: string, id: string): Promise<DriveFile> {
  return file(await driveJson(secret, `/files/${encodeURIComponent(id)}?fields=${fileFields}&supportsAllDrives=true`));
}

/** Requires `target` to be `root` or in a folder under it, following Drive parents a bounded way up. */
async function requireUnder(secret: string, root: string, target: DriveFile): Promise<void> {
  if (target.id === root) return;
  let parents = target.parents;
  for (let step = 0; step < sourceReadLimits.ancestry && parents.length; step++) {
    if (parents.includes(root)) return;
    const answer = await drive(secret, `/files/${encodeURIComponent(parents[0]!)}?fields=id,parents&supportsAllDrives=true`);
    if (answer.status !== 200) break;
    const parent = json('Google Drive', answer);
    parents = Array.isArray(parent.parents) ? parent.parents.filter((value): value is string => typeof value === 'string') : [];
  }
  outsideSource();
}

const textTypes = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql|toml|x-toml|csv)\b)/;
const textNames = /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|xml|html?|css|js|ts|py|sh|sql|ini|cfg|log)$/i;

async function exported(secret: string, item: DriveFile, mimeType: string): Promise<{ text: string; truncated: boolean } | null> {
  const answer = await drive(secret, `/files/${encodeURIComponent(item.id)}/export?mimeType=${encodeURIComponent(mimeType)}`, 'text', textLimit);
  if (answer.status === 200) return textBody(answer);
  if (answer.status === 400) return null;
  if (answer.status === 403) return { text: '', truncated: true };
  if (answer.status === 404) notFound('Google Drive', share);
  return fail(502, 'source_unavailable', 'Google Drive could not export the file. Try again later.');
}

async function content(secret: string, item: DriveFile): Promise<{ content?: string; note?: string; truncated: boolean }> {
  if (item.type === 'document') {
    // Markdown where Drive exports it; plain text otherwise.
    const body = await exported(secret, item, 'text/markdown') ?? await exported(secret, item, 'text/plain');
    return body?.text ? { content: body.text, truncated: body.truncated } : { note: 'Google Drive could not export this document (it may be too large).', truncated: true };
  }
  if (item.type === 'spreadsheet' || item.type === 'presentation') {
    const body = await exported(secret, item, item.type === 'spreadsheet' ? 'text/csv' : 'text/plain');
    const note = item.type === 'spreadsheet' ? 'Only the first sheet is exported, as CSV.' : undefined;
    return body?.text ? { content: body.text, truncated: body.truncated, ...(note ? { note } : {}) } : { note: 'Google Drive could not export this file.', truncated: true };
  }
  if (item.mimeType.startsWith('application/vnd.google-apps.')) return { note: `A ${item.mimeType.slice('application/vnd.google-apps.'.length)} can't be read as text.`, truncated: false };
  if (!textTypes.test(item.mimeType) && !textNames.test(item.title)) return { note: `A binary file (${item.mimeType || 'unknown type'}) can't be read as text.`, truncated: false };
  const answer = await drive(secret, `/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`, 'text', textLimit);
  if (answer.status === 403 || answer.status === 404) notFound('Google Drive', share);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Google Drive could not download the file. Try again later.');
  const body = textBody(answer);
  return { content: body.text, truncated: body.truncated };
}

async function children(secret: string, folder: string): Promise<{ entries: SourceReadEntry[]; truncated: boolean }> {
  const entries: SourceReadEntry[] = [];
  let pageToken: string | null = null;
  do {
    const query = new URLSearchParams({ q: `'${folder}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)',
      pageSize: '100', orderBy: 'folder,name', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) });
    const page = await driveJson(secret, `/files?${query}`);
    for (const value of Array.isArray(page.files) ? page.files.filter((item): item is Json => Boolean(item) && typeof item === 'object') : []) {
      const child = file(value);
      entries.push({ id: child.id, type: child.type, title: child.title, url: child.url, lastEdited: child.lastEdited });
    }
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
  } while (pageToken && entries.length < sourceReadLimits.entries);
  return { entries: entries.slice(0, sourceReadLimits.entries), truncated: Boolean(pageToken) || entries.length > sourceReadLimits.entries };
}

export const googleDriveAdapter: DocumentAdapter = {
  name: 'Google Drive',
  async connect(input) {
    if (Object.keys(input).some(key => !['provider', 'key'].includes(key))) fail(400, 'invalid_input', 'Only the service account key is accepted.');
    let key: Json;
    try { key = JSON.parse(typeof input.key === 'string' ? input.key : '') as Json; }
    catch { return fail(400, 'invalid_source_account', 'Paste the service account\'s JSON key file.'); }
    if (!key || typeof key !== 'object' || key.type !== 'service_account' || typeof key.client_email !== 'string'
      || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(key.client_email)
      || typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY') || key.private_key.length > 8192
      || (key.token_uri !== undefined && key.token_uri !== googleTokenUri)
      || (key.private_key_id !== undefined && (typeof key.private_key_id !== 'string' || !/^[0-9a-f]{1,64}$/.test(key.private_key_id)))) {
      fail(400, 'invalid_source_account', 'Paste the JSON key of a Google Cloud service account (type service_account).');
    }
    // Only what signing needs is kept; the key's other fields are dropped.
    const secret = JSON.stringify({ client_email: key.client_email, private_key: key.private_key, ...(key.private_key_id ? { private_key_id: key.private_key_id } : {}) });
    await driveJson(secret, '/about?fields=user');
    return { secret, name: key.client_email };
  },
  async resolve(secret, target) {
    const id = googleDriveId(target);
    if (!id) fail(400, 'invalid_source', 'Paste the link of a Google Drive folder or file (or a Google Doc, Sheet or Slides), or its id.');
    const found = await metadata(secret, id);
    return { id: found.id, type: found.type, title: found.title, url: found.url };
  },
  async read(secret, root, item): Promise<ItemView> {
    const id = item === null ? root.id : googleDriveId(item);
    if (!id) fail(400, 'invalid_input', 'item must be a Google Drive file or folder id or link.');
    const target = await metadata(secret, id);
    await requireUnder(secret, root.id, target);
    const base = { id: target.id, type: target.type, title: target.title, url: target.url, lastEdited: target.lastEdited };
    if (target.type === 'folder') return { ...base, ...await children(secret, target.id) };
    return { ...base, ...await content(secret, target) };
  },
};
