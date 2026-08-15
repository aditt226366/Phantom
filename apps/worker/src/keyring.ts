import { createKeyring, type Keyring } from "@whatsapp-os/core";
import { env } from "./env.ts";

/**
 * The worker's view of the keyring.
 *
 * Built on first use rather than at module load, for the same reason
 * encryption.ts resolves keys lazily: importing a module must not be what
 * fails when a key is missing.
 */

let cached: Keyring | undefined;

export function keyring(): Keyring {
  cached ??= createKeyring(env.ENCRYPTION_KEYS, env.ENCRYPTION_KEY_ACTIVE);
  return cached;
}
