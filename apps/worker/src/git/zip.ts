import { repositoryLimits } from '../../../../packages/shared/src/repositories.js';
import { fail } from '../http.js';

/**
 * Converts a provider zip snapshot (Azure DevOps) into the gzip'd ustar/PAX archive the runner extracts.
 * Only stored/deflated, unencrypted, single-disk, non-zip64 archives are accepted; every entry is checked against
 * repositoryLimits and placed under `topDirectory/`. Symlinks keep their target as linkname; runner policy decides.
 */

const textEncoder = new TextEncoder();
const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

interface ZipEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  executable: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function invalid(message: string): never {
  return fail(502, 'invalid_repository_archive', message);
}
function tooLarge(): never {
  return fail(502, 'repository_size_limit', 'The repository archive exceeds the supported size limit.');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip entry name -> repository-relative path, refusing anything that could leave or alias inside the tree. */
function entryPath(raw: Uint8Array): { path: string; directory: boolean } {
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return invalid('The repository archive has a non-UTF-8 path.'); }
  if (!name || /[\x00-\x1f\x7f]/.test(name)) invalid('The repository archive has an empty path or a control character in a path.');
  if (name.includes('\\')) invalid('The repository archive has a backslash in a path.');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) invalid('The repository archive has an absolute path.');
  const directory = name.endsWith('/');
  const path = directory ? name.slice(0, -1) : name;
  if (path.split('/').some(part => part === '' || part === '.' || part === '..')) invalid('The repository archive has a traversal or empty path segment.');
  return { path, directory };
}

function centralDirectory(zip: Uint8Array, view: DataView): { entries: ZipEntry[]; directoryStart: number } {
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === zip.length) { end = offset; break; }
  }
  if (end < 0) invalid('The repository archive is not a zip file.');
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) invalid('ZIP64 repository archives are not supported.');
  const disk = view.getUint16(end + 4, true), directoryDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true), count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) invalid('ZIP64 repository archives are not supported.');
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== count) invalid('Multi-disk repository archives are not supported.');
  // One extra tar entry holds the top-level directory.
  if (count + 1 > repositoryLimits.entries) tooLarge();
  if (start + size > end) invalid('The repository archive central directory is out of bounds.');

  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let expanded = 0;
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || view.getUint32(offset, true) !== 0x02014b50) invalid('The repository archive central directory is corrupt.');
    const madeBy = view.getUint16(offset + 4, true), flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true), compressedSize = view.getUint32(offset + 20, true), entrySize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true), external = view.getUint32(offset + 38, true), localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > start + size) invalid('The repository archive central directory is corrupt.');
    if (compressedSize === 0xffffffff || entrySize === 0xffffffff || localOffset === 0xffffffff || entryDisk === 0xffff) {
      invalid('ZIP64 repository archives are not supported.');
    }
    for (let extra = offset + 46 + nameLength; extra + 4 <= offset + 46 + nameLength + extraLength;) {
      if (view.getUint16(extra, true) === 0x0001) invalid('ZIP64 repository archives are not supported.');
      extra += 4 + view.getUint16(extra + 2, true);
    }
    if (entryDisk !== 0) invalid('Multi-disk repository archives are not supported.');
    if (flags & 0x41) invalid('Encrypted repository archives are not supported.');
    if (method !== 0 && method !== 8) invalid('The repository archive uses an unsupported compression method.');

    const { path, directory } = entryPath(zip.subarray(offset + 46, offset + 46 + nameLength));
    // Unix hosts (made-by high byte 3) carry st_mode in the high half of the external attributes.
    const mode = madeBy >>> 8 === 3 ? external >>> 16 : 0;
    const type = mode & 0o170000;
    let kind: ZipEntry['kind'] = 'file';
    if (directory || type === 0o040000) kind = 'directory';
    else if (type === 0o120000) kind = 'symlink';
    else if (type !== 0 && type !== 0o100000) invalid('The repository archive contains a special file.');
    if (kind === 'directory' && (entrySize !== 0 || (directory && type !== 0 && type !== 0o040000))) invalid('The repository archive has a directory with contents.');
    if (entrySize > repositoryLimits.fileBytes) tooLarge();
    expanded += entrySize;
    if (expanded > repositoryLimits.expandedBytes) tooLarge();
    if (paths.has(path)) invalid('The repository archive contains duplicate paths.');
    paths.add(path);
    entries.push({ path, kind, executable: (mode & 0o111) !== 0, method, crc, compressedSize, size: entrySize, localOffset });
    offset = next;
  }
  if (offset !== start + size) invalid('The repository archive central directory is corrupt.');
  const files = new Set(entries.filter(entry => entry.kind !== 'directory').map(entry => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (files.has(parts.slice(0, depth).join('/'))) invalid('The repository archive uses a file as a directory.');
    }
  }
  return { entries, directoryStart: start };
}

