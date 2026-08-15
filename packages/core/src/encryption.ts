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
 *   - 256-bit keys, supplied via ENCRYPTION_KEYS (base64, 32 raw bytes each)
 *   - 96-bit random IV per message (never reused)
 *   - 128-bit auth tag, verified on decrypt
 *   - optional AAD, bound into the tag but never stored
 *
 * Wire format (single string, safe for a Postgres text column):
 *
 *     v2.<key-id>.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 *
 * This is NOT for passwords. Passwords must be hashed (argon2/bcrypt), never
 * encrypted - there is no legitimate reason to read a password back.
 *
 * ---------------------------------------------------------------------------
 * Why a keyring, and why the key id is on the wire
 * ---------------------------------------------------------------------------
 *
 * Rotation is: add a key, make it active, re-encrypt, drop the old key. Every
 * step has to work while both keys are in play, which means a stored value has
 * to say which key opens it. Guessing - try each key until one works - turns a
 * wrong key into a slow success instead of an immediate failure, and hides the
 * one thing rotation needs to report: how many rows are still on the old key.
 *
 * resolveKey() is the seam. Today it reads a Map built from an environment
 * variable; a KMS or a per-tenant key lives behind the same call.
 *
 * ---------------------------------------------------------------------------
 * AAD: a ciphertext is bound to where it lives
 * ---------------------------------------------------------------------------
 *
 * GCM authenticates additional data alongside the plaintext. The vault passes
 * the row's own coordinates, so a ciphertext copied out of one company's row
 * into another's fails to open rather than quietly working. Company isolation
 * is enforced one layer down by RLS; this is the same guarantee for a value
 * that has been lifted out of the table entirely - a database dump, a backup,
 * a support export.
 *
 * The AAD is derived at call time and never stored, so it costs no column and
 * changes no format. What it does cost: the values it is derived from become
 * immutable in practice. Changing one means decrypt-and-re-encrypt, not an
 * UPDATE. See the IntegrationSecret docblock in schema.prisma.
 *
 * ---------------------------------------------------------------------------
 * Importing this module must never throw
 * ---------------------------------------------------------------------------
 *
 * Nothing here reads the environment, and no key is decoded at module scope. A
 * missing or malformed key is a failure of encrypt/decrypt, not of importing a
 * file that happens to sit in the same package as something unrelated. Keep it
 * that way: it is why resolveKey is a function rather than a constant.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v2";

/**
 * Key ids are deliberately dull.
 *
 * No dots, because the wire format is dot-delimited and an id containing one
 * would make the segments ambiguous in a way that only shows up on decrypt.
 * Lowercase and short so that it stays readable in a `key_id` column.
 */
const KEY_ID_PATTERN = /^[a-z0-9_]{1,16}$/;

export class EncryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EncryptionError";
  }
}

/** Every key that can currently open something, and the one used for new writes. */
export interface Keyring {
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeId: string;
}

/* ---------------------------------------------------------------- */
/* Building a keyring                                                */
/* ---------------------------------------------------------------- */

/**
 * Parse `id:base64,id:base64` into decoded key material.
 *
 * Exported so the environment contract validates with exactly this function
 * rather than a second regex that agrees with it until it does not.
 *
 * Base64 contains `+`, `/` and `=` but never a comma or a colon, so splitting
 * on the first colon of each comma-separated entry is unambiguous.
 */
