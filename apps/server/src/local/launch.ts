import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOwner } from '../auth.js';
import { loadConfig } from '../config.js';
import { startServer } from '../serve.js';
import type { Env } from '../types.js';
import type { LocalState } from './state.js';

// A Pistead server for one person on their own computer: SQLite and backups in its state directory, listening on
// 127.0.0.1 only, and admitting only the GitHub account that claims it with the sign-in link it prints (auth.ts).

export const LOCAL_ORIGIN_HOST = '127.0.0.1';
export const githubCallbackPath = '/api/auth/github/callback';

/**
 * The built web app: `web/` beside the bundle (the published CLI and the desktop app stage it there), else the
 * repository's `dist/web` (`pnpm build`) when running from source. A build has its hashed assets (`apps/web` itself,
 * the sources, has an index.html too).
 */
export function defaultStaticDir(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    for (const candidate of [join(directory, 'web'), join(directory, 'dist', 'web')]) {
      if (existsSync(join(candidate, 'index.html')) && existsSync(join(candidate, 'assets'))) return candidate;
    }
    directory = dirname(directory);
  }
  return undefined;
}

export interface LocalServerOptions {
  stateDir: string;
  state: LocalState;
  /** The built web app; defaultStaticDir() when omitted. */
  staticDir?: string;
  /** Tests and development only: settings added to the server's (test mode, say). */
  extraEnv?: Record<string, string>;
}

export interface LocalServer {
  /** http://127.0.0.1:PORT */
  readonly origin: string;
  readonly env: Env;
  /** The GitHub account that claimed it, or null while nobody has. */
  owner(): Promise<{ id: string } | null>;
  /** The owner's sign-in link while the server is unclaimed: whoever opens it first becomes its owner. Null once claimed. */
  claimUrl(): Promise<string | null>;
  close(): Promise<void>;
}

export class LocalServerError extends Error {}

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const { stateDir, state } = options;
  const staticDir = options.staticDir ?? defaultStaticDir();
  if (!staticDir) throw new LocalServerError('The Pistead web app is missing from this installation. Reinstall it, or run `pnpm build` in a source checkout.');
  const backups = join(stateDir, 'backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const origin = `http://${LOCAL_ORIGIN_HOST}:${state.port}`;
  const settings: Record<string, string> = {
    APP_ORIGIN: origin, HOST: LOCAL_ORIGIN_HOST, PORT: String(state.port), TRUST_PROXY: 'false',
    DATABASE_URL: `sqlite://${join(stateDir, 'pistead.sqlite')}`, STORAGE_URL: `file://${backups}`, STATIC_DIR: staticDir,
    SESSION_SECRET: state.sessionSecret, VAULT_KEY: state.vaultKey, LOCAL_MODE: 'true', LOCAL_CLAIM_SECRET: state.claimSecret,
    ...(state.github ? { GITHUB_CLIENT_ID: state.github.clientId, GITHUB_CLIENT_SECRET: state.github.clientSecret } : {}),
    ...options.extraEnv,
  };
  const config = await loadConfig(settings);
  let server;
  try { server = await startServer(config); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new LocalServerError(`Port ${state.port} is in use: another Pistead may already be running here. Stop it, or choose another port with --port.`);
    }
    throw error;
  }
  const { env } = config;
  return {
    origin, env,
    owner: () => localOwner(env),
    async claimUrl() {
      return await localOwner(env) ? null : `${origin}/api/auth/local/claim?token=${state.claimSecret}`;
    },
    close: () => server.close(),
  };
}

/** What to register at https://github.com/settings/applications/new for a local server on any port. */
export function githubOAuthAppInstructions(): string {
  return `Pistead signs you in with GitHub through an OAuth app of your own. Register one once at
  https://github.com/settings/applications/new
with
  Application name:            Pistead on my computer (any name)
  Homepage URL:                http://${LOCAL_ORIGIN_HOST}
  Authorization callback URL:  http://${LOCAL_ORIGIN_HOST}${githubCallbackPath}
(GitHub accepts that callback on any port of ${LOCAL_ORIGIN_HOST}.) Then generate a client secret and give Pistead the
client ID and secret.
`;
}
