/** Opaque object storage for session backups. Keys look like `sessions/<owner>/<session>/<backup>.json`. */
export interface ObjectStorage {
  readonly provider: StorageProviderName;
  put(key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void>;
  /** The whole object, or null when absent. Callers bound sizes before calling. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export interface ObjectMetadata {
  contentType: string;
  /** Free-form string pairs stored with the object (owner, session, sha256, format). */
  custom: Record<string, string>;
}

export interface StoredObject {
  body: Uint8Array;
  size: number;
  metadata: ObjectMetadata;
}

export const storageProviderNames = ['filesystem', 's3'] as const;
export type StorageProviderName = (typeof storageProviderNames)[number];
