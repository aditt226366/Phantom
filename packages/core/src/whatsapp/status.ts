/**
 * How far a message has got, and the rule that it only ever moves forward.
 *
 * Meta delivers status callbacks out of order. A "sent" arriving after a "read"
 * is normal traffic, not a fault, and applying it would walk the thread
 * backwards - the customer's message showing as on-its-way after they have
 * already been seen reading it.
 */

export const MESSAGE_STATUSES = [
  "PENDING",
  "SENT",
  "FAILED",
  "DELIVERED",
  "READ",
] as const;

export type MessageStatusName = (typeof MESSAGE_STATUSES)[number];

/**
 * The ladder. A plain integer map, and it must stay one.
 *
 * ---------------------------------------------------------------------------
 * This has to be expressible in SQL
 * ---------------------------------------------------------------------------
 *
 * The advance is a single statement:
 *
 *     UPDATE messages SET status = $new
 *      WHERE wamid = $1 AND status = ANY($below)
 *
 * The comparison happens inside the UPDATE because it has to. Reading the
 * current status, comparing in JavaScript and writing back is a
 * read-modify-write, and two workers processing "delivered" and "read"
 * concurrently would interleave between the read and the write - losing exactly
 * the out-of-order delivery this exists to handle. The race is not theoretical;
 * it is the common case for a message that is read the moment it arrives.
 *
 * So the rank must be inlinable: either as the ANY(...) list above, or as a
 * CASE expression over the column. Both are derived from this map by the
 * helpers below.
 *
 * Which means: keep this DATA. No function calls, no conditionals, no
 * derivation at runtime. The moment the rank has logic in it, it can no longer
 * be rendered into a statement, and whoever needs it in SQL will write a second
 * copy of the ordering by hand.
 *
 * ---------------------------------------------------------------------------
 * Why FAILED sits above SENT rather than below
 * ---------------------------------------------------------------------------
 *
 * Meta emits `failed` after `sent` for downstream rejections - the handset is
 * unreachable, the number is not on WhatsApp. Ranked below SENT, that failure
 * would be discarded and the message would read as on-its-way for ever.
 *
 * Below DELIVERED, because nothing is ever delivered and then failed. A stale
 * `failed` arriving after a real delivery is the same kind of reordering as a
 * stale `sent`, and gets the same treatment.
 */
const MESSAGE_STATUS_RANK: Readonly<Record<MessageStatusName, number>> = {
  PENDING: 0,
  SENT: 1,
  FAILED: 2,
  DELIVERED: 3,
  READ: 4,
};

export function statusRank(status: MessageStatusName): number {
  return MESSAGE_STATUS_RANK[status];
}

/** Whether a string is one of the statuses this build can rank. */
export function isRankedStatus(value: string): value is MessageStatusName {
  return Object.prototype.hasOwnProperty.call(MESSAGE_STATUS_RANK, value);
}

/**
 * Meta's status strings, mapped onto the ladder.
 *
 * Null for anything unrecognised, and that is the contract the ingest path
 * depends on - see the note below. PENDING has no Meta equivalent: it means
 * accepted by us and not yet handed over.
 */
const FROM_META: Readonly<Record<string, MessageStatusName>> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

/**
 * Translate one of Meta's status strings, or return null.
 *
 * Null rather than a throw, and the distinction matters more than it looks.
 *
 * Status is Meta's vocabulary, not ours - the same test that made
 * message.type a text column rather than an enum. The four above are stable,
 * but Meta has shipped others historically and can ship another tomorrow. A
 * parser that threw on an unknown value would turn a routine delivery-status
 * webhook into a failed insert, on the ingest path, where nobody is watching
 * and the delivery retries until Meta gives up.
 *
 * So an unrecognised status is not an error. The raw value survives in
 * whatsapp_webhook_events.payload, which stores the body verbatim for exactly
 * this reason; the rank comparison is skipped; and the message stays where it
 * was. Nothing is lost and nothing fails.
 */
export function statusFromMeta(raw: string): MessageStatusName | null {
  return FROM_META[raw.toLowerCase()] ?? null;
}

/**
 * The statuses strictly below `incoming`, for the SQL guard.
 *
 * Strictly, so an identical status arriving twice is excluded. Meta redelivers,
 * and the same status arriving again is the ordinary case rather than the
 * exotic one - it must be a no-op affecting zero rows, not an error and not a
 * pointless write that bumps updated_at.
 */
export function statusesBelow(
  incoming: MessageStatusName,
): readonly MessageStatusName[] {
  const limit = MESSAGE_STATUS_RANK[incoming];
  return MESSAGE_STATUSES.filter((status) => MESSAGE_STATUS_RANK[status] < limit);
}

/**
 * The rank as a SQL CASE expression over `column`.
 *
 * Rendered from the same map rather than written out by hand, because a second
 * copy of the ordering is a second thing to get wrong - and it would only be
 * wrong for the one status somebody forgot, which is the status that then walks
 * backwards.
 *
 * Provided for the callers that want an inline comparison rather than the
 * ANY(...) list. Both are the same ordering by construction, and a test asserts
 * it by executing this against the database.
 */
export function statusRankSqlCase(column: string): string {
  const arms = MESSAGE_STATUSES.map(
    (status) => `WHEN '${status}' THEN ${MESSAGE_STATUS_RANK[status]}`,
  ).join(" ");

  return `CASE ${column} ${arms} END`;
}

/**
 * The ladder applied in memory: the further of the two, never backwards.
 *
 * `incoming` is a raw string rather than a typed status, because the callers
 * are handling Meta's payloads and an unknown value must reach a decision
 * rather than a type error. Unknown means "leave it alone".
 */
/*
 * A note on `>` versus `>=` below, because flipping it produces no test
 * failure and that looks like a gap.
 *
 * It is not one. Ranks are unique - asserted by the no-ties test - so equal
 * rank means the two statuses ARE the same status, and returning `next` or
 * `current` returns the same value. The operators are indistinguishable here.
 *
 * They are not indistinguishable in statusesBelow, which is what the SQL guard
 * uses, and where `<=` would include the incoming status and make a duplicate
 * callback rewrite a row it already agrees with. That case is covered, and it
 * is the one that reaches the database.
 */
export function advanceStatus(
  current: MessageStatusName,
  incoming: string,
): MessageStatusName {
  const next = isRankedStatus(incoming) ? incoming : statusFromMeta(incoming);
  if (next === null) return current;

  return MESSAGE_STATUS_RANK[next] > MESSAGE_STATUS_RANK[current] ? next : current;
}
