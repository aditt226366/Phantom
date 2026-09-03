/**
 * What each countable thing costs.
 *
 * The source of truth for which usage kinds exist and what they are worth. The
 * database stores `kind` as text precisely so this list can be the only place
 * a kind is defined: a second list there could only ever disagree with this
 * one, and db depends on core rather than the reverse, so a Prisma enum is not
 * importable here anyway.
 *
 * ---------------------------------------------------------------------------
 * Micros
 * ---------------------------------------------------------------------------
 *
 * Prices are in millionths of one unit of the entry's currency. 1_000_000
 * micros is ₹1. Sub-cent prices are the reason: an AI reply costing $0.0003 is
 * 300 micros, and rounds to zero in any minor-unit column. Everything stays an
 * integer until something is displayed.
 *
 * ---------------------------------------------------------------------------
 * Versioning
 * ---------------------------------------------------------------------------
 *
 * ACTIVE_PRICE_VERSION is stamped onto every row at the moment it is written.
 * Changing a price means adding entries at a new version and bumping the
 * constant - never editing an existing entry, because rows already stamped
 * with the old version must keep meaning what they meant. A reprice then
 * affects the future only, and "what was this charged under" stays answerable.
 *
 * ---------------------------------------------------------------------------
 * Currency comes from the entry
 * ---------------------------------------------------------------------------
 *
 * Never from the caller. A caller that picks the currency is a caller that can
 * record an INR price as USD, and the error is invisible: the number is
 * plausible, the column says USD, and it is wrong by a factor of eighty.
 */

