import { describe, expect, it } from "vitest";
import {
  EncryptionError,
  createKeyring,
  decrypt,
  encrypt,
  generateEncryptionKey,
  keyIdOf,
  parseKeyMaterial,
  resolveKey,
  reseal,
  safeEqual,
  type Keyring,
} from "../src/encryption.ts";

/**
 * The module had no tests at all before this commit, and no caller either -
 * it was written in the scaffold and never used. Everything below is new, so
 * each assertion was checked against a deliberately broken implementation
 * before being kept.
 */

const KEY_ONE = generateEncryptionKey();
const KEY_TWO = generateEncryptionKey();

const ONE_KEY = createKeyring(`k1:${KEY_ONE}`, "k1");
const BOTH_KEYS = createKeyring(`k1:${KEY_ONE},k2:${KEY_TWO}`, "k2");

/** What the vault passes: the row's own coordinates. */
const AAD = "company_a:integration_1:WHATSAPP_ACCESS_TOKEN";
const OTHER_AAD = "company_b:integration_1:WHATSAPP_ACCESS_TOKEN";

const SECRET = "EAAG...a-real-looking-access-token";

describe("the keyring", () => {
  it("parses several keys at once", () => {
    const keys = parseKeyMaterial(`k1:${KEY_ONE},k2:${KEY_TWO}`);

    expect([...keys.keys()]).toEqual(["k1", "k2"]);
    expect(keys.get("k1")).toHaveLength(32);
  });

  it("tolerates whitespace around entries", () => {
    const keys = parseKeyMaterial(` k1:${KEY_ONE} , k2:${KEY_TWO} `);
    expect([...keys.keys()]).toEqual(["k1", "k2"]);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => parseKeyMaterial("k1:c2hvcnQ=")).toThrow(
      /must decode to exactly 32 bytes/i,
    );
  });

  it("rejects a key id containing a dot", () => {
    /* The wire format is dot-delimited; an id with a dot would only show up
       as a malformed-segment error much later, on decrypt. */
    expect(() => parseKeyMaterial(`k.1:${KEY_ONE}`)).toThrow(/invalid key id/i);
  });

  it("rejects a duplicate key id", () => {
    expect(() => parseKeyMaterial(`k1:${KEY_ONE},k1:${KEY_TWO}`)).toThrow(
      /duplicate key id/i,
    );
  });

  it("rejects an entry with no colon", () => {
    expect(() => parseKeyMaterial(KEY_ONE)).toThrow(/expected id:base64key/i);
  });

  it("refuses an active id that names no key", () => {
    /* The rotation footgun: flipping ENCRYPTION_KEY_ACTIVE before adding the
       key it names. Failing at startup beats failing on the first write. */
    expect(() => createKeyring(`k1:${KEY_ONE}`, "k2")).toThrow(
      /not in ENCRYPTION_KEYS/i,
    );
  });

  it("refuses an unset active id", () => {
    expect(() => createKeyring(`k1:${KEY_ONE}`, undefined)).toThrow(
      /ENCRYPTION_KEY_ACTIVE is not set/i,
    );
  });

  it("refuses to build from nothing", () => {
    expect(() => createKeyring(undefined, "k1")).toThrow(
      /ENCRYPTION_KEYS is not set/i,
    );
  });

  it("names the keys it does have when asked for one it does not", () => {
    /* The message is the whole value of this path: it appears when a key has
       been dropped while rows still reference it. */
    expect(() => resolveKey(ONE_KEY, "k9")).toThrow(/have: k1/);
  });
});

