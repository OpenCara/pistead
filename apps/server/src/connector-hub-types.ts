import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ConnectorRelayEnvelope } from './connector-transport.js';

/**
 * The in-process relay between the control plane and one connected host (`apps/runner`).
 * One hub exists per connector id for the life of the server; the previous Durable Object
 * guaranteed the same single-instance semantics, which the wire protocol relies on.
 */
export interface ConnectorHub {
  /**
   * Completes a WebSocket upgrade for an authenticated connector. `credentialHash` must match the
   * connectors row; the current connection (if any) is replaced and its pending requests fail.
   * The hub takes ownership of `socket` and sends the welcome frame.
   */
  connect(request: IncomingMessage, socket: Duplex, head: Buffer, connectorId: string, credentialHash: string): Promise<void>;
  /** Relays one authorized RPC to the connected host and resolves with its reply, or a connector_relay_error response. */
  rpc(connectorId: string, envelope: ConnectorRelayEnvelope): Promise<Response>;
  /** Whether a live, still-authorized connection exists; a database check bounded by `timeoutMs`. */
  status(connectorId: string, timeoutMs: number): Promise<boolean>;
  /** Closes the current connection after the connectors row has been revoked or its owner suspended. */
  revoke(connectorId: string): Promise<void>;
  /** Closes every connection; used on server shutdown. */
  close(): Promise<void>;
}
