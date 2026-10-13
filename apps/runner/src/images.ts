import { Buffer } from "node:buffer";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";

/**
 * Largest image file `read_file` reads; text keeps `MAX_FILE_BYTES`. It covers full-resolution camera photos and
 * high-DPI screenshots. The file only passes through memory on its way to the processor; the transcript keeps the
 * prepared image, bounded by `IMAGE_LIMITS`.
 */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * What the model gets of an image. Images stay base64 in the session's SQLite transcript, and every backup carries
 * that database base64 again, under the 24 MiB restore bound (`pullBackup` in server.ts): at Pi's 4.5 MiB default
 * about four images would exhaust a session's backup, at 512 KiB a few dozen fit. 1568 pixels is the longest edge
 * Anthropic takes without scaling the image down itself, so larger images only cost bytes; at that size a JPEG within
 * 512 KiB of base64 keeps screenshot text legible.
 */
export const IMAGE_LIMITS: ImageLimits = { maxWidth: 1568, maxHeight: 1568, maxBytes: 512 * 1024 };

/**
 * Decoding runs in this process, in a worker's WebAssembly memory that never shrinks while the worker lives: the
 * pixels at their source depth plus Photon's two RGBA copies. The header decides that size, not the file, so a few
 * hundred KB can declare tens of megapixels. 512 MiB admits 40-megapixel 8-bit photos and 8K screenshots.
 */
const MAX_DECODE_BYTES = 512 * 1024 * 1024;
/** How long one image may take to prepare; a worker that takes longer is replaced, since its decode cannot be stopped. */
const PREPARE_TIMEOUT_MS = 30_000;
/** Reads that may wait their turn: the whole process prepares one image at a time. */
const MAX_WAITING = 8;

export const IMAGE_ERROR = "The image cannot be decoded or fitted to the model's image limits";
export const IMAGE_BUSY = "Too many images are being prepared at once; read this file again shortly";

/**
 * File signatures of the formats every provider takes inline: byte strings at offsets that must all match. The Linux
 * sandbox helper mirrors this table.
 */
const IMAGE_SIGNATURES: readonly (readonly [string, readonly (readonly [number, Buffer])[]])[] = [
  ["image/png", [[0, Buffer.from("89504e470d0a1a0a", "hex")]]],
  ["image/jpeg", [[0, Buffer.from("ffd8ff", "hex")]]],
  ["image/gif", [[0, Buffer.from("GIF87a")]]],
  ["image/gif", [[0, Buffer.from("GIF89a")]]],
  ["image/webp", [[0, Buffer.from("RIFF")], [8, Buffer.from("WEBP")]]],
];

/** The image type `bytes` starts with, by signature: the name of a file says nothing about its content. */
export function imageType(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return IMAGE_SIGNATURES.find(([, parts]) => parts.every(([offset, expected]) => data.subarray(offset, offset + expected.length).equals(expected)))?.[0];
}

/** A confined file as `read_file` returns it: an image as its bytes, anything else as text. */
export type FileContent = { readonly text: string } | { readonly image: Uint8Array; readonly mimeType: string };

export type ModelImage = { readonly data: string; readonly mimeType: string; readonly width: number; readonly height: number };

/** What an image's header declares: its size, the bytes per pixel it decodes to, and whether it has several frames. */
type ImageHeader = { readonly width: number; readonly height: number; readonly bytesPerPixel: number; readonly animated: boolean };

let processor: Promise<ImageProcessor> | undefined;

/**
 * The process's processor. Importing it loads only Photon's JavaScript bindings: its WebAssembly loads in the worker
 * the processor starts for an image. That worker ends as soon as no image waits (`idleMs: 0`), so the memory a decode
 * leaves behind, which Photon never returns, goes with it; a new worker costs tens of milliseconds.
 */
function imageProcessor(): Promise<ImageProcessor> {
  processor ??= createNodePhotonImages({ idleMs: 0 }).catch((error: unknown) => { processor = undefined; throw error; });
  return processor;
}

let busy = false;
const waiting: (() => void)[] = [];
const BUSY = Symbol("busy");