describe("round trip", () => {
  it("returns what went in", () => {
    expect(decrypt(encrypt(SECRET, ONE_KEY), ONE_KEY)).toBe(SECRET);
  });

  it("survives a value with newlines and unicode", () => {
    /* A Google service-account private key is a PEM block. */
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----\n";
    expect(decrypt(encrypt(pem, ONE_KEY), ONE_KEY)).toBe(pem);
  });

  it("handles an empty string", () => {
    expect(decrypt(encrypt("", ONE_KEY), ONE_KEY)).toBe("");
  });

  it("never produces the same ciphertext twice", () => {
    /* A fresh IV per message. Identical output would mean IV reuse, which in
       GCM is catastrophic rather than untidy. */
    const first = encrypt(SECRET, ONE_KEY);
    const second = encrypt(SECRET, ONE_KEY);

    expect(first).not.toBe(second);
    expect(decrypt(first, ONE_KEY)).toBe(decrypt(second, ONE_KEY));
  });

  it("stamps the active key id on the wire", () => {
    expect(encrypt(SECRET, BOTH_KEYS).split(".")[1]).toBe("k2");
    expect(keyIdOf(encrypt(SECRET, BOTH_KEYS))).toBe("k2");
  });

  it("writes the documented format", () => {
    const parts = encrypt(SECRET, BOTH_KEYS).split(".");

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe("k2");
  });
});

describe("additional authenticated data", () => {
  it("opens with the same context", () => {
    expect(decrypt(encrypt(SECRET, ONE_KEY, AAD), ONE_KEY, AAD)).toBe(SECRET);
  });

  it("refuses a ciphertext moved to another company", () => {
    /*
     * The reason AAD is here at all. This is a row lifted out of one company's
     * integration_secrets and written into another's - which RLS cannot see,
     * because by then it is a legitimate row in the thief's own company.
     */
    const sealed = encrypt(SECRET, ONE_KEY, AAD);

    expect(() => decrypt(sealed, ONE_KEY, OTHER_AAD)).toThrow(EncryptionError);
  });

  it("refuses a ciphertext read with no context at all", () => {
    /* Fails closed: a caller that forgets the AAD does not get the plaintext. */
    const sealed = encrypt(SECRET, ONE_KEY, AAD);

    expect(() => decrypt(sealed, ONE_KEY)).toThrow(/decryption failed/i);
  });

  it("refuses a context-free ciphertext read with a context", () => {
    const sealed = encrypt(SECRET, ONE_KEY);

    expect(() => decrypt(sealed, ONE_KEY, AAD)).toThrow(/decryption failed/i);
  });

  it("does not store the context", () => {
    /*
     * AAD is authenticated, not encrypted, and it is not on the wire at all
     * here - it is re-derived from the row. If it appeared in the token, a
     * dump would carry the company id next to the ciphertext for free.
     */
    const sealed = encrypt(SECRET, ONE_KEY, AAD);

    expect(sealed).not.toContain("company_a");
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("integration_1");
  });
});

describe("tampering and wrong keys", () => {
  it("refuses a flipped byte in the ciphertext", () => {
    const sealed = encrypt(SECRET, ONE_KEY);
    const parts = sealed.split(".");
    const body = Buffer.from(parts[4]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    parts[4] = body.toString("base64url");

    expect(() => decrypt(parts.join("."), ONE_KEY)).toThrow(EncryptionError);
  });

  it("refuses a flipped byte in the auth tag", () => {
    const sealed = encrypt(SECRET, ONE_KEY);
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[3]!, "base64url");
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString("base64url");

    expect(() => decrypt(parts.join("."), ONE_KEY)).toThrow(EncryptionError);
  });

  it("refuses the wrong key", () => {
    const sealed = encrypt(SECRET, createKeyring(`k1:${KEY_ONE}`, "k1"));
    const impostor = createKeyring(`k1:${KEY_TWO}`, "k1");

    expect(() => decrypt(sealed, impostor)).toThrow(/decryption failed/i);
  });

  it("refuses a v1 token", () => {
    /* v1 was never written to any column - nothing has ever called this
       module - so v2 is the only format and old tokens are a malformed
       input rather than a migration. */
    expect(() => decrypt("v1.aXY.dGFn.Y2lwaGVy", ONE_KEY)).toThrow(
      /expected 5 segments/i,
    );
  });

  it("refuses a token with the wrong segment count", () => {
    expect(() => decrypt("v2.k1.aXY.dGFn", ONE_KEY)).toThrow(
      /expected 5 segments/i,
    );
  });

  it("refuses an unknown version", () => {
    expect(() => decrypt("v3.k1.aXY.dGFn.Y2lwaGVy", ONE_KEY)).toThrow(
      /unsupported ciphertext version/i,
    );
  });

  it("refuses a truncated IV", () => {
    const sealed = encrypt(SECRET, ONE_KEY);
    const parts = sealed.split(".");
    parts[2] = Buffer.from([1, 2, 3]).toString("base64url");

    expect(() => decrypt(parts.join("."), ONE_KEY)).toThrow(/bad iv length/i);
  });
});

