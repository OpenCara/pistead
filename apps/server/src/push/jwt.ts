import { sha256 } from '../../../../packages/shared/src/crypto.js';

const encoder = new TextEncoder();
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const maxPemLength = 16_384;
const keyError = 'The private key must be an unencrypted RSA key (PEM) of at least 2048 bits.';
// AlgorithmIdentifier for rsaEncryption: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }.
const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

export interface RsaPublicJwk { kty: 'RSA'; n: string; e: string; alg: 'RS256'; use: 'sig'; kid: string }

export function base64urlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid encoding.');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo: SEQUENCE { INTEGER 0, rsaEncryption, OCTET STRING pkcs1 }. */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const octets = [0x04, ...derLength(pkcs1.byteLength)];
  const bodyLength = 3 + rsaAlgorithm.length + octets.length + pkcs1.byteLength;
  const head = [0x30, ...derLength(bodyLength), 0x02, 0x01, 0x00, ...rsaAlgorithm, ...octets];
  const der = new Uint8Array(head.length + pkcs1.byteLength);
  der.set(head);
  der.set(pkcs1, head.length);
  return der;
}

function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  if (typeof pem !== 'string' || pem.length > maxPemLength) throw new Error(keyError);
  // Secrets pasted through dashboards often carry escaped newlines.
  const match = /^\s*-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END \1PRIVATE KEY-----\s*$/
    .exec(pem.replace(/\\n/g, '\n'));
  if (!match) throw new Error(keyError);
  let der: Uint8Array<ArrayBuffer>;
  try { der = Uint8Array.from(atob(match[2]!.replace(/\s+/g, '')), char => char.charCodeAt(0)); }
  catch { throw new Error(keyError); }
  return match[1] ? wrapPkcs1(der) : der;
}

async function importKey(pem: string, extractable: boolean): Promise<CryptoKey> {
  const der = pkcs8(pem);
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey('pkcs8', der, algorithm, extractable, ['sign']); }
  catch { throw new Error(keyError); }
  const { modulusLength } = key.algorithm as RsaHashedKeyAlgorithm;
  if (!Number.isSafeInteger(modulusLength) || modulusLength < 2048) throw new Error(keyError);
  return key;
}

/** Imports a PKCS#8 or PKCS#1 RSA private key (≥ 2048 bits) for RS256 signing; throws a fixed error otherwise. */
export function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  return importKey(pem, false);
}

export async function signJwt(key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const message = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, encoder.encode(message)));
  return `${message}.${base64urlEncode(signature)}`;
}

/** The public half of `pem` as an RS256 JWK; `kid` is the RFC 7638 thumbprint. */
export async function publicJwk(pem: string): Promise<RsaPublicJwk> {
  const exported = await crypto.subtle.exportKey('jwk', await importKey(pem, true)) as JsonWebKey;
  if (typeof exported.n !== 'string' || typeof exported.e !== 'string') throw new Error(keyError);
  const kid = await sha256(JSON.stringify({ e: exported.e, kty: 'RSA', n: exported.n }));
  return { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid };
}
