import { HTTPException } from 'hono/http-exception';
import { instanceAdmins } from './admin.js';
import { auditStatement } from './db.js';
import { ConstraintError, type Database } from './db/types.js';
import { now } from './http.js';
import { hashPassword, newPassword, passwordAccountStatements, passwordUsername } from './password-auth.js';
import type { Env } from './types.js';

/**
 * The operator's password accounts, from the server's command line, whose shell access is the authority:
 *
 * - `--create-admin USERNAME` creates `password:USERNAME`, which ADMIN_USER_IDS must list already. Nobody can sign up
 *   as a listed account in the app, so this is how a server's first administrator exists without a race to claim it,
 *   and the role still comes only from ADMIN_USER_IDS.
 * - `--reset-password USERNAME` sets a new password for any password account, clears its failed sign-ins and signs it
 *   out everywhere: the way back in for someone who forgot theirs.
 *
 * The password is typed at a hidden prompt on a terminal, or read from the first line of standard input when it is a
 * pipe; never from argv, where other users of the machine could read it.
 */

export interface PasswordCommand { kind: 'create-admin' | 'reset-password'; username: string }

export class PasswordCommandError extends Error {}

/** The password command in `argv`, or null when there is none; more than one, or one without a username, is an error. */
export function passwordCommand(argv: readonly string[]): PasswordCommand | null {
  const found: { kind: PasswordCommand['kind']; username: string | undefined }[] = [];
  argv.forEach((argument, index) => {
    for (const kind of ['create-admin', 'reset-password'] as const) {
      const flag = `--${kind}`;
      if (argument === flag) found.push({ kind, username: argv[index + 1] });
      else if (argument.startsWith(`${flag}=`)) found.push({ kind, username: argument.slice(flag.length + 1) });
    }
  });
  if (!found.length) return null;
  const [command] = found;
  if (found.length > 1 || !command!.username || command!.username.startsWith('--')) {
    throw new PasswordCommandError('one command at a time: --create-admin USERNAME or --reset-password USERNAME');
  }
  return { kind: command!.kind, username: command!.username };
}

/** The message of a validation failure the HTTP routes share, for the terminal. */
async function plain<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    const body = await error.getResponse().json().catch(() => null) as { error?: unknown } | null;
    throw new PasswordCommandError(typeof body?.error === 'string' ? body.error : error.message);
  }
}

/** Runs `command` against `db` with the server's settings in `settings`; returns what to tell the operator. */
export async function runPasswordCommand(db: Database, settings: NodeJS.ProcessEnv, command: PasswordCommand, readPassword: () => Promise<string>): Promise<string> {
  const name = await plain(() => passwordUsername(command.username));
  const userId = `password:${name}`;
  if (command.kind === 'create-admin') {
    if (settings.PASSWORD_AUTH !== 'true' || settings.LOCAL_MODE === 'true') {
      throw new PasswordCommandError('password accounts are off: set PASSWORD_AUTH=true (not on a LOCAL_MODE server) first');
    }
    // Read like the server reads it, so the account is an administrator once the server starts.
    if (!instanceAdmins({ ADMIN_USER_IDS: settings.ADMIN_USER_IDS } as Env).has(userId)) {
      throw new PasswordCommandError(`list ${userId} in ADMIN_USER_IDS first: this command creates administrators only, and nobody can sign up as an account it lists`);
    }
    const password = await plain(async () => newPassword(await readPassword(), name));
    const hash = await hashPassword(password);
    try {
      await db.batch([...passwordAccountStatements(db, name, name, hash), auditStatement({ DB: db } as Env, null, 'account.password.created_by_operator', null, null, { userId })]);
    } catch (error) {
      if (error instanceof ConstraintError) throw new PasswordCommandError(`${userId} exists already; --reset-password ${name} sets a new password for it`);
      throw error;
    }
    return `pistead: created ${userId}, an administrator while ADMIN_USER_IDS lists it; sign in with the username ${name}`;
  }
  const account = await db.query<{ auth_kind: string }>('SELECT u.auth_kind FROM users u JOIN password_credentials p ON p.user_id = u.id WHERE u.id = ?')
    .bind(userId).first();
  if (account?.auth_kind !== 'password') throw new PasswordCommandError(`there is no password account ${userId}`);
  const password = await plain(async () => newPassword(await readPassword(), name));
  const hash = await hashPassword(password);
  await db.batch([
    db.query('UPDATE password_credentials SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?').bind(hash, now(), userId),
    // Whoever was signed in as it, with the old password, is signed out.
    db.query('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId),
    auditStatement({ DB: db } as Env, null, 'account.password.reset_by_operator', null, null, { userId }),
  ]);
  return `pistead: set a new password for ${userId} and signed it out everywhere`;
}

/** A line typed on the terminal without echo; any characters, up to 1,024. */
function hiddenLine(label: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let line = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(line);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u0003' || char === '\u0004') { finish(new PasswordCommandError('cancelled')); return; }
        if (char === '\u007f' || char === '\b') { line = [...line].slice(0, -1).join(''); continue; }
        if (line.length >= 1024) { finish(new PasswordCommandError('that password is too long')); return; }
        line += char;
      }
    };
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
  });
}

/** The new password: typed twice at a hidden prompt on a terminal, or the first line of a pipe on standard input. */
export async function readNewPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await hiddenLine('New password (hidden): ');
    const again = await hiddenLine('Type it again: ');
    if (first !== again) throw new PasswordCommandError('the passwords don\'t match');
    return first;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).byteLength;
    if (size > 8192) throw new PasswordCommandError('standard input is too long for a password');
    chunks.push(chunk as Buffer);
  }
  const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  if (!line) throw new PasswordCommandError('no password on standard input: type it at a terminal, or pipe it in on the first line');
  return line;
}
