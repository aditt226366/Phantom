import { hash, verify } from "@node-rs/argon2";
import type { Algorithm } from "@node-rs/argon2";

/**
 * Argon2id.
 *
 * Written as its discriminant rather than `Algorithm.Argon2id` because the
 * upstream declaration is an *ambient const enum*, and `isolatedModules` — which
 * this repo needs, since packages are consumed as TypeScript source with no
 * build step — forbids reading one as a value. The annotation still type-checks
 * the number against the enum, and the round-trip test asserts the resulting
 * hash actually starts with "$argon2id$", so a renumbering upstream fails
 * loudly rather than silently selecting Argon2d.
 */
const ARGON2ID: Algorithm = 2;

/**
 * Password hashing.
 *
 * Argon2id at the OWASP-recommended parameters. Everything here exists to make
 * two properties hold: a hash produced today verifies tomorrow, and an attacker
 * cannot learn whether an account exists by timing the response.
 */

/**
 * The one definition of the hashing parameters.
 *
 * Never inline these at a call site. Argon2 encodes its parameters in the hash
 * string, so `verify` reads them from the stored hash rather than from these
 * options — which means a call site that hashes with different parameters
 * produces hashes that still verify, and the drift is invisible until you try
 * to reason about cost. Worse, a future change made in one place and not
 * another produces two populations of hashes with no way to tell them apart.
 * One constant, imported everywhere.
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Upper bound on what we will hash.
 *
 * Argon2's cost is dominated by memoryCost, not input length, so this is not a
 * DoS guard so much as a refusal to treat a megabyte paste as a password.
 */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * The single normalisation point, called by BOTH hash and verify.
 *
 * "é" can be one code point or two, and the two forms are different byte
 * sequences with different hashes. A user whose password contains one — or an
 * emoji, or anything outside ASCII — can register on a keyboard that emits NFC
 * and then be unable to sign in from one that emits NFD. Normalising on only
 * one of the two paths is worse than not normalising at all, so both go
 * through here.
 */
function prepare(password: string): string {
  return password.normalize("NFKC").slice(0, MAX_PASSWORD_LENGTH);
}

export async function hashPassword(password: string): Promise<string> {
  return hash(prepare(password), ARGON2_PARAMS);
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, prepare(password), ARGON2_PARAMS);
  } catch {
    /*
     * A malformed or truncated hash in the database is not a valid password.
     * Returning false keeps this indistinguishable from a wrong password,
     * rather than turning a corrupt row into a 500 that identifies the account.
     */
    return false;
  }
}

/**
 * A real Argon2id hash of a value nobody knows, computed once at import.
 *
 * Sign-in for an unknown username has nothing to verify against, so it would
 * return in microseconds while a real account takes ~60-120ms. That difference
 * is measurable over the network and enumerates your users. verifyDummy() burns
 * the same work.
 */
const DUMMY_PASSWORD = "dummy-password-for-timing-equalisation";
let dummyHash: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHash ??= hash(prepare(DUMMY_PASSWORD), ARGON2_PARAMS);
  return dummyHash;
}

/**
 * Spend the same time verifying as a real sign-in would, and return false.
 *
 * This runs an actual Argon2 verification. Do not "optimise" it into a sleep or
 * a short-circuit: the cost has to track the real parameters, or it stops
 * matching the moment ARGON2_PARAMS changes and the equalisation becomes
 * theatre that looks like a control.
 */
export async function verifyDummy(password: string): Promise<false> {
  await verify(await getDummyHash(), prepare(password), ARGON2_PARAMS);
  return false;
}
