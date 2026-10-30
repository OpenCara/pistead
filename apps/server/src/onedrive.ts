import { onedriveItem, sourceLimits, sourceReadLimits, type DocumentItemType, type SourceReadEntry } from '../../../packages/shared/src/sources.js';
import { fail } from './http.js';
import { accountRejected, clean, json, notFound, outsideSource, rateLimited, textBody, upstream, type BoundItem, type DocumentAdapter, type ItemView, type Upstream } from './document-http.js';
import { docxFile, docxText, textFile } from './office.js';

/**
 * OneDrive and SharePoint through Microsoft Graph, signed in as the member (Files.Read.All, Sites.Read.All). Items are
 * named `DRIVE~ITEM`; links resolve through Graph's /shares. "Under" follows parentReference up within the same drive.
 * Downloads follow Graph's redirect to a pre-authenticated URL on a Microsoft download host, without the token.
 */
export const graphApi = 'https://graph.microsoft.com/v1.0';
const share = 'your Microsoft account';
const fields = 'id,name,folder,file,parentReference,webUrl,lastModifiedDateTime,package';
const textLimit = 512 * 1024;
const downloadHosts = /(^|\.)(sharepoint\.com|1drv\.com|onedrive\.com|microsoftpersonalcontent\.com|live\.net|svc\.ms)$/;

type Json = Record<string, unknown>;

function token(secret: string): string {
  return (JSON.parse(secret) as { accessToken: string }).accessToken;
}

function refused(answer: Upstream): void {
  if (answer.status === 401) accountRejected('Microsoft');
  if (answer.status === 429) rateLimited('Microsoft');
  if (answer.status === 400 || answer.status === 403 || answer.status === 404) notFound('OneDrive', share);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'Microsoft Graph could not complete the request. Try again later.');
}

async function graph(secret: string, path: string): Promise<Json> {
  const answer = await upstream('Microsoft', `${graphApi}${path}`, { headers: { Authorization: `Bearer ${token(secret)}`, Accept: 'application/json' } });
  refused(answer);
  return json('Microsoft', answer);
}

interface Item { driveId: string; itemId: string; id: string; type: DocumentItemType; folder: boolean; title: string; url: string; lastEdited: string; parentId: string | null; mimeType: string }

function item(value: Json): Item {
  const parent = (value.parentReference && typeof value.parentReference === 'object' ? value.parentReference : {}) as Json;
  if (typeof value.id !== 'string' || typeof parent.driveId !== 'string') fail(502, 'invalid_source_response', 'Microsoft Graph returned an unexpected response.');
  const folder = Boolean(value.folder) || Boolean(value.package);
  const file = (value.file && typeof value.file === 'object' ? value.file : {}) as Json;
  const title = clean(value.name, sourceLimits.title) || 'Untitled';
  const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
  return { driveId: parent.driveId, itemId: value.id, id: `${parent.driveId}~${value.id}`, folder,
    type: folder ? 'folder' : mimeType === docxFile.type || docxFile.name.test(title) ? 'document' : 'file', title,
    url: typeof value.webUrl === 'string' && /^https:\/\//.test(value.webUrl) ? value.webUrl.slice(0, 2048) : 'https://onedrive.live.com/',
    lastEdited: typeof value.lastModifiedDateTime === 'string' ? value.lastModifiedDateTime : '', parentId: typeof parent.id === 'string' ? parent.id : null, mimeType };
}

