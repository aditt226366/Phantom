import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type {
  ClosingWindow,
  NumberHealth,
  PendingTemplate,
  RecentThread,
  WaitingThread,
} from "@whatsapp-os/db";
import type { CurrencySpend } from "@whatsapp-os/core/dashboard";
import {
  ageLabel,
  closingBucket,
  qualityTone,
  qualityWarning,
  tierLabel,
} from "@/lib/dashboard/display";
import { formatCount, formatMicros, formatTimestamp } from "@/lib/format";
import { PanelCard } from "./tiles";

/**
 * The four cards that change what somebody does next, plus the two lists.
 *
 * Everything else on this page is a report. These are the reason it is worth
 * opening: each one is a fact the tenant can act on today and which nothing
 * else in the product surfaces where they would see it.
 *
 * All six are LIVE - read at request time, not from the rollup - and the reason
 * is different for each but rhymes: a minute of staleness on a total is
 * nothing, and a minute of staleness on "this window shuts in four minutes" is
 * the difference between reaching somebody and not.
 */

/**
 * Every list here is defensive about width in the same way the inbox is.
 *
 * Both faults the screenshot suite has ever caught were an element whose
 * automatic minimum size was an unbreakable string - a contact's profile name,
 * a message preview - pushing the page wider than the viewport. `truncate`
 * alone does not fix it: it sets white-space: nowrap, which clips what is drawn
 * and leaves min-content at the full string. `min-w-0` on the flex child is
 * what fixes it, and it is on every one of them below.
 */

/* ------------------------------------------------------------------------- *
   Windows closing
   ------------------------------------------------------------------------- */

/**
 * Threads whose 24-hour window shuts within the hour.
 *
 * The card that turns this page into a tool. After the window closes the only
 * legal message is an approved template, which costs money and reads like
 * marketing; inside it, a free-form reply is still possible. Nothing else in
 * the product tells anybody which threads are about to cross that line.
 *
 * Every row links straight into the thread, because a list of names somebody
 * then has to find in the inbox is a list nobody works through.
 *
 * The time is a coarse bucket - under 15 minutes, under 30, within the hour -
 * and never an instant or a ticking count. That is the conventions' rule about
 * this column, and a decrementing minute count fails it the same way a
 * timestamp does: it differs between the seed and the capture, so the baseline
 * never matches twice. The three buckets are also the three decisions actually
 * available, since nobody acts differently at 41 minutes than at 43.
 */