/** Runs `work` once no other image is being prepared, or gives up when too many reads already wait. */
async function inTurn<T>(work: () => Promise<T>): Promise<T | typeof BUSY> {
  if (busy) {
    if (waiting.length >= MAX_WAITING) return BUSY;
    // The read that finishes hands its turn over directly, so a newcomer cannot slip in between.
    await new Promise<void>(resolve => waiting.push(resolve));
  } else busy = true;
  try { return await work(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  }
}

/**
 * `prepare` with a deadline. Photon cannot free the input of a decode that failed, and a slow decode cannot be
 * stopped, so after either the worker is replaced instead of reused.
 */
async function prepareWithin(bytes: Uint8Array, mimeType: string): Promise<PreparedImage | undefined> {
  const current = imageProcessor();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(resolve, PREPARE_TIMEOUT_MS, undefined); });
  try {
    const prepared = await Promise.race([current.then(images => images.prepare(bytes, mimeType, IMAGE_LIMITS)), timeout]);
    if (!prepared && processor === current) processor = undefined;
    return prepared;
  } catch {
    if (processor === current) processor = undefined;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** `bytes` fitted to `IMAGE_LIMITS` with the size the model sees, or the fixed error for the model when it cannot be. */
export async function prepareImage(bytes: Uint8Array, mimeType: string): Promise<{ readonly image: ModelImage } | { readonly error: string }> {
  const header = imageHeader(bytes, mimeType);
  // Only the first frame is used, and an animated WebP may be decoded frame by frame up front.
  if (!header || (header.animated && mimeType === "image/webp")) return { error: IMAGE_ERROR };
  if (header.width * header.height * (header.bytesPerPixel + 8) > MAX_DECODE_BYTES) return { error: IMAGE_ERROR };
  // A plain view of the same memory: the processor transfers a `slice()` to its worker, and a Node Buffer's `slice()`
  // shares its (untransferable) pool instead of copying.
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Under a type providers do not take inline, Photon re-encodes an animated GIF's first frame as a still image:
  // OpenAI accepts only still GIFs, and a rejected image would fail every later turn of the conversation.
  const prepared = await inTurn(() => prepareWithin(view, header.animated ? "image/x-animated-gif" : mimeType));
  if (prepared === BUSY) return { error: IMAGE_BUSY };
  // Read from the result: a passed-through image keeps its size, an EXIF-rotated one swaps it.
  const size = prepared && imageHeader(Buffer.from(prepared.data, "base64"), prepared.mimeType);
  if (!prepared || !size) return { error: IMAGE_ERROR };
  return { image: { data: prepared.data, mimeType: prepared.mimeType, width: size.width, height: size.height } };
}

/**
 * What an image declares in its header (PNG IHDR, GIF screen and frames, WebP VP8/VP8L/VP8X, JPEG SOF), or
 * `undefined` when it has none.
 */
function imageHeader(bytes: Uint8Array, mimeType: string): ImageHeader | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = (width: number, height: number, bytesPerPixel = 4, animated = false) =>
    width > 0 && height > 0 ? { width, height, bytesPerPixel, animated } : undefined;
  switch (mimeType) {
    // A 16-bit PNG decodes to twice the bytes per pixel.
    case "image/png": return bytes.length >= 26 ? header(view.getUint32(16), view.getUint32(20), bytes[24] === 16 ? 8 : 4) : undefined;
    case "image/gif": return gifHeader(bytes, view);
    case "image/webp": {
      if (bytes.length < 30) return undefined;
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + 12, 4).toString("latin1");
      if (chunk === "VP8 ") return header(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return header((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      const uint24 = (offset: number) => view.getUint16(offset, true) + (view.getUint8(offset + 2) << 16);
      // Bit 0x02 of the VP8X flags marks an animation.
      return chunk === "VP8X" ? header(uint24(24) + 1, uint24(27) + 1, 4, (bytes[20]! & 0x02) !== 0) : undefined;
    }
    case "image/jpeg":
      for (let offset = 2; offset + 9 <= bytes.length;) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) { offset++; continue; }
        // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return header(view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        offset += 2 + view.getUint16(offset + 2);
      }
      return undefined;
    default: return undefined;
  }
}

/**
 * A GIF's size is its logical screen grown to cover every frame, because the decoder allocates a frame at the frame's
 * own size; the blocks are walked to find them.
 */
function gifHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  if (bytes.length < 13) return undefined;
  let width = view.getUint16(6, true);
  let height = view.getUint16(8, true);
  let frames = 0;
  const colourTable = (packed: number) => packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0;
  // After a block's fixed part come data sub-blocks, each prefixed with its length, ending with a zero length.
  const skipSubBlocks = (from: number) => {
    let offset = from;
    while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset]! + 1;
    return offset + 1;
  };
  let offset = 13 + colourTable(bytes[10]!);
  while (offset < bytes.length && bytes[offset] !== 0x3b) {
    if (bytes[offset] === 0x21) {
      offset = skipSubBlocks(offset + 2);
      continue;
    }
    if (bytes[offset] !== 0x2c || offset + 10 > bytes.length) return undefined;
    frames++;
    width = Math.max(width, view.getUint16(offset + 1, true) + view.getUint16(offset + 5, true));
    height = Math.max(height, view.getUint16(offset + 3, true) + view.getUint16(offset + 7, true));
    // The descriptor, its local colour table and the LZW minimum code size, then the image data.
    offset = skipSubBlocks(offset + 10 + colourTable(bytes[offset + 9]!) + 1);
  }
  return frames && width > 0 && height > 0 ? { width, height, bytesPerPixel: 4, animated: frames > 1 } : undefined;
}
