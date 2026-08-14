import { createInterface } from "node:readline";
import { hashPassword } from "@whatsapp-os/core";

/**
 * Print an Argon2id hash for a password, to paste into ADMIN_PASSWORD_HASH.
 *
 *     npm run admin:hash
 *
 * Exists so nobody has to hand-roll one, and so there is never a reason to put
 * a plaintext admin password in an environment variable. Environment variables
 * turn up in shell history, in `docker inspect`, in crash reports and in the
 * process listing.
 *
 * Read from stdin rather than argv, because an argument is visible in `ps` to
 * every user on the machine. Echo is suppressed while typing, so the password
 * does not stay on screen or in a scrollback buffer.
 *
 * Uses hashPassword from @whatsapp-os/core rather than calling argon2 directly,
 * so the parameters and the NFKC normalisation cannot drift from the ones
 * verifyPassword will use — a hash produced with different parameters would
 * still verify, and the mismatch would be invisible.
 */

const rl = createInterface({ input: process.stdin, output: process.stderr });

/*
 * Suppress echo. readline writes each keystroke to output; overriding that to
 * emit nothing keeps the characters off the terminal while still letting
 * Enter, Ctrl-C and backspace behave normally.
 */
let muted = false;
const realWrite = rl._writeToOutput?.bind(rl);
rl._writeToOutput = function write(chunk) {
  if (muted && realWrite) {
    /* Keep the prompt itself visible; swallow everything typed after it. */
    if (chunk.includes("Password")) realWrite(chunk);
    return;
  }
  realWrite?.(chunk);
};

const password = await new Promise((resolve) => {
  rl.question("Password: ", (answer) => resolve(answer));
  muted = true;
});

rl.close();
process.stderr.write("\n");

const trimmed = String(password).trim();

if (trimmed.length < 12) {
  console.error("Refusing: an admin password must be at least 12 characters.");
  process.exit(1);
}

/* stdout only, so the hash can be redirected without losing the prompt. */
console.log(await hashPassword(trimmed));
