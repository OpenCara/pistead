import { sha256 } from "./crypto.js";

/** Image types a message can carry: those the host's image preparation reads (see apps/runner/src/images.ts). */
export const chatImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ChatImageType = (typeof chatImageTypes)[number];

/** An image pasted into a message: its bytes, base64. The host prepares it for the model again, whatever the client did. */
export interface ChatImage {
  mimeType: ChatImageType;
  data: string;
}

/**
 * How many images one message carries, and how large they may be as base64. A message reaches its host in a single
 * request of at most `connectorLimits.requestBytes` (1 MiB) of JSON, so its images together leave about 300 KiB of that
 * for the text and the request's other fields. One image is held to what the model gets of an image anyway
 * (`IMAGE_LIMITS` on the host).
 */
export const chatImageLimits = { count: 4, imageBase64: 512 * 1024, totalBase64: 720 * 1024 } as const;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A message's images in the shape and within the bounds every host takes, or why not, in words fit for the sender.
 * An empty list is the same as none.
 */
export function parseChatImages(value: unknown): { images: ChatImage[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "Invalid images." };
  if (value.length > chatImageLimits.count) return { error: `A message can carry at most ${chatImageLimits.count} images.` };
  const images: ChatImage[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Invalid image." };
    const image = item as Record<string, unknown>;
    if (Object.keys(image).some(key => key !== "mimeType" && key !== "data")) return { error: "Invalid image." };
    if (!chatImageTypes.includes(image.mimeType as never)) return { error: "Images must be PNG, JPEG, GIF or WebP." };
    if (typeof image.data !== "string" || image.data.length % 4 !== 0 || !BASE64.test(image.data)) return { error: "Invalid image." };
    if (image.data.length > chatImageLimits.imageBase64) return { error: `Each image can be at most ${chatImageLimits.imageBase64 / 1024} KiB as base64.` };
    total += image.data.length;
    if (total > chatImageLimits.totalBase64) return { error: `A message's images can be at most ${chatImageLimits.totalBase64 / 1024} KiB together as base64.` };
    images.push({ mimeType: image.mimeType as ChatImageType, data: image.data });
  }
  return { images };
}

/**
 * What a message's idempotency key binds: its text alone, exactly as before messages carried images, or its text and
 * its images in order.
 */
export function messageHash(content: string, images?: readonly ChatImage[]): Promise<string> {
  return sha256(images?.length ? JSON.stringify([content, images.map(image => [image.mimeType, image.data])]) : content);
}
