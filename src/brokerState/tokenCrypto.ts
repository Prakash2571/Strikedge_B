/**
 * AES-256-GCM at-rest encryption for broker access tokens.
 *
 * WHAT IS ENCRYPTED, AND WHAT IS NOT
 * Only the broker access token is secret. The metadata that identifies WHICH
 * token this is — the broker name, the credential version, the api key or client
 * id it belongs to, and the login date — is NOT secret, but it is
 * security-relevant: a swapped `broker` or a rewritten `login_date` would let a
 * stale or foreign token be read back as valid. So the metadata is stored in the
 * clear (queryable) AND authenticated as GCM Additional Authenticated Data. If a
 * row's metadata is tampered with, decryption fails its auth-tag check rather than
 * returning a token bound to different metadata than it was sealed with.
 *
 * KEY MATERIAL
 * `BROKER_TOKEN_ENCRYPTION_KEY` must decode to EXACTLY 32 bytes. Base64 (44 chars
 * with padding, or unpadded) and 64-char hex are both accepted; anything else is
 * rejected with a message that says what was wrong, because a silently-truncated
 * or silently-padded key would either weaken the cipher or make previously-sealed
 * tokens permanently unreadable.
 *
 * FRESH IV EVERY WRITE
 * GCM is catastrophically broken if an (key, IV) pair is ever reused, so a fresh
 * 12-byte random IV is generated on every seal and never derived from the
 * plaintext or a counter. The IV is stored beside the ciphertext; it is not
 * secret, only unique.
 *
 * THIS MODULE NEVER LOGS. It returns bytes and throws typed errors. Ciphertext,
 * IV, auth tag and plaintext never reach a log line from here.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** A sealed token: ciphertext plus the public-but-unique IV and the auth tag. */
export interface SealedToken {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * The non-secret, authenticated metadata bound to a sealed token.
 *
 * Order and formatting here define the AAD byte string, so it must be produced
 * identically on seal and open. Changing this shape is a breaking change to every
 * stored row and requires a key/credential rotation.
 */
export interface TokenAad {
  broker: string;
  credentialVersion: number;
  apiKeyOrClientId: string;
  loginDate: string;
}

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

/**
 * Decode and validate the configured key into exactly 32 bytes.
 *
 * Accepts 64-char hex or base64. The hex check is first and exact-length so a
 * 64-char hex string is never mis-read as base64. Throws `TokenCryptoError` with a
 * specific reason on anything else.
 */
export function decodeEncryptionKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new TokenCryptoError(
      "BROKER_TOKEN_ENCRYPTION_KEY is not set. It must be 32 bytes, as 64-char hex or base64.",
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  // base64 / base64url
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalised, "base64");
    if (decoded.length === KEY_BYTES) return decoded;
    throw new TokenCryptoError(
      `BROKER_TOKEN_ENCRYPTION_KEY decoded to ${decoded.length} bytes; it must decode to exactly ${KEY_BYTES}. ` +
        "Provide 32 bytes as 64-char hex or base64.",
    );
  }

  throw new TokenCryptoError(
    "BROKER_TOKEN_ENCRYPTION_KEY is neither 64-char hex nor valid base64. It must be 32 bytes.",
  );
}

/** Deterministic AAD byte string from the authenticated metadata. */
function aadBytes(aad: TokenAad): Buffer {
  // A field separator that cannot appear in a broker name / date / api key avoids
  // ("a","bc") colliding with ("ab","c"). \x1f is the ASCII unit separator.
  const parts = [
    aad.broker,
    String(aad.credentialVersion),
    aad.apiKeyOrClientId,
    aad.loginDate,
  ];
  return Buffer.from(parts.join("\x1f"), "utf8");
}

/** Encrypt `plaintext`, binding `aad` as authenticated metadata. Fresh IV each call. */
export function sealToken(key: Buffer, plaintext: string, aad: TokenAad): SealedToken {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt a sealed token, verifying `aad` matches what it was sealed with.
 *
 * Throws `TokenCryptoError` on any auth failure (wrong key, tampered ciphertext,
 * tampered metadata) rather than returning a wrong plaintext — GCM makes those
 * indistinguishable and all of them mean "do not trust this token".
 */
export function openToken(key: Buffer, sealed: SealedToken, aad: TokenAad): string {
  assertKey(key);
  if (sealed.iv.length !== IV_BYTES) {
    throw new TokenCryptoError(`Stored IV is ${sealed.iv.length} bytes; expected ${IV_BYTES}.`);
  }
  if (sealed.authTag.length !== AUTH_TAG_BYTES) {
    throw new TokenCryptoError(
      `Stored auth tag is ${sealed.authTag.length} bytes; expected ${AUTH_TAG_BYTES}.`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAAD(aadBytes(aad));
  decipher.setAuthTag(sealed.authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // The underlying error is an opaque "unable to authenticate data"; rethrow as a
    // typed, non-leaking error. Never include ciphertext/tag/plaintext.
    throw new TokenCryptoError(
      "Failed to decrypt a stored broker token: wrong encryption key or tampered record.",
    );
  }
}

/** Constant-time check that two keys are identical (used by rotation dry-run). */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(`Encryption key must be ${KEY_BYTES} bytes; got ${key.length}.`);
  }
}
