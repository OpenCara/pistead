import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireRunnerLease, RunnerLeaseBusyError } from '../../../runner/src/lease.js';

// A local server's private state: the secrets it was set up with (generated once, never shown), the GitHub OAuth app its
// owner registered for it, and the port it listens on. The database, backups and this machine's host live beside it.

export const defaultLocalStateDir = (): string => join(homedir(), '.local', 'share', 'pistead', 'server');
export const DEFAULT_LOCAL_PORT = 7878;
const STATE_FILE = 'server.json';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** GitHub OAuth app client IDs (`Ov23li…`, older 20 hex digits) and secrets (40 hex digits). */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const CLIENT_SECRET = /^[A-Za-z0-9._-]{1,200}$/;

export class LocalStateError extends Error {}

export interface GitHubOAuthApp { clientId: string; clientSecret: string }

export interface LocalState {
  version: 1;
  sessionSecret: string;
  /** Encrypts the GitHub and Git tokens stored in the database: losing it loses them, never the reverse. */
  vaultKey: string;
  /** In the owner's sign-in link until someone claims the server (auth.ts localClaim). */
  claimSecret: string;
  port: number;
  github?: GitHubOAuthApp;
}

const secret = () => randomBytes(32).toString('base64url');

export function validGitHubApp(value: unknown): value is GitHubOAuthApp {
  if (!value || typeof value !== 'object') return false;
  const app = value as Record<string, unknown>;
  return typeof app.clientId === 'string' && CLIENT_ID.test(app.clientId) && typeof app.clientSecret === 'string' && CLIENT_SECRET.test(app.clientSecret);
}

export function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function parseState(value: unknown): LocalState {
  const state = value as Partial<LocalState> | null;
  if (!state || typeof state !== 'object' || state.version !== 1 || ![state.sessionSecret, state.vaultKey, state.claimSecret].every(item => typeof item === 'string' && SECRET.test(item))
    || !validPort(state.port) || (state.github !== undefined && !validGitHubApp(state.github))) {
    throw new LocalStateError('The local server state is damaged or from another version.');
  }
  return { version: 1, sessionSecret: state.sessionSecret!, vaultKey: state.vaultKey!, claimSecret: state.claimSecret!, port: state.port!,
    ...(state.github ? { github: { clientId: state.github.clientId, clientSecret: state.github.clientSecret } } : {}) };
}

/** The state directory, created owner-only; refused when it is a symlink, someone else's, or open to others. */
export async function privateStateDirectory(directory: string): Promise<string> {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== path) {
    throw new LocalStateError(`${path} must be a directory of yours, not a symlink, that only you can open (mode 0700).`);
  }
  return path;
}

async function readState(directory: string): Promise<LocalState | undefined> {
  let file;
  try { file = await open(join(directory, STATE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new LocalStateError('The local server state could not be opened safely.');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384 || (process.getuid && stat.uid !== process.getuid())) {
      throw new LocalStateError('The local server state must be a file of yours that only you can read (mode 0600).');
    }
    let value: unknown;
    try { value = JSON.parse(await file.readFile('utf8')); } catch { throw new LocalStateError('The local server state is damaged.'); }
    return parseState(value);
  } finally { await file.close(); }
}

async function writeState(directory: string, state: LocalState): Promise<void> {
  const temporary = join(directory, `.server-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  // Atomic: a crash leaves the old state or the new one, so the vault key is never lost half-written.
  try { await rename(temporary, join(directory, STATE_FILE)); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/**
 * Holds the state directory's kernel lease (flock on Linux, lockf on macOS, as the connector's runner lease): a
 * `pistead serve` and a desktop app sharing the directory never both create or change the state, nor both run its
 * server. The kernel drops the lease when its holder exits, however it exits, so a crash leaves nothing stale behind.
 */
async function lease(directory: string): Promise<() => Promise<void>> {
  try { return await acquireRunnerLease(directory, () => {}); }
  catch (error) {
    if (error instanceof RunnerLeaseBusyError) throw new LocalStateError('Pistead is already running with this state directory, for example `pistead serve` in a terminal or the Pistead app. Stop it there first.');
    throw new LocalStateError('The local server state could not be locked: this needs flock (Linux, util-linux) or lockf (macOS).');
  }
}

function changed(state: LocalState | undefined, changes: { github?: GitHubOAuthApp; port?: number }): LocalState {
  if (changes.github !== undefined && !validGitHubApp(changes.github)) throw new LocalStateError('That is not a GitHub OAuth app client ID and secret.');
  if (changes.port !== undefined && !validPort(changes.port)) throw new LocalStateError('The port must be a number from 1024 to 65535.');
  const base: LocalState = state ?? { version: 1, sessionSecret: secret(), vaultKey: secret(), claimSecret: secret(), port: DEFAULT_LOCAL_PORT };
  return { ...base, ...(changes.github ? { github: { ...changes.github } } : {}), ...(changes.port ? { port: changes.port } : {}) };
}

/** The saved state, read without the lease and without creating it: what a running server or the next start uses. */
export async function peekLocalState(directory: string): Promise<LocalState | undefined> {
  return readState(await privateStateDirectory(directory));
}

/**
 * The state in `directory`, created with fresh secrets the first time, with `changes` (a GitHub OAuth app, a port)
 * saved before it is returned; the secrets never change once written. It holds the directory's lease until `release`:
 * a local server keeps it for as long as it runs, so whoever holds it is the only one creating or changing the state.
 */
export async function openLocalState(directory: string, changes: { github?: GitHubOAuthApp; port?: number } = {}): Promise<{ state: LocalState; release(): Promise<void> }> {
  const path = await privateStateDirectory(directory);
  const release = await lease(path);
  try {
    const saved = await readState(path);
    const state = changed(saved, changes);
    if (!saved || JSON.stringify(state) !== JSON.stringify(saved)) await writeState(path, state);
    return { state, release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** openLocalState, released at once: for changes made while no server runs. */
export async function loadLocalState(directory: string, changes: { github?: GitHubOAuthApp; port?: number } = {}): Promise<LocalState> {
  const { state, release } = await openLocalState(directory, changes);
  await release();
  return state;
}
