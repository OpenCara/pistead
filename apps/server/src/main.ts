import { createReadStream } from 'node:fs';
import { createAdaptorServer } from '@hono/node-server';
import { ConfigurationError, defaultDatabaseUrl, loadConfig } from './config.js';
import { rejectUpgrade } from './connector-hub.js';
import { connectorError } from './connector-transport.js';
import { authenticateConnectorSocket } from './connectors.js';
import { exportSession, exportWorkspace } from './data-export.js';
import { openDatabase } from './db/index.js';
import { requestUrl, trustForwardedHeaders } from './forwarded.js';
import type { Database } from './db/types.js';
import { app } from './index.js';
import { createStaticHandler } from './static.js';
import { settlePushCredentials } from './push/broker.js';
import { refreshPullRequestStates } from './pull-request-states.js';
import { runAutomaticBackups } from './automatic-backups.js';
import { DumpImportError, importDumpFromCommandLine } from './workspace-databases/import.js';
import { workspaceDatabaseExplanation } from './workspace-databases/store.js';
import { WorkspaceDatabaseError } from './workspace-databases/types.js';

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

/**
 * `--dump-session ID` or `--dump-workspace ID` (also `--dump-session=ID`): the export to write to stdout, or null.
 * `--dump` alone (as `pnpm db:dump` passes it) never starts the server.
 */
function dumpRequest(argv: readonly string[]): { kind: 'session' | 'workspace'; id: string } | null {
  const requests: { kind: 'session' | 'workspace'; id: string | undefined }[] = [];
  argv.forEach((argument, index) => {
    for (const kind of ['session', 'workspace'] as const) {
      const flag = `--dump-${kind}`;
      if (argument === flag) requests.push({ kind, id: argv[index + 1] });
      else if (argument.startsWith(`${flag}=`)) requests.push({ kind, id: argument.slice(flag.length + 1) });
    }
  });
  const [request] = requests;
  if (!request && !argv.includes('--dump')) return null;
  if (!request || requests.length > 1 || !request.id || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) {
    console.error('pistead: dump one session or workspace at a time: --dump-session SESSION_ID or --dump-workspace WORKSPACE_ID');
    process.exit(2);
  }
  return { kind: request.kind, id: request.id };
}

/** `--import-dump FILE` (also `--import-dump=FILE`; `-` reads standard input): the dump to import, or null. */
function importRequest(argv: readonly string[]): string | null {
  const positions = argv.flatMap((argument, index) => argument === '--import-dump' || argument.startsWith('--import-dump=') ? [index] : []);
  if (!positions.length) return null;
  const index = positions[0]!;
  const file = argv[index] === '--import-dump' ? argv[index + 1] : argv[index]!.slice('--import-dump='.length);
  if (positions.length > 1 || !file) {
    console.error('pistead: import one dump at a time: --import-dump FILE (- reads standard input)');
    process.exit(2);
  }
  return file;
}

/** A dump from a file or standard input, bounded: the command line takes larger dumps than the web app uploads. */
async function readDump(file: string): Promise<string> {
  const limit = 256 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file === '-' ? process.stdin : createReadStream(file)) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    if (size > limit) throw new DumpImportError('The dump is larger than 256 MiB.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** stdout is asynchronous on pipes: resolves once `text` is written, so exiting next loses nothing. */
function writeOut(text: string): Promise<void> {
  return new Promise((resolve, reject) => { process.stdout.write(text, error => (error ? reject(error) : resolve())); });
}

const commandLine = process.argv.slice(2);
const dump = dumpRequest(commandLine);
const importFile = importRequest(commandLine);
if (dump && importFile) {
  console.error('pistead: dump or import, one at a time');
  process.exit(2);
}

// The operator's dump of one session or workspace from the database, as JSON on stdout: every session in full, without
// secrets (see data-export.ts). Pending migrations are applied first, as at start-up, so the current schema is read.
if (dump) {
  const db = await openDatabase(process.env.DATABASE_URL || defaultDatabaseUrl);
  let output: string | null = null;
  try {
    await migrateWhenReachable(db);
    const document = dump.kind === 'session' ? await exportSession(db, dump.id, null) : await exportWorkspace(db, dump.id, null);
    if (document) output = `${JSON.stringify(document, null, 2)}\n`;
  } finally {
    await db.close();
  }
  if (output === null) {
    console.error(`pistead: ${dump.kind} ${dump.id} not found`);
    process.exit(1);
  }
  await writeOut(output);
  process.exit(0);
}

// The operator's import of a dump into the database its workspace's owner connected (see workspace-databases/import.ts),
// with this server's WORKSPACE_DATABASES, WORKSPACE_DATABASE_PRIVATE_HOSTS and VAULT_KEY. Migrations are applied first.
if (importFile) {
  let document: unknown;
  try {
    document = JSON.parse(await readDump(importFile));
  } catch (error) {
    console.error(`pistead: ${error instanceof DumpImportError ? error.message : `no JSON dump could be read from ${importFile}`}`);
    process.exit(1);
  }
  const db = await openDatabase(process.env.DATABASE_URL || defaultDatabaseUrl);
  let failure: string | null = null;
  let outcome = '';
  try {
    await migrateWhenReachable(db);
    const { summary, database } = await importDumpFromCommandLine(db, process.env, document);
    outcome = `pistead: imported ${summary.sessions} session record${summary.sessions === 1 ? '' : 's'} (${summary.sessionDetails} with details) and `
      + `${summary.auditEntries} activity entr${summary.auditEntries === 1 ? 'y' : 'ies'}${summary.workspaceSettings ? ', with the workspace settings,' : ''} `
      + `into ${database.host}/${database.database_name}\n`;
  } catch (error) {
    if (error instanceof DumpImportError) failure = error.message;
    else if (error instanceof WorkspaceDatabaseError) failure = `the workspace database could not be used. ${workspaceDatabaseExplanation(error.failure)}`;
    else throw error;
  } finally {
    await db.close();
  }
  if (failure !== null) {
    console.error(`pistead: ${failure}`);
    process.exit(1);
  }
  await writeOut(outcome);
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

// Push credentials no completion settled: pushes their host never reported, and owner-token resets to retry.
const settling = setInterval(() => { void settlePushCredentials(env).catch(() => {}); }, 5 * 60_000);
settling.unref();

// The state of each session's pull request (pull-request-states.ts); one sweep at a time.
let readingPulls = false;
const pullStates = setInterval(() => {
  if (readingPulls) return;
  readingPulls = true;
  void refreshPullRequestStates(env)
    .catch(error => { console.error('pistead: pull request states failed:', error instanceof Error ? error.message : error); })
    .finally(() => { readingPulls = false; });
}, 30_000);
pullStates.unref();

// Automatic backups into workspace databases (automatic-backups.ts); one sweep at a time.
let sweeping = false;
const backingUp = setInterval(() => {
  if (sweeping || !env.WORKSPACE_DATABASES) return;
  sweeping = true;
  void runAutomaticBackups(env)
    .catch(error => { console.error('pistead: automatic backups failed:', error instanceof Error ? error.message : error); })
    .finally(() => { sweeping = false; });
}, 60_000);
backingUp.unref();

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

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`pistead: ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  clearInterval(settling);
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
  console.log(`pistead: listening on http://${listening} (database=${env.DB.provider}, storage=${env.BUCKET?.provider ?? 'none'}, workspaceDatabases=${env.WORKSPACE_DATABASES ? (env.WORKSPACE_DATABASES.privateHosts ? 'public+private' : 'public') : 'off'}, static=${staticDir}, trustProxy=${trustProxy})`);
});
