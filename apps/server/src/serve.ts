import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import type { ServerConfig } from './config.js';
import { rejectUpgrade } from './connector-hub.js';
import { connectorError } from './connector-transport.js';
import { authenticateConnectorSocket } from './connectors.js';
import type { Database } from './db/types.js';
import { requestUrl, trustForwardedHeaders } from './forwarded.js';
import { app } from './index.js';
import { createStaticHandler } from './static.js';
import { settlePushCredentials } from './push/broker.js';
import { refreshPullRequestStates } from './pull-request-states.js';
import { runAutomaticBackups } from './automatic-backups.js';
import { runScheduledPrompts } from './scheduled-prompts.js';

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
export async function migrateWhenReachable(db: Pick<Database, 'migrate' | 'provider'>): Promise<void> {
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

/** A sweep that runs every `ms`, one at a time, logging its failures. */
function sweep(name: string, ms: number, run: () => Promise<unknown>): NodeJS.Timeout {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void run()
      .catch(error => { console.error(`pistead: ${name} failed:`, error instanceof Error ? error.message : error); })
      .finally(() => { busy = false; });
  }, ms);
  timer.unref();
  return timer;
}

export interface RunningServer {
  /** The address it listens on, such as 127.0.0.1:8787 (its port, when the configuration asked for port 0). */
  address: AddressInfo;
  /** Stops listening, then closes the connector hub and the database. */
  close(): Promise<void>;
}

/**
 * Serves the API, the web app and the connector socket with `config`, after applying pending migrations, and runs the
 * background sweeps. Resolves once it listens. One per process: the routes live on the shared `app`.
 */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { env, host, port, trustProxy, staticDir } = config;
  const hub = env.CONNECTOR_HUB!;
  await migrateWhenReachable(env.DB);

  const timers = [
    // Push credentials no completion settled: pushes their host never reported, and owner-token resets to retry.
    sweep('push credential settling', 5 * 60_000, () => settlePushCredentials(env).catch(() => {})),
    // The state of each session's pull request (pull-request-states.ts).
    sweep('pull request states', 30_000, () => refreshPullRequestStates(env)),
    // Automatic backups into workspace databases (automatic-backups.ts).
    sweep('automatic backups', 60_000, async () => { if (env.WORKSPACE_DATABASES) await runAutomaticBackups(env); }),
    // Scheduled prompts (scheduled-prompts.ts).
    sweep('scheduled prompts', 30_000, () => runScheduledPrompts(env)),
  ];

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
    fetch: trustProxy ? trustForwardedHeaders(request => app.fetch(request, env)) : request => app.fetch(request, env),
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

  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, host, () => listening.resolve());
  try { await listening.promise; } catch (error) {
    for (const timer of timers) clearInterval(timer);
    await hub.close();
    await env.DB.close();
    throw error;
  }
  server.off('error', listening.reject);

  let closing: Promise<void> | undefined;
  return {
    address: server.address() as AddressInfo,
    close() {
      closing ??= (async () => {
        for (const timer of timers) clearInterval(timer);
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        // Open connections (a browser's keep-alive, the connector's socket) would otherwise hold close() open.
        if ('closeAllConnections' in server) server.closeAllConnections();
        await hub.close();
        await closed;
        await env.DB.close();
      })();
      return closing;
    },
  };
}
