import { createReadStream } from 'node:fs';
import { ConfigurationError, defaultDatabaseUrl, loadConfig } from './config.js';
import { exportSession, exportWorkspace } from './data-export.js';
import { openDatabase } from './db/index.js';
import { passwordCommand, PasswordCommandError, readNewPassword, runPasswordCommand, type PasswordCommand } from './password-accounts-cli.js';
import { migrateWhenReachable, startServer } from './serve.js';
import { DumpImportError, importDumpFromCommandLine } from './workspace-databases/import.js';
import { workspaceDatabaseExplanation } from './workspace-databases/store.js';
import { WorkspaceDatabaseError } from './workspace-databases/types.js';

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
let accountCommand: PasswordCommand | null = null;
try { accountCommand = passwordCommand(commandLine); } catch (error) {
  if (!(error instanceof PasswordCommandError)) throw error;
  console.error(`pistead: ${error.message}`);
  process.exit(2);
}
if ([dump, importFile, accountCommand].filter(Boolean).length > 1) {
  console.error('pistead: dump, import or manage an account, one at a time');
  process.exit(2);
}

// The operator creates an administrator's password account, or sets a new password, in the server's database
// (password-accounts-cli.ts). Migrations are applied first, as at start-up.
if (accountCommand) {
  const db = await openDatabase(process.env.DATABASE_URL || defaultDatabaseUrl);
  let failure: string | null = null;
  let outcome = '';
  try {
    await migrateWhenReachable(db);
    outcome = `${await runPasswordCommand(db, process.env, accountCommand, readNewPassword)}\n`;
  } catch (error) {
    if (!(error instanceof PasswordCommandError)) throw error;
    failure = error.message;
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
const { env, staticDir, trustProxy } = config;
const server = await startServer(config);
const listening = `${server.address.address}:${server.address.port}`;
console.log(`pistead: listening on http://${listening} (database=${env.DB.provider}, storage=${env.BUCKET?.provider ?? 'none'}, workspaceDatabases=${env.WORKSPACE_DATABASES ? (env.WORKSPACE_DATABASES.privateHosts ? 'public+private' : 'public') : 'off'}, static=${staticDir}, trustProxy=${trustProxy})`);

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`pistead: ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', signal => { void shutdown(signal); });
process.on('SIGINT', signal => { void shutdown(signal); });
