import { createHash } from "node:crypto";

/**
 * HaveIBeenPwned range check, by k-anonymity.
 *
 * The password never leaves this process. It is SHA-1'd locally and only the
 * first five hex characters of the digest are sent; the API answers with every
 * suffix sharing that prefix — a few hundred to a few thousand — and the match
 * happens here. The service learns a 5-character prefix shared by roughly
 * 1/1,048,576 of the keyspace, and nothing else.
 *
 * SHA-1 is not a security choice. It is the digest HIBP's corpus is indexed by.
 */

const RANGE_ENDPOINT = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 3_000;

/**
 * Identifies the caller, per HIBP's acceptable-use guidance. A generic or
 * absent agent is liable to be rate-limited.
 */
const USER_AGENT = "whatsapp-os-signup-breach-check";

/**
 * A result, not a boolean.
 *
 * `checked: false` is a distinct outcome from "not breached" and the caller
 * must be able to tell them apart: signup proceeds either way, but only the
 * unchecked case writes an audit row recording that the control did not run.
 * Collapsing both into `false` loses that permanently, and the gap becomes
 * invisible exactly when it matters.
 */
export type BreachCheck =
  | { checked: true; breached: boolean }
  | { checked: false; reason: string };

function sha1Hex(value: string): string {
  return createHash("sha1")
    .update(value.normalize("NFKC"), "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * Parse a range response into the suffixes it contains.
 *
 * With Add-Padding the response includes synthetic entries with a count of 0,
 * present only to make every response a similar size so an observer cannot
 * infer the answer from the length. They are dropped here; treating one as a
 * hit would reject a perfectly good password.
 */
function findSuffix(body: string, suffix: string): boolean {
  for (const line of body.split("\n")) {
    const [candidate, countRaw] = line.trim().split(":");
    if (!candidate || candidate.toUpperCase() !== suffix) continue;

    const count = Number(countRaw ?? "0");
    return Number.isFinite(count) && count > 0;
  }
  return false;
}

export async function checkPasswordBreached(
  password: string,
): Promise<BreachCheck> {
  const digest = sha1Hex(password);
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  let response: Response;
  try {
    response = await fetch(`${RANGE_ENDPOINT}${prefix}`, {
      headers: {
        /* Uniform response sizes, so length does not leak the answer. */
        "Add-Padding": "true",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    /*
     * Fail open. HIBP being unreachable must not take the signup funnel down
     * with it — the password has still passed length checks and the bundled
     * denylist. The caller records the gap.
     */
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${TIMEOUT_MS}ms`
        : `request failed: ${error instanceof Error ? error.message : String(error)}`;
    return { checked: false, reason };
  }

  if (!response.ok) {
    return { checked: false, reason: `HTTP ${response.status}` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return {
      checked: false,
      reason: `could not read response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return { checked: true, breached: findSuffix(body, suffix) };
}
