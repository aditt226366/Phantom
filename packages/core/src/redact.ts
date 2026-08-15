import { ALL_INTEGRATION_KEYS } from "./integrations.ts";

/**
 * Keeping secrets out of logs, stored errors and debug panels.
 *
 * ---------------------------------------------------------------------------
 * This is defence in depth, not the control
 * ---------------------------------------------------------------------------
 *
 * The control is that a plaintext credential is never stored and never
 * returned: the vault is write-only, decryption happens inside the provider
 * call, and nothing hands a secret back to a caller. If that holds, none of
 * this is needed.
 *
 * This exists for the case it does not cover — a provider echoing our own
 * credential back at us. Meta's error bodies quote request parameters,
 * including the access token, and that response is exactly what an operator
 * wants to see in "debug details". So a value we correctly never logged arrives
 * back inside somebody else's error message, and gets written to
 * integration_verifications.error by code that is doing the right thing.
 *
 * ---------------------------------------------------------------------------
 * Two mechanisms, because neither covers the other
 * ---------------------------------------------------------------------------
 *
 * redactKeys() removes values sitting under a name that says what they are:
 * `{ WHATSAPP_ACCESS_TOKEN: "EAAG..." }`, an `authorization` header, a cookie.
 * It cannot help when the secret is loose inside a sentence.
 *
 * scrubValues() removes known plaintext values wherever they appear, which is
 * the echo case — the token is in the middle of a message string, under no key
 * at all. It requires knowing the secret, which the caller does at exactly the
 * moment it matters: it has just decrypted it to make the request that failed.
 */

export const REDACTED = "[redacted]";

/**
 * Names that mean "this is a credential", beyond the provider registry.
 *
 * The registry alone misses the common case. A failed fetch reports its request
 * headers, and the token is under `authorization` — a name no provider ever
 * declared, and the single most likely place for a credential to appear in an
 * error.
 */
const GENERIC_SECRET_NAMES = [
  "password",
  "token",
  "secret",
  "authorization",
  "api_key",
  "cookie",
  "set-cookie",
  "private_key",
];

/**
 * Case- and separator-insensitive, so GOOGLE_PRIVATE_KEY, googlePrivateKey and
 * google-private-key are one name. JSON from three sources uses three
 * conventions and the redactor should not care which.
 */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const REGISTRY_NAMES = new Set(ALL_INTEGRATION_KEYS.map(normalise));
const GENERIC_NAMES = GENERIC_SECRET_NAMES.map(normalise);

/**
 * Registry names match exactly; generic names match as substrings.
 *
 * `accessToken`, `x-api-key` and `refresh_token` all need to match, and they
 * are not enumerable in advance. Over-redaction is the safe direction: a
 * redacted `tokenCount` costs a debugging session, a printed token costs a
 * credential rotation.
 */
export function isSecretKey(name: string): boolean {
  const normalised = normalise(name);
  if (REGISTRY_NAMES.has(normalised)) return true;
  return GENERIC_NAMES.some((generic) => normalised.includes(generic));
}

/**
 * Secrets shorter than this are left alone by scrubValues.
 *
 * Not hypothetical: WHATSAPP_PHONE_NUMBER_ID is stored in the vault, is passed
 * to the scrubber with everything else, and is neither long nor secret.
 * Replacing a short value turns a log into mush — a 3-character id matches
 * inside timestamps, ids and ordinary words — and the result is unreadable
 * exactly when someone is trying to read it. An empty string is worse: it
 * matches at every position and replaces the entire message with separators.
 */
const MIN_SCRUBBABLE_LENGTH = 8;

/**
 * Values that look like credentials wherever they appear in text.
 *
 * These catch what scrubValues cannot: a token that was never in our registry,
 * because it belongs to somebody else or because the provider generated it.
 * Node's fetch errors embed the request URL, and Meta puts access_token in the
 * query string, so this fires on ordinary error handling rather than on
 * anything exotic.
 */
const QUERY_PARAMETER =
  /\b(access_token|refresh_token|api_key|apikey|client_secret|password|token|secret|signature|sig|key)=([^&\s"'<>]+)/gi;

/** `Authorization: Bearer <token>`, as it appears once flattened into text. */
const BEARER_TOKEN = /\b(bearer)\s+([\w.~+/-]+=*)/gi;

/**
 * Remove known plaintext secrets from a string.
 *
 * split/join rather than a RegExp: a credential can contain any character, and
 * building a pattern from one means escaping it correctly every time. String
 * splitting has no metacharacters to get wrong.
 */
export function scrubValues(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let out = text;

  for (const secret of secrets) {
    if (typeof secret !== "string") continue;
    if (secret.length < MIN_SCRUBBABLE_LENGTH) continue;
    if (!out.includes(secret)) continue;

    out = out.split(secret).join(REDACTED);
  }

  return out;
}

/** Pattern scrubbing plus known-value scrubbing, in that order. */
export function scrubText(
  text: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  const patterned = text
    .replace(QUERY_PARAMETER, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(BEARER_TOKEN, (_match, scheme: string) => `${scheme} ${REDACTED}`);

  return scrubValues(patterned, secrets);
}

/**
 * Walk a value, removing anything that looks like a credential.
 *
 * Handles what actually turns up in a log call rather than only plain objects:
 *
 *   Error      its own properties are not enumerable, so a naive walk produces
 *              `{}` and throws the message away. Message and stack are walked
 *              as text, because a fetch failure carries the URL — and the query
 *              string — inside both.
 *   arrays     walked element-wise.
 *   cycles     tracked with a WeakSet. A circular object is ordinary in Node
 *              (a socket references its server), and hanging the logger is a
 *              worse outage than the one being logged.
 *   Buffer     reported as a length. Key material is a Buffer, and printing it
 *              byte by byte would be the exact failure this file prevents.
 */
export function redactKeys(
  value: unknown,
  secrets: readonly (string | undefined)[] = [],
): unknown {
  return walk(value, secrets, new WeakSet());
}

function walk(
  value: unknown,
  secrets: readonly (string | undefined)[],
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return scrubText(value, secrets);
  if (typeof value === "number" || typeof value === "boolean") return value;
  /* JSON.stringify throws on a bigint; a logger must not. */
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();

  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();

  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) return walkError(value, secrets, seen);
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, secrets, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : walk(entry, secrets, seen);
  }
  return out;
}

function walkError(
  error: Error,
  secrets: readonly (string | undefined)[],
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: scrubText(error.message, secrets),
  };

  if (error.stack !== undefined) {
    out["stack"] = scrubText(error.stack, secrets);
  }
  if (error.cause !== undefined) {
    out["cause"] = walk(error.cause, secrets, seen);
  }

  /* Attached properties: a fetch error's `url`, a Prisma error's `code`. */
  for (const [key, entry] of Object.entries(error)) {
    if (key === "name" || key === "message") continue;
    if (key === "stack" || key === "cause") continue;

    out[key] = isSecretKey(key) ? REDACTED : walk(entry, secrets, seen);
  }

  return out;
}
