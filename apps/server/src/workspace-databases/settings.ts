import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { workspaceDatabaseTlsModes, type WorkspaceDatabaseTls } from '../../../../packages/shared/src/types.js';
import { fail } from '../http.js';
import type { WorkspaceDatabaseTarget } from './types.js';

/** Room for a CA bundle (a cloud provider's regional bundle is well within it). */
export const maxCaCertificateLength = 262_144;
const fields = ['host', 'port', 'database', 'user', 'password', 'tls', 'caCertificate'];
const hostLabel = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const certificateBlock = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

function invalid(message: string): never {
  return fail(400, 'invalid_workspace_database', message);
}

/** A host name or IP address, lowercase, IPv6 without brackets. Whether it may be reached is decided once it is resolved. */
export function databaseHost(value: unknown): string {
  if (typeof value !== 'string') invalid('Enter the database host name or IP address.');
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes('%')) invalid('Enter the database host name or IP address.');
  if (isIP(host)) return host;
  if (!host || host.length > 253 || !host.split('.').every(label => hostLabel.test(label))) {
    invalid('Enter only the database host name or IP address, without a scheme, port or path.');
  }
  return host;
}

/** A database or role name: at most 63 bytes, as Postgres keeps them, without control characters. */
function name(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || Buffer.byteLength(text) > 63 || /[\x00-\x1f\x7f]/.test(text)) invalid(`Enter the ${label} (at most 63 bytes).`);
  return text;
}

/** Keeps only the PEM certificate blocks of a pasted CA bundle; each must parse. */
function caCertificates(value: unknown): string {
  if (typeof value !== 'string' || value.length > maxCaCertificateLength) invalid('Paste the CA certificate in PEM format, at most 256 KiB.');
  const blocks = value.match(certificateBlock) ?? [];
  if (!blocks.length) invalid('Paste the CA certificate in PEM format (-----BEGIN CERTIFICATE-----).');
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    invalid('The CA certificate could not be read.');
  }
  return `${blocks.join('\n')}\n`;
}

/**
 * Validated connection settings. The owner gives the host, port, database, user and password separately: a connection
 * string would also accept options that read files on the server (sslrootcert, sslkey) or name a unix socket.
 * The password is required on every save, so new settings never send the stored one to a different host.
 */
export function databaseSettings(input: Record<string, unknown>): WorkspaceDatabaseTarget {
  if (Object.keys(input).some(key => !fields.includes(key))) invalid('Only host, port, database, user, password, tls and caCertificate may be set.');
  const host = databaseHost(input.host);
  const port = input.port ?? 5432;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) invalid('Enter a port between 1 and 65535.');
  const database = name(input.database, 'database name');
  const user = name(input.user, 'user name');
  const password = input.password;
  if (typeof password !== 'string' || !password || password.length > 1024 || password.includes('\0')) {
    invalid('Enter the database password; it is needed every time the connection is saved.');
  }
  const tls = input.tls ?? 'verify-full';
  if (!(workspaceDatabaseTlsModes as readonly unknown[]).includes(tls)) invalid('Choose verify-full, require or disable for TLS.');
  let caCertificate: string | null = null;
  if (input.caCertificate !== undefined && input.caCertificate !== null && input.caCertificate !== '') {
    if (tls !== 'verify-full') invalid('A CA certificate applies only when the server certificate is verified (verify-full).');
    caCertificate = caCertificates(input.caCertificate);
  }
  return { host, port, database, user, password, tls: tls as WorkspaceDatabaseTls, caCertificate };
}