describe("rotation", () => {
  it("still opens a value sealed under a retired key", () => {
    /* The property that makes rotation possible at all: k1 sealed it, k2 is
       active, and the row has not been touched yet. */
    const sealed = encrypt(SECRET, ONE_KEY);

    expect(decrypt(sealed, BOTH_KEYS)).toBe(SECRET);
    expect(keyIdOf(sealed)).toBe("k1");
  });

  it("reseals onto the active key", () => {
    const sealed = encrypt(SECRET, ONE_KEY);
    const resealed = reseal(sealed, BOTH_KEYS);

    expect(keyIdOf(resealed)).toBe("k2");
    expect(decrypt(resealed, BOTH_KEYS)).toBe(SECRET);
  });

  it("carries the context across a reseal", () => {
    const sealed = encrypt(SECRET, ONE_KEY, AAD);
    const resealed = reseal(sealed, BOTH_KEYS, AAD);

    expect(decrypt(resealed, BOTH_KEYS, AAD)).toBe(SECRET);
  });

  it("keeps a resealed row bound to its own company", () => {
    /*
     * The rotation job must not launder a value out of its context. If reseal
     * dropped the AAD, every rotated row would become portable between
     * companies and nothing would report it.
     */
    const sealed = encrypt(SECRET, ONE_KEY, AAD);
    const resealed = reseal(sealed, BOTH_KEYS, AAD);

    expect(() => decrypt(resealed, BOTH_KEYS, OTHER_AAD)).toThrow(
      EncryptionError,
    );
  });

  it("refuses to reseal under the wrong context", () => {
    /* Fails at the first decrypt, before anything is produced to write. */
    const sealed = encrypt(SECRET, ONE_KEY, AAD);

    expect(() => reseal(sealed, BOTH_KEYS, OTHER_AAD)).toThrow(
      /decryption failed/i,
    );
  });

  it("is a no-op that still verifies when already on the active key", () => {
    const sealed = encrypt(SECRET, BOTH_KEYS, AAD);
    const resealed = reseal(sealed, BOTH_KEYS, AAD);

    expect(keyIdOf(resealed)).toBe("k2");
    expect(decrypt(resealed, BOTH_KEYS, AAD)).toBe(SECRET);
  });

  it("cannot open a row once its key is dropped", () => {
    /*
     * What "zero rows on the old key before dropping it" protects against.
     * The error names the keys that remain, because the operator's next
     * question is which one they removed.
     */
    const sealed = encrypt(SECRET, ONE_KEY);
    const afterDrop = createKeyring(`k2:${KEY_TWO}`, "k2");

    expect(() => decrypt(sealed, afterDrop)).toThrow(/no key "k1"/i);
  });
});

describe("safeEqual", () => {
  it("matches identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    /* timingSafeEqual throws on a length mismatch; this must not. */
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("the module contract", () => {
  it("exposes a keyring shape the vault can hold", () => {
    const keyring: Keyring = BOTH_KEYS;

    expect(keyring.activeId).toBe("k2");
    expect(keyring.keys.size).toBe(2);
  });

  it("generates keys of the right size", () => {
    expect(Buffer.from(generateEncryptionKey(), "base64")).toHaveLength(32);
  });

  it("imported with no ENCRYPTION_* variable set", () => {
    /*
     * The invariant that importing must never throw, asserted the only way it
     * can be: this file imports the module at the top level, and the core test
     * project sets no ENCRYPTION_* variables, so the suite running at all is
     * the proof. The expectations below make the claim visible, and fail if
     * someone later adds those variables to the test environment and quietly
     * removes the coverage.
     */
    expect(process.env["ENCRYPTION_KEYS"]).toBeUndefined();
    expect(process.env["ENCRYPTION_KEY_ACTIVE"]).toBeUndefined();
    expect(encrypt).toBeTypeOf("function");
  });
});
