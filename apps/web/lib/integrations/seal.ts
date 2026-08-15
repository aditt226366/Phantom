import "server-only";
import {
  createKeyring,
  decrypt,
  encrypt,
  last4Of,
  secretAad,
  type Keyring,
} from "@whatsapp-os/core";
import { env } from "@/lib/env";

/**
 * Turning a credential into a stored row, and back.
 *
 * Deliberately the only place either direction happens. The AAD binding a
 * ciphertext to its row has to be assembled identically on both sides, and the
 * cost of getting that wrong is not a failed request — it is a value that
 * nothing can ever open again, because the plaintext existed only in between.
 * secretAad() in @whatsapp-os/core is the one construction; this is the one
 * caller.
 *
 * No transaction, no I/O: seal() and open() are CPU only. That is what makes it
 * safe for the vault to seal inside the transaction that created the
 * integration row — the AAD needs that row's id, so the alternative is
 * encrypting against an id that does not exist yet.
 */

let cached: Keyring | undefined;

/**
 * Built once and memoised, not at module load.
 *
 * Importing this file must not throw for a missing key — the same reason
 * encryption.ts resolves keys lazily. A module that dies on import takes
 * unrelated pages down with it and reports the wrong cause.
 */
export function keyring(): Keyring {
  cached ??= createKeyring(env.ENCRYPTION_KEYS, env.ENCRYPTION_KEY_ACTIVE);
  return cached;
}

export interface SealedSecret {
  ciphertext: string;
  keyId: string;
  /** Null for values too short to hint at without disclosing them. */
  last4: string | null;
}

export function seal(
  companyId: string,
  integrationId: string,
  key: string,
  plaintext: string,
): SealedSecret {
  const ring = keyring();

  return {
    ciphertext: encrypt(plaintext, ring, secretAad(companyId, integrationId, key)),
    keyId: ring.activeId,
    last4: last4Of(plaintext),
  };
}

/**
 * Open a stored secret.
 *
 * Called from exactly one path: immediately before a provider call, outside
 * any transaction. Nothing renders the result, nothing returns it to a
 * browser, and nothing logs it.
 */
export function open(
  companyId: string,
  integrationId: string,
  key: string,
  ciphertext: string,
): string {
  return decrypt(
    ciphertext,
    keyring(),
    secretAad(companyId, integrationId, key),
  );
}
