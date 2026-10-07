import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ObjectMetadata, ObjectStorage, StoredObject } from './types.js';

const keyPattern = /^[A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+)*$/;
const metadataSuffix = '.meta.json';

/** Rejects keys that are not plain relative paths of safe segments; `..` and absolute paths never reach the filesystem. */
export function validateObjectKey(key: string): string {
  if (!keyPattern.test(key) || key.split('/').some(segment => segment === '..' || segment === '.' || segment.endsWith(metadataSuffix))) {
    throw new Error('Invalid object key.');
  }
  return key;
}

/**
 * Objects live at `<root>/<key>` with a `<root>/<key>.meta.json` sidecar. Writes go to a temporary
 * file in the same directory and are renamed into place, so readers never see partial bodies.
 */
export class FilesystemStorage implements ObjectStorage {
  readonly provider = 'filesystem' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, validateObjectKey(key));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid object key.');
    return path;
  }

  async put(key: string, body: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bodyTemp = `${path}.${token}.tmp`;
    const metaTemp = `${path}${metadataSuffix}.${token}.tmp`;
    try {
      await writeFile(bodyTemp, body, { mode: 0o600 });
      await writeFile(metaTemp, JSON.stringify({ contentType: metadata.contentType, custom: metadata.custom }), { mode: 0o600 });
      await rename(metaTemp, `${path}${metadataSuffix}`);
      await rename(bodyTemp, path);
    } catch (error) {
      await Promise.all([rm(bodyTemp, { force: true }), rm(metaTemp, { force: true })]);
      throw error;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    let body: Buffer;
    try { body = await readFile(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let metadata: ObjectMetadata = { contentType: 'application/octet-stream', custom: {} };
    try {
      const parsed = JSON.parse(await readFile(`${path}${metadataSuffix}`, 'utf8')) as Partial<ObjectMetadata>;
      metadata = {
        contentType: typeof parsed.contentType === 'string' ? parsed.contentType : metadata.contentType,
        custom: parsed.custom && typeof parsed.custom === 'object' ? { ...parsed.custom } : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), size: body.byteLength, metadata };
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await Promise.all([rm(path, { force: true }), rm(`${path}${metadataSuffix}`, { force: true })]);
  }
}
