import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";
import { credentialedApiHosts } from "../../../packages/shared/src/network.js";

/*
 * The certificate authority behind the egress proxy's credentialed APIs (api-access.ts). Sandboxed clients trust it,
 * through the session's CA bundle (trust-store.ts), so the proxy can answer for those few hosts itself and add the
 * credential there, outside the sandbox. Its key is made in memory when the connector starts and never written
 * anywhere; a restart makes a new one, which every session gets when it next opens. Its certificate is name-constrained
 * to `credentialedApiHosts`, so even its key couldn't vouch for any other host to clients that check (OpenSSL, Go,
 * Node, Python).
 *
 * X.509 is built here as DER, from Node's own keys and signatures: just the few fields these certificates need.
 */

const CA_LIFETIME_MS = 10 * 365 * 24 * 3600_000;
const LEAF_LIFETIME_MS = 7 * 24 * 3600_000;
/** A leaf certificate is replaced once less than this of its lifetime is left. */
const LEAF_RENEW_MS = 24 * 3600_000;
/** Clocks of the sandbox's clients may be a little behind the host's. */
const BACKDATE_MS = 3600_000;

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let value = size; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const octets = (value: Buffer) => tlv(0x04, value);
const bits = (value: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), value);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));
const TRUE = Buffer.from([0x01, 0x01, 0xff]);
/** `[n]` EXPLICIT, constructed. */
const explicit = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts);

function oid(value: string): Buffer {
  const [first, second, ...rest] = value.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) chunk.unshift(0x80 | (value & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
/** A positive INTEGER from unsigned big-endian bytes. */
function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}
/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return at.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}
function name(commonName: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.10"), utf8("Pistead"))), set(sequence(oid("2.5.4.3"), utf8(commonName))));
}
function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [TRUE] : []), octets(value));
}
/** A `dNSName` GeneralName: [2] IMPLICIT IA5String. */
const dnsName = (host: string) => tlv(0x82, Buffer.from(host, "ascii"));

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function subjectPublicKeyInfo(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" });
}
/** RFC 5280's method 1: the SHA-1 of the subjectPublicKey bits; for P-256, the uncompressed point that ends the SPKI. */
function keyIdentifier(spki: Buffer): Buffer {
  return createHash("sha1").update(spki.subarray(spki.length - 65)).digest();
}

interface Issued { pem: string; der: Buffer }

function certificate(input: { serial: Buffer; issuer: string; subject: string; notBefore: Date; notAfter: Date; publicKey: KeyObject;
  extensions: Buffer[]; signer: KeyObject }): Issued {
  const tbs = sequence(
    explicit(0, tlv(0x02, Buffer.from([2]))),
    integer(input.serial),
    ECDSA_SHA256,
    name(input.issuer),
    sequence(time(input.notBefore), time(input.notAfter)),
    name(input.subject),
    subjectPublicKeyInfo(input.publicKey),
    explicit(3, sequence(...input.extensions)),
  );
  // Node signs EC keys in DER (ECDSA-Sig-Value), as X.509 carries it.
  const der = sequence(tbs, ECDSA_SHA256, bits(sign("sha256", tbs, input.signer)));
  const base64 = der.toString("base64").replace(/.{1,64}/g, line => `${line}\n`);
  return { der, pem: `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n` };
}

/** A serial number: 16 random bytes with the top bit clear, so it stays positive and within RFC 5280's 20 octets. */
function serial(): Buffer {
  const value = randomBytes(16);
  value[0] = (value[0]! & 0x7f) | 0x01;
  return value;
}

/** One certificate authority, able to vouch only for `hosts`. */
export class InterceptionAuthority {
  readonly certificate: string;
  readonly hosts: readonly string[];
  readonly #key: KeyObject;
  readonly #keyId: Buffer;
  readonly #subject: string;
  readonly #leaves = new Map<string, { context: SecureContext; renewAt: number; certificate: string }>();

  constructor(hosts: readonly string[] = credentialedApiHosts, now = new Date()) {
    if (!hosts.length) throw new Error("A credentialed API host is required");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.#key = privateKey;
    this.hosts = [...hosts];
    this.#keyId = keyIdentifier(subjectPublicKeyInfo(publicKey));
    this.#subject = `Pistead egress proxy ${this.#keyId.subarray(0, 4).toString("hex")}`;
    const issued = certificate({
      serial: serial(), issuer: this.#subject, subject: this.#subject, publicKey, signer: privateKey,
      notBefore: new Date(now.getTime() - BACKDATE_MS), notAfter: new Date(now.getTime() + CA_LIFETIME_MS),
      extensions: [
        extension("2.5.29.19", true, sequence(TRUE)), // basicConstraints: CA, no path length needed
        extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)), // keyUsage: keyCertSign, cRLSign
        extension("2.5.29.14", false, octets(this.#keyId)), // subjectKeyIdentifier
        // nameConstraints: permittedSubtrees ([0]) of exactly these names.
        extension("2.5.29.30", true, sequence(tlv(0xa0, ...this.hosts.map(host => sequence(dnsName(host)))))),
      ],
    });
    this.certificate = issued.pem;
  }

  /** A TLS context answering as `host`, one of `hosts`, with a certificate from this authority (reused for a week). */
  context(host: string, now = Date.now()): SecureContext {
    if (!this.hosts.includes(host)) throw new Error(`The egress proxy doesn't answer for ${host}`);
    const cached = this.#leaves.get(host);
    if (cached && cached.renewAt > now) return cached.context;
    const leaf = this.issue(host, new Date(now));
    const context = createSecureContext({ key: leaf.key, cert: `${leaf.certificate}${this.certificate}` });
    this.#leaves.set(host, { context, certificate: leaf.certificate, renewAt: now + LEAF_LIFETIME_MS - LEAF_RENEW_MS });
    return context;
  }

  /** A server certificate for `host` and its key (PEM). */
  issue(host: string, now = new Date()): { certificate: string; key: string } {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const leaf = certificate({
      serial: serial(), issuer: this.#subject, subject: host, publicKey, signer: this.#key,
      notBefore: new Date(now.getTime() - BACKDATE_MS), notAfter: new Date(now.getTime() + LEAF_LIFETIME_MS),
      extensions: [
        extension("2.5.29.19", true, sequence()), // basicConstraints: not a CA
        extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)), // keyUsage: digitalSignature
        extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
        extension("2.5.29.17", false, sequence(dnsName(host))), // subjectAltName
        extension("2.5.29.14", false, octets(keyIdentifier(subjectPublicKeyInfo(publicKey)))),
        extension("2.5.29.35", false, sequence(tlv(0x80, this.#keyId))), // authorityKeyIdentifier: [0] keyIdentifier
      ],
    });
    return { certificate: leaf.pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  }
}

let shared: InterceptionAuthority | undefined;
/** This connector's authority, made on first use; sessions' CA bundles include its certificate. */
export function interceptionAuthority(): InterceptionAuthority {
  shared ??= new InterceptionAuthority();
  return shared;
}
