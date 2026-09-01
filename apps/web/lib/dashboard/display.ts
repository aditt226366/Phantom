import {
  PLATFORM_TIMEZONE_LABEL,
  type RollupFreshness,
} from "@whatsapp-os/core";
import { describeWindow, windowBucket } from "@whatsapp-os/core/whatsapp";

/**
 * The dashboard's display decisions, as functions with return values.
 *
 * Here rather than inline in the components, and for a reason this repository
 * has already paid for once: a test that asserted the markup contained
 * "Reactivate" stayed green after the control was deleted, because the word
 * survived in a neighbouring heading. A branch worth getting right is a branch
 * worth returning a value from, and every one below is asserted directly.
 */

/** Badge has no warning tier, so the vocabulary is these three. */
export type Tone = "success" | "error" | "default";

/* ------------------------------------------------------------------------- *
   Number health
   ------------------------------------------------------------------------- */

/**
 * Whether a number's quality rating is something to act on today.
 *
 * The one figure on this page that is worth an interruption. Meta restricts a
 * number whose rating stays low, and a restricted number cannot be un-restricted
 * by asking - the business simply stops being able to message its customers.
 * The rating drops to YELLOW first, usually for days, and nothing in this
 * product told anybody.
 *
 * MEDIUM is included beside YELLOW because Meta reports this value under two
 * vocabularies depending on which surface it came from - the Graph field is
 * GREEN/YELLOW/RED and the Business Manager wording is high/medium/low. The
 * column is our enum and the refresh maps into it, but a value arriving as
 * UNKNOWN because a mapping missed is exactly the case that must not read as
 * healthy.
 */
export function qualityIsWarning(rating: string): boolean {
  return rating === "YELLOW" || rating === "MEDIUM";
}

export function qualityIsCritical(rating: string): boolean {
  return rating === "RED" || rating === "LOW";
}

export function qualityTone(rating: string): Tone {
  if (rating === "GREEN" || rating === "HIGH") return "success";
  if (qualityIsCritical(rating)) return "error";
  /*
   * Neutral for YELLOW and for UNKNOWN alike, because there is no warning
   * token in globals.css and inventing one here would be a literal outside that
   * file - rule 7. The warning is carried by the sentence the card renders
   * beside it, which says more than a colour could anyway.
   */
  return "default";
}

/**
 * The sentence a number in trouble gets, or null when there is nothing to say.
 *
 * A sentence rather than a colour, and it names the consequence rather than the
 * state. "Quality: YELLOW" is a fact nobody outside Meta's documentation can
 * act on; "Meta restricts numbers that stay here" is the same fact with the
 * stakes attached.
 */
export function qualityWarning(rating: string): string | null {
  if (qualityIsCritical(rating)) {
    return "Meta has rated this number low. Sending more marketing from it risks a restriction that cannot be appealed quickly.";
  }
  if (qualityIsWarning(rating)) {
    return "Quality has dropped. Meta restricts numbers that stay here, so slow down marketing sends and check what recent recipients were sent.";
  }
  if (rating === "UNKNOWN") {
    return "Meta has not reported a rating for this number yet.";
  }
  return null;
}

/**
 * Meta's tier string as a number of unique recipients per rolling 24 hours.
 *
 * Text in, text out for anything unrecognised. The tier vocabulary is Meta's
 * and has changed twice; a tier they ship next month must render as itself at
 * 3am rather than as "Unknown", which is the same rule
 * whatsapp_numbers.messaging_tier is a text column for.
 */
export function tierLabel(tier: string | null): string {
  if (!tier) return "Not reported";

  switch (tier) {
    case "TIER_50":
      return "50 customers / day";
    case "TIER_250":
      return "250 customers / day";
    case "TIER_1K":
      return "1,000 customers / day";
    case "TIER_10K":
      return "10,000 customers / day";
    case "TIER_100K":
      return "100,000 customers / day";
    case "TIER_UNLIMITED":
      return "Unlimited";
    default:
      return tier;
  }
}

/* ------------------------------------------------------------------------- *
   Freshness
   ------------------------------------------------------------------------- */

/**
 * How old the numbers are, in words.
 *
 * Always says something. A dashboard that shows an age only when it is bad
 * teaches people that no line means live, and the whole point of a rollup is
 * that nothing here is live.
 *
 * ---------------------------------------------------------------------------
 * A fresh reading carries NO number, and that is deliberate twice over
 * ---------------------------------------------------------------------------
 *
 * The product reason: while the refresh is running, the exact age is not a
 * fact anybody acts on. Every value between zero and the stale threshold means
 * the same thing - the figures are current - and printing "37 seconds" invites
 * watching a number tick instead of reading the page. The distinction that
 * matters is binary: being refreshed, or not.
 *
 * The fixture reason, which is why this is a rule rather than a preference: an
 * age that ticks is a rendered value that differs between the seed and the
 * screenshot, so the baseline never matches twice and the suite is diagnosed as
 * flaky rather than as a fixture. The conventions state the general form of
 * this for the 24-hour window - a state or a coarse bucket, never an instant -
 * and a duration counted from a stored timestamp is the same hazard.
 *
 * Past the threshold the age IS the content, because "how long has this been
 * broken" is the question, and by then it is coarse enough not to tick.
 */
