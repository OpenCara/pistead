import type { S3Client } from '@aws-sdk/client-s3';
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

/**
 * Backups on any S3-compatible service. Metadata is stored as object user metadata next to `ContentType`. The SDK is
 * loaded at the first request, so servers that keep backups elsewhere (a local one, say) need it not installed.
 */
export class S3Storage implements ObjectStorage {
  readonly provider = 's3' as const;
  private sdk?: Promise<{ client: S3Client; commands: typeof import('@aws-sdk/client-s3') }>;

  constructor(private readonly options: S3StorageOptions) {}

  private async s3() {
    this.sdk ??= import('@aws-sdk/client-s3').then(commands => ({ commands, client: new commands.S3Client({
      region: this.options.region,
      ...(this.options.endpoint ? { endpoint: this.options.endpoint, forcePathStyle: true } : {}),
      ...(this.options.credentials ? { credentials: this.options.credentials } : {}),
    }) }));
    return this.sdk;
  }

  private keyFor(key: string): string {
    validateObjectKey(key);
    return this.options.prefix ? `${this.options.prefix}/${key}` : key;
  }

  async put(key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    const { client, commands: { PutObjectCommand } } = await this.s3();
    await client.send(new PutObjectCommand({
      Bucket: this.options.bucket, Key: this.keyFor(key), Body: body, ContentLength: body.byteLength,
      ContentType: metadata.contentType, Metadata: metadata.custom,
    }));
  }

  async get(key: string): Promise<StoredObject | null> {
    const { client, commands: { GetObjectCommand } } = await this.s3();
    let output;
    try {
      output = await client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key) }));
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
    const { client, commands: { DeleteObjectCommand } } = await this.s3();
    await client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key) }));
  }

  destroy(): void {
    void this.sdk?.then(({ client }) => client.destroy(), () => {});
  }
}
