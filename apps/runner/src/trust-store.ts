import { getCACertificates, rootCertificates } from "node:tls";

/**
 * Where shell commands find the certificates the host trusts. The sandbox has no `/etc`, so HTTPS clients that read
 * the system store (OpenSSL, GnuTLS, Go, Python) found none, and every tunnel the egress proxy allowed failed to verify.
 * This is the path most of them look at by default; `CA_BUNDLE_VARIABLES` point the others at it.
 */
export const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * Variables HTTPS clients read their trust store from, all pointing at `CA_BUNDLE` (after sandbox-runtime's
 * `CA_TRUST_VARS`). `NODE_EXTRA_CA_CERTS` adds to Node's own store rather than replacing it, so Node keeps working as
 * before and also trusts the host's additions, such as a company's root.
 */
export const CA_BUNDLE_VARIABLES = ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"] as const;

type CertificateSource = (type: "system" | "bundled" | "extra") => string[];

/**
 * The certificates the host trusts, as one PEM bundle: its system store, or Node's bundled Mozilla store where the host
 * has none, plus `NODE_EXTRA_CA_CERTS` of the connector. Read on the host, outside the sandbox, and only certificates:
 * no other file of the host's `/etc` becomes visible.
 */
export function trustedCertificates(source: CertificateSource = getCACertificates, platform: NodeJS.Platform = process.platform): string {
  const read = (type: "system" | "bundled" | "extra"): string[] => {
    try {
      return source(type).filter(certificate => typeof certificate === "string" && certificate.includes("-----BEGIN CERTIFICATE-----"));
    } catch {
      return [];
    }
  };
  const system = read("system");
  // macOS's "system" store is only the keychain's certificates with trust settings (no system roots), so the bundled
  // Mozilla store comes first there.
  const base = platform === "darwin" ? [...read("bundled"), ...system] : system.length ? system : read("bundled");
  const certificates = [...new Set([...(base.length ? base : rootCertificates), ...read("extra")].map(certificate => certificate.trim()))];
  return `${certificates.join("\n")}\n`;
}
