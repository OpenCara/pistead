import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * The state in `directory`, created with fresh secrets the first time. `changes` (a GitHub OAuth app, a port) are saved
 * before it is returned; the secrets never change once written.
 */
export async function loadLocalState(directory: string, changes: { github?: GitHubOAuthApp; port?: number } = {}): Promise<LocalState> {
  const path = await privateStateDirectory(directory);
  const saved = await readState(path);
  const state: LocalState = saved ?? { version: 1, sessionSecret: secret(), vaultKey: secret(), claimSecret: secret(), port: DEFAULT_LOCAL_PORT };
  if (changes.github !== undefined && !validGitHubApp(changes.github)) throw new LocalStateError('That is not a GitHub OAuth app client ID and secret.');
  if (changes.port !== undefined && !validPort(changes.port)) throw new LocalStateError('The port must be a number from 1024 to 65535.');
  const next: LocalState = { ...state, ...(changes.github ? { github: { ...changes.github } } : {}), ...(changes.port ? { port: changes.port } : {}) };
  if (!saved || JSON.stringify(next) !== JSON.stringify(saved)) await writeState(path, next);
  return next;
}
