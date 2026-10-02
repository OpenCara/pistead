import type { Env } from './types.js';
import { fail } from './http.js';

const encoder = new TextEncoder();
const MAX_TOKEN_BYTES = 16_384;

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding.');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (char) => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Invalid encoding.');
  return bytes;
}

async function vaultKey(env: Env): Promise<CryptoKey> {
  try {
    const value = env.VAULT_KEY;
    if (typeof value !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{43}=?|[A-Za-z0-9_-]{43}=?)$/.test(value)) {
      throw new Error('Invalid key.');
    }
    const bytes = decode(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    if (bytes.byteLength !== 32) throw new Error('Invalid key.');
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    fail(503, 'vault_unavailable', 'Token storage is not configured securely.');
  }
}

// Check configuration before initiating OAuth or exchanging a one-use authorization code.
export async function assertVaultConfigured(env: Env): Promise<void> {
  await vaultKey(env);
}

function associatedData(userId: string): Uint8Array<ArrayBuffer> {
  if (!userId || userId.length > 256 || userId.includes('\0')) throw new Error('Invalid identity.');
  return encoder.encode(userId);
}

export async function encryptToken(env: Env, userId: string, token: string): Promise<string> {
  const key = await vaultKey(env);
  try {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_BYTES || token.includes('\0')) {
      throw new Error('Invalid token.');
    }
    const plaintext = encoder.encode(token);
    if (plaintext.byteLength > MAX_TOKEN_BYTES) throw new Error('Invalid token.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData(userId), tagLength: 128 }, key, plaintext,
    );
    return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  } catch {
    fail(500, 'vault_error', 'Unable to store connected account credentials.');
  }
}

export async function decryptToken(env: Env, userId: string, ciphertext: string): Promise<string> {
  const key = await vaultKey(env);
  try {
    if (typeof ciphertext !== 'string' || ciphertext.length > 22_000) throw new Error('Invalid ciphertext.');
    const parts = ciphertext.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid ciphertext.');
    const iv = decode(parts[1]!);
    const encrypted = decode(parts[2]!);
    if (iv.byteLength !== 12 || encrypted.byteLength < 17 || encrypted.byteLength > MAX_TOKEN_BYTES + 16) {
      throw new Error('Invalid ciphertext.');
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData(userId), tagLength: 128 }, key, encrypted,
    );
    const token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (!token || token.includes('\0')) throw new Error('Invalid token.');
    return token;
  } catch {
    fail(500, 'vault_error', 'Unable to read connected account credentials.');
  }
}
