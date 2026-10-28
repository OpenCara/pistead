import { parseArgs } from 'node:util';
import { z } from 'zod';
import { assertConnectorPlatform, assertPrerequisites, hostIsolation, loadConnectorModels, unsandboxedWarning } from '../../../runner/src/connect-setup.js';
import { parentTransport } from '../../../runner/src/desktop-transport.js';
import type { LocalModels } from '../../../runner/src/local-pi.js';
import { ConnectorSetupError } from '../../../runner/src/protocol.js';
import { ConfigurationError } from '../config.js';
import type { LocalHostState, LocalInspection, LocalServerEvent, LocalServerRequest, LocalStartRequest, LocalStatus } from './desktop-protocol.js';
import { startLocalHost, type LocalHost } from './host.js';
import { LocalServerError, startLocalServer, type LocalServer } from './launch.js';
import { defaultLocalStateDir, loadLocalState, LocalStateError } from './state.js';

// The local server run by a desktop app instead of `pistead serve` in a terminal: the same server, state and host,
// with requests arriving over the parent's IPC channel and status and logs going back the same way.

const requestId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Strict: unknown request types and unknown fields are refused, never ignored. */
const requestSchema: z.ZodType<LocalServerRequest> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect'), id: requestId }).strict(),
  z.object({
    type: z.literal('start'), id: requestId,
    github: z.object({ clientId: z.string().min(1).max(100), clientSecret: z.string().min(1).max(200) }).strict().optional(),
    unsandboxedConsent: z.boolean().optional(), testMode: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal('stop'), id: requestId }).strict(),
]);

class LocalFailure extends Error {}

/** Only text this code wrote crosses to the app: SDK, HTTP and file system errors can carry configuration detail. */
function message(error: unknown, fallback: string): string {
  return error instanceof LocalFailure || error instanceof LocalStateError || error instanceof LocalServerError
    || error instanceof ConfigurationError || error instanceof ConnectorSetupError ? error.message : fallback;
}

// --state-dir and --static-dir are for development and tests: the app passes them only when it runs unpackaged.
const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: { 'state-dir': { type: 'string' }, 'static-dir': { type: 'string' } } });
const stateDir = values['state-dir'] ?? defaultLocalStateDir();
const staticDir = values['static-dir'];
const transport = parentTransport<LocalServerEvent>();
interface Running { server: LocalServer; host?: LocalHost; hostState: LocalHostState; stopping: boolean }
let running: Running | undefined;
let starting = false;

function emit(event: LocalServerEvent): void { transport.send(event); }
function log(level: 'info' | 'warning' | 'error', text: string): void { emit({ type: 'log', level, message: text }); }

async function status(): Promise<void> {
  const current = running;
  if (!current) { emit({ type: 'status', state: 'stopped', host: 'off' }); return; }
  const claimUrl = await current.server.claimUrl().catch(() => null);
  const update: LocalStatus = { state: current.stopping ? 'stopping' : 'running', origin: current.server.origin, host: current.hostState, ...(claimUrl ? { claimUrl } : {}) };
  if (running === current) emit({ type: 'status', ...update });
}

/** What would run this computer's sessions, and why it couldn't: the server runs either way. */
async function hostCheck(testMode: boolean): Promise<{ mode: LocalInspection['hostMode']; problem?: string; models?: LocalModels }> {
  try { assertConnectorPlatform(); }
  catch (error) { return { mode: 'unsandboxed', problem: message(error, 'This computer cannot run Pistead sessions.') }; }
  const { mode, prerequisites } = await hostIsolation();
  try {
    assertPrerequisites(prerequisites, mode === 'unsandboxed', '');
    return { mode, models: await loadConnectorModels({ allowFaux: testMode }) };
  } catch (error) {
    return { mode, problem: message(error, "Pi's models could not be loaded. Check Pi's configuration on this computer.") };
  }
}