const path = (driveId: string, itemId: string) => `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;

async function lookup(secret: string, ref: { driveId: string; itemId: string } | { url: string }): Promise<Item> {
  if ('url' in ref) return item(await graph(secret, `/shares/u!${Buffer.from(ref.url).toString('base64url')}/driveItem?$select=${fields}`));
  return item(await graph(secret, `${path(ref.driveId, ref.itemId)}?$select=${fields}`));
}

async function requireUnder(secret: string, root: Item, target: Item): Promise<void> {
  if (target.id === root.id) return;
  if (target.driveId !== root.driveId || !root.folder) outsideSource();
  let parent = target.parentId;
  for (let step = 0; parent && step < sourceReadLimits.ancestry; step++) {
    if (parent === root.itemId) return;
    const next = await graph(secret, `${path(root.driveId, parent)}?$select=id,parentReference`);
    const reference = (next.parentReference ?? {}) as Json;
    parent = typeof reference.id === 'string' ? reference.id : null;
  }
  outsideSource();
}

/** The file's bytes: Graph answers /content with a redirect to a pre-authenticated download URL. */
async function download(secret: string, target: Item): Promise<Upstream> {
  const first = await upstream('Microsoft', `${graphApi}${path(target.driveId, target.itemId)}/content`, { headers: { Authorization: `Bearer ${token(secret)}` } }, textLimit);
  if (first.status !== 302 && first.status !== 301 && first.status !== 307) { refused(first); return first; }
  const location = first.headers.get('location') ?? '';
  let url: URL;
  try { url = new URL(location); } catch { return fail(502, 'invalid_source_response', 'Microsoft Graph returned an unexpected download link.'); }
  if (url.protocol !== 'https:' || !downloadHosts.test(url.hostname)) fail(502, 'invalid_source_response', 'Microsoft Graph returned an unexpected download link.');
  const answer = await upstream('OneDrive', url.href, {}, textLimit);
  if (answer.status !== 200) fail(502, 'source_unavailable', 'OneDrive could not download the file. Try again later.');
  return answer;
}

export const onedriveAdapter: DocumentAdapter = {
  name: 'OneDrive / SharePoint',
  async connect() { return fail(400, 'oauth_required', 'Connect OneDrive and SharePoint by signing in to Microsoft.'); },
  async resolve(secret, target): Promise<BoundItem> {
    const ref = onedriveItem(target);
    if (!ref) fail(400, 'invalid_source', 'Paste a OneDrive or SharePoint link to a folder or file.');
    const found = await lookup(secret, ref);
    return { id: found.id, type: found.type, title: found.title, url: found.url };
  },
  async read(secret, root, raw): Promise<ItemView> {
    const rootRef = onedriveItem(root.id);
    if (!rootRef || 'url' in rootRef) return fail(500, 'invalid_source', 'The bound OneDrive item is malformed.');
    const ref = raw === null ? rootRef : onedriveItem(raw);
    if (!ref) fail(400, 'invalid_input', 'item must be an id from an earlier result (DRIVE~ITEM) or a OneDrive or SharePoint link.');
    const bound = await lookup(secret, rootRef);
    const target = raw === null ? bound : await lookup(secret, ref);
    await requireUnder(secret, bound, target);
    const base = { id: target.id, type: target.type, title: target.title, url: target.url, lastEdited: target.lastEdited };
    if (target.folder) {
      const entries: SourceReadEntry[] = [];
      let next: string | null = `${graphApi}${path(target.driveId, target.itemId)}/children?$top=200&$select=${fields}`;
      while (next && entries.length < sourceReadLimits.entries) {
        const answer = await upstream('Microsoft', next, { headers: { Authorization: `Bearer ${token(secret)}`, Accept: 'application/json' } });
        refused(answer);
        const page = json('Microsoft', answer);
        for (const value of Array.isArray(page.value) ? page.value.filter((entry: unknown): entry is Json => Boolean(entry) && typeof entry === 'object') : []) {
          const child = item(value);
          entries.push({ id: child.id, type: child.type, title: child.title, url: child.url, ...(child.lastEdited ? { lastEdited: child.lastEdited } : {}) });
        }
        const link = page['@odata.nextLink'];
        // Only Graph's own next page; never a link elsewhere with the token.
        next = typeof link === 'string' && link.startsWith(`${graphApi}/`) ? link : null;
      }
      return { ...base, entries: entries.slice(0, sourceReadLimits.entries), truncated: Boolean(next) || entries.length > sourceReadLimits.entries };
    }
    if (target.type === 'document') {
      const answer = await download(secret, target);
      const text = answer.headers.get('x-pistead-truncated') ? null : docxText(answer.bytes);
      return text === null ? { ...base, note: 'This Word document is too large or unreadable.', truncated: true } : { ...base, content: text, truncated: false };
    }
    if (!textFile.types.test(target.mimeType) && !textFile.names.test(target.title)) return { ...base, note: `A binary file (${target.mimeType || 'unknown type'}) can't be read as text.`, truncated: false };
    const body = textBody(await download(secret, target));
    return { ...base, content: body.text, truncated: body.truncated };
  },
};
