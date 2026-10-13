import { Buffer } from "node:buffer";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";

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
 * Decoding takes width × height × 4 bytes of WebAssembly memory in this process, which the header decides, not the
 * file size: a small file can declare gigapixels. 40 megapixels (160 MiB) admits 8K screens and common camera photos.
 */
const MAX_IMAGE_PIXELS = 40_000_000;

export const IMAGE_ERROR = "The image cannot be decoded or fitted to the model's image limits";

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

let processor: Promise<ImageProcessor> | undefined;

/**
 * One processor for the process, made on the first image. Importing it loads only Photon's JavaScript bindings: its
 * WebAssembly loads in the worker the processor starts on the first `prepare`, which exits after 30 s idle.
 */
function imageProcessor(): Promise<ImageProcessor> {
  processor ??= createNodePhotonImages().catch((error: unknown) => { processor = undefined; throw error; });
  return processor;
}

/** `bytes` fitted to `IMAGE_LIMITS` with the size the model sees, or `undefined` when it cannot be decoded or fitted. */
export async function prepareImage(bytes: Uint8Array, mimeType: string): Promise<ModelImage | undefined> {
  const declared = imageSize(bytes, mimeType);
  if (!declared || declared.width * declared.height > MAX_IMAGE_PIXELS) return undefined;
  // A plain view of the same memory: the processor transfers a `slice()` to its worker, and a Node Buffer's `slice()`
  // shares its (untransferable) pool instead of copying.
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prepared = await (await imageProcessor()).prepare(view, mimeType, IMAGE_LIMITS);
  if (!prepared) return undefined;
  // Read from the result: a passed-through image keeps its size, an EXIF-rotated one swaps it.
  const size = imageSize(Buffer.from(prepared.data, "base64"), prepared.mimeType);
  return size && { data: prepared.data, mimeType: prepared.mimeType, ...size };
}

/**
 * The width and height an image declares in its header (PNG IHDR, GIF screen, WebP VP8/VP8L/VP8X, JPEG SOF), or
 * `undefined` when it has none.
 */
function imageSize(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : undefined;
  switch (mimeType) {
    case "image/png": return bytes.length >= 24 ? size(view.getUint32(16), view.getUint32(20)) : undefined;
    case "image/gif": return bytes.length >= 10 ? size(view.getUint16(6, true), view.getUint16(8, true)) : undefined;
    case "image/webp": {
      if (bytes.length < 30) return undefined;
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + 12, 4).toString("latin1");
      if (chunk === "VP8 ") return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      const uint24 = (offset: number) => view.getUint16(offset, true) + (view.getUint8(offset + 2) << 16);
      return chunk === "VP8X" ? size(uint24(24) + 1, uint24(27) + 1) : undefined;
    }
    case "image/jpeg":
      for (let offset = 2; offset + 9 <= bytes.length;) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) { offset++; continue; }
        // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return size(view.getUint16(offset + 7), view.getUint16(offset + 5));
        }
        offset += 2 + view.getUint16(offset + 2);
      }
      return undefined;
    default: return undefined;
  }
}