async function inspect(): Promise<LocalInspection> {
  const state = await loadLocalState(stateDir);
  const host = await hostCheck(false);
  return {
    stateDir, port: state.port, hostMode: host.mode,
    ...(state.github ? { githubClientId: state.github.clientId } : {}),
    ...(host.mode === 'unsandboxed' ? { unsandboxedWarning: unsandboxedWarning() } : {}),
    ...(host.problem ? { hostProblem: host.problem } : {}),
  };
}

async function start(request: LocalStartRequest): Promise<void> {
  if (running || starting) throw new LocalFailure('Pistead is already running on this computer.');
  starting = true;
  try {
    const github = request.github && { clientId: request.github.clientId.trim(), clientSecret: request.github.clientSecret.trim() };
    const state = await loadLocalState(stateDir, github ? { github } : {});
    if (!state.github) throw new LocalFailure('Add your GitHub OAuth app first: Pistead signs you in with it.');
    const testMode = request.testMode === true;
    const host = await hostCheck(testMode);
    const server = await startLocalServer({ stateDir, state, ...(staticDir ? { staticDir } : {}), ...(testMode ? { extraEnv: {
      TEST_AUTH_ENABLED: 'true', TEST_AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
      TEST_AUTH_EXPIRES_AT: new Date(Date.now() + 24 * 3600_000).toISOString() } } : {}) });
    const current: Running = { server, hostState: 'off', stopping: false };
    running = current;
    log('info', `Pistead is running at ${server.origin}, reachable from this computer only.`);
    const unsandboxed = host.mode === 'unsandboxed';
    if (host.problem || !host.models) log('warning', `This computer can't run sessions: ${host.problem ?? 'no models.'} Pair another machine in Settings › Hosts instead.`);
    else if (unsandboxed && request.unsandboxedConsent !== true) log('warning', 'This computer runs no sessions: running them without a sandbox needs your consent.');
    else {
      const setHost = (state: LocalHostState) => { if (running === current) { current.hostState = state; void status(); } };
      current.host = startLocalHost(server, stateDir, {
        localModels: host.models, unsandboxed, allowFaux: testMode,
        onWaiting: () => setHost('waiting'),
        onStatus: (state, reason) => {
          setHost(state);
          if (state === 'disconnected' && reason) log('warning', `This computer's host disconnected: ${reason}`);
        },
        onWarning: () => log('warning', 'Some resource domains are unavailable; production bash remains fail-closed.'),
      });
      current.host.started.catch((error: unknown) => {
        if (current.stopping || (error instanceof Error && error.name === 'AbortError')) return;
        setHost('failed');
        log('error', message(error, "This computer could not become Pistead's host. Check its Pi configuration and prerequisites."));
      });
    }
    await status();
  } finally { starting = false; }
}

async function stop(): Promise<void> {
  const current = running;
  if (!current || current.stopping) return;
  current.stopping = true;
  await status();
  try {
    await current.host?.stop().catch(() => {});
    await current.server.close();
  } finally {
    running = undefined;
    await status();
  }
}

async function handle(request: LocalServerRequest): Promise<void> {
  try {
    if (request.type === 'inspect') emit({ type: 'result', id: request.id, ok: true, inspection: await inspect() });
    else {
      await (request.type === 'start' ? start(request) : stop());
      emit({ type: 'result', id: request.id, ok: true });
    }
  } catch (error) {
    emit({ type: 'result', id: request.id, ok: false, error: { message: message(error, request.type === 'stop'
      ? 'Pistead did not stop cleanly.' : 'Pistead could not start on this computer. Check its state directory and port.') } });
  }
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await stop().catch(() => {});
  process.exit(0);
}

transport.onMessage(value => {
  const request = requestSchema.safeParse(value);
  if (request.success) { void handle(request.data); return; }
  const id = value && typeof value === 'object' && 'id' in value && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id >= 0 ? value.id : undefined;
  if (id === undefined) log('error', 'Ignored a malformed request.');
  else emit({ type: 'result', id, ok: false, error: { message: 'Refused a malformed request.' } });
});
transport.onClose(() => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
emit({ type: 'ready' });
