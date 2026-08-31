import "server-only";
import {
  createKeyring,
  decrypt,
  encrypt,
  isSecretField,
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
 * Called immediately before a provider call, outside any transaction. Nothing
 * logs the result.
 *
 * ---------------------------------------------------------------------------
 * One value is rendered, and it is the only one
 * ---------------------------------------------------------------------------
 *
 * This used to say nothing renders the result, which was true until lead
 * sources needed to show the tenant which address to share their spreadsheet
 * with. GOOGLE_SERVICE_ACCOUNT_EMAIL is declared `secret: false` in
 * INTEGRATION_FIELDS for exactly that reason: it is Google's public identifier
 * for the service account, knowing it grants nothing, and a tenant who cannot
 * see it cannot complete the setup at all - which presents as a binding that
 * silently never reads their sheet.
 *
 * The rule that keeps this narrow is `isSecretField`, which fails closed for
 * any key nobody declared. A caller that wants to render a stored value has to
 * pass it through openRenderable below rather than this, and openRenderable
 * refuses everything else - so widening this is a diff in this file rather than
 * a page quietly printing an access token.
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

/**
 * Open a stored secret that is about to be shown to somebody.
 *
 * The only path to the plaintext of a value a page renders, and it refuses any
 * key `isSecretField` does not clear. That check fails closed for a key nobody
 * declared, so a credential added later cannot reach a browser by being passed
 * to the wrong helper - it has to be declared non-secret first, in
 * INTEGRATION_FIELDS, which is a reviewed diff.
 *
 * Returns null rather than throwing. A page that cannot show the service
 * account address should say so, not 500.
 */
export function openRenderable(
  companyId: string,
  integrationId: string,
  key: string,
  ciphertext: string,
): string | null {
  if (isSecretField(key)) return null;

  return open(companyId, integrationId, key, ciphertext);
}
