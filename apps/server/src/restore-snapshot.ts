import { sha256 } from '../../../packages/shared/src/crypto.js';
import type { RunnerBinding } from '../../../packages/shared/src/types.js';
import type { Env } from './types.js';
import { fail } from './http.js';
import { loadWorkspaceBackup } from './workspace-databases/store.js';

export const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
export interface BackupRow {
  id: string; session_id: string; owner_id: string; object_key: string;
  sha256: string; size: number; created_at: string;
  /** 1 when the server took it on the workspace's schedule (automatic-backups.ts); absent in rows read before. */
  automatic?: number;
  /** 1 when it keeps only the session's conversation, without its files or clones; absent in rows read before. */
  conversation_only?: number;
}

export async function boundedSnapshotText(response: Response, expectedSize?: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) fail(502, 'invalid_backup', 'The backup is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BACKUP_BYTES || (expectedSize !== undefined && size > expectedSize)) {
        fail(502, 'invalid_backup', 'The backup exceeds its size limit.');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (!size || (expectedSize !== undefined && size !== expectedSize)) fail(502, 'invalid_backup', 'The backup size does not match.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(502, 'invalid_backup', 'The backup is not valid UTF-8.'); }
}

export function repositoryIdentity(repositories: RunnerBinding['session']['repositories']): string {
  if (repositories === undefined) return '[]';
  if (!Array.isArray(repositories)) fail(409, 'invalid_restore', 'Invalid session repository pins.');
  return JSON.stringify(repositories.map(repository => {
    const provider = repository && 'provider' in repository;
    if (!repository || typeof repository.bindingId !== 'string' || typeof repository.repositoryId !== (provider ? 'string' : 'number') ||
        typeof repository.fullName !== 'string' || typeof repository.ref !== 'string' ||
        typeof repository.commit !== 'string' || typeof repository.path !== 'string' ||
        (provider && (typeof repository.provider !== 'string' || typeof repository.host !== 'string'))) {
      fail(409, 'invalid_restore', 'Invalid session repository pins.');
    }
    // GitHub pins keep their original identity tuple; other providers add provider and host.
    const identity = [repository.bindingId, repository.repositoryId, repository.fullName, repository.ref, repository.commit, repository.path];
    return 'provider' in repository ? [...identity, repository.provider, repository.host] : identity;
  }));
}

// Ignore mutable display names and owner profile, but never execution routing or identity.
export function bindingIdentity(binding: RunnerBinding): string {
  const { session: s, agent: a, model: m } = binding;
  return JSON.stringify([s.workspaceId, s.ownerId, s.agentVersionId, s.connectorId ?? null, s.connectorOwnerId ?? null,
    binding.owner.id, a.id, a.agentId, a.authorId, a.workspaceId, a.version, a.instructions, a.tools, a.modelId,
    m.id, m.workspaceId, m.provider, m.modelId, m.connectorId ?? null, m.connectorOwnerId ?? null,
    repositoryIdentity(s.repositories)]);
}

/**
 * Checks a snapshot against its session's binding. With `conversationOnly` set, the snapshot must also be of that kind:
 * a conversation-only one carries no files and no clones, and a host that ignored the request sends a full one instead.
 */
export function validateSnapshot(raw: string, source: RunnerBinding, expected: { conversationOnly?: boolean } = {}): void {
  // Untrusted JSON, checked field by field below.
  let snapshot: any;
  try {
    snapshot = JSON.parse(raw);
    if (JSON.stringify(snapshot) !== raw) throw new Error('Noncanonical snapshot');
    if (snapshot?.format !== 'pi-runner-backup-v1' || snapshot.binding?.session?.id !== source.session.id ||
        bindingIdentity(snapshot.binding) !== bindingIdentity(source) || typeof snapshot.sqlite !== 'string' ||
        !snapshot.sqlite || !Array.isArray(snapshot.files) || !snapshot.manifest) throw new Error('Invalid binding');
  } catch { fail(502, 'invalid_backup', 'The backup does not match the immutable session binding.'); }
  if (expected.conversationOnly === undefined) return;
  const conversationOnly = snapshot.conversationOnly === true && !snapshot.files.length && snapshot.clones === undefined;
  if (expected.conversationOnly !== conversationOnly || (!expected.conversationOnly && snapshot.conversationOnly !== undefined)) {
    fail(502, 'invalid_backup', expected.conversationOnly ? 'The host returned a full backup instead of the conversation only; update its connector.'
      : 'The host returned a conversation-only backup instead of a full one.');
  }
}

/**
 * The stored snapshot: in the workspace's own database when the backup was saved there, else in the server's storage.
 * Either way it is untrusted until `loadBackupSnapshot` has checked its size, digest and binding.
 */
async function readBackupObject(env: Env, record: BackupRow, workspaceId: string): Promise<{ body: Uint8Array; size: number } | null> {
  const location = await env.DB.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_database_backups WHERE backup_id = ?')
    .bind(record.id).first();
  if (!location) {
    if (!env.BUCKET) fail(503, 'backup_unavailable', 'Durable backup storage is not configured.');
    return env.BUCKET.get(record.object_key);
  }
  if (location.workspace_id !== workspaceId) fail(409, 'invalid_backup', 'The backup record does not match its session.');
  return loadWorkspaceBackup(env, workspaceId, { id: record.id, sessionId: record.session_id, size: record.size });
}

export async function loadBackupSnapshot(env: Env, record: BackupRow, source: RunnerBinding): Promise<string> {
  if (!Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_BACKUP_BYTES ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.sha256) ||
      record.session_id !== source.session.id || record.owner_id !== source.session.ownerId ||
      record.object_key !== `sessions/${record.owner_id}/${record.session_id}/${record.id}.json`) {
    fail(409, 'invalid_backup', 'The backup record does not match its session.');
  }
  const object = await readBackupObject(env, record, source.session.workspaceId);
  if (!object) fail(404, 'not_found', 'Backup object is unavailable.');
  if (object.size !== record.size || object.body.byteLength !== record.size || object.size > MAX_BACKUP_BYTES) {
    fail(502, 'invalid_backup', 'The backup size does not match.');
  }
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(object.body); }
  catch { fail(502, 'invalid_backup', 'The backup is not valid UTF-8.'); }
  if (await sha256(raw) !== record.sha256) fail(502, 'invalid_backup', 'The backup checksum does not match.');
  validateSnapshot(raw, source);
  return raw;
}
