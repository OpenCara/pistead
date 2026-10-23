import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { chatImageLimits, type ChatImage, type ChatImageType } from "../../../packages/shared/src/chat-images";
import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import { Button } from "./ui";
import "./attachments.css";

/** An image pasted into a composer, until its message is sent. */
export interface PastedImage {
  id: string;
  file: Blob;
}

/** The longest edge, in pixels, the model gets of an image (as `IMAGE_LIMITS` on the host): larger images only cost bytes. */
const MAX_EDGE = 1568;
/** Larger pastes are refused before they are decoded. */
const MAX_PASTE_BYTES = 32 * 1024 * 1024;

/**
 * Why messages to `host` can't carry images: its connector predates them. A host this reader can't see is left to the
 * server, which checks it on every message.
 */
export function imagesUnavailable(host: ConnectorInfo | undefined): string | undefined {
  return host && !host.capabilities.chatImages ? "Update the host's connector (npx pistead@latest connect) to send images." : undefined;
}

/** The images a paste carries, from the clipboard's items where the browser lists them there, else its files. */
function clipboardImages(data: DataTransfer): File[] {
  const items = Array.from(data.items ?? []).filter(item => item.kind === "file" && item.type.startsWith("image/"))
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
  return items.length ? items : Array.from(data.files ?? []).filter(file => file.type.startsWith("image/"));
}

/**
 * A composer's pasted images. `unavailable` says why this composer can't send images right now (its host's connector
 * predates them, say); a paste then only shows that.
 */
export function useAttachments(unavailable?: string, initial?: () => Blob[]) {
  const [images, setImages] = useState<PastedImage[]>(() => (initial?.() ?? []).map(file => ({ id: crypto.randomUUID(), file })));
  const [notice, setNotice] = useState("");
  const current = useRef(images);
  current.current = images;
  function add(files: readonly Blob[]) {
    if (unavailable) { setNotice(unavailable); return; }
    const fitting = files.filter(file => file.size <= MAX_PASTE_BYTES);
    const added = fitting.map(file => ({ id: crypto.randomUUID(), file }));
    setNotice(fitting.length < files.length ? "An image larger than 32 MiB can't be attached."
      : current.current.length + added.length > chatImageLimits.count ? `A message can carry at most ${chatImageLimits.count} images.` : "");
    if (added.length) setImages(previous => [...previous, ...added].slice(0, chatImageLimits.count));
  }
  /**
   * Attaches the images of a paste, if any. The paste's text, when it has some (a spreadsheet's cells, a copied file's
   * name), still goes into the text box: nothing pasted is lost.
   */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardImages(event.clipboardData);
    if (!files.length) return;
    if (!unavailable && !event.clipboardData.types.includes("text/plain")) event.preventDefault();
    add(files);
  }
  function remove(id: string) {
    setImages(previous => previous.filter(image => image.id !== id));
    setNotice("");
  }
  /** Removes images once their message was sent, keeping any pasted while it was being sent. */
  function sent(images: readonly PastedImage[]) {
    const ids = new Set(images.map(image => image.id));
    setImages(previous => previous.filter(image => !ids.has(image.id)));
  }
  return { images, notice, paste, remove, sent };
}
export type Attachments = ReturnType<typeof useAttachments>;

/** Thumbnails of a composer's images, each with a button to remove it. */
export function AttachmentStrip({ attachments, disabled }: { attachments: Attachments; disabled?: boolean }) {
  if (!attachments.images.length) return null;
  return <ul className="composer-attachments" aria-label="Attached images">
    {attachments.images.map((image, index) => <li key={image.id} className="composer-attachment">
      <Thumbnail file={image.file} label={`Image ${index + 1}`} />
      <Button variant="secondary" size="xs" icon="x" className="composer-attachment-remove" aria-label={`Remove image ${index + 1}`} title="Remove image"
        disabled={disabled} onClick={() => attachments.remove(image.id)} />
    </li>)}
  </ul>;
}

/** The object URL lives as long as the thumbnail shows it. */
function Thumbnail({ file, label }: { file: Blob; label: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url ? <img src={url} alt={label} /> : null;
}

/** Images a new session's first message couldn't send, kept in memory for that session's composer (as its text is). */
const handedOver = new Map<string, Blob[]>();
export function handOverImages(sessionId: string, images: readonly PastedImage[]): void {
  if (images.length) handedOver.set(sessionId, images.map(image => image.file));
}
/** Read when the composer starts; `forgetHandedOverImages` once it has (the start may run twice in development). */
export function handedOverImages(sessionId: string): Blob[] {
  return handedOver.get(sessionId) ?? [];
}
export function forgetHandedOverImages(sessionId: string): void {
  handedOver.delete(sessionId);
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * A message's images as it sends them: each within the edge the model takes and its share of the message's budget. An
 * image already within both goes as it is, so a screenshot stays exact; any other is drawn again, smaller or compressed
 * until it fits. The host prepares every image again either way.
 */
export async function encodeImages(images: readonly PastedImage[]): Promise<ChatImage[]> {
  const budget = Math.min(chatImageLimits.imageBase64, Math.floor(chatImageLimits.totalBase64 / Math.max(1, images.length)));
  const encoded: ChatImage[] = [];
  for (const image of images) encoded.push(await encodeImage(image.file, budget));
  return encoded;
}

async function encodeImage(file: Blob, budget: number): Promise<ChatImage> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("A pasted image can't be read. Copy it again, or paste a PNG or JPEG."); }
  try {
    const type = await signature(file);
    // Animated WebP isn't something the host reads, so a WebP is always drawn again as a still.
    if (type && type !== "image/webp" && bitmap.width <= MAX_EDGE && bitmap.height <= MAX_EDGE && base64Length(file.size) <= budget) {
      return { mimeType: type, data: await base64(file) };
    }
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      // A PNG (a screenshot, usually) stays lossless if it fits; JPEG otherwise, a little more compressed each time.
      const attempts: { mimeType: ChatImageType; quality?: number }[] = [...(type === "image/png" ? [{ mimeType: "image/png" as const }] : []),
        { mimeType: "image/jpeg", quality: 0.85 }, { mimeType: "image/jpeg", quality: 0.7 }, { mimeType: "image/jpeg", quality: 0.55 }];
      for (const { mimeType, quality } of attempts) {
        const blob = await draw(bitmap, width, height, mimeType, quality);
        if (blob && base64Length(blob.size) <= budget) return { mimeType, data: await base64(blob) };
      }
    }
    throw new Error("A pasted image is too large to send, even scaled down.");
  } finally { bitmap.close(); }
}

function draw(bitmap: ImageBitmap, width: number, height: number, mimeType: ChatImageType, quality?: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  // JPEG has no transparency: transparent pixels become white, as on a page, rather than black.
  if (mimeType === "image/jpeg") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
}

/** The image type a file's first bytes say it is, of those a message can carry. */
async function signature(file: Blob): Promise<ChatImageType | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("A pasted image can't be read."));
    reader.readAsDataURL(blob);
  });
}
