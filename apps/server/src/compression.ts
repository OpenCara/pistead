import { constants, createGzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';

const responses = compress({ encoding: 'gzip' });

/**
 * gzip for clients that accept it. Responses go through Hono's compress, which leaves event streams alone because it
 * would hold their events back; those are gzipped here with a flush after every write, so each event still arrives the
 * moment it is sent. Host and runner callbacks stay as they are: their downloads are checked against exact lengths.
 */
export const compression: MiddlewareHandler = async (c, next) => {
  if (c.req.path.startsWith('/api/internal/') || c.req.path.startsWith('/api/connectors/self/') || !acceptsGzip(c.req.header('Accept-Encoding'))) return next();
  await responses(c, next);
  if (c.res.headers.has('Content-Encoding')) {
    if (c.res.headers.get('Content-Encoding') === 'gzip') c.res.headers.append('Vary', 'Accept-Encoding');
    return;
  }
  if (!/^text\/event-stream\b/i.test(c.res.headers.get('Content-Type') ?? '') || !c.res.body) return;
  c.res = new Response(gzipEvents(c.res.body), c.res);
  c.res.headers.set('Content-Encoding', 'gzip');
  c.res.headers.append('Vary', 'Accept-Encoding');
};

function acceptsGzip(header: string | undefined): boolean {
  return (header ?? '').split(',').some(part => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(';').map(value => value.trim());
    const quality = parameters.find(value => value.startsWith('q='));
    return (coding === 'gzip' || coding === '*') && (!quality || Number(quality.slice(2)) > 0);
  });
}

/** One gzip stream over the events, flushed after each write. Cancelling it cancels the events, as the client leaving does. */
export function gzipEvents(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
  let ended = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      gzip.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      gzip.once('end', () => controller.close());
      gzip.once('error', error => controller.error(error));
    },
    async pull() {
      if (ended) return;
      const part = await reader.read();
      if (part.done) {
        ended = true;
        gzip.end();
        return;
      }
      await new Promise<void>((resolve, reject) => gzip.write(part.value, error => error ? reject(error) : resolve()));
    },
    cancel(reason) {
      ended = true;
      gzip.destroy();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
