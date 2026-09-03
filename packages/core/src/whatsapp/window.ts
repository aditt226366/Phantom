/**
 * The customer service window.
 *
 * Meta allows free-form messaging for 24 hours after the customer's last
 * message. Outside it, only an approved template may be sent - a policy
 * boundary rather than an API error, which is why it is decided here and
 * enforced in the send path rather than by disabling a button.
 */

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When free-form messaging stops being allowed, given the last inbound. */
export function windowExpiryFor(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
}

/**
 * What the thread should say about the time remaining.
 *
 * Buckets rather than a live countdown, and `now` is a parameter rather than
 * read from the clock. Both for the same reason: this renders server-side into
 * a screenshot suite that diffs images, and a value that changes every second
 * produces baselines people re-record without looking. A bucket changes on the
 * minute near the end and on the hour before that.
 *
 * `hours` and `minutes` are whole and rounded UP, so "1 hour left" means
 * between 0 and 60 minutes remain rather than at least an hour. Rounding down
 * would show "0 hours" for the last stretch of a window that is still open.
 */
export type WindowState =
  | { kind: "closed" }
  | { kind: "closing"; minutes: number }
  | { kind: "open"; hours: number };

/** Below this much remaining, count in minutes rather than hours. */
const CLOSING_THRESHOLD_MS = 60 * 60 * 1000;

export function describeWindow(
  expiresAt: Date | null | undefined,
  now: Date,
): WindowState {
  /*
   * Null means no inbound message has ever arrived, so there is no window -
   * not a window that happens to be open. A conversation created by an
   * outbound template has exactly this shape.
   */
  if (!expiresAt) return { kind: "closed" };

  const remaining = expiresAt.getTime() - now.getTime();

  /*
   * Closed AT the expiry instant, not after it. `remaining <= 0` rather than
   * `< 0`: at exactly the boundary Meta has stopped accepting free-form
   * messages, and being open for the final millisecond is a race the send path
   * would lose anyway.
   */
  if (remaining <= 0) return { kind: "closed" };

  if (remaining < CLOSING_THRESHOLD_MS) {
    return { kind: "closing", minutes: Math.ceil(remaining / 60_000) };
  }

  return { kind: "open", hours: Math.ceil(remaining / 3_600_000) };
}

/**
 * How near a closing window is, coarsely.
 *
 * ---------------------------------------------------------------------------
 * Why a bucket and not the minute count the state already carries
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and the second is the one that made this a shared function
 * rather than a detail of one page.
 *
 * A person does not act differently at 41 minutes than at 43. The decisions
 * available are reply now, reply this half hour, and reply before it shuts -
 * which is three buckets, and a minute count invites reading precision into a
 * value whose whole purpose is a deadline.
 *
 * And a rendered minute count TICKS. The conventions state the rule for this
 * exact column - the window may appear as an open/closed state or as a coarse
 * bucket, never as an instant - because the screenshot fixture seeds an open
 * window relative to now(), and anything decrementing differs between the seed
 * and the capture. That hazard was latent for as long as no fixture had a
 * near-term window; Phase 7 seeded three, and both inbox baselines moved by
 * ~190 pixels a run. Not rasteriser noise, which is one or two.
 *
 * Here rather than in either page because the inbox badge and the dashboard's
 * closing-windows card describe the same column, and two wordings for one state
 * across two screens is how a support conversation goes wrong.
 */
export function windowBucket(state: WindowState): string | null {
  if (state.kind !== "closing") return null;

  if (state.minutes <= 15) return "Under 15 min";
  if (state.minutes <= 30) return "Under 30 min";
  return "Within the hour";
}

/** Whether free-form messaging is allowed right now. */
export function isWindowOpen(state: WindowState): boolean {
  return state.kind !== "closed";
}
