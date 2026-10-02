import { connectorLimits, type ConnectorRpcResponse } from '../../../packages/shared/src/connector.js';
import { sha256 } from '../../../packages/shared/src/crypto.js';
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

async function boundedJSON(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'invalid_rpc', 'Expected JSON.');
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'body_too_large', 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_rpc', 'Expected a request body.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let raw = '';
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 10000);
  try {
    while (true) {
      const part = await reader.read();
      if (expired) fail(408, 'request_timeout', 'Request body timed out.');
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) fail(413, 'body_too_large', 'Request is too large.');
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

// A plain Durable Object class keeps cloudflare:workers out of the Node import graph.
// SQLite stores only fencing metadata; prompts, replies and plaintext tokens are never persisted.
export class ConnectorHub {
  private current: SocketGeneration | null = null;
  private connectorId: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private admitting = 0;
  private replying = 0;
  private bufferedBytes = 0;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS connector_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), connector_id TEXT NOT NULL, generation TEXT, credential_hash TEXT, connection_hash TEXT)');
      const rows = ctx.storage.sql.exec<{ connector_id: string; generation: string | null; credential_hash: string | null; connection_hash: string | null }>('SELECT * FROM connector_identity WHERE singleton = 1').toArray();
      const identity = rows[0];
      this.connectorId = identity?.connector_id ?? null;
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as Generation | null;
        if (!this.current && identity?.generation && attachment?.connectorId === identity.connector_id &&
            attachment.generation === identity.generation && attachment.credentialHash === identity.credential_hash &&
            attachment.connectionHash === identity.connection_hash && socket.readyState === 1) {
          this.current = { ...attachment, socket };
        } else this.close(socket, 1008, 'Stale connection');
      }
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.search) fail(400, 'invalid_route', 'Invalid connector route.');
      if (url.pathname === '/socket' && request.method === 'GET') {
        return await this.ctx.blockConcurrencyWhile(async () => {
          try { return await this.connect(request); } catch (error) { return connectorError(error); }
        });
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        const connection = this.current;
        if (!connection) return Response.json({ online: false });
        try {
          await requireConnectorGeneration(this.env, connection.connectorId, connection.credentialHash, connection.connectionHash);
          return Response.json({ online: this.current === connection && connection.socket.readyState === 1 });
        } catch { return Response.json({ online: false }); }
      }
      if (url.pathname === '/rpc' && request.method === 'POST') return await this.rpc(request);
      if (url.pathname === '/revoke' && request.method === 'POST') {
        const body = await boundedJSON(request, 1024) as { connectorId?: unknown };
        if (!body || typeof body.connectorId !== 'string' || body.connectorId !== this.connectorId) fail(404, 'not_found', 'Connector not found.');
        return await this.ctx.blockConcurrencyWhile(async () => {
          try {
            const row = await this.env.DB.prepare('SELECT revoked_at FROM connectors WHERE id = ?').bind(body.connectorId).first<{ revoked_at: string | null }>();
            if (row && !row.revoked_at) fail(409, 'not_revoked', 'Revoke the connector before closing its connection.');
            if (this.current) await this.disconnect(this.current, 403, 'Connector revoked');
            return new Response(null, { status: 204 });
          } catch (error) { return connectorError(error); }
        });
      }
      fail(404, 'not_found', 'Connector route not found.');
    } catch (error) { return connectorError(error); }
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') fail(426, 'upgrade_required', 'A WebSocket upgrade is required.');
    const connectorId = request.headers.get('x-connector-id') ?? '';
    const credentialHash = request.headers.get('x-connector-credential-hash') ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(connectorId) || !/^[A-Za-z0-9_-]{43}$/.test(credentialHash)) fail(403, 'invalid_connector', 'Invalid connector authentication.');
    if (this.connectorId && this.connectorId !== connectorId) fail(403, 'invalid_connector', 'Incorrect connector namespace.');
    const row = await currentConnector(this.env, connectorId);
    if (row.credential_hash !== credentialHash) fail(403, 'invalid_connector', 'Connector credentials changed.');
    const connectionToken = randomToken();
    const connectionHash = await sha256(connectionToken);
    const generation = id();
    const result = await this.env.DB.prepare(`UPDATE connectors SET connection_hash = ?, last_seen_at = ?
      WHERE id = ? AND credential_hash = ? AND revoked_at IS NULL AND connection_hash IS ?`)
      .bind(connectionHash, now(), connectorId, credentialHash, row.connection_hash).run();
    if (result.meta.changes !== 1) fail(409, 'connector_replaced', 'Connector authorization changed during connection.');
    const previous = this.current;
    if (previous) {
      this.current = null;
      this.failPending(previous, 503, 'Connector connection replaced');
      this.close(previous.socket, 1012, 'Connection replaced');
    }
    const pair = new WebSocketPair();
    const attachment: Generation = { connectorId, credentialHash, connectionHash, generation };
    try {
      this.ctx.storage.sql.exec('INSERT INTO connector_identity (singleton, connector_id, generation, credential_hash, connection_hash) VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, credential_hash = excluded.credential_hash, connection_hash = excluded.connection_hash', connectorId, generation, credentialHash, connectionHash);
      this.connectorId = connectorId;
      pair[1].serializeAttachment(attachment);
      this.ctx.acceptWebSocket(pair[1]);
      this.current = { ...attachment, socket: pair[1] };
      pair[1].send(JSON.stringify({ type: 'welcome', connectorId, connectionToken }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'opencara-pi-v1' } });
    } catch (error) {
      this.close(pair[1], 1011, 'Connection failed');
      this.current = null;
      this.ctx.storage.sql.exec('UPDATE connector_identity SET generation = NULL, credential_hash = NULL, connection_hash = NULL WHERE singleton = 1');
      await this.clearConnection(attachment);
      throw error;
    }
  }

  private reserve(bytes: number): boolean {
    if (bytes < 0 || this.bufferedBytes + bytes > connectorLimits.bufferedBytes) return false;
    this.bufferedBytes += bytes;
    return true;
  }

  private async rpc(request: Request): Promise<Response> {
    // Reserve before the first await, including requests still reading or checking D1.
    if (this.admitting + this.pending.size + this.replying >= connectorLimits.pendingRequests || !this.reserve(connectorRequestFrameBytes * 2)) {
      await request.body?.cancel();
      fail(429, 'connector_busy', 'The connector relay is at capacity.');
    }
    this.admitting++;
    let reserved = connectorRequestFrameBytes * 2;
    try {
      const envelope = await boundedJSON(request, connectorRequestFrameBytes) as ConnectorRelayEnvelope;
      await validateConnectorRpc(envelope);
      const connection = this.current;
      if (!connection || envelope.connectorId !== connection.connectorId || envelope.credentialHash !== connection.credentialHash ||
          envelope.connectionHash !== connection.connectionHash || connection.socket.readyState !== 1) fail(503, 'connector_offline', 'The connector is offline or has reconnected.');
      // A hub-minted wire nonce prevents reuse of an old RPC id from matching a late reply.
      const wireId = id();
      envelope.request.id = wireId;
      envelope.request.ticket.jti = wireId;
      const wire = JSON.stringify(envelope.request);
      const bytes = connectorUtf8Bytes(wire) + connectorUtf8Bytes(envelope.request.body);
      this.bufferedBytes -= reserved - bytes;
      reserved = bytes;
      await this.checkAuthority(connection, envelope);
      if (this.current !== connection || connection.socket.readyState !== 1) fail(503, 'connector_replaced', 'The connector connection changed.');
      if (envelope.request.ticket.exp <= Math.floor(Date.now() / 1000)) fail(403, 'ticket_expired', 'Connector authorization expired.');
      const timeout = ['backup', 'restore'].includes(envelope.request.ticket.action) ? 90000 : 30000;
      const { promise: response, resolve } = Promise.withResolvers<Response>();
      const timer = setTimeout(() => {
        void this.disconnect(connection, 504, 'Connector timed out').catch(() => {});
      }, timeout);
      const pending: Pending = { connection, envelope, resolve, bytes, responding: false, cancelTimer: () => clearTimeout(timer) };
      this.pending.set(wireId, pending);
      reserved = 0;
      try { connection.socket.send(wire); }
      catch { void this.disconnect(connection, 503, 'Connector disconnected').catch(() => {}); }
      return response;
    } finally {
      this.admitting--;
      this.bufferedBytes -= reserved;
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connection = this.current;
    if (!connection || connection.socket !== socket) { this.close(socket, 1008, 'Stale connection'); return; }
    // Binary frames are not part of this protocol. Charge the complete JSON frame before parsing.
    if (typeof message !== 'string' || message.length > connectorLimits.frameBytes) {
      await this.disconnect(connection, 502, 'Invalid connector frame'); return;
    }
    const frameBytes = connectorUtf8Bytes(message);
    // Reserve both the wire text and its decoded body, not just one copy.
    let charged = frameBytes * 2;
    if (frameBytes > connectorLimits.frameBytes || !this.reserve(charged)) {
      await this.disconnect(connection, 502, 'Connector buffer limit exceeded'); return;
    }
    try {
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
      await this.checkAuthority(connection, pending.envelope);
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
        const timer = setTimeout(() => { controller.error(new Error('Connector response expired')); release(); }, 30000);
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
    } catch (error) {
      // Do not retain or reflect connector-supplied data in protocol errors.
      this.failPending(connection, 403, 'Connector authorization or protocol validation failed');
      await this.disconnect(connection, 403, 'Connector authorization or protocol validation failed');
    } finally { this.bufferedBytes -= charged; }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    if (this.current?.socket === socket) await this.disconnect(this.current, 503, 'Connector disconnected');
    else this.close(socket, 1000, 'Closed');
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    if (this.current?.socket === socket) await this.disconnect(this.current, 503, 'Connector disconnected');
    else this.close(socket, 1011, 'Closed');
  }

  private async checkAuthority(connection: Generation, envelope: ConnectorRelayEnvelope): Promise<void> {
    const { promise: deadline, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error('Connector policy lookup timed out')), 10000);
    try {
      await Promise.race([deadline, (async () => {
        await authorizeConnectorTicket(this.env, envelope.request.ticket, connection.connectionHash);
        await requireConnectorGeneration(this.env, connection.connectorId, connection.credentialHash, connection.connectionHash);
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
    await this.env.DB.prepare('UPDATE connectors SET connection_hash = NULL WHERE id = ? AND credential_hash = ? AND connection_hash = ?')
      .bind(connection.connectorId, connection.credentialHash, connection.connectionHash).run();
  }

  private async disconnect(connection: SocketGeneration, status: number, reason: string): Promise<void> {
    if (this.current === connection) {
      this.current = null;
      this.ctx.storage.sql.exec('UPDATE connector_identity SET generation = NULL, credential_hash = NULL, connection_hash = NULL WHERE singleton = 1');
    }
    this.failPending(connection, status, reason);
    this.close(connection.socket, 1008, reason);
    await this.clearConnection(connection);
  }
}
