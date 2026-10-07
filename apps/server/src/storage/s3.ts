import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { validateObjectKey } from './filesystem.js';
import type { ObjectMetadata, ObjectStorage, StoredObject } from './types.js';

export interface S3StorageOptions {
  bucket: string;
  /** Key prefix without leading or trailing slash; empty for the bucket root. */
  prefix: string;
  region: string;
  /** Custom endpoint (MinIO, R2, …); enables path-style addressing. */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** Backups on any S3-compatible service. Metadata is stored as object user metadata next to `ContentType`. */
export class S3Storage implements ObjectStorage {
  readonly provider = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
  }

  private keyFor(key: string): string {
    validateObjectKey(key);
    return this.options.prefix ? `${this.options.prefix}/${key}` : key;
  }

  async put(key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket, Key: this.keyFor(key), Body: body, ContentLength: body.byteLength,
      ContentType: metadata.contentType, Metadata: metadata.custom,
    }));
  }

  async get(key: string): Promise<StoredObject | null> {
    let output;
    try {
      output = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key) }));
    } catch (error) {
      if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) return null;
      throw error;
    }
    const body = output.Body ? await output.Body.transformToByteArray() : new Uint8Array(0);
    return {
      body, size: body.byteLength,
      metadata: { contentType: output.ContentType ?? 'application/octet-stream', custom: { ...output.Metadata } },
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key) }));
  }

  destroy(): void {
    this.client.destroy();
  }
}
