import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HTTPException } from 'hono/http-exception';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { connectorLimits, type ConnectorRpcResponse } from '../../../packages/shared/src/connector.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
import type { ConnectorHub } from './connector-hub-types.js';
import {
  authorizeConnectorTicket, connectorError, connectorRequestFrameBytes, currentConnector,
  requireConnectorGeneration, validateConnectorRpc, connectorUtf8Bytes, connectorJsonValid, type ConnectorRelayEnvelope,
} from './connector-transport.js';
import { fail, id, now, randomToken } from './http.js';
import type { Env } from './types.js';

type Generation = { connectorId: string; credentialHash: string; connectionHash: string; generation: string };
type SocketGeneration = Generation & { socket: WebSocket };
type Pending = {
  connection: SocketGeneration;
  envelope: ConnectorRelayEnvelope;
  resolve: (response: Response) => void;
  cancelTimer: () => void;
  bytes: number;
  responding: boolean;
};
const encoder = new TextEncoder();

class SessionAuthorizationError extends HTTPException {}

/** Answers a failed upgrade with a plain HTTP response on the raw socket and closes it. */
export async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}`, 'Connection: close', `Content-Length: ${body.byteLength}`];
  for (const [name, value] of response.headers) {
    if (name !== 'content-length' && name !== 'connection') lines.push(`${name}: ${value}`);
  }
  if (!socket.writable) { socket.destroy(); return; }
  socket.once('finish', () => socket.destroy());
  socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
}

/**
 * The relay for one connector id: the same state machine the Durable Object ran, with the
 * current generation held in memory (the server is the single instance; every connector
 * reconnects after a restart) and fenced through `connectors.connection_hash` in the database.
 * Prompts, replies and plaintext tokens are never persisted.
 */
class ConnectorRelay {
  private current: SocketGeneration | null = null;
  private readonly pending = new Map<string, Pending>();
  private admitting = 0;
  private replying = 0;
  private bufferedBytes = 0;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(readonly connectorId: string, private readonly env: Env, private readonly server: WebSocketServer) {}

  /** Runs connection-changing work one at a time, as `blockConcurrencyWhile` did. */
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work, work);
    this.serial = result.catch(() => {});
    return result;
  }

  async connect(request: IncomingMessage, socket: Duplex, head: Buffer, credentialHash: string): Promise<void> {
    const connectorId = this.connectorId;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(connectorId) || !/^[A-Za-z0-9_-]{43}$/.test(credentialHash)) fail(403, 'invalid_connector', 'Invalid connector authentication.');
    const row = await currentConnector(this.env, connectorId);
    if (row.credential_hash !== credentialHash) fail(403, 'invalid_connector', 'Connector credentials changed.');
    const connectionToken = randomToken();
    const connectionHash = await sha256(connectionToken);
    const generation = id();
    const result = await this.env.DB.query(`UPDATE connectors SET connection_hash = ?, last_seen_at = ?
      WHERE id = ? AND credential_hash = ? AND revoked_at IS NULL AND connection_hash IS ?`)
      .bind(connectionHash, now(), connectorId, credentialHash, row.connection_hash).run();
    if (result.changes !== 1) fail(409, 'connector_replaced', 'Connector authorization changed during connection.');
    const previous = this.current;
    if (previous) {
      this.current = null;
      this.failPending(previous, 503, 'Connector connection replaced');
      this.close(previous.socket, 1012, 'Connection replaced');
    }
    const attachment: Generation = { connectorId, credentialHash, connectionHash, generation };
    // `handleUpgrade` completes synchronously: either the callback runs or ws has already answered the client.
    let accepted: WebSocket | undefined;
    this.server.handleUpgrade(request, socket, head, upgraded => { accepted = upgraded; });
    if (!accepted) { await this.clearConnection(attachment); return; }
    const connection: SocketGeneration = { ...attachment, socket: accepted };
    this.current = connection;
    accepted.on('message', (data, isBinary) => { void this.message(connection, data, isBinary); });
    accepted.on('close', () => { if (this.current === connection) void this.disconnect(connection, 503, 'Connector disconnected').catch(() => {}); });
    accepted.on('error', (error: NodeJS.ErrnoException) => {
      if (this.current !== connection) return;
      const oversized = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
      void this.disconnect(connection, oversized ? 502 : 503, oversized ? 'Connector buffer limit exceeded' : 'Connector disconnected').catch(() => {});
    });
    try {
      accepted.send(JSON.stringify({ type: 'welcome', connectorId, connectionToken }));
    } catch {
      await this.disconnect(connection, 503, 'Connector disconnected');
    }
  }

  private reserve(bytes: number): boolean {
    if (bytes < 0 || this.bufferedBytes + bytes > connectorLimits.bufferedBytes) return false;
    this.bufferedBytes += bytes;
    return true;
  }

  async rpc(envelope: ConnectorRelayEnvelope): Promise<Response> {
    // Reserve before the first await, including requests still validating or checking the database.
    if (this.admitting + this.pending.size + this.replying >= connectorLimits.pendingRequests || !this.reserve(connectorRequestFrameBytes * 2)) {
      fail(429, 'connector_busy', 'The connector relay is at capacity.');
    }
    this.admitting++;
    let reserved = connectorRequestFrameBytes * 2;
    try {
      await validateConnectorRpc(envelope);
      const connection = this.current;
      if (!connection || envelope.connectorId !== connection.connectorId || envelope.credentialHash !== connection.credentialHash ||
          envelope.connectionHash !== connection.connectionHash || connection.socket.readyState !== WebSocket.OPEN) fail(503, 'connector_offline', 'The connector is offline or has reconnected.');
      // A hub-minted wire nonce prevents reuse of an old RPC id from matching a late reply. The caller's envelope stays untouched.
      const wireId = id();
      const relayed: ConnectorRelayEnvelope = { ...envelope, request: { ...envelope.request, id: wireId, ticket: { ...envelope.request.ticket, jti: wireId } } };
      const wire = JSON.stringify(relayed.request);
      const bytes = connectorUtf8Bytes(wire) + connectorUtf8Bytes(relayed.request.body);
      if (bytes > connectorRequestFrameBytes) fail(413, 'body_too_large', 'Request is too large.');
      this.bufferedBytes -= reserved - bytes;
      reserved = bytes;
      await this.checkAuthority(connection, relayed);
      if (this.current !== connection || connection.socket.readyState !== WebSocket.OPEN) fail(503, 'connector_replaced', 'The connector connection changed.');
      if (relayed.request.ticket.exp <= Math.floor(Date.now() / 1000)) fail(403, 'ticket_expired', 'Connector authorization expired.');
      const timeout = ['backup', 'restore'].includes(relayed.request.ticket.action) ? 90000 : 30000;
      const { promise: response, resolve } = Promise.withResolvers<Response>();
      const timer = setTimeout(() => {
        void this.disconnect(connection, 504, 'Connector timed out').catch(() => {});
      }, timeout);
      const pending: Pending = { connection, envelope: relayed, resolve, bytes, responding: false, cancelTimer: () => clearTimeout(timer) };
      this.pending.set(wireId, pending);
      reserved = 0;
      try { connection.socket.send(wire); }
      catch { void this.disconnect(connection, 503, 'Connector disconnected').catch(() => {}); }
      // Not awaited: admission ends once the request is on the wire; the pending entry owns the reply.
      return response;
    } finally {
      this.admitting--;
      this.bufferedBytes -= reserved;
    }
  }

  async status(timeoutMs: number): Promise<boolean> {
    const connection = this.current;
    if (!connection) return false;
    const { promise: deadline, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error('Connector status lookup timed out')), timeoutMs);
    try {
      await Promise.race([deadline, requireConnectorGeneration(this.env, connection.connectorId, connection.credentialHash, connection.connectionHash)]);
      return this.current === connection && connection.socket.readyState === WebSocket.OPEN;
    } catch {
      return false;
    } finally { clearTimeout(timer); }
  }

  async revoke(): Promise<void> {
    const row = await this.env.DB.query<{ revoked_at: string | null }>('SELECT revoked_at FROM connectors WHERE id = ?').bind(this.connectorId).first();
    if (row && !row.revoked_at) fail(409, 'not_revoked', 'Revoke the connector before closing its connection.');
    if (this.current) await this.disconnect(this.current, 403, 'Connector revoked');
  }

  async shutdown(): Promise<void> {
    if (this.current) await this.disconnect(this.current, 503, 'Server shutting down', 1012);
  }

  private async message(connection: SocketGeneration, data: RawData, isBinary: boolean): Promise<void> {
    const socket = connection.socket;
    if (this.current !== connection) { this.close(socket, 1008, 'Stale connection'); return; }
    const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Binary frames are not part of this protocol. Charge the complete JSON frame before parsing.
    if (isBinary || frame.byteLength > connectorLimits.frameBytes) {
      await this.disconnect(connection, 502, 'Invalid connector frame'); return;
    }
    const frameBytes = frame.byteLength;
    // Heartbeats are answered without admission, as the Durable Object's auto-response did.
    if (frameBytes === 4 && frame.toString('latin1') === 'ping') {
      try { socket.send('pong'); } catch { /* The close handler reports the drop. */ }
      return;
    }
    // Reserve both the wire text and its decoded body, not just one copy.
    let charged = frameBytes * 2;
    if (!this.reserve(charged)) {
      await this.disconnect(connection, 502, 'Connector buffer limit exceeded'); return;
    }
    try {
      let message = frame.toString('utf8');
      if (!connectorJsonValid(message, 1, 8)) {
        await this.disconnect(connection, 502, 'Invalid connector frame'); return;
      }
      const reply = JSON.parse(message) as ConnectorRpcResponse;
      message = '';
      if (!reply || reply.type !== 'response' || typeof reply.id !== 'string' || typeof reply.body !== 'string' ||
          !Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 ||
          (['204', '205', '304'].includes(String(reply.status)) && reply.body !== '') ||
          reply.body.length > connectorLimits.responseBytes || connectorUtf8Bytes(reply.body) > connectorLimits.responseBytes ||
          (![204, 205, 304].includes(reply.status) && !connectorJsonValid(reply.body))) {
        await this.disconnect(connection, 502, 'Invalid connector response'); return;
      }
      const pending = this.pending.get(reply.id);
      if (!pending || pending.responding || pending.connection !== connection) {
        await this.disconnect(connection, 502, 'Unsolicited connector response'); return;
      }
      pending.responding = true;
      try {
        await this.checkAuthority(connection, pending.envelope);
      } catch (error) {
        if (!(error instanceof SessionAuthorizationError)) throw error;
        // A session policy change does not revoke other sessions on the same host.
        if (this.current === connection && this.pending.get(reply.id) === pending) {
          this.finish(reply.id, this.errorResponse(error.status, 'Session authorization changed; inspect the session before retrying'));
        }
        return;
      }
      if (this.current !== connection || this.pending.get(reply.id) !== pending) return;
      const responseBytes = connectorUtf8Bytes(reply.body);
      this.bufferedBytes -= charged - responseBytes;
      charged = responseBytes;
      if ([204, 205, 304].includes(reply.status)) {
        this.finish(reply.id, new Response(null, { status: reply.status }));
      } else {
        // Keep completed replies charged until their internal fetch consumer drains or cancels them.
        this.replying++;
        let body = reply.body;
        reply.body = '';
        let offset = 0;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          this.bufferedBytes -= responseBytes;
          this.replying--;
          body = '';
        };
        let controller: ReadableStreamDefaultController<Uint8Array>;
        // Safety release for consumers that never drain; it must not keep an otherwise idle process alive.
        const timer = setTimeout(() => { controller.error(new Error('Connector response expired')); release(); }, 30000).unref();
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          pull(value) {
            let end = Math.min(offset + 16384, body.length);
            const last = body.charCodeAt(end - 1);
            if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
            value.enqueue(encoder.encode(body.slice(offset, end)));
            offset = end;
            if (offset === body.length) { value.close(); release(); }
          },
          cancel() { release(); },
        }, { highWaterMark: 0 });
        charged = 0;
        this.finish(reply.id, new Response(stream, { status: reply.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
      }
    } catch {
      // Do not retain or reflect connector-supplied data in protocol errors.
      this.failPending(connection, 403, 'Connector authorization or protocol validation failed');
      await this.disconnect(connection, 403, 'Connector authorization or protocol validation failed');
    } finally { this.bufferedBytes -= charged; }
  }

  private async checkAuthority(connection: Generation, envelope: ConnectorRelayEnvelope): Promise<void> {
    const { promise: deadline, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error('Connector policy lookup timed out')), 10000);
    try {
      await Promise.race([deadline, (async () => {
        let denied: HTTPException | undefined;
        try {
          await authorizeConnectorTicket(this.env, envelope.request.ticket, connection.connectionHash);
        } catch (error) {
          if (!(error instanceof HTTPException) || ![403, 404, 409].includes(error.status)) throw error;
          denied = error;
        }
        // Only isolate session denials after confirming the host generation is still valid.
        await requireConnectorGeneration(this.env, connection.connectorId, connection.credentialHash, connection.connectionHash);
        if (denied) throw new SessionAuthorizationError(denied.status, { res: denied.getResponse() });
      })()]);
    } finally { clearTimeout(timer); }
  }

  private finish(requestId: string, response: Response): void {
    const pending = this.pending.get(requestId);
    if (!pending) { void response.body?.cancel(); return; }
    this.pending.delete(requestId);
    pending.cancelTimer();
    this.bufferedBytes -= pending.bytes;
    pending.resolve(response);
  }

  private failPending(connection: SocketGeneration, status: number, message: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.connection === connection) this.finish(requestId, this.errorResponse(status, `${message}; inspect the session before retrying`));
    }
  }

  private errorResponse(status: number, message: string): Response {
    return Response.json({ error: message, code: 'connector_relay_error' }, { status });
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    try { socket.close(code, reason); } catch { /* Already closed. */ }
  }

  private async clearConnection(connection: Generation): Promise<void> {
    await this.env.DB.query('UPDATE connectors SET connection_hash = NULL WHERE id = ? AND credential_hash = ? AND connection_hash = ?')
      .bind(connection.connectorId, connection.credentialHash, connection.connectionHash).run();
  }

  private async disconnect(connection: SocketGeneration, status: number, reason: string, code = 1008): Promise<void> {
    if (this.current === connection) this.current = null;
    this.failPending(connection, status, reason);
    this.close(connection.socket, code, reason);
    await this.clearConnection(connection);
  }
}

/** One relay per connector id for the life of the process; see `ConnectorHub`. */
export class ConnectorHubRegistry implements ConnectorHub {
  private readonly relays = new Map<string, ConnectorRelay>();
  private readonly server: WebSocketServer;

  constructor(private readonly env: Env) {
    this.server = new WebSocketServer({
      noServer: true, perMessageDeflate: false, maxPayload: connectorLimits.frameBytes,
      handleProtocols: () => 'opencara-pi-v1',
    });
  }

  private relay(connectorId: string): ConnectorRelay {
    let relay = this.relays.get(connectorId);
    if (!relay) {
      relay = new ConnectorRelay(connectorId, this.env, this.server);
      this.relays.set(connectorId, relay);
    }
    return relay;
  }

  async connect(request: IncomingMessage, socket: Duplex, head: Buffer, connectorId: string, credentialHash: string): Promise<void> {
    const relay = this.relay(connectorId);
    try {
      await relay.serialize(() => relay.connect(request, socket, head, credentialHash));
    } catch (error) {
      // Only pre-upgrade failures reach here; once upgraded, the relay closes the WebSocket itself.
      await rejectUpgrade(socket, connectorError(error));
    }
  }

  async rpc(connectorId: string, envelope: ConnectorRelayEnvelope): Promise<Response> {
    try {
      const relay = this.relays.get(connectorId);
      if (!relay || envelope.connectorId !== connectorId) {
        await validateConnectorRpc(envelope);
        fail(503, 'connector_offline', 'The connector is offline or has reconnected.');
      }
      return await relay.rpc(envelope);
    } catch (error) {
      return connectorError(error);
    }
  }

  async status(connectorId: string, timeoutMs: number): Promise<boolean> {
    const relay = this.relays.get(connectorId);
    return relay ? relay.status(timeoutMs) : false;
  }

  async revoke(connectorId: string): Promise<void> {
    const relay = this.relays.get(connectorId);
    if (!relay) fail(404, 'not_found', 'Connector not found.');
    await relay.serialize(() => relay.revoke());
  }

  async close(): Promise<void> {
    await Promise.all([...this.relays.values()].map(relay => relay.serialize(() => relay.shutdown())));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
