/**
 * What Meta will actually let a number send, and what to do when it says no.
 *
 * Two separate ceilings, and confusing them is the mistake this file exists to
 * prevent:
 *
 *   the gap    OUR pacing. 800ms between sends, tenant-configurable. It shapes
 *              the rate, and Meta has no opinion about it.
 *   the tier   META'S limit. A cap on how many UNIQUE recipients a number may
 *              start conversations with in a rolling 24 hours. This is the
 *              real ceiling, and no amount of slowing down gets past it.
 *
 * A broadcast paced perfectly and larger than the tier does not fail at the
 * end; it fails partway through with a rate-limit error, having already sent
 * to some of the list. Which is why the confirm screen reports headroom rather
 * than only duration.
 */

/**
 * Meta's messaging tiers, as unique recipients per rolling 24 hours.
 *
 * The vocabulary is Meta's and the column is TEXT for the reason
 * 20260816100000 gives about number status: they have changed these sets twice
 * already, and a value this build has never seen must not fail a write.
 *
 * So an unrecognised tier is not an error here - it is `null` capacity, which
 * means "we cannot say", and every caller has to decide what to do about that
 * rather than being handed a number that was guessed.
 */
const TIER_CAPACITY: Record<string, number | null> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  /* Meta's own name for "no cap". Null rather than Infinity, so the
     unlimited case and the unknown case are distinguished below. */
  TIER_UNLIMITED: null,
};

export type TierKnowledge =
  /** A tier we recognise, with a number attached. */
  | { known: true; unlimited: false; capacity: number }
  /** Recognised, and Meta imposes no cap. */
  | { known: true; unlimited: true }
  /** Not a tier this build knows, or none recorded yet. */
  | { known: false };

/**
 * What we know about a number's cap.
 *
 * Deliberately three states rather than a number with a sentinel. "Unlimited"
 * and "we have not been told" are completely different facts to put in front
 * of somebody about to message ten thousand people, and a single number would
 * have to lie about one of them.
 */
export function tierCapacity(tier: string | null | undefined): TierKnowledge {
  if (!tier) return { known: false };

  /*
   * Read once and test for undefined, rather than an `in` guard followed by an
   * index. Under noUncheckedIndexedAccess the second read is
   * `number | null | undefined` however the first one narrowed, and the two
   * absent cases mean different things here: undefined is "not a tier we
   * recognise" and null is "recognised, no cap".
   */
  const capacity = TIER_CAPACITY[tier];

  if (capacity === undefined) return { known: false };

  return capacity === null
    ? { known: true, unlimited: true }
    : { known: true, unlimited: false, capacity };
}

export interface TierHeadroom {
  tier: string | null;
  knowledge: TierKnowledge;
  /** Unique recipients already started with in the rolling window. */
  used: number;
  /** How many more this number may reach. Null when unknown or unlimited. */
  remaining: number | null;
  /** Recipients this broadcast would exceed the cap by. Zero when it fits. */
  over: number;
}

/**
 * Does this audience fit in what is left of the number's 24-hour allowance?
 *
 * `used` is counted by the caller, which needs the database: unique contacts
 * this number has started a conversation with since now - 24h.
 *
 * An unknown tier reports `remaining: null` and `over: 0` - it does not block.
 * Failing closed here would stop a tenant broadcasting because a metadata
 * refresh has not run, which is a self-inflicted outage for a limit Meta will
 * enforce itself. What protects the run instead is the backoff below: 130472
 * and 131049 arrive when the cap is really hit, and the drip pauses. The
 * confirm screen says we cannot read the tier rather than pretending a number.
 */
export function tierHeadroom(
  tier: string | null | undefined,
  used: number,
  audienceSize: number,
): TierHeadroom {
  const knowledge = tierCapacity(tier);

  if (!knowledge.known || knowledge.unlimited) {
    return {
      tier: tier ?? null,
      knowledge,
      used,
      remaining: null,
      over: 0,
    };
  }

  const remaining = Math.max(0, knowledge.capacity - used);

  return {
    tier: tier ?? null,
    knowledge,
    used,
    remaining,
    over: Math.max(0, audienceSize - remaining),
  };
}

/* ------------------------------------------------------------------------- *
 * What Meta's refusals mean for a run
 * ------------------------------------------------------------------------- */

export type BulkErrorAction =
  /**
   * The number is being rate limited. Stop the run and let a person restart
   * it, rather than burning through the rest of the list against a wall.
   */
  | "backoff"
  /**
   * This handset cannot receive WhatsApp. Mark the contact and skip it in
   * every future broadcast - it is a fact about the number, not about us.
   */
  | "undeliverable"
  /** An ordinary failure. The message row records it; the run carries on. */
  | "continue";

/**
 * Meta's codes that mean "slow down or stop", each for a different reason.
 *
 * Grouped because the response is identical and the distinction is not ours to
 * act on - what matters is that four different numbers all mean the run cannot
 * usefully continue right now.
 *
 *   131049  Meta declined to deliver for quality reasons - the per-user
 *           marketing limit. It is per RECIPIENT, not per sender, so the run
 *           is not necessarily doomed; but a burst of these means the template
 *           is landing badly and continuing damages the number's rating.
 *   130472  The recipient is in an experiment group and the message was not
 *           delivered. Arrives in waves.
 *   131056  Pair rate limit: too many messages between this number and that
 *           one in a short window.
 *   133016  The number is rate limited outright.
 */
const BACKOFF_CODES = new Set([131049, 130472, 131056, 133016]);

/** The handset cannot receive WhatsApp at all. */
const UNDELIVERABLE_CODES = new Set([131026]);

export function classifyBulkError(code: number | null | undefined): BulkErrorAction {
  if (code === null || code === undefined) return "continue";
  if (UNDELIVERABLE_CODES.has(code)) return "undeliverable";
  if (BACKOFF_CODES.has(code)) return "backoff";
  return "continue";
}

/* ------------------------------------------------------------------------- *
 * Pacing arithmetic
 * ------------------------------------------------------------------------- */

/**
 * When the nth recipient of a broadcast should be sent, as a delay from start.
 *
 * Computed at enqueue and handed to BullMQ as `delay`, which is what makes the
 * schedule deterministic and restart-proof: the queue holds the plan, so a
 * worker that dies and comes back finds every remaining send still due at the
 * time it was always going to be due. No scheduler, no ticking loop, and
 * nothing to catch up on.
 *
 * The first recipient goes immediately - index 0, delay 0 - because a
 * broadcast that waited 800ms to start would look broken for the first second
 * of every run somebody watched.
 */
export function sendDelayMs(index: number, gapMs: number): number {
  return index * gapMs;
}

/** How long the whole run takes, for the confirm screen. */
export function estimatedDurationMs(recipients: number, gapMs: number): number {
  /* n recipients means n-1 gaps: the first is immediate. A run of one takes no
     time at all, which is the right answer and not an edge case to special
     case. */
  return Math.max(0, recipients - 1) * gapMs;
}

/** "about 4 minutes", "about 2 hours 10 minutes". Never a bare millisecond count. */
export function describeDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);

  if (totalMinutes < 1) return "under a minute";
  if (totalMinutes < 60) {
    return `about ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const hoursPart = `${hours} hour${hours === 1 ? "" : "s"}`;
  if (minutes === 0) return `about ${hoursPart}`;

  return `about ${hoursPart} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
