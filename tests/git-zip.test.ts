import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync, gunzipSync } from 'node:zlib';
import { HTTPException } from 'hono/http-exception';
import { zipToTarGz } from '../apps/worker/src/git/zip.js';
import { repositoryLimits } from '../packages/shared/src/repositories.js';

interface ZipInput {
  name: string;
  data?: string | Buffer;
  /** Unix st_mode stored in the external attributes. */
  mode?: number;
  method?: 0 | 8;
  flags?: number;
  crc?: number;
  /** Declared uncompressed size override (central directory only). */
  size?: number;
}

function makeZip(items: ZipInput[], options: { zip64?: boolean } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const data = Buffer.from(item.data ?? '');
    const method = item.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const crc = item.crc ?? crc32(data);
    const flags = item.flags ?? 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(item.size ?? data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? (item.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

interface TarEntry { name: string; type: string; mode: number; linkname: string; body: Buffer; rawName: string }

function untar(gz: Uint8Array): TarEntry[] {
  const tar = gunzipSync(gz);
  assert.equal(tar.length % 512, 0);
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder();
  const text = (bytes: Uint8Array) => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
  let pending: string | null = null;
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      assert.ok(tar.subarray(offset).every(byte => byte === 0));
      assert.equal(tar.length - offset, 512);
      break;
    }
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    assert.equal(parseInt(text(header.subarray(148, 156)).trim(), 8), sum);
    assert.equal(decoder.decode(header.subarray(257, 263)), 'ustar\0');
    const size = parseInt(text(header.subarray(124, 136)), 8);
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156]!);
    const rawName = text(header.subarray(0, 100));
    if (type === 'x') {
      const record = decoder.decode(body);
      const match = /^(\d+) path=(.*)\n$/s.exec(record);
      assert.ok(match);
      assert.equal(Number(match[1]), body.length);
      pending = match[2]!;
      continue;
    }
    entries.push({ name: pending ?? rawName, rawName, type, mode: parseInt(text(header.subarray(100, 108)), 8),
      linkname: text(header.subarray(157, 257)), body: Buffer.from(body) });
    pending = null;
  }
  return entries;
}

async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException);
    const body: unknown = await error.getResponse().json();
    assert.ok(body && typeof body === 'object' && 'code' in body && typeof body.code === 'string');
    return { status: error.status, code: body.code };
  }
  return assert.fail('expected the conversion to fail');
}

