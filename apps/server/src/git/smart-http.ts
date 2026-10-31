import { boundedRepositoryBody } from '../repositories.js';

/**
 * Git's smart HTTP ref advertisement (`GET <remote>/info/refs?service=...`), for Git servers without a forge API: it
 * says whether a credential may read (upload-pack) or push (receive-pack), and lists the refs with HEAD's branch.
 * See gitprotocol-http(5) and gitprotocol-pack(5). Protocol version 0 is asked for, as it carries every ref and HEAD's
 * symref in one response.
 */

export type AdvertisedService = 'git-upload-pack' | 'git-receive-pack';

export interface Advertisement {
  /** Ref name to object id, peeled tags as `refs/tags/<name>^{}`. */
  refs: Map<string, string>;
  /** What HEAD points to (`refs/heads/main`), when the server says. */
  head: string | null;
  /** The repository uses SHA-256 object names. */
  sha256: boolean;
}

/** Why an advertisement wasn't read; the caller turns each into its own error. */
export type AdvertisementFailure = 'denied' | 'redirected' | 'not-smart' | 'unavailable' | 'invalid';
export type AdvertisementResult = { ok: true; advertisement: Advertisement } | { ok: false; failure: AdvertisementFailure };

// The refs of a large repository (100 000 branches and tags) fit well within this.
export const advertisementBytes = 8 * 1024 * 1024;
const timeout = 20_000;
// Some servers only speak smart HTTP to clients that look like Git.
const userAgent = 'git/2 (OpenCara-Agent-Workspace)';
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const zero = /^0+$/;

/**
 * Reads the advertisement of `service` at `remote` (a credential-free https URL), sending `authorization` when given.
 * Redirects are never followed, so a credential only ever goes to the remote's own origin.
 */
export async function readAdvertisement(remote: string, service: AdvertisedService, authorization: string | null,
  fetcher: typeof fetch = fetch): Promise<AdvertisementResult> {
  let response: Response;
  try {
    response = await fetcher(`${remote}/info/refs?service=${service}`, {
      headers: { 'User-Agent': userAgent, Accept: '*/*', ...(authorization ? { Authorization: authorization } : {}) },
      redirect: 'manual', signal: AbortSignal.timeout(timeout),
    });
  } catch { return { ok: false, failure: 'unavailable' }; }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403, 404].includes(response.status)) return { ok: false, failure: 'denied' };
    if (response.status >= 300 && response.status < 400) return { ok: false, failure: 'redirected' };
    return { ok: false, failure: 'unavailable' };
  }
  // A dumb HTTP server answers with the plain info/refs file instead; it can't be fetched through the relay.
  if ((response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== `application/x-${service}-advertisement`) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, failure: 'not-smart' };
  }
  let body: Uint8Array;
  try { body = await boundedRepositoryBody(response, advertisementBytes); } catch { return { ok: false, failure: 'unavailable' }; }
  const advertisement = parseAdvertisement(body, service);
  return advertisement ? { ok: true, advertisement } : { ok: false, failure: 'invalid' };
}

/** pkt-lines of `body`; null entries are flush packets. Null when the framing is broken. */
function packets(body: Uint8Array): (string | null)[] | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: (string | null)[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) return null;
    const header = String.fromCharCode(...body.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) return null;
    const length = parseInt(header, 16);
    if (length === 0) { lines.push(null); offset += 4; continue; }
    // 0001 and 0002 are protocol v2 delimiters; v0 has none.
    if (length < 4 || offset + length > body.length) return null;
    let text: string;
    try { text = decoder.decode(body.subarray(offset + 4, offset + length)); } catch { return null; }
    lines.push(text.endsWith('\n') ? text.slice(0, -1) : text);
    offset += length;
  }
  return lines;
}

/** The refs of a v0 advertisement, after the optional `# service=` announcement and its flush. */
export function parseAdvertisement(body: Uint8Array, service: AdvertisedService): Advertisement | null {
  const lines = packets(body);
  if (!lines) return null;
  let index = 0;
  if (lines[0] === `# service=${service}`) {
    if (lines[1] !== null) return null;
    index = 2;
  }
  const refs = new Map<string, string>();
  let head: string | null = null;
  let sha256 = false;
  let first = true;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line === null) break;
    // Protocol v2 servers answer a v0 request with `version 2` and capabilities, never with refs.
    if (first && line.startsWith('version ')) return null;
    let ref = line;
    if (first) {
      const nul = line.indexOf('\0');
      if (nul < 0) return null;
      ref = line.slice(0, nul);
      for (const capability of line.slice(nul + 1).split(' ')) {
        if (capability.startsWith('symref=HEAD:')) head = capability.slice('symref=HEAD:'.length);
        if (capability === 'object-format=sha256') sha256 = true;
      }
      first = false;
    }
    const space = ref.indexOf(' ');
    const id = ref.slice(0, space);
    const name = ref.slice(space + 1);
    if (space < 0 || !objectId.test(id) || !name || /[\x00-\x20\x7f]/.test(name)) return null;
    if (id.length === 64) sha256 = true;
    // An empty repository advertises only its capabilities, on the zero id.
    if (zero.test(id) && name === 'capabilities^{}') continue;
    refs.set(name, id);
  }
  if (first) return null;
  return { refs, head, sha256 };
}

/**
 * The branch HEAD names: its symref where the server sends one, otherwise the branch whose tip HEAD shares (main and
 * master first), otherwise the only branch. Null for a repository without branches.
 */
export function defaultBranch(advertisement: Advertisement): string | null {
  const branches = [...advertisement.refs.keys()].filter(name => name.startsWith('refs/heads/'));
  if (advertisement.head?.startsWith('refs/heads/') && advertisement.refs.has(advertisement.head)) return advertisement.head.slice('refs/heads/'.length);
  const tip = advertisement.refs.get('HEAD');
  if (tip) {
    const preferred = ['refs/heads/main', 'refs/heads/master'];
    const match = [...preferred.filter(name => branches.includes(name)), ...branches.sort()].find(name => advertisement.refs.get(name) === tip);
    if (match) return match.slice('refs/heads/'.length);
  }
  return branches.length === 1 ? branches[0]!.slice('refs/heads/'.length) : null;
}

/** The commit `ref` names: a branch, then a tag (peeled to its commit), or null. Object ids aren't resolved here. */
export function resolveRef(advertisement: Advertisement, ref: string): string | null {
  return advertisement.refs.get(`refs/heads/${ref}`)
    ?? advertisement.refs.get(`refs/tags/${ref}^{}`) ?? advertisement.refs.get(`refs/tags/${ref}`) ?? null;
}
