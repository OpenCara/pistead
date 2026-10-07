import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built web client from `root`: an existing file as-is (hashed `/assets/*` files are
 * immutable), anything else as `index.html` so the SPA router owns the path. The caller limits
 * this to GET/HEAD requests outside `/api/`.
 */
export function createStaticHandler(root: string): (request: Request) => Promise<Response> {
  const base = resolve(root);
  const index = join(base, 'index.html');
  async function serve(path: string, request: Request, cacheControl: string): Promise<Response | null> {
    let info;
    try { info = await stat(path); } catch { return null; }
    if (!info.isFile()) return null;
    const headers = {
      'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Last-Modified': info.mtime.toUTCString(),
      'Cache-Control': cacheControl,
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, { status: 200, headers });
  }
  return async request => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { pathname = '/'; }
    if (!pathname.includes('\0') && pathname !== '/') {
      const path = resolve(base, `.${pathname}`);
      if (path.startsWith(base + sep)) {
        const response = await serve(path, request, pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        if (response) return response;
      }
    }
    return await serve(index, request, 'no-cache') ?? Response.json({ error: 'Not found.', code: 'not_found' }, { status: 404 });
  };
}
