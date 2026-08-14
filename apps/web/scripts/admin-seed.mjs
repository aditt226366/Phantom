import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Create or update the platform admin from the environment. Idempotent.
 *
 *     npm run admin:seed
 *
 * ADMIN_PASSWORD_HASH is a hash, never a password. `npm run admin:hash`
 * produces one. This script refuses anything that is not an Argon2id encoded
 * hash, because the failure mode of accepting a plaintext there is silent: the
 * value looks like it worked, sign-in fails with "wrong credentials", and the
 * password sits in the environment of every process on the box.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "..", "..", ".env"), quiet: true });

const username = process.env["ADMIN_USERNAME"]?.trim().toLowerCase();
const passwordHash = process.env["ADMIN_PASSWORD_HASH"];

if (!username || !passwordHash) {
  console.error(
    "ADMIN_USERNAME and ADMIN_PASSWORD_HASH must both be set.\n" +
      "Generate the hash with: npm run admin:hash",
  );
  process.exit(1);
}

if (!/^\$argon2id\$/.test(passwordHash)) {
  console.error(
    "ADMIN_PASSWORD_HASH is not an Argon2id hash — it must start with $argon2id$.\n\n" +
      "If you put the password itself there, change the password: it has been\n" +
      "in your environment, and therefore in your shell history and process list.\n\n" +
      "Generate a hash with: npm run admin:hash",
  );
  process.exit(1);
}

/*
 * Goes through lib/admin-db.ts rather than the admin client directly, so that
 * module stays the single import site for @whatsapp-os/db/admin — the whole
 * point of the rule, and something a CLI script exempting itself would quietly
 * undo.
 *
 * It imports `server-only`, whose main entry throws outside the react-server
 * condition, which is why the npm script runs tsx with --conditions=react-server.
 */
const { upsertAdminUser } = await import("../lib/admin-db.ts");

const { created } = await upsertAdminUser(username, passwordHash);

console.log(
  created
    ? `Created platform admin "${username}".`
    : `Updated platform admin "${username}".`,
);

process.exit(0);