export function parseKeyMaterial(raw: string | undefined): Map<string, Buffer> {
  if (!raw || raw.trim() === "") {
    throw new EncryptionError(
      "ENCRYPTION_KEYS is not set. Format: id:base64key,id:base64key " +
        "(generate a key with: openssl rand -base64 32)",
    );
  }

  const keys = new Map<string, Buffer>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new EncryptionError(
        `Malformed ENCRYPTION_KEYS entry "${trimmed}": expected id:base64key`,
      );
    }

    const id = trimmed.slice(0, separator);
    const material = trimmed.slice(separator + 1);

    if (!KEY_ID_PATTERN.test(id)) {
      throw new EncryptionError(
        `Invalid key id "${id}": must match ${String(KEY_ID_PATTERN)}`,
      );
    }

    if (keys.has(id)) {
      throw new EncryptionError(`Duplicate key id "${id}" in ENCRYPTION_KEYS`);
    }

    const key = Buffer.from(material, "base64");

    if (key.length !== KEY_BYTES) {
      throw new EncryptionError(
        `Key "${id}" must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
          "Generate one with: openssl rand -base64 32",
      );
    }

    keys.set(id, key);
  }

  if (keys.size === 0) {
    throw new EncryptionError("ENCRYPTION_KEYS contains no keys");
  }

  return keys;
}

/**
 * Build a keyring from the two environment values.
 *
 * The cross-check - that the active id names a key that is present - lives
 * here rather than in the Zod schema because sharedEnvSchema is extended by
 * both the web and worker schemas, and a schema carrying an object-level
 * refinement is no longer extendable. One check in one place, run the first
 * time anything encrypts.
 */
export function createKeyring(
  rawKeys: string | undefined,
  activeId: string | undefined,
): Keyring {
  const keys = parseKeyMaterial(rawKeys);

  if (!activeId) {
    throw new EncryptionError(
      "ENCRYPTION_KEY_ACTIVE is not set. It must name one of the ids in " +
        `ENCRYPTION_KEYS (${[...keys.keys()].join(", ")}).`,
    );
  }

  if (!keys.has(activeId)) {
    throw new EncryptionError(
      `ENCRYPTION_KEY_ACTIVE is "${activeId}", which is not in ENCRYPTION_KEYS ` +
        `(${[...keys.keys()].join(", ")}). Add the key before making it active.`,
    );
  }

  return { keys, activeId };
}

/**
 * The key for an id, or a clear failure.
 *
 * The seam a KMS drops into: everything else in this file asks for key
 * material through here and does not care where it came from.
 */
export function resolveKey(keyring: Keyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);

  if (!key) {
    throw new EncryptionError(
      `No key "${keyId}" in the keyring (have: ${[...keyring.keys.keys()].join(", ")}). ` +
        "A value was encrypted with a key that has since been dropped; " +
        "restore it and re-encrypt before removing it again.",
    );
  }

  return key;
}

/* ---------------------------------------------------------------- */
/* Sealing and opening                                               */
/* ---------------------------------------------------------------- */

export function encrypt(
  plaintext: string,
  keyring: Keyring,
  aad?: string,
): string {
  const key = resolveKey(keyring, keyring.activeId);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    keyring.activeId,
    b64url(iv),
    b64url(tag),
    b64url(ciphertext),
  ].join(".");
}

export function decrypt(token: string, keyring: Keyring, aad?: string): string {
  const { keyId, iv, tag, ciphertext } = parseToken(token);
  const key = resolveKey(keyring, keyId);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    /*
     * One message for four causes - wrong key, tampered ciphertext, tampered
     * tag, wrong AAD - because GCM cannot distinguish them and pretending
     * otherwise would be a guess. The AAD case is the interesting one: it is
     * what a row copied between companies looks like.
     */
    throw new EncryptionError(
      "Decryption failed: wrong key, wrong context, or the value was tampered with",
      { cause },
    );
  }
}

/**
 * Re-encrypt a value under the active key, proving the result opens first.
 *
 * The readback is the whole point. An AAD built even slightly differently on
 * the encrypt side than on the decrypt side produces a value that *nothing*
 * can ever open - not the old key, not the new one, not a restore of key
 * material, because the plaintext only existed in between. Writing that to the
 * column destroys the secret.
 *
 * So the sequence is decrypt, encrypt, decrypt again, compare, and only then
 * hand back something for the caller to store. It lives here rather than in
 * the rotation job so that the dangerous part is written once and tested
 * directly, and so a second caller cannot get it subtly wrong.
 *
 * The caller must pass the same `aad` it would use to read the row, and must
 * write `keyring.activeId` into `key_id` alongside the returned ciphertext.
 */
export function reseal(token: string, keyring: Keyring, aad?: string): string {
  const plaintext = decrypt(token, keyring, aad);
  const resealed = encrypt(plaintext, keyring, aad);
  const readback = decrypt(resealed, keyring, aad);

  if (!safeEqual(readback, plaintext)) {
    /* Unreachable short of a bug in this file. Loud rather than clever. */
    throw new EncryptionError(
      "Refusing to return a resealed value that does not read back identically",
    );
  }

  return resealed;
}

/**
 * Which key sealed this value, without opening it.
 *
 * Lets the rotation status check count rows per key without holding a single
 * plaintext, and without needing the key that would open them.
 */
export function keyIdOf(token: string): string {
  return parseToken(token).keyId;
}

/* ---------------------------------------------------------------- */
/* Internals                                                         */
/* ---------------------------------------------------------------- */

interface ParsedToken {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function parseToken(token: string): ParsedToken {
  const parts = token.split(".");

  if (parts.length !== 5) {
    throw new EncryptionError(
      `Malformed ciphertext: expected 5 segments, got ${parts.length}`,
    );
  }

  const [version, keyId, ivPart, tagPart, dataPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new EncryptionError(`Unsupported ciphertext version: ${version}`);
  }

  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new EncryptionError(`Malformed ciphertext: bad key id "${keyId}"`);
  }

  const iv = fromB64url(ivPart, "iv");
  const tag = fromB64url(tagPart, "tag");

  if (iv.length !== IV_BYTES) {
    throw new EncryptionError(`Bad IV length: ${iv.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new EncryptionError(`Bad auth tag length: ${tag.length}`);
  }

  return { keyId, iv, tag, ciphertext: fromB64url(dataPart, "ciphertext") };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 && value.length > 0) {
    throw new EncryptionError(`Malformed ${label} segment`);
  }
  return decoded;
}

/** Generate a fresh base64 key suitable for an ENCRYPTION_KEYS entry. */
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
