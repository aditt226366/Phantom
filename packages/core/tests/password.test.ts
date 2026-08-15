import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMON_PASSWORDS } from "../src/data/common-passwords.ts";

import {
  ARGON2_PARAMS,
  MAX_PASSWORD_LENGTH,
  hashPassword,
  verifyDummy,
  verifyPassword,
} from "../src/password.ts";

describe("password hashing", () => {
  it("round-trips", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword(hash, "correct horse battery staple"),
    ).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(hash, "Correct horse battery staple")).resolves.toBe(
      false,
    );
    await expect(verifyPassword(hash, "")).resolves.toBe(false);
  });

  it("produces a different hash each time", async () => {
    /* Distinct salts, so identical passwords are not identifiable in a dump. */
    const [a, b] = await Promise.all([
      hashPassword("same password here"),
      hashPassword("same password here"),
    ]);

    expect(a).not.toBe(b);
    await expect(verifyPassword(a, "same password here")).resolves.toBe(true);
    await expect(verifyPassword(b, "same password here")).resolves.toBe(true);
  });

  it("encodes the agreed parameters in the hash", async () => {
    const hash = await hashPassword("parameters check please");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain(`m=${ARGON2_PARAMS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_PARAMS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_PARAMS.parallelism}`);
  });

  it("treats both Unicode forms of a password as the same", async () => {
    /*
     * The bug this prevents: "café" as NFC (é as one code point) and as NFD (e
     * plus a combining accent) are different byte sequences. Normalise on only
     * the hash path and the user registers on one keyboard and can never sign
     * in from another.
     */
    const composed = "café-password-long";
    const decomposed = "café-password-long";

    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    await expect(verifyPassword(hash, decomposed)).resolves.toBe(true);

    const reverse = await hashPassword(decomposed);
    await expect(verifyPassword(reverse, composed)).resolves.toBe(true);
  });

  it("ignores anything past the length cap", async () => {
    const base = "a".repeat(MAX_PASSWORD_LENGTH);
    const hash = await hashPassword(base + "ignored-tail");

    await expect(verifyPassword(hash, base)).resolves.toBe(true);
  });

  it("returns false for a malformed stored hash rather than throwing", async () => {
    /*
     * A corrupt row must look exactly like a wrong password. Throwing would
     * turn it into a 500 that identifies the account.
     */
    await expect(verifyPassword("not-a-hash", "whatever")).resolves.toBe(false);
    await expect(verifyPassword("", "whatever")).resolves.toBe(false);
  });
});

describe("verifyDummy", () => {
  it("always returns false", async () => {
    await expect(verifyDummy("anything at all")).resolves.toBe(false);
  });

  it("costs about as much as a real verification", async () => {
    /*
     * The point of the dummy is that an unknown username cannot be told from a
     * known one by timing. If this ever gets "optimised" into a short-circuit,
     * the ratio blows out and this fails.
     *
     * A wide band on purpose: this asserts the same order of magnitude, not a
     * stopwatch reading, because CI machines are noisy.
     */
    const hash = await hashPassword("a real password for timing");

    const realStart = performance.now();
    await verifyPassword(hash, "a real password for timing");
    const real = performance.now() - realStart;

    const dummyStart = performance.now();
    await verifyDummy("a real password for timing");
    const dummy = performance.now() - dummyStart;

    expect(dummy).toBeGreaterThan(real * 0.25);
    expect(dummy).toBeLessThan(real * 4);
  });
});

describe("the generated denylist", () => {
  /*
   * data/common-passwords.ts is generated from data/common-passwords.txt by
   * scripts/build-denylist.mjs. The .txt is the source of truth — reviewable
   * and diffable — and the .ts is what ships, because resolving a data file
   * relative to import.meta.url breaks under Turbopack.
   *
   * Two files means they can disagree, so forgetting to re-run the generator
   * is a failing test rather than a denylist that silently stopped matching
   * the file somebody edited.
   */
  it("matches the text file it was generated from", () => {
    const txt = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "data",
        "common-passwords.txt",
      ),
      "utf8",
    )
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0);

    expect(COMMON_PASSWORDS.length).toBe(txt.length);
    expect([...COMMON_PASSWORDS]).toEqual(txt);
  });

  it("is not empty, which an empty source file would silently produce", () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(9000);
  });
});
