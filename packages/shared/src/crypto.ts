const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (char) => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("Signing secret must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function signToken<T extends object>(payload: T, secret: string): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const message = `${header}.${body}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(message)));
  return `${message}.${base64url(signature)}`;
}

/** Verify signature and mandatory expiry; callers still validate audience, action and subject. */
export async function verifyToken<T>(token: string, secret: string): Promise<T | null> {
  try {
    if (token.length > 24_000 || secret.length < 32) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(decoder.decode(decodeBase64url(headerPart)));
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), decodeBase64url(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`));
    if (!valid) return null;
    const payload: unknown = JSON.parse(decoder.decode(decodeBase64url(payloadPart)));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const claims = payload as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return null;
    if (claims.iat !== undefined && (typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > now + 5)) return null;
    return payload as T;
  } catch {
    return null;
  }
}
