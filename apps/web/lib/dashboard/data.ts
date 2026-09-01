import "server-only";
import {
  countedDayIsCurrent,
  currencySpend,
  dashboardWindows,
  rate,
  rollupFreshness,
  summariseFailures,
  type CurrencySpend,
  type DashboardWindows,
  type FailureBreakdown,
  type RollupFreshness,
} from "@whatsapp-os/core/dashboard";
import {
  closingWindows,
  countClosingWindows,
  countMap,
  countPendingTemplates,
  countWaitingForAHuman,
  microsMap,
  numberHealth,
  pendingTemplates,
  readDashboardRollup,
  recentThreads,
  waitingForAHuman,
  withCompany,
  type ClosingWindow,
  type NumberHealth,
  type PendingTemplate,
  type RecentThread,
  type WaitingThread,
} from "@whatsapp-os/db";
import { requireSession } from "@/lib/auth/session";

/**
 * Everything the dashboard renders, read once.
 *
 * ---------------------------------------------------------------------------
 * One scope, one clock
 * ---------------------------------------------------------------------------
 *
 * `dashboardWindows()` is called once, at the top, and every query below binds
 * instants from it. Calling `new Date()` per query would give the cards
 * slightly different ideas of "now" - which is invisible until the closing-
 * windows list and the count beside it disagree by one row, at which point it
 * looks like a bug in the count.
 *
 * The four live reads share one withCompany scope, so they also share one
 * database snapshot. Same argument at the other end: a page that says "3
 * closing" above a list of two is a page nobody trusts again.
 *
 * ---------------------------------------------------------------------------
 * Why the rollup and the live reads are not the same age, on purpose
 * ---------------------------------------------------------------------------
 *
 * The aggregates are as of `computedAt`, up to a minute ago. The four lists are
 * as of this request. That is a real inconsistency and the page states it
 * rather than hiding it: the totals carry a freshness line, and the action
 * cards do not, because they are live.
 *
 * Pretending otherwise would mean either scanning `messages` six times per page
 * load, or holding back a window that is closing in four minutes until the next
 * refresh. Neither is worth a page that looks internally consistent.
 */

export interface DashboardTotals {
  messages: number;
  inbound: number;
  outbound: number;
  conversations: number;
  conversationsNewToday: number;
  contacts: number;
  contactsNewToday: number;
}

/** The delivery ladder, as a partition of everything the tenant tried to send. */
export interface DeliverySlice {
  key: string;
  label: string;
  count: number;
}

export interface DashboardPerformance {
  /** Of everything attempted. Null when nothing has been attempted. */
  deliveredRate: number | null;
  readRate: number | null;
  /** Of threads the business opened. A different denominator, and labelled so. */
  repliedRate: number | null;
  attempted: number;
  delivered: number;
  read: number;
  threadsMessaged: number;
  threadsReplied: number;
}

export interface DashboardSpend {
  perCurrency: CurrencySpend[];
  unpricedCount: number;
}

export interface DashboardCounts {
  closingWindows: number;
  waiting: number;
  pendingTemplates: number;
}

export interface DashboardData {
  windows: DashboardWindows;
  freshness: RollupFreshness;
  /**
   * Whether the rollup's "today" is the day the reader is having.
   *
   * Separate from freshness because they catch different faults, and the one
   * this catches is invisible to the other: at 00:04 IST a rollup from 23:59 is
   * five minutes old and every figure under "today" on it is yesterday's.
   */
  todayIsCurrent: boolean;
  /** Null when no refresh has ever run. Not zeroes - see the page. */
  totals: DashboardTotals | null;
  delivery: DeliverySlice[];
  failures: FailureBreakdown;
  performance: DashboardPerformance | null;
  bySource: Array<{ source: string; count: number }>;
  /**
   * Lead temperature, and how much of the contact book has never been scored.
   *
   * The unscored count is carried BESIDE the map rather than folded into it as
   * a fourth bucket, because the two answer different questions. "How warm are
   * the leads we know about" is the chart; "how much of the book has been
   * through a flow at all" is the caption, and a business with nine hot leads
   * out of four thousand contacts should not read the first without the
   * second.
   */
  leads: { byScore: Array<{ score: string; count: number }>; unscored: number } | null;
  /** Conversations a flow handled at least one step of, and the total. */
  automation: { automated: number; total: number } | null;
  spend: DashboardSpend | null;
  counts: DashboardCounts;
  closing: ClosingWindow[];
  waiting: WaitingThread[];
  recent: RecentThread[];
  numbers: NumberHealth[];
  templates: PendingTemplate[];
}

/**
 * The ladder's members, in the order the chart draws them.
 *
 * Ordered by how far a message got rather than by the enum's declaration, so
 * the bar reads left to right as progress. Named here rather than derived from
 * the enum for the same reason: an order is a display decision, and the enum's
 * is documentation of the status rank.
 *
 * The labels are the ones thread-display.ts already uses in the inbox. Two
 * words for the same state across two screens is how a support conversation
 * goes wrong.
 */
const LADDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: "outboundRead", label: "Read" },
  { key: "outboundDelivered", label: "Delivered" },
  { key: "outboundSent", label: "Sent" },
  { key: "outboundHeld", label: "Held by Meta" },
  { key: "outboundPending", label: "Sending" },
  { key: "outboundUnconfirmed", label: "Delivery unknown" },
  { key: "outboundFailed", label: "Failed" },
];

export async function loadDashboard(
  now: Date = new Date(),
): Promise<DashboardData> {
  /*
   * Rule 4: the loader calls it itself. The page does too, and React cache()
   * makes the second call free - what it buys is that this function cannot be
   * called from somewhere that forgot.
   */
  const session = await requireSession();

  const windows = dashboardWindows(now);

  const read = await withCompany(session.companyId, async (db, companyId) => {
    /*
     * One snapshot for all of it. Sequential rather than Promise.all: they run
     * on one pinned connection inside a transaction, so concurrency here buys
     * nothing and only makes the failure modes stranger.
     */
    const rollup = await readDashboardRollup(db, companyId);

    return {
      rollup,
      closing: await closingWindows(db, windows),
      closingCount: await countClosingWindows(db, windows),
      waiting: await waitingForAHuman(db),
      waitingCount: await countWaitingForAHuman(db),
      recent: await recentThreads(db, windows),
      numbers: await numberHealth(db),
      templates: await pendingTemplates(db),
      templateCount: await countPendingTemplates(db),
    };
  });

  const { rollup } = read;

  const totals: DashboardTotals | null = rollup
    ? {
        messages: rollup.messagesTotal,
        inbound: rollup.messagesInbound,
        outbound: rollup.messagesOutbound,
        conversations: rollup.conversationsTotal,
        conversationsNewToday: rollup.conversationsNewToday,
        contacts: rollup.contactsTotal,
        contactsNewToday: rollup.contactsNewToday,
      }
    : null;

  const delivery: DeliverySlice[] = rollup
    ? LADDER.map(({ key, label }) => ({
        key,
        label,
        count: rollup[key as keyof typeof rollup] as number,
      })).filter((slice) => slice.count > 0)
    : [];

  const performance: DashboardPerformance | null = rollup
    ? {
        attempted: rollup.messagesOutbound,
        /*
         * DELIVERED and READ both mean delivered. The ladder stores where a
         * message got to, not every rung it passed, so a read message is not
         * counted in outboundDelivered - and a rate that only counted that
         * column would fall as delivery got BETTER.
         */
        delivered: rollup.outboundDelivered + rollup.outboundRead,
        read: rollup.outboundRead,
        threadsMessaged: rollup.conversationsMessaged,
        threadsReplied: rollup.conversationsReplied,
        deliveredRate: rate(
          rollup.outboundDelivered + rollup.outboundRead,
          rollup.messagesOutbound,
        ),
        readRate: rate(rollup.outboundRead, rollup.messagesOutbound),
        repliedRate: rate(
          rollup.conversationsReplied,
          rollup.conversationsMessaged,
        ),
      }
    : null;

  const bySource = rollup
    ? Object.entries(countMap(rollup.conversationsBySource))
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    : [];

  const byScore = rollup ? countMap(rollup.contactsByScore) : {};
  const scored = Object.values(byScore).reduce((sum, n) => sum + n, 0);

  return {
    windows,
    freshness: rollupFreshness(rollup?.computedAt, now),
    todayIsCurrent: countedDayIsCurrent(rollup?.dayStart, now),
    totals,
    delivery,
    failures: summariseFailures(countMap(rollup?.failuresByCode)),
    performance,
    bySource,
    leads: rollup
      ? {
          /* HOT, WARM, COLD in that order, always - a distribution whose
             buckets reorder themselves by size is one nobody can read twice. */
          byScore: (["HOT", "WARM", "COLD"] as const)
            .map((score) => ({ score, count: byScore[score] ?? 0 }))
            .filter((entry) => entry.count > 0),
          unscored: Math.max(0, rollup.contactsTotal - scored),
        }
      : null,
    automation: rollup
      ? {
          automated: rollup.conversationsAutomated,
          total: rollup.conversationsTotal,
        }
      : null,
    spend: rollup
      ? {
          perCurrency: currencySpend(microsMap(rollup.costByCurrency)),
          unpricedCount: rollup.costUnpricedCount,
        }
      : null,
    counts: {
      closingWindows: read.closingCount,
      waiting: read.waitingCount,
      pendingTemplates: read.templateCount,
    },
    closing: read.closing,
    waiting: read.waiting,
    recent: read.recent,
    numbers: read.numbers,
    templates: read.templates,
  };
}
