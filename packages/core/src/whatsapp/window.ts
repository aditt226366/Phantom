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

/** Whether free-form messaging is allowed right now. */
export function isWindowOpen(state: WindowState): boolean {
  return state.kind !== "closed";
}
