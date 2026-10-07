import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { createAdaptorServer } from '@hono/node-server';
import { ConfigurationError, defaultDatabaseUrl, loadConfig } from './config.js';
import { rejectUpgrade } from './connector-hub.js';
import { connectorError } from './connector-transport.js';
import { authenticateConnectorSocket } from './connectors.js';
import { openDatabase } from './db/index.js';
import type { Database } from './db/types.js';
import { app } from './index.js';
import { createStaticHandler } from './static.js';

/** The request URL as the client sees it: forwarded scheme/host only when the operator trusts the proxy. */
function requestUrl(request: IncomingMessage, trustProxy: boolean): URL {
  const forwarded = (name: string) => trustProxy ? String(request.headers[name] ?? '').split(',')[0]!.trim() : '';
  const proto = forwarded('x-forwarded-proto');
  const scheme = proto === 'https' || proto === 'http' ? proto : (request.socket as TLSSocket).encrypted ? 'https' : 'http';
  const host = forwarded('x-forwarded-host') || request.headers.host;
  if (!host) throw new Error('Missing host header');
  return new URL(`${scheme}://${host}${request.url ?? '/'}`);
}

/** The `code` of a Node or pg error, looking one `cause` deep (pg wraps socket errors). */
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return errorCode(error.cause);
  return undefined;
}

const transientDatabaseCodes = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', '57P03'];

/**
 * Applies migrations, waiting for the database to accept connections first: under docker compose
 * Postgres is often still starting when the server boots. Connection refusals are retried for up
 * to `DATABASE_WAIT_SECONDS` (default 60); every other error (bad credentials, broken migration) fails at once.
 */
async function migrateWhenReachable(db: Pick<Database, 'migrate' | 'provider'>): Promise<void> {
  const deadline = Date.now() + Number(process.env.DATABASE_WAIT_SECONDS || 60) * 1000;
  for (let attempt = 1; ; attempt++) {
    try { return await db.migrate(); } catch (error) {
      const code = errorCode(error);
      if (!code || !transientDatabaseCodes.includes(code) || Date.now() >= deadline) throw error;
      if (attempt === 1) console.error(`pistead: waiting for the ${db.provider} database (${code})`);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.min(5000, 500 * attempt));
      await promise;
    }
  }
}

if (process.argv.includes('--migrate-only')) {
  const db = await openDatabase(process.env.DATABASE_URL || defaultDatabaseUrl);
  try { await migrateWhenReachable(db); } finally { await db.close(); }
  console.log(`pistead: migrations applied (${db.provider})`);
  process.exit(0);
}

let config;
try {
  config = await loadConfig();
} catch (error) {
  if (!(error instanceof ConfigurationError)) throw error;
  console.error(`pistead: ${error.message}`);
  process.exit(1);
}
const { env, host, port, trustProxy, staticDir } = config;
const hub = env.CONNECTOR_HUB!;
await migrateWhenReachable(env.DB);

const serveStatic = createStaticHandler(staticDir);
app.notFound(async c => {
  if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Not found.', code: 'not_found' }, 404);
  }
  const response = await serveStatic(c.req.raw);
  return c.newResponse(response.body, response);
});

const server = createAdaptorServer({
  overrideGlobalObjects: false,
  fetch: (request, bindings) => {
    if (trustProxy) {
      // createAdaptorServer defaults to node:http, so the incoming message is always HTTP/1.
      const url = requestUrl(bindings.incoming as IncomingMessage, true);
      if (url.href !== request.url) request = new Request(url, request);
    }
    return app.fetch(request, env);
  },
});

server.on('upgrade', (request, socket, head) => {
  // Nothing owns the socket until the hub accepts it; an unhandled error event would crash the process.
  socket.on('error', () => {});
  void (async () => {
    let url: URL;
    try { url = requestUrl(request, trustProxy); } catch { await rejectUpgrade(socket, Response.json({ error: 'Invalid request.', code: 'invalid_request' }, { status: 400 })); return; }
    if (url.pathname !== '/api/connectors/socket' || url.search) {
      await rejectUpgrade(socket, Response.json({ error: 'Not found.', code: 'not_found' }, { status: 404 }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (typeof value === 'string') headers.append(name, value);
    }
    const { connectorId, credentialHash } = await authenticateConnectorSocket(env, headers, url);
    await hub.connect(request, socket, head, connectorId, credentialHash);
  })().catch(error => rejectUpgrade(socket, connectorError(error)));
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`pistead: ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  server.close();
  await hub.close();
  await env.DB.close();
  process.exit(0);
}
process.on('SIGTERM', signal => { void shutdown(signal); });
process.on('SIGINT', signal => { void shutdown(signal); });

server.listen(port, host, () => {
  const address = server.address();
  const listening = address && typeof address === 'object' ? `${address.address}:${address.port}` : String(address);
  console.log(`pistead: listening on http://${listening} (database=${env.DB.provider}, storage=${env.BUCKET?.provider ?? 'none'}, static=${staticDir}, trustProxy=${trustProxy})`);
});
