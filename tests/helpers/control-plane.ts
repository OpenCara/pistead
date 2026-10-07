import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { openDatabase, sqliteHandle } from "../../apps/server/src/db/index.js";
import type { Database, Query } from "../../apps/server/src/db/types.js";
import type { ConnectorHub } from "../../apps/server/src/connector-hub-types.js";
import type { ConnectorRelayEnvelope } from "../../apps/server/src/connector-transport.js";
import type { ObjectMetadata, ObjectStorage, StoredObject } from "../../apps/server/src/storage/types.js";

export interface TestDatabase {
  /** The provider handed to `Env.DB`; every `query()` call is observed. */
  db: Database;
  /** Raw synchronous handle for seeding rows and inspecting state. */
  sqlite: DatabaseSync;
  queryCount(): number;
  setBeforeQuery(hook?: (sql: string) => void): void;
}

/** A migrated in-memory sqlite provider with query observation for budget and race tests. */
export async function testDatabase(): Promise<TestDatabase> {
  const inner = await openDatabase("sqlite::memory:");
  await inner.migrate();
  let queryCount = 0;
  let beforeQuery: ((sql: string) => void) | undefined;
  const db: Database = {
    provider: inner.provider,
    query<T>(sql: string): Query<T> {
      beforeQuery?.(sql);
      queryCount++;
      return inner.query<T>(sql);
    },
    batch: statements => inner.batch(statements),
    transaction: work => inner.transaction(work),
    migrate: () => inner.migrate(),
    close: () => inner.close(),
  };
  return { db, sqlite: sqliteHandle(inner), queryCount: () => queryCount, setBeforeQuery(hook) { beforeQuery = hook; } };
}

export interface MemoryStorage extends ObjectStorage {
  /** Raw bodies by key; tests seed and corrupt objects here. */
  objects: Map<string, Uint8Array>;
  metadata: Map<string, ObjectMetadata>;
  reads: string[];
}

/** In-memory `ObjectStorage`; `reads` records every `get` key for tests that bound storage traffic. */
export function memoryStorage(): MemoryStorage {
  const objects = new Map<string, Uint8Array>();
  const metadata = new Map<string, ObjectMetadata>();
  const reads: string[] = [];
  return {
    provider: "filesystem",
    objects,
    metadata,
    reads,
    async put(key, body, meta) { objects.set(key, new Uint8Array(body)); metadata.set(key, meta); },
    async get(key): Promise<StoredObject | null> {
      reads.push(key);
      const body = objects.get(key);
      if (!body) return null;
      return { body: new Uint8Array(body), size: body.byteLength,
        metadata: metadata.get(key) ?? { contentType: "application/octet-stream", custom: {} } };
    },
    async delete(key) { objects.delete(key); metadata.delete(key); },
  };
}

export interface FakeHubOptions {
  /** Answers relayed RPCs; defaults to a 503 relay error like an offline host. */
  rpc?(connectorId: string, envelope: ConnectorRelayEnvelope): Response | Promise<Response>;
  /** Reported by `status`; defaults to online. */
  online?: boolean;
}

export interface FakeHub extends ConnectorHub {
  revoked: string[];
  statusChecks: string[];
}

/** A `ConnectorHub` double for route tests: no sockets, scripted RPC replies, recorded revocations. */
export function fakeHub(options: FakeHubOptions = {}): FakeHub {
  const revoked: string[] = [];
  const statusChecks: string[] = [];
  return {
    revoked,
    statusChecks,
    async connect(_request: IncomingMessage, _socket: Duplex, _head: Buffer, _connectorId: string, _credentialHash: string) {
      throw new Error("Test hub does not accept sockets");
    },
    async rpc(connectorId, envelope) {
      if (!options.rpc) return Response.json({ error: "Unsupported test relay request", code: "connector_relay_error" }, { status: 503 });
      return options.rpc(connectorId, envelope);
    },
    async status(connectorId) { statusChecks.push(connectorId); return options.online ?? true; },
    async revoke(connectorId) { revoked.push(connectorId); },
    async close() {},
  };
}
