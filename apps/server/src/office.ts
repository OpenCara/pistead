import { inflateRawSync } from 'node:zlib';

/**
 * The text of a Word document (.docx): its paragraphs, tabs and line breaks from word/document.xml, without
 * formatting. Null for anything that isn't a readable .docx. Bounded: the archive is read from memory, and the
 * document part inflates to at most 16 MiB.
 */
export function docxText(bytes: Uint8Array): string | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const part = zipEntry(data, 'word/document.xml');
  if (!part) return null;
  const xml = part.toString('utf8');
  const body = xml.slice(Math.max(0, xml.indexOf('<w:body')));
  let text = '';
  // Runs of text, tabs and breaks in document order; a paragraph's end is a line's end.
  for (const match of body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<\/w:p>/g)) {
    if (match[1] !== undefined) text += entities(match[1]);
    else if (match[0] === '<w:tab/>') text += '\t';
    else text += '\n';
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function entities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (_all, name: string) => {
    if (name === 'amp') return '&'; if (name === 'lt') return '<'; if (name === 'gt') return '>';
    if (name === 'quot') return '"'; if (name === 'apos') return "'";
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** One entry of a ZIP archive, found through its central directory; null if absent, encrypted or unreadable. */
function zipEntry(data: Buffer, name: string): Buffer | null {
  // The end of central directory record is in the last 64 KiB plus its own 22 bytes.
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at--) {
    if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return null;
  const entries = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  for (let index = 0; index < entries && at + 46 <= data.length; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const entryName = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (flags & 1 || local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + compressed > data.length) return null;
    const raw = data.subarray(start, start + compressed);
    try {
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: 16 * 1024 * 1024 });
    } catch { return null; }
    return null;
  }
  return null;
}

/** File names and types read as text as they are. */
export const textFile = { types: /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql|toml|x-toml|csv)\b)/, names: /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|xml|html?|css|js|ts|py|sh|sql|ini|cfg|log)$/i };
export const docxFile = { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: /\.docx$/i };