export const USAGE_KINDS = [
  "integration.verify",
  /*
   * One outbound message we handed to Meta. Deduped on our own message id, not
   * on the wamid: the wamid does not exist until Meta answers, so a send that
   * times out and is retried produces a second wamid for the same message row
   * - and this table becomes an invoice.
   */
  "whatsapp.message.sent",
  /*
   * One 24-hour conversation window Meta told us was billable, per category.
   *
   * The category is in the kind rather than a column because the price list is
   * keyed on kind, and Meta charges these at genuinely different rates.
   */
  "whatsapp.conversation.marketing",
  "whatsapp.conversation.utility",
  "whatsapp.conversation.authentication",
  "whatsapp.conversation.service",
  /*
   * One metadata read of a company's numbers. Meta charges nothing for it and
   * it is recorded anyway: it is an API call we chose to make, it is the thing
   * a dashboard would otherwise make on every render, and a rate that starts
   * climbing is the first sign somebody wired it to a page load after all.
   */
  "whatsapp.numbers.refresh",
  /*
   * One Verse answer, deduped on OUR message id.
   *
   * The message id and not the job id, and not the wamid. The job can be
   * retried and the wamid does not exist until Meta answers, so either would
   * charge twice for one answer - and this table is an invoice.
   *
   * Recorded even when the answer is a handoff, because the model call
   * happened and cost real money whether or not the customer got an answer
   * out of it. A usage record that only counts successes under-reports spend
   * in exactly the situations where somebody is asking why the bill is high.
   */
  "verse.reply",
  /*
   * One embedding call during ingestion, deduped on the document.
   *
   * Per document rather than per chunk: a 2,000-chunk PDF is one act of
   * ingestion that a tenant asked for once, and a per-chunk row would make the
   * usage table larger than the thing it measures.
   */
  "verse.embedding",
  /*
   * One lead score. Always on the cheapest tier - see VERSE_SCORING_TIER.
   *
   * Its own kind rather than folded into verse.reply, because it runs on every
   * inbound message of every campaign and is therefore the highest-VOLUME
   * thing in the phase while being the cheapest per call. Collapsed together,
   * nobody could tell a tenant whose bill is answers from one whose bill is
   * scoring.
   */
  "verse.lead_score",
  /*
   * One day of one campaign's ad spend, as Meta reported it.
   *
   * The only kind in this list whose cost we do NOT set. Every other entry
   * records something we did and will price later against a rate card; this
   * one records money the tenant has ALREADY been charged by Meta, in the ad
   * account's own currency, and the amount is theirs rather than ours.
   *
   * That is why its price entry is not the answer and the cost is carried on
   * the row. A priced entry here would be a second opinion about a number
   * somebody has already been billed for.
   *
   * Deduped per (account, campaign, day), so the nightly re-read of a
   * 28-day window restates rather than accumulates - the same key the
   * insights table itself uses, for the same reason.
   */
  "meta.ad.spend",
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/** Bump when any price changes. Never edit an entry in place. */
export const ACTIVE_PRICE_VERSION = 1;

export interface UsagePrice {
  kind: UsageKind;
  /** ISO 4217. */
  currency: string;
  version: number;
  /** Millionths of one currency unit, per unit of quantity. */
  micros: number;
}

/**
 * Keyed on (kind, currency, version), so the same kind can be priced in more
 * than one currency later - Meta bills in the ad account's own currency, and
 * that is a Phase 5 problem this shape leaves room for.
 *
 * Verification calls are priced at zero rather than left out. They cost real
 * money to serve and will not stay free, and an explicit zero is a decision;
 * an absent entry is an oversight. The two are distinguishable here and would
 * not be in the table.
 */
/*
 * ---------------------------------------------------------------------------
 * This table does not model Meta's pricing, and should not try
 * ---------------------------------------------------------------------------
 *
 * The WhatsApp entries are zero, like the integration ones, and that is a
 * deliberate refusal rather than a placeholder waiting to be filled in.
 *
 * Meta's per-message pricing has changed twice recently, varies by country and
 * by category, and is reconciled against an invoice we do not have an API for
 * yet. A table here with plausible numbers in it would be an approximation
 * that silently disagrees with what the customer is actually charged - and a
 * billing figure that is quietly wrong is worse than one that is openly an
 * estimate, because nobody checks the first kind.
 *
 * So we record the facts we own: a message was sent, a conversation window
 * opened, which category Meta said it was. Those are ours and they are
 * correct. Turning them into money against Meta's real rate card is Phase 11,
 * with their billing API, and it will price these same events retrospectively
 * because every row carries the price version it was written under.
 */
const PRICES: readonly UsagePrice[] = [
  { kind: "integration.verify", currency: "INR", version: 1, micros: 0 },
  { kind: "whatsapp.message.sent", currency: "INR", version: 1, micros: 0 },
  { kind: "whatsapp.conversation.marketing", currency: "INR", version: 1, micros: 0 },
  { kind: "whatsapp.conversation.utility", currency: "INR", version: 1, micros: 0 },
  { kind: "whatsapp.conversation.authentication", currency: "INR", version: 1, micros: 0 },
  { kind: "whatsapp.conversation.service", currency: "INR", version: 1, micros: 0 },
  { kind: "whatsapp.numbers.refresh", currency: "INR", version: 1, micros: 0 },
  /*
   * Zero, like everything else here, and for the same reason: this table
   * records the facts we own - a call happened, against this company, at this
   * moment - and turning them into money against a real rate card is Phase 11.
   *
   * Verse is the first kind where we DO know the price at call time: the
   * provider returns token counts and the rate card is public. It is still
   * zero, deliberately, because a priced row here beside seven unpriced ones
   * would make "Est. spend this month" look complete while omitting every
   * WhatsApp charge - a number that is wrong in the direction of reassuring.
   * Every row carries its price version, so these are repriceable in arrears.
   */
  { kind: "verse.reply", currency: "INR", version: 1, micros: 0 },
  { kind: "verse.embedding", currency: "INR", version: 1, micros: 0 },
  { kind: "verse.lead_score", currency: "INR", version: 1, micros: 0 },
  /* Zero, and here it means something different from the seven above.
     Those are unpriced because Phase 11 will price them; this one has no
     price of OURS at all - the real figure is Meta's, it is on the row, and
     it is denominated in a currency this table cannot express per-kind. */
  { kind: "meta.ad.spend", currency: "INR", version: 1, micros: 0 },
];

/** The conversation kind for one of Meta's pricing categories, if we know it. */
export function conversationUsageKind(category: string): UsageKind | null {
  const kind = `whatsapp.conversation.${category.toLowerCase()}`;
  return (USAGE_KINDS as readonly string[]).includes(kind)
    ? (kind as UsageKind)
    : null;
}

function priceKey(kind: string, currency: string, version: number): string {
  return `${kind}|${currency}|${version}`;
}

export const USAGE_PRICES: ReadonlyMap<string, UsagePrice> = new Map(
  PRICES.map((price) => [
    priceKey(price.kind, price.currency, price.version),
    price,
  ]),
);

/**
 * The price for a kind at a version, or nothing.
 *
 * Returns rather than throws. A usage record must never be the thing that
 * fails a provider call that already succeeded - the work happened, the
 * customer is owed it, and refusing to record it because a price list is
 * incomplete loses the event entirely. The caller writes a null cost and the
 * reason instead.
 *
 * Ambiguity is impossible rather than handled: a test asserts no (kind,
 * version) has entries in two currencies, so the first match is the only
 * match. When multi-currency pricing arrives it needs an explicit resolution
 * rule, and that test failing is how it gets asked for.
 */
export function findPrice(
  kind: string,
  version: number = ACTIVE_PRICE_VERSION,
): UsagePrice | undefined {
  for (const price of USAGE_PRICES.values()) {
    if (price.kind === kind && price.version === version) return price;
  }
  return undefined;
}

export interface PricedUsage {
  /** Null when nothing priced this kind. Never 0 as a stand-in. */
  costMicros: bigint | null;
  currency: string | null;
  priceVersion: number;
  unpricedReason: string | null;
}

/**
 * The pricing decision, separated from the write.
 *
 * Two callers store usage — the tenant path through withCompany and the admin
 * panel through the admin client — and only the client differs. Duplicating
 * the lookup is how the same event ends up charged two different amounts
 * depending on who triggered it.
 */
export function priceUsage(kind: string, quantity: number): PricedUsage {
  const price = findPrice(kind, ACTIVE_PRICE_VERSION);

  if (!price) {
    return {
      costMicros: null,
      currency: null,
      priceVersion: ACTIVE_PRICE_VERSION,
      unpricedReason: `no price for kind "${kind}" at version ${ACTIVE_PRICE_VERSION}`,
    };
  }

  return {
    costMicros: BigInt(price.micros) * BigInt(quantity),
    currency: price.currency,
    priceVersion: ACTIVE_PRICE_VERSION,
    unpricedReason: null,
  };
}

/**
 * A deterministic idempotency key.
 *
 * Same inputs, same key, so a retried job's insert collides with the row its
 * first attempt already wrote. Colons because the parts are ids, which do not
 * contain them.
 */
export function usageDedupeKey(
  kind: UsageKind,
  ...parts: readonly string[]
): string {
  return [kind, ...parts].join(":");
}
