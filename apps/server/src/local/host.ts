import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { savedPairing } from '../../../runner/src/connect-setup.js';
import { createConnector, type ConnectorOptions, type LocalConnector } from '../../../runner/src/connector.js';
import { createPairing } from '../connectors.js';
import type { LocalServer } from './launch.js';

// This computer as the local server's host: once the owner has claimed the server, the connector pairs itself with a code
// the server makes for them (no code to copy), and later starts reuse that pairing. Its state is the local server's own
// (`<state>/connector`), so a pairing of this machine with another server through `pistead connect` is left alone.

export type LocalHostOptions = Pick<ConnectorOptions, 'localModels' | 'unsandboxed' | 'resources' | 'allowFaux' | 'allowTestShell' | 'onStatus' | 'onWarning' | 'capabilities'
  | 'acquireLease' | 'runtimeFactory'>;

export interface LocalHost {
  /** Resolves once the connector first connects; rejects when it can't start. */
  readonly started: Promise<void>;
  stop(): Promise<void>;
}

export const localHostStateDir = (stateDir: string): string => join(stateDir, 'connector');

export function startLocalHost(server: LocalServer, stateDir: string, options: LocalHostOptions & { onWaiting?(): void; pollMs?: number }): LocalHost {
  const stopped = new AbortController();
  let connector: LocalConnector | undefined;
  const started = (async () => {
    let owner = await server.owner();
    if (!owner) options.onWaiting?.();
    while (!owner) {
      await delay(options.pollMs ?? 1000, undefined, { signal: stopped.signal });
      owner = await server.owner();
    }
    stopped.signal.throwIfAborted();
    const dataDir = localHostStateDir(stateDir);
    // Paired with this server before: reuse it. Paired with this server on another port, or never: pair (again).
    const saved = await savedPairing(dataDir, true);
    const pairing = saved === server.origin ? undefined : await createPairing(server.env, owner.id, hostname().slice(0, 120) || 'This computer');
    stopped.signal.throwIfAborted();
    connector = createConnector({
      ...options, dataDir, server: server.origin, allowInsecureLoopback: true,
      ...(pairing ? { pairing: { id: pairing.id, code: pairing.code }, replacePairing: saved !== undefined } : {}),
      capabilities: options.capabilities ?? { platform: process.platform, sandbox: false, productionShell: false },
    });
    await connector.start();
  })();
  void started.catch(() => {});
  return {
    started,
    async stop() {
      stopped.abort();
      await connector?.stop();
    },
  };
}