test('zip snapshots round-trip into a single-directory tar.gz', async () => {
  const longName = `deep/${'x'.repeat(120)}.txt`;
  const zip = makeZip([
    { name: 'src/' },
    { name: 'src/a.txt', data: 'hello world\n'.repeat(100) },
    { name: 'run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755, method: 0 },
    { name: 'link', data: 'src/a.txt', mode: 0o120777, method: 0 },
    { name: longName, data: 'long' },
    { name: 'empty.txt', data: '' },
  ]);
  const entries = untar(await zipToTarGz(zip, 'acme-app-0123456'));
  assert.deepEqual(entries.map(entry => [entry.name, entry.type]), [
    ['acme-app-0123456/', '5'],
    ['acme-app-0123456/src/', '5'],
    ['acme-app-0123456/src/a.txt', '0'],
    ['acme-app-0123456/run.sh', '0'],
    ['acme-app-0123456/link', '2'],
    [`acme-app-0123456/${longName}`, '0'],
    ['acme-app-0123456/empty.txt', '0'],
  ]);
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  assert.equal(byName.get('acme-app-0123456/src/a.txt')!.body.toString(), 'hello world\n'.repeat(100));
  assert.equal(byName.get('acme-app-0123456/src/a.txt')!.mode, 0o644);
  assert.equal(byName.get('acme-app-0123456/run.sh')!.mode, 0o755);
  assert.equal(byName.get('acme-app-0123456/run.sh')!.body.toString(), '#!/bin/sh\necho hi\n');
  assert.equal(byName.get('acme-app-0123456/link')!.linkname, 'src/a.txt');
  assert.equal(byName.get('acme-app-0123456/link')!.body.length, 0);
  const long = byName.get(`acme-app-0123456/${longName}`)!;
  assert.equal(long.body.toString(), 'long');
  // The fallback ustar name stays a valid in-tree path for the runner's per-header validation.
  assert.equal(long.rawName, 'acme-app-0123456/PaxPath');
});

test('unsafe zip paths and entries are rejected', async () => {
  const cases: Array<[string, ZipInput[]]> = [
    ['traversal', [{ name: '../evil', data: 'x' }]],
    ['nested traversal', [{ name: 'a/../../evil', data: 'x' }]],
    ['absolute', [{ name: '/etc/passwd', data: 'x' }]],
    ['drive', [{ name: 'C:/evil', data: 'x' }]],
    ['backslash', [{ name: 'a\\b', data: 'x' }]],
    ['control', [{ name: 'a\nb', data: 'x' }]],
    ['empty segment', [{ name: 'a//b', data: 'x' }]],
    ['duplicate', [{ name: 'a.txt', data: 'x' }, { name: 'a.txt', data: 'y' }]],
    ['duplicate directory', [{ name: 'a/' }, { name: 'a', data: 'y' }]],
    ['file used as directory', [{ name: 'a', data: 'x' }, { name: 'a/b', data: 'y' }]],
    ['encrypted', [{ name: 'a.txt', data: 'x', flags: 0x1 }]],
    ['unsupported method', [{ name: 'a.txt', data: 'x', method: 12 as 0 }]],
    ['special file', [{ name: 'fifo', data: '', mode: 0o010644 }]],
    ['crc mismatch', [{ name: 'a.txt', data: 'payload', crc: 1234 }]],
    ['declared size mismatch', [{ name: 'a.txt', data: 'payload', size: 3 }]],
  ];
  for (const [label, items] of cases) {
    assert.deepEqual(await failure(zipToTarGz(makeZip(items), 'top')), { status: 502, code: 'invalid_repository_archive' }, label);
  }
  assert.deepEqual(await failure(zipToTarGz(makeZip([{ name: 'a.txt', data: 'x' }], { zip64: true }), 'top')),
    { status: 502, code: 'invalid_repository_archive' });
  assert.deepEqual(await failure(zipToTarGz(new TextEncoder().encode('not a zip at all, not even close'), 'top')),
    { status: 502, code: 'invalid_repository_archive' });
});

test('zip size and entry limits are enforced', async () => {
  assert.deepEqual(await failure(zipToTarGz(makeZip([{ name: 'big.bin', data: 'x', size: repositoryLimits.fileBytes + 1 }]), 'top')),
    { status: 502, code: 'repository_size_limit' });
  const half = repositoryLimits.fileBytes;
  const many = Array.from({ length: Math.floor(repositoryLimits.expandedBytes / half) + 1 }, (_, index) => ({ name: `f${index}`, data: 'x', size: half }));
  assert.deepEqual(await failure(zipToTarGz(makeZip(many), 'top')), { status: 502, code: 'repository_size_limit' });
  const crowded = Array.from({ length: repositoryLimits.entries }, (_, index) => ({ name: `d${index}/` }));
  assert.deepEqual(await failure(zipToTarGz(makeZip(crowded), 'top')), { status: 502, code: 'repository_size_limit' });
  assert.deepEqual(await failure(zipToTarGz(new Uint8Array(repositoryLimits.archiveBytes + 1), 'top')), { status: 502, code: 'repository_size_limit' });
});

test('the top directory must be one safe path segment', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'x' }]);
  for (const top of ['', '.', '..', 'a/b', '.git', 'x'.repeat(81), 'a b']) {
    assert.equal((await failure(zipToTarGz(zip, top))).status, 400, top);
  }
});
