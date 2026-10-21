import test from 'node:test';
import assert from 'node:assert/strict';
import { createGunzip, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { compression } from '../apps/server/src/compression.js';

const view = { entries: Array.from({ length: 100 }, (_, index) => ({ id: `0:${index}`, text: 'the same words again and again' })) };

function server() {
  const app = new Hono();
  app.use('*', compression);
  app.get('/api/view', c => c.json(view));
  app.get('/api/internal/download', c => new Response(JSON.stringify(view), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(JSON.stringify(view).length) } }));
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  app.get('/api/events', c => {
    const response = streamSSE(c, async stream => {
      stream.onAbort(() => { aborted = true; });
      await stream.writeSSE({ event: 'view', data: JSON.stringify(view) });
      await released;
      await stream.writeSSE({ event: 'patch', data: '{}' });
    });
    response.headers.set('Cache-Control', 'private, no-store, no-transform');
    return response;
  });
  return { app, release: () => release(), aborted: () => aborted };
}

test('JSON responses are gzipped for clients that accept it and left alone for others and for host callbacks', async () => {
  const { app } = server();
  const compressed = await app.request('/api/view', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.match(compressed.headers.get('vary') ?? '', /Accept-Encoding/);
  const bytes = Buffer.from(await compressed.arrayBuffer());
  assert.ok(bytes.length < JSON.stringify(view).length / 5, `${bytes.length} compressed bytes`);
  assert.deepEqual(JSON.parse(gunzipSync(bytes).toString()), view);
  for (const encoding of [undefined, 'identity', 'gzip;q=0']) {
    const plain = await app.request('/api/view', { headers: encoding ? { 'Accept-Encoding': encoding } : {} });
    assert.equal(plain.headers.get('content-encoding'), null, String(encoding));
    assert.deepEqual(await plain.json(), view);
  }
  // A restore or repository download is checked against its exact length.
  const callback = await app.request('/api/internal/download', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(callback.headers.get('content-encoding'), null);
  assert.equal(callback.headers.get('content-length'), String(JSON.stringify(view).length));
});

test('event streams are gzipped with every event decodable as soon as it is sent', async () => {
  const { app, release } = server();
  const response = await app.request('/api/events', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const gunzip = createGunzip();
  let text = '';
  gunzip.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  const reader = response.body!.getReader();
  const until = async (pattern: RegExp) => {
    while (!pattern.test(text)) {
      const part = await reader.read();
      if (part.done) break;
      gunzip.write(part.value);
      await new Promise<void>(resolve => gunzip.flush(() => resolve()));
    }
  };
  // The first event arrives whole while the stream is still open and the second not yet written.
  await until(/event: view\ndata: .*\n\n/);
  assert.deepEqual(JSON.parse(/data: (.*)/.exec(text)![1]!), view);
  release();
  await until(/event: patch/);
  assert.match(text, /event: patch\ndata: \{\}/);
  // Then the gzip trailer, and the end.
  let parts = 0;
  while (!(await reader.read()).done) parts++;
  assert.ok(parts <= 1);
  const plain = await app.request('/api/events');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.match(await plain.text(), /event: view/);
});

test('a client leaving a gzipped event stream ends the stream behind it', async () => {
  const { app, aborted } = server();
  const response = await app.request('/api/events', { headers: { 'Accept-Encoding': 'gzip' } });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(aborted(), true);
});
