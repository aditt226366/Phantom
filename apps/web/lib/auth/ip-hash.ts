import "server-only";
import { createHmac } from "node:crypto";

/**
 * One-way, keyed hash of a source address.
 *
 * Extracted because there were two identical copies - session-store and
 * admin-session - and the webhook throttle would have been a third. Three
 * copies of a security primitive is how one of them quietly stops matching the
 * others.
 *
 * HMAC rather than a bare digest, and the reason is arithmetic: IPv4 has four
 * billion addresses, so a plain sha256 of one reverses by brute force in
 * seconds and stores nothing meaningfully different from the address itself.
 * Keying with the application secret means the stored value is correlatable
 * only by something that already holds the key.
 *
 * The output is compared, counted and stored. It is never displayed and never
 * reversed - nothing in this system needs the address back.
 */
export function hashIp(ip: string): string {
  const key = process.env["ENCRYPTION_KEY"] ?? "";
  return createHmac("sha256", key).update(ip).digest("hex");
}
