/**
 * Reading back what a producer stored, and why that is its own module.
 *
 * ---------------------------------------------------------------------------
 * These two are the consumer half of a jsonb column
 * ---------------------------------------------------------------------------
 *
 * `messages.template_payload` and `messages.interactive_payload` are written by
 * four producers - bulk, lead sources, flows and Verse campaigns - and read by
 * exactly one, the send worker. Both halves were correct in isolation for seven
 * phases and nothing asserted that they AGREE, because the writer lives in
 * packages/db and the reader lived inside the worker where no database test
 * could reach it.
 *
 * They are here so that one can. `verse`-era or not, a round-trip test now
 * writes a real row through the real producer and reads the real jsonb back
 * through these, which is the only thing that can catch a serialisation
 * mismatch: a hand-written fixture object agrees with the reader by
 * construction and proves nothing about what Postgres actually stored.
 *
 * ---------------------------------------------------------------------------
 * Returning null is deliberate and is NOT sufficient on its own
 * ---------------------------------------------------------------------------
 *
 * Both parse defensively, because the column holds whatever was written and a
 * row from an older build must not make the worker throw on every attempt.
 *
 * What that costs, and what the caller therefore owes: a null here used to mean
 * the worker sent the row as ordinary TEXT. For a row typed `template` that is
 * a different message than the one intended, and outside a 24-hour window Meta
 * refuses it - so a payload fault surfaced as a WINDOW error on a message whose
 * window was fine. The caller must now record the fault instead. See
 * `stored_payload_unreadable` in send-policy.ts.
 */

/**
 * What a template row carries, or null if this is an ordinary text.
 *
 * Parsed defensively because `template_payload` is jsonb: the column will hold
 * whatever was written, and a row half-written by an older build must not make
 * the worker throw on every attempt. A payload it cannot read is treated as a
 * text send, which is the safe direction - the message goes out as its body
 * rather than as a template nobody could reconstruct.
 */
export function readTemplatePayload(raw: unknown): {
  name: string;
  language: string;
  parameters: string[];
  buttonPayloads: string[];
} | null {
  if (!raw || typeof raw !== "object") return null;

  const payload = raw as Record<string, unknown>;
  const name = payload["name"];
  const language = payload["language"];

  if (typeof name !== "string" || typeof language !== "string") return null;

  const parameters = Array.isArray(payload["parameters"])
    ? payload["parameters"].filter((v): v is string => typeof v === "string")
    : [];

  /* Absent on every template row written before flows existed, and on every
     one written since by a producer with no buttons to fill. */
  const buttonPayloads = Array.isArray(payload["buttonPayloads"])
    ? payload["buttonPayloads"].filter((v): v is string => typeof v === "string")
    : [];

  return { name, language, parameters, buttonPayloads };
}

/**
 * What an interactive row carries, or null if this is not one.
 *
 * Parsed as defensively as the template payload beside it and for the same
 * reason: the column is jsonb and holds whatever was written. A payload this
 * cannot read falls through to a text send of the row's body, which is the
 * safe direction - the customer gets the question without the buttons rather
 * than nothing at all, and the thread shows what happened.
 *
 * The shape is only checked as far as Meta needs it to be. Rebuilding it from
 * the flow version instead would be the tempting alternative and is wrong: the
 * ids inside name a specific run and node, and re-deriving them at send time
 * would silently repair a payload whose ids no longer match the run - turning
 * a bug into a question a customer actually receives.
 */
export function readInteractivePayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const payload = raw as Record<string, unknown>;
  const type = payload["type"];

  if (type !== "button" && type !== "list") return null;
  if (!payload["action"] || typeof payload["action"] !== "object") return null;

  return payload;
}
