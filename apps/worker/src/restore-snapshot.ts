import { sha256 } from '../../../packages/shared/src/crypto.js';
import type { RunnerBinding } from '../../../packages/shared/src/types.js';
import type { Env } from './types.js';
import { fail } from './http.js';

export const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
export interface BackupRow {
  id: string; session_id: string; owner_id: string; object_key: string;
  sha256: string; size: number; created_at: string;
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
    if (!repository || typeof repository.bindingId !== 'string' || typeof repository.repositoryId !== 'number' ||
        typeof repository.fullName !== 'string' || typeof repository.ref !== 'string' ||
        typeof repository.commit !== 'string' || typeof repository.path !== 'string') {
      fail(409, 'invalid_restore', 'Invalid session repository pins.');
    }
    return [repository.bindingId, repository.repositoryId, repository.fullName, repository.ref, repository.commit, repository.path];
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

export function validateSnapshot(raw: string, source: RunnerBinding): void {
  try {
    const snapshot = JSON.parse(raw);
    if (JSON.stringify(snapshot) !== raw) throw new Error('Noncanonical snapshot');
    if (snapshot?.format !== 'pi-runner-backup-v1' || snapshot.binding?.session?.id !== source.session.id ||
        bindingIdentity(snapshot.binding) !== bindingIdentity(source) || typeof snapshot.sqlite !== 'string' ||
        !snapshot.sqlite || !Array.isArray(snapshot.files) || !snapshot.manifest) throw new Error('Invalid binding');
  } catch { fail(502, 'invalid_backup', 'The backup does not match the immutable session binding.'); }
}

export async function loadBackupSnapshot(env: Env, record: BackupRow, source: RunnerBinding): Promise<string> {
  if (!env.BUCKET) fail(503, 'backup_unavailable', 'Durable R2 backup storage is not configured.');
  if (!Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_BACKUP_BYTES ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.sha256) ||
      record.session_id !== source.session.id || record.owner_id !== source.session.ownerId ||
      record.object_key !== `sessions/${record.owner_id}/${record.session_id}/${record.id}.json`) {
    fail(409, 'invalid_backup', 'The backup record does not match its session.');
  }
  const object = await env.BUCKET.get(record.object_key);
  if (!object) fail(404, 'not_found', 'Backup object is unavailable.');
  if (object.size !== record.size) {
    await object.body.cancel();
    fail(502, 'invalid_backup', 'The backup size does not match.');
  }
  const raw = await boundedSnapshotText(new Response(object.body), record.size);
  if (await sha256(raw) !== record.sha256) fail(502, 'invalid_backup', 'The backup checksum does not match.');
  validateSnapshot(raw, source);
  return raw;
}
