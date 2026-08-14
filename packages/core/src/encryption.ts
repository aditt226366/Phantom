import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated symmetric encryption for values at rest (API tokens, webhook
 * secrets, anything we must be able to read back).
 *
 * Algorithm: AES-256-GCM.
 *   - 256-bit key, supplied via ENCRYPTION_KEY (base64, 32 raw bytes)
 *   - 96-bit random IV per message (never reused)
 *   - 128-bit auth tag, verified on decrypt
 *
 * Wire format (single string, safe for a Postgres text column):
 *
 *     v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 *
 * The version prefix exists so the key or algorithm can be rotated later
 * without a destructive migration: decrypt() dispatches on it.
 *
 * This is NOT for passwords. Passwords must be hashed (argon2/bcrypt), never
 * encrypted - there is no legitimate reason to read a password back.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

export class EncryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EncryptionError";
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(value: string, label: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch (cause) {
    throw new EncryptionError(`Malformed ${label} segment`, { cause });
  }
}

/**
 * Decode and validate the raw key material.
 *
 * Kept as a function rather than a module-level constant so that importing
 * this module never throws - only actually encrypting/decrypting does. That
 * keeps a missing key from taking down unrelated code paths at import time.
 */
export function resolveKey(rawKey: string | undefined): Buffer {
  if (!rawKey) {
    throw new EncryptionError(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }

  const key = Buffer.from(rawKey, "base64");

  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(
      `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  return key;
}

/** Encrypt a UTF-8 string. Returns the versioned wire format described above. */
export function encrypt(plaintext: string, rawKey: string | undefined): string {
  const key = resolveKey(rawKey);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64url(iv), b64url(tag), b64url(ciphertext)].join(".");
}

/**
 * Decrypt a value produced by encrypt().
 *
 * Throws EncryptionError if the payload was tampered with, truncated, or
 * encrypted under a different key - GCM authentication makes all three
 * indistinguishable from the caller's point of view, which is the point.
 */
export function decrypt(token: string, rawKey: string | undefined): string {
  const key = resolveKey(rawKey);
  const parts = token.split(".");

  if (parts.length !== 4) {
    throw new EncryptionError(
      `Malformed ciphertext: expected 4 segments, got ${parts.length}`,
    );
  }

  const [version, ivPart, tagPart, dataPart] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new EncryptionError(`Unsupported ciphertext version: ${version}`);
  }

  const iv = fromB64url(ivPart, "iv");
  const tag = fromB64url(tagPart, "tag");
  const ciphertext = fromB64url(dataPart, "ciphertext");

  if (iv.length !== IV_BYTES) {
    throw new EncryptionError(`Bad IV length: ${iv.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new EncryptionError(`Bad auth tag length: ${tag.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new EncryptionError(
      "Decryption failed: the value was tampered with, or the key is wrong",
      { cause },
    );
  }
}

/** Generate a fresh base64 key suitable for ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Constant-time string comparison, for webhook signature checks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