async function entryData(zip: Uint8Array, view: DataView, entry: ZipEntry, directoryStart: number): Promise<Uint8Array> {
  const offset = entry.localOffset;
  if (offset + 30 > directoryStart || view.getUint32(offset, true) !== 0x04034b50) invalid('The repository archive has a corrupt local header.');
  if (view.getUint16(offset + 6, true) & 0x41 || view.getUint16(offset + 8, true) !== entry.method) invalid('The repository archive has an inconsistent local header.');
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  const end = start + entry.compressedSize;
  if (end > directoryStart) invalid('The repository archive entry data is out of bounds.');
  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) invalid('The repository archive has an inconsistent stored entry size.');
    data = zip.subarray(start, end);
  } else {
    data = new Uint8Array(entry.size);
    let size = 0;
    const reader = new Blob([zip.slice(start, end)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > entry.size - size) throw new Error('entry larger than declared');
        data.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } catch {
      void reader.cancel().catch(() => {});
      invalid('The repository archive has a corrupt or oversized compressed entry.');
    }
    if (size !== entry.size) invalid('The repository archive has an inconsistent entry size.');
  }
  if (crc32(data) !== entry.crc) invalid('The repository archive failed its CRC-32 check.');
  return data;
}

function octal(header: Uint8Array, offset: number, length: number, value: number): void {
  header.set(textEncoder.encode(value.toString(8).padStart(length - 1, '0')), offset);
}

function tarHeader(name: Uint8Array, type: string, mode: number, size: number, linkname?: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(name, 0);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header[156] = type.charCodeAt(0);
  if (linkname) header.set(linkname, 157);
  header.set(textEncoder.encode('ustar\0' + '00'), 257);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(textEncoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return header;
}

/** One PAX record: "<length> path=<value>\n", where length counts the whole record including its own digits. */
function paxPath(value: string): Uint8Array {
  const rest = textEncoder.encode(` path=${value}\n`).length;
  let length = rest + 1;
  while (String(length).length + rest !== length) length = String(length).length + rest;
  return textEncoder.encode(`${length} path=${value}\n`);
}

export async function zipToTarGz(zip: Uint8Array, topDirectory: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(topDirectory) || /^\.+$/.test(topDirectory) || topDirectory.toLowerCase() === '.git') {
    fail(400, 'invalid_repository_path', 'The repository archive directory name is invalid.');
  }
  if (zip.length > repositoryLimits.archiveBytes) tooLarge();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const { entries, directoryStart } = centralDirectory(zip, view);

  const chunks: Uint8Array[] = [];
  let tarSize = 0;
  let headers = 0;
  const push = (chunk: Uint8Array) => {
    tarSize += chunk.length;
    if (tarSize > repositoryLimits.expandedBytes) tooLarge();
    chunks.push(chunk);
  };
  const padded = (body: Uint8Array) => {
    push(body);
    if (body.length % 512) push(new Uint8Array(512 - (body.length % 512)));
  };
  const entry = (path: string, type: string, mode: number, body?: Uint8Array, linkname?: Uint8Array) => {
    const name = textEncoder.encode(path);
    headers += name.length > 100 ? 2 : 1;
    if (headers > repositoryLimits.entries) tooLarge();
    if (name.length > 100) {
      // The runner validates every header name, so the PAX header and the overridden name are both real paths.
      const record = paxPath(path);
      push(tarHeader(textEncoder.encode(`${topDirectory}/PaxHeader`), 'x', 0o644, record.length));
      padded(record);
      push(tarHeader(textEncoder.encode(`${topDirectory}/PaxPath`), type, mode, body?.length ?? 0, linkname));
    } else push(tarHeader(name, type, mode, body?.length ?? 0, linkname));
    if (body) padded(body);
  };

  entry(`${topDirectory}/`, '5', 0o755);
  for (const item of entries) {
    if (item.kind === 'directory') { entry(`${topDirectory}/${item.path}/`, '5', 0o755); continue; }
    const data = await entryData(zip, view, item, directoryStart);
    if (item.kind === 'symlink') {
      let target: string;
      try { target = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return invalid('The repository archive has a non-UTF-8 symlink target.'); }
      const linkname = textEncoder.encode(target);
      if (!target || target.includes('\0') || linkname.length > 100) invalid('The repository archive has an empty or overlong symlink target.');
      entry(`${topDirectory}/${item.path}`, '2', 0o777, undefined, linkname);
    } else entry(`${topDirectory}/${item.path}`, '0', item.executable ? 0o755 : 0o644, data);
  }
  push(new Uint8Array(1024));

  const reader = new Blob(chunks as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new CompressionStream('gzip')).getReader();
  const output = new Uint8Array(repositoryLimits.archiveBytes);
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength > output.length - size) { void reader.cancel().catch(() => {}); tooLarge(); }
    output.set(chunk.value, size);
    size += chunk.value.byteLength;
  }
  return output.slice(0, size);
}
