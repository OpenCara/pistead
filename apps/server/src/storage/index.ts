import { FilesystemStorage } from './filesystem.js';
import { S3Storage } from './s3.js';
import type { ObjectStorage } from './types.js';

/**
 * Builds the backup store named by `STORAGE_URL`:
 * - `file:///data/backups` — a directory on the local filesystem.
 * - `s3://bucket/prefix?endpoint=https://minio.example&region=us-east-1` — any S3-compatible service.
 *   Credentials come from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (or the standard `AWS_*` names,
 *   including the SDK's own provider chain when neither is set).
 */
export function openStorage(url: string, processEnv: NodeJS.ProcessEnv = process.env): ObjectStorage {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`STORAGE_URL is not a valid URL: ${url}`); }
  if (parsed.protocol === 'file:') {
    if (parsed.host && parsed.host !== 'localhost') throw new Error('STORAGE_URL file:// URLs must not name a host (use file:///absolute/path).');
    const root = decodeURIComponent(parsed.pathname);
    if (!root) throw new Error('STORAGE_URL file:// URL is missing a directory.');
    return new FilesystemStorage(root);
  }
  if (parsed.protocol === 's3:') {
    const bucket = parsed.hostname;
    if (!bucket) throw new Error('STORAGE_URL s3:// URL is missing a bucket name.');
    const prefix = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, '');
    const endpoint = parsed.searchParams.get('endpoint') ?? processEnv.AWS_ENDPOINT_URL_S3;
    const region = parsed.searchParams.get('region') ?? processEnv.AWS_REGION ?? processEnv.AWS_DEFAULT_REGION ?? 'us-east-1';
    const accessKeyId = processEnv.S3_ACCESS_KEY_ID || processEnv.AWS_ACCESS_KEY_ID;
    const secretAccessKey = processEnv.S3_SECRET_ACCESS_KEY || processEnv.AWS_SECRET_ACCESS_KEY;
    return new S3Storage({
      bucket, prefix, region,
      ...(endpoint ? { endpoint } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }
  throw new Error(`STORAGE_URL scheme is not supported: ${parsed.protocol} (expected file:// or s3://)`);
}
