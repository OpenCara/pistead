import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext, Env } from './types';

export function fail(status: ContentfulStatusCode, code: string, message: string): never {
  throw new HTTPException(status, { res: Response.json({ error: message, code }, { status }) });
}
export async function jsonObject(c: AppContext, maxBytes = 65536): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type')?.split(';')[0]?.trim();
  if (type !== 'application/json') fail(415, 'unsupported_media_type', 'Expected application/json.');
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail(413, 'body_too_large', 'Request body is too large.');
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, 'invalid_json', 'Expected a JSON object.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      fail(413, 'body_too_large', 'Request body is too large.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'invalid_json', 'Expected valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 200, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) {
    fail(400, 'invalid_input', `Invalid ${field}.`);
  }
  return value;
}
export function identifier(value: unknown, field = 'id'): string {
  const result = text(value, field, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail(400, 'invalid_input', `Invalid ${field}.`);
  return result;
}
export function userIdentifier(value: unknown, field = 'userId'): string {
  const result = text(value, field, 133);
  if (!/^github:[1-9][0-9]*$/.test(result) && !/^test:[A-Za-z0-9_-]{1,128}$/.test(result)) {
    fail(400, 'invalid_input', `Invalid ${field}.`);
  }
  return result;
}
export function now(): string { return new Date().toISOString(); }
export function id(): string { return crypto.randomUUID(); }
export function testMode(env: Env): boolean {
  const expiry = Date.parse(env.TEST_AUTH_EXPIRES_AT ?? '');
  return env.TEST_AUTH_ENABLED === 'true' &&
    !!env.TEST_AUTH_SECRET && env.TEST_AUTH_SECRET.length >= 32 && Number.isFinite(expiry) && expiry > Date.now();
}
export function appOrigin(env: Env): string {
  let url: URL;
  try { url = new URL(env.APP_ORIGIN); } catch { fail(503, 'configuration_error', 'Application origin is not configured.'); }
  if (url.origin !== env.APP_ORIGIN || url.username || url.password ||
      (url.protocol !== 'https:' && !(testMode(env) && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    fail(503, 'configuration_error', 'Application origin is not configured securely.');
  }
  return url.origin;
}
export function requireOrigin(c: AppContext): void {
  const origin = c.req.header('origin');
  if (origin && origin !== appOrigin(c.env)) fail(403, 'invalid_origin', 'Request origin is not allowed.');
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') fail(403, 'invalid_origin', 'Cross-site requests are not allowed.');
}
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
