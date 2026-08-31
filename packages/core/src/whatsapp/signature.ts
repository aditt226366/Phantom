import { createHmac } from "node:crypto";
import { safeEqual } from "../encryption.ts";

/**
 * Proving an inbound delivery came from Meta.
 *
 * The webhook URL is public. The opaque path segment makes it unguessable, not
 * secret - Meta stores it, it is rendered in a UI customers screenshot, and it
 * travels through every proxy between them and us. So the path is routing, and
 * this is the authentication.
 *
 * Meta signs the raw request body with the app secret and sends the digest in
 * X-Hub-Signature-256 as `sha256=<hex>`.
 *
 * ---------------------------------------------------------------------------
 * Why this lives on its own subpath
 * ---------------------------------------------------------------------------
 *
 * node:crypto. @whatsapp-os/core/whatsapp is imported by the template preview,
 * which is a client component, and anything reaching into the barrel from there
 * drags server-only modules into the browser graph - the failure the
 * @node-rs/argon2 note in the conventions describes, which hid for six commits
 * because a component reachable only from tests never enters the client graph.
 *
 * Hence two subpaths: `/whatsapp` is pure and safe to import anywhere,
 * `/whatsapp-server` is this.
 */

/** Meta's prefix. The header is not a bare hex digest. */
const SIGNATURE_PREFIX = "sha256=";

/**
 * Whether `header` is a valid signature over `rawBody` for `appSecret`.
 *
 * rawBody must be the exact bytes received, before any parse. Re-serialising
 * parsed JSON reorders keys and normalises numbers, and the digest of that is
 * not the digest Meta computed - which is also why whatsapp_webhook_events
 * stores the payload as text rather than jsonb.
 *
 * Returns false rather than throwing on a malformed or absent header. A
 * forgery, a stale app secret and a missing header are the same answer to the
 * caller: this did not come from Meta with the secret we hold.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  if (!header.startsWith(SIGNATURE_PREFIX)) return false;

  const provided = header.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  /*
   * safeEqual, not ===. It length-checks first and then compares in constant
   * time; timingSafeEqual throws outright on a length mismatch, which is why
   * the guard is in there rather than here.
   *
   * The timing channel is small but real: a byte-by-byte comparison leaks how
   * much of a guessed digest was correct, and the attacker controls the guess
   * and can repeat it.
   */
  return safeEqual(provided, expected);
}
