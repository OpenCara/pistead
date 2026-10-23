import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { openDatabase, sqliteHandle } from "../../apps/server/src/db/index.js";
import type { Database, Query } from "../../apps/server/src/db/types.js";
import type { ConnectorHub } from "../../apps/server/src/connector-hub-types.js";
import type { ConnectorRelayEnvelope } from "../../apps/server/src/connector-transport.js";
import type { ObjectMetadata, ObjectStorage, StoredObject } from "../../apps/server/src/storage/types.js";
import type { AgentVersion, ToolName } from "../../packages/shared/src/types.js";

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

export interface SeededAgent {
  authorId: string;
  modelId: string;
  tools: readonly ToolName[];
  /** Set for a version published to that workspace. */
  workspaceId?: string | null;
  instructions?: string;
  name?: string;
}

/**
 * An agent version saved before agents were removed. Sessions started from one keep its tools and instructions and
 * still run; sessions started now get a chat agent with every tool their host carries.
 */
export function seedAgentVersion(sqlite: DatabaseSync, input: SeededAgent): AgentVersion {
  const agent: AgentVersion = { id: randomUUID(), agentId: randomUUID(), authorId: input.authorId, workspaceId: input.workspaceId ?? null,
    version: 1, name: input.name ?? "Saved agent", description: "", instructions: input.instructions ?? "", tools: [...input.tools],
    modelId: input.modelId, createdAt: new Date().toISOString() };
  sqlite.prepare("INSERT INTO agents (id, author_id, created_at) VALUES (?, ?, ?)").run(agent.agentId, agent.authorId, agent.createdAt);
  sqlite.prepare(`INSERT INTO agent_versions
      (id, agent_id, author_id, workspace_id, version, name, description, instructions, tools_json, model_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(agent.id, agent.agentId, agent.authorId, agent.workspaceId, agent.version, agent.name,
    agent.description, agent.instructions, JSON.stringify(agent.tools), agent.modelId, agent.createdAt);
  return agent;
}

/**
 * A session started from a saved agent before agents were removed: a copy of the session `sessionId` (owner, host,
 * repositories, visibility and status) that runs `agent`, which must be on the same model. Returns the copy's id.
 */
export function seedSavedAgentSession(sqlite: DatabaseSync, sessionId: string, agent: AgentVersion, id: string = randomUUID()): string {
  const copied = sqlite.prepare(`INSERT INTO sessions
      (id, workspace_id, owner_id, agent_version_id, title, policy_version, status, created_at, connector_id, connector_owner_id,
        repositories_json, visibility, repository_mode)
    SELECT ?, s.workspace_id, s.owner_id, a.id, s.title, s.policy_version, s.status, s.created_at, s.connector_id, s.connector_owner_id,
      s.repositories_json, s.visibility, s.repository_mode
    FROM sessions s
    JOIN agent_versions pinned ON pinned.id = s.agent_version_id
    JOIN agent_versions a ON a.id = ? AND a.model_id = pinned.model_id
    WHERE s.id = ?`).run(id, agent.id, sessionId);
  if (copied.changes !== 1) throw new Error("The saved agent must be on the session's model.");
  return id;
}