export function freshnessLabel(freshness: RollupFreshness): string {
  if (freshness.state === "never") {
    return "Not counted yet — the first refresh runs within a minute.";
  }

  if (freshness.state === "fresh") {
    return "Counted within the last few minutes";
  }

  const { ageSeconds } = freshness;
  const age =
    ageSeconds < 3600
      ? `${Math.round(ageSeconds / 60)} minutes ago`
      : ageSeconds < 86_400
        ? `${Math.round(ageSeconds / 3600)} hours ago`
        : `${Math.round(ageSeconds / 86_400)} days ago`;

  return `Last counted ${age}. The refresh does not appear to be running.`;
}

/**
 * The notice shown when the rollup's "today" is not today.
 *
 * Its own message rather than folding into staleness, because the two are
 * different problems with different remedies and one of them looks fine. A
 * rollup computed at 23:59 and read at 00:04 is five minutes old and its "new
 * today" is a complete count of yesterday.
 */
export function staleDayNotice(
  freshness: RollupFreshness,
  todayIsCurrent: boolean,
): string | null {
  if (freshness.state === "never") return null;
  if (todayIsCurrent) return null;

  return `These were counted against a previous ${PLATFORM_TIMEZONE_LABEL} day, so the "today" figures describe that day rather than this one.`;
}

/* ------------------------------------------------------------------------- *
   Ages
   ------------------------------------------------------------------------- */

/**
 * How long ago, coarsely, for a template waiting on Meta.
 *
 * Coarse for the reason above, and floor rather than round: a template
 * submitted 110 minutes ago has been waiting one hour, not two. Rounding up an
 * age overstates a delay, and an overstated delay is what makes somebody
 * resubmit a template that was about to be approved.
 */
export function ageLabel(since: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return minutes <= 1 ? "just now" : `${minutes} minutes`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }

  const days = Math.floor(seconds / 86_400);
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * How long until a window shuts, as one of three buckets.
 *
 * ---------------------------------------------------------------------------
 * A bucket rather than a count of minutes, which is the conventions' own rule
 * ---------------------------------------------------------------------------
 *
 * The screenshot suite seeds an open window as `now() + 18h`, because a
 * conversation cannot be both permanently open and described by a fixed
 * instant. The corollary the conventions state is binding on whoever renders
 * one: the window may appear as an open/closed state or as a COARSE BUCKET,
 * never as a timestamp.
 *
 * A count of minutes is not a timestamp, but it has the identical failure -
 * it decrements between the seed and the capture, so the baseline never
 * matches twice and the suite gets re-recorded rather than read.
 *
 * Three buckets, and they are the three decisions available: reply now, reply
 * this half hour, reply today. A person acting on this list does not do
 * anything differently at 41 minutes than at 43.
 *
 * `minutesLeft` stays exported beside it because the sort order and the
 * accessible label want the real number - what must not be RENDERED as a
 * ticking value is the visible text.
 */
export function minutesLeft(expiresAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.ceil((expiresAt.getTime() - now.getTime()) / 60_000),
  );
}

export function closingBucket(expiresAt: Date, now: Date): string {
  /*
   * Delegates to the window vocabulary rather than restating it. The inbox
   * badge renders the same column through the same function, so the two screens
   * cannot drift into two wordings for one state - which is the same argument
   * the delivery ladder's labels make.
   */
  return windowBucket(describeWindow(expiresAt, now)) ?? "Within the hour";
}

/* ------------------------------------------------------------------------- *
   Sources
   ------------------------------------------------------------------------- */

/**
 * A conversation source in words.
 *
 * CAMPAIGN covers both producers of outbound-first threads - bulk messaging and
 * a lead-source binding - because `conversation_source` does not distinguish
 * them and inventing a distinction here would be a claim the data does not
 * support. The card's footnote says so, which is better than a label that
 * silently means two things.
 */
export function sourceLabel(source: string): string {
  switch (source) {
    case "INBOUND":
      return "Customer wrote first";
    case "CAMPAIGN":
      return "Campaign or lead source";
    case "ADS_CLICK_TO_WHATSAPP":
      return "Click-to-WhatsApp ad";
    case "MANUAL":
      return "Started here";
    default:
      /* Ours is an enum, so unreachable today - and rendered rather than
         blanked, because a slice with no name is the hardest gap to notice. */
      return source;
  }
}
