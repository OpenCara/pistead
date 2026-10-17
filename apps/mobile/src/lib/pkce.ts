import * as Crypto from "expo-crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url of random bytes; React Native has no Buffer, and these are the only bytes the app encodes. */
function randomToken(byteCount: number): string {
  const bytes = Crypto.getRandomBytes(byteCount);
  let text = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      text += alphabet[(value >> bits) & 63];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) text += alphabet[(value << (6 - bits)) & 63];
  return text;
}

/**
 * A proof key for the native sign-in (RFC 7636, S256): a 43-character verifier the app keeps, its challenge for the
 * start URL, and a state value the callback must echo.
 */
export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomToken(32);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
  const challenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge, state: randomToken(24) };
}
