import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "../src/whatsapp/signature.ts";

/**
 * The expected digests below were produced OUTSIDE this codebase, and that is
 * the point of the file.
 *
 * The obvious test - build a body, run our own HMAC over it, assert verify()
 * accepts the result - proves that our HMAC equals our HMAC. It passes with the
 * wrong hash, the wrong key derivation, the secret and message swapped, or the
 * `sha256=` prefix mishandled identically on both sides. Every one of those is
 * a real bug that ships an endpoint accepting forged deliveries.
 *
 * So the values are frozen, generated with openssl and recorded with the
 * command that produced them. Re-derive them the same way if a body changes:
 *
 *   printf '%s' '<body>' > body.json
 *   openssl dgst -sha256 -hmac '<secret>' -hex < body.json
 *
 * OpenSSL 3.5.5 produced these.
 */

/** printf '%s' '...' > body-a.json  (86 bytes, no trailing newline) */
const BODY_A =
  '{"object":"whatsapp_business_account","entry":[{"id":"102290129340398","changes":[]}]}';

/** A different delivery, same shape. Used for the replay case. */
const BODY_B =
  '{"object":"whatsapp_business_account","entry":[{"id":"999999999999999","changes":[]}]}';

const SECRET_A = "meta_app_secret_fixture_a";
const SECRET_B = "meta_app_secret_fixture_b";

/** openssl dgst -sha256 -hmac 'meta_app_secret_fixture_a' -hex < body-a.json */
const SIG_A_WITH_A =
  "e847f02f057deba0657197eccd9d03c268283215ba9993576b88691b6d83f214";

/** openssl dgst -sha256 -hmac 'meta_app_secret_fixture_a' -hex < body-b.json */
const SIG_B_WITH_A =
  "3fce9c2bea7a3b1f45a9a7b24a029bbdc98f259d8f31bcee617dc49a96d5bfaa";

/** openssl dgst -sha256 -hmac 'meta_app_secret_fixture_b' -hex < body-a.json */
const SIG_A_WITH_B =
  "23fbd9acd7bde4b3587c63560cc0abf9094f40ff0ff9e611ab343ca9c07d5ce2";

describe("a genuine delivery", () => {
  it("accepts a signature generated outside this codebase", () => {
    /*
     * The only test here that can fail because our algorithm is wrong rather
     * than because our algorithm is inconsistent with itself.
     */
    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_A_WITH_A}`, SECRET_A),
    ).toBe(true);
  });

  it("agrees with openssl on a second body and a second secret", () => {
    /* Two more independent points, so a coincidence on one body is not enough. */
    expect(
      verifyMetaSignature(BODY_B, `sha256=${SIG_B_WITH_A}`, SECRET_A),
    ).toBe(true);
    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_A_WITH_B}`, SECRET_B),
    ).toBe(true);
  });
});

describe("what an attacker who has seen one genuine delivery actually holds", () => {
  it("rejects a valid signature replayed against a different body", () => {
    /*
     * The first real attack shape, and the one a corrupted-signature test does
     * not cover. Having observed one delivery, an attacker holds a signature
     * that is genuinely valid - for that body. Rebinding it to different
     * content is the whole game.
     *
     * Both digests below are real: SIG_A_WITH_A verifies BODY_A. Against
     * BODY_B it must not.
     */
    expect(
      verifyMetaSignature(BODY_B, `sha256=${SIG_A_WITH_A}`, SECRET_A),
      "a signature for another body was accepted",
    ).toBe(false);

    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_B_WITH_A}`, SECRET_A),
    ).toBe(false);
  });

  it("rejects a correct body signed with a different app secret", () => {
    /*
     * The second shape. The body is exactly right; only the key is wrong.
     * This is what a forgery looks like from anyone who knows the payload
     * format - which is public - but not the secret.
     *
     * It is also what a real tenant looks like after rotating the app secret
     * at Meta without updating it here, which is why the endpoint records it
     * and answers 200 rather than refusing.
     */
    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_A_WITH_B}`, SECRET_A),
      "a signature from another secret was accepted",
    ).toBe(false);

    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_A_WITH_A}`, SECRET_B),
    ).toBe(false);
  });

  it("rejects a body altered after signing, byte for byte", () => {
    /* One character, in a place a tamperer would care about. */
    const tampered = BODY_A.replace("102290129340398", "102290129340399");

    expect(tampered).not.toBe(BODY_A);
    expect(tampered.length).toBe(BODY_A.length);
    expect(
      verifyMetaSignature(tampered, `sha256=${SIG_A_WITH_A}`, SECRET_A),
    ).toBe(false);
  });
});

describe("malformed headers", () => {
  it("rejects an absent header", () => {
    expect(verifyMetaSignature(BODY_A, null, SECRET_A)).toBe(false);
    expect(verifyMetaSignature(BODY_A, undefined, SECRET_A)).toBe(false);
    expect(verifyMetaSignature(BODY_A, "", SECRET_A)).toBe(false);
  });

  it("rejects the digest without its prefix", () => {
    /*
     * Meta sends `sha256=<hex>`. Accepting a bare digest would mean accepting
     * a header the other end never sends, and the prefix is exactly the part
     * an implementation gets wrong on both sides at once - which is why the
     * expected values here are frozen rather than computed.
     */
    expect(verifyMetaSignature(BODY_A, SIG_A_WITH_A, SECRET_A)).toBe(false);
  });

  it("rejects a different algorithm prefix", () => {
    expect(
      verifyMetaSignature(BODY_A, `sha1=${SIG_A_WITH_A}`, SECRET_A),
    ).toBe(false);
  });

  it("rejects a prefix that is the right length but the wrong word", () => {
    /*
     * `sha512=` is seven characters, exactly like `sha256=`.
     *
     * That matters because the natural implementation slices the prefix off by
     * length. Drop the startsWith check and every malformed header still fails
     * - except one the same length, where the slice lands perfectly and a
     * correct digest under the wrong algorithm label is accepted.
     *
     * The `sha1=` case above does not catch that: five characters, so the
     * slice mangles the digest and it fails for the wrong reason. Found by
     * removing the check and watching the suite stay green.
     */
    expect(
      verifyMetaSignature(BODY_A, `sha512=${SIG_A_WITH_A}`, SECRET_A),
    ).toBe(false);
  });

  it("rejects a truncated digest", () => {
    /*
     * safeEqual length-checks before comparing, because timingSafeEqual throws
     * on a length mismatch. A prefix of a correct digest must be false, not an
     * exception the route would have to catch.
     */
    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_A_WITH_A.slice(0, 32)}`, SECRET_A),
    ).toBe(false);
  });

  it("rejects an uppercase digest rather than normalising it", () => {
    /* Meta sends lowercase hex. Accepting either would widen what counts as a
       match for no reason, and the comparison is over bytes. */
    expect(
      verifyMetaSignature(BODY_A, `sha256=${SIG_A_WITH_A.toUpperCase()}`, SECRET_A),
    ).toBe(false);
  });

  it("rejects an empty app secret", () => {
    /*
     * The state every WhatsApp integration was in before the app secret became
     * a required key. An empty secret is a real HMAC key and would verify a
     * digest computed with an empty key, so this has to be refused explicitly
     * rather than left to the maths.
     */
    const emptyKeyDigest = createHmac("sha256", "").update(BODY_A).digest("hex");

    expect(verifyMetaSignature(BODY_A, `sha256=${emptyKeyDigest}`, "")).toBe(false);
  });
});