export function ClosingWindowsCard({
  rows,
  total,
  now,
}: {
  rows: readonly ClosingWindow[];
  total: number;
  now: Date;
}) {
  return (
    <PanelCard
      title="Windows closing within the hour"
      aside={
        total > 0 ? (
          <Badge variant="outline">{formatCount(total)}</Badge>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <p className="text-body-sm text-body">
          No customer&rsquo;s 24-hour window closes in the next hour. Threads
          appear here while there is still time to reply for free.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-sm">
            {rows.map((row) => (
              <li key={row.conversationId}>
                <Link
                  href={`/inbox/${row.conversationId}`}
                  className="flex items-center gap-sm rounded-md px-xxs py-xxs transition-colors hover:bg-surface-strong"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm text-ink">
                      {row.name}
                    </span>
                    <span className="block truncate text-caption text-muted">
                      {row.lastMessagePreview ?? "No preview"}
                    </span>
                  </span>
                  <span className="shrink-0 text-caption text-body-strong">
                    {closingBucket(row.windowExpiresAt, now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {total > rows.length ? (
            <p className="mt-sm text-caption text-muted">
              {formatCount(total - rows.length)} more not shown.
            </p>
          ) : null}
        </>
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------------- *
   Number health
   ------------------------------------------------------------------------- */

/**
 * Quality rating and messaging tier, per number.
 *
 * This is the number that kills WhatsApp accounts. Meta restricts a number
 * whose quality stays low, a restriction is not something a support ticket
 * lifts quickly, and the rating sits at YELLOW for days first. Until this card
 * the value was visible only on Configuration > Numbers, which is a page people
 * open when they are setting something up and never again.
 *
 * The warning is a sentence, not a colour. There is no warning token in
 * globals.css and inventing one would be a literal outside that file - but the
 * better reason is that "Quality: YELLOW" is a fact nobody outside Meta's
 * documentation can act on, and the sentence names the consequence.
 *
 * `metadataRefreshedAt` is printed because every value here is a cache of
 * Meta's, and a cache with no age is a claim nobody can check. As an absolute
 * timestamp, not an age - both because Configuration > Numbers already prints
 * it that way and two renderings of one column across two screens is how a
 * support conversation goes wrong, and because an age computed against a
 * LITERAL seeded instant drifts with the calendar: a baseline recorded today
 * saying "18 days" says "25 days" next week, and the suite fails for the
 * passage of time. An age is only safe where the fixture can seed the value
 * relative to now(), which is what the template card below does.
 */
export function NumberHealthCard({
  numbers,
}: {
  numbers: readonly NumberHealth[];
}) {
  return (
    <PanelCard title="Number health">
      {numbers.length === 0 ? (
        <p className="text-body-sm text-body">
          No WhatsApp number is connected yet. Quality rating and messaging tier
          appear here once one is.
        </p>
      ) : (
        <ul className="flex flex-col gap-base">
          {numbers.map((number) => {
            const warning = qualityWarning(number.qualityRating);

            return (
              <li key={number.id} className="flex min-w-0 flex-col gap-xxs">
                <div className="flex items-center justify-between gap-sm">
                  <span className="min-w-0 truncate text-body-sm text-ink">
                    {number.displayNumber}
                  </span>
                  <Badge
                    variant={
                      qualityTone(number.qualityRating) === "success"
                        ? "success"
                        : qualityTone(number.qualityRating) === "error"
                          ? "error"
                          : "default"
                    }
                  >
                    {number.qualityRating}
                  </Badge>
                </div>

                <span className="text-caption text-body">
                  {tierLabel(number.messagingTier)}
                </span>

                {warning ? (
                  <p className="text-caption text-body-strong">{warning}</p>
                ) : null}

                <span className="text-caption text-muted">
                  {number.metadataRefreshedAt
                    ? `Meta last confirmed this ${formatTimestamp(number.metadataRefreshedAt)}.`
                    : "Never confirmed with Meta."}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------------- *
   Spend
   ------------------------------------------------------------------------- */

/**
 * What this month has cost, per currency.
 *
 * A list, never a total. There is no exchange rate in this system and one must
 * not appear at render time - adding ₹4,000 to $50 produces 4,050 of nothing,
 * and it would render with exactly the same authority as a correct figure.
 *
 * The unpriced count shows only when it is non-zero, and it is not a footnote:
 * SUM ignores nulls, so unpriced events lower no total and the month would
 * otherwise read as complete when part of it was never priced at all.
 */
export function SpendCard({
  perCurrency,
  unpricedCount,
  monthLabel,
}: {
  perCurrency: readonly CurrencySpend[];
  unpricedCount: number;
  monthLabel: string;
}) {
  return (
    <PanelCard title="Cost this month">
      {perCurrency.length === 0 ? (
        <p className="text-body-sm text-body">
          Nothing priced this month yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-xs">
          {perCurrency.map((entry) => (
            <li
              key={entry.currency}
              className="flex items-baseline justify-between gap-sm"
            >
              <span className="text-caption-uppercase text-muted">
                {entry.currency}
              </span>
              <span className="font-display text-display-sm text-ink">
                {formatMicros(entry.micros, entry.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-sm text-caption text-muted">{monthLabel}</p>

      {unpricedCount > 0 ? (
        <p className="mt-xxs text-caption text-body-strong">
          {formatCount(unpricedCount)}{" "}
          {unpricedCount === 1 ? "event has" : "events have"} no price yet, so
          {unpricedCount === 1 ? " it is" : " they are"} not in the figures
          above.
        </p>
      ) : null}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------------- *
   Templates awaiting Meta
   ------------------------------------------------------------------------- */

/**
 * Templates Meta has not answered on, oldest first, with their age.
 *
 * The age is the content. Meta usually answers in minutes and occasionally
 * takes days, and there is no notification either way - so a template submitted
 * on Friday for Monday's campaign is discovered on Monday. Oldest first because
 * this is a queue, and the one at the top has been waiting longest.
 *
 * This is the one age on the page, and it obliges the fixture: the seed must
 * write these timestamps RELATIVE to now(), so what renders is a fixed string.
 * A literal instant here would drift with the calendar and the baseline would
 * fail for the passage of time rather than for a change to the page.
 */
export function PendingTemplatesCard({
  templates,
  total,
  now,
}: {
  templates: readonly PendingTemplate[];
  total: number;
  now: Date;
}) {
  return (
    <PanelCard
      title="Templates awaiting Meta"
      aside={
        total > 0 ? (
          <Badge variant="outline">{formatCount(total)}</Badge>
        ) : null
      }
    >
      {templates.length === 0 ? (
        <p className="text-body-sm text-body">
          Nothing is waiting on Meta. Submitted templates appear here with how
          long they have been pending.
        </p>
      ) : (
        <ul className="flex flex-col gap-sm">
          {templates.map((template) => (
            <li key={template.id}>
              <Link
                href={`/configuration/templates/${template.id}`}
                className="flex items-center gap-sm rounded-md px-xxs py-xxs transition-colors hover:bg-surface-strong"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-ink">
                    {template.name}
                  </span>
                  <span className="block truncate text-caption text-muted">
                    {template.language} &middot; {template.category}
                  </span>
                </span>
                <span className="shrink-0 text-caption text-body-strong">
                  {ageLabel(template.submittedAt, now)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------------- *
   The two thread lists
   ------------------------------------------------------------------------- */

/**
 * Threads nobody has picked up, oldest first.
 *
 * Oldest, which is the opposite of the feed beside it, and the difference is
 * the point: this is a queue. Sorting it newest-first would bury the customer
 * who has been waiting since Tuesday under the one who wrote a minute ago.
 */
export function WaitingCard({
  rows,
  total,
}: {
  rows: readonly WaitingThread[];
  total: number;
}) {
  return (
    <PanelCard
      title="Waiting for a human"
      aside={
        total > 0 ? (
          <Badge variant="outline">{formatCount(total)}</Badge>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <p className="text-body-sm text-body">
          Nothing is waiting. Threads nobody has picked up appear here, and so
          do the ones a flow handed over, longest wait first.
        </p>
      ) : (
        <ul className="flex flex-col gap-sm">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <Link
                href={`/inbox/${row.conversationId}`}
                className="flex items-center gap-sm rounded-md px-xxs py-xxs transition-colors hover:bg-surface-strong"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-ink">
                    {row.name}
                  </span>
                  {/*
                    * The reason when there is one, the preview otherwise.
                    *
                    * A flagged thread is in this queue because somebody said
                    * so, and the sentence they wrote is more use than the last
                    * message - which for a handoff is the flow's own goodbye
                    * and says nothing about what is wanted. An ordinary unread
                    * thread has no reason and shows its preview, which is
                    * exactly what it did before.
                    */}
                  <span className="block truncate text-caption text-muted">
                    {row.needsHumanReason ?? row.lastMessagePreview ?? "No preview"}
                  </span>
                </span>
                {/*
                  * The unread count, or a word.
                  *
                  * A flagged thread very often has nothing unread - a flow
                  * decides by itself that a person is needed - and a badge
                  * reading "0" beside it would say the opposite of why it is
                  * in this list.
                  */}
                <Badge
                  variant={row.needsHumanReason ? "outline" : "default"}
                  className="shrink-0"
                >
                  {row.needsHumanReason && row.unreadCount === 0
                    ? "Handed over"
                    : formatCount(row.unreadCount)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}

/**
 * The newest threads, as a feed.
 *
 * The window renders as an open/closed state and never as a timestamp - the
 * fixture rule again, and the same one ClosingWindowsCard obeys.
 */
export function RecentCard({ rows }: { rows: readonly RecentThread[] }) {
  return (
    <PanelCard title="Recent conversations">
      {rows.length === 0 ? (
        <p className="text-body-sm text-body">
          No conversations yet. Threads appear here the moment a message goes
          out or arrives.
        </p>
      ) : (
        <ul className="flex flex-col gap-sm">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <Link
                href={`/inbox/${row.conversationId}`}
                className="flex items-center gap-sm rounded-md px-xxs py-xxs transition-colors hover:bg-surface-strong"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm text-ink">
                    {row.name}
                  </span>
                  <span className="block truncate text-caption text-muted">
                    {row.lastMessagePreview ?? "No preview"}
                  </span>
                </span>
                <Badge
                  variant={row.windowOpen ? "success" : "default"}
                  className="shrink-0"
                >
                  {row.windowOpen ? "Open" : "Closed"}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  );
}
