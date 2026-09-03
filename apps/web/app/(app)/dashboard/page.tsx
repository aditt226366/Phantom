import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/session";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { loadDashboard } from "@/lib/dashboard/data";
import {
  freshnessLabel,
  leadScoreLabel,
  sourceLabel,
  staleDayNotice,
} from "@/lib/dashboard/display";
import { PENDING } from "@/lib/dashboard/pending";
import { formatCount } from "@/lib/format";
import { SectionHeader, SectionShell } from "../_components/section";
import {
  ClosingWindowsCard,
  NumberHealthCard,
  PendingTemplatesCard,
  RecentCard,
  AdSpendCard,
  LeadSourcesCard,
  SpendCard,
  WaitingCard,
} from "./_components/action-cards";
import { Donut, LadderBar, RateBars, type Segment } from "./_components/charts";
import {
  BandHeading,
  FreshnessLine,
  NotYetCard,
  PanelCard,
  StatTile,
} from "./_components/tiles";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * What the product has actually done for this tenant.
 *
 * ---------------------------------------------------------------------------
 * Every number here comes from the database. There are no placeholders.
 * ---------------------------------------------------------------------------
 *
 * This section was an empty state from Phase 1 to Phase 7 while five features
 * sent, received, scored and spent on the tenant's behalf. The rule for filling
 * it was that a figure is either real or it is absent - so the cards whose data
 * does not exist yet (AI handling, lead scores, orders) say so in words and
 * carry no figure at all. A zero would read as a fact about the business.
 * See lib/dashboard/pending.ts.
 *
 * ---------------------------------------------------------------------------
 * Two clocks, deliberately, and the page says which is which
 * ---------------------------------------------------------------------------
 *
 * The totals and the charts come from `dashboard_rollups`, refreshed once a
 * minute by the worker, and carry a freshness line saying how old they are. The
 * six cards below them are read at request time and carry none, because they
 * are live.
 *
 * That inconsistency is the design. Making the totals live means six aggregate
 * scans of `messages` per page load on the one page people leave open all day;
 * making the action cards rolled-up means holding back a window that shuts in
 * four minutes until the next refresh. Neither is worth a page that merely
 * looks internally consistent.
 *
 * ---------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------------
 *
 * One column on a phone throughout, widening at `tablet` and `desktop`. Every
 * grid child carries `min-w-0`: both faults the screenshot suite has ever
 * caught were an element whose automatic minimum size was an unbreakable
 * customer-supplied string, taking the whole page wider than the viewport.
 */
export default async function DashboardPage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="The dashboard" />;
  }

  const data = await loadDashboard();
  const { windows, totals, performance } = data;

  const todayLabel = `today (${windows.timezoneLabel})`;

  /*
   * The ladder's two ends are semantic and the middle is the value ramp.
   * READ is `success` to match the inbox, which already calls it that - two
   * words for one state across two screens is how a support conversation goes
   * wrong - and FAILED is `error` for the same reason.
   */
  const ladderTone: Record<string, string> = {
    outboundRead: "text-success",
    outboundFailed: "text-error",
  };

  const ladderSegments: Segment[] = data.delivery.map((slice) => {
    const tone = ladderTone[slice.key];
    return {
      key: slice.key,
      label: slice.label,
      value: slice.count,
      /* Spread rather than `tone: tone` so an unmapped rung carries no key at
         all and falls through to the value ramp, which is what the chart's
         default does with an absent tone. */
      ...(tone ? { tone } : {}),
    };
  });

  const sourceSegments: Segment[] = data.bySource.map((entry) => ({
    key: entry.source,
    label: sourceLabel(entry.source),
    value: entry.count,
  }));

  /*
   * Hot, warm, cold - and never a fourth "unscored" segment.
   *
   * Unscored contacts are reported in the caption instead. Folding them in
   * would make the ring a picture of the contact book rather than of the leads
   * in it, and the two questions have different answers: nine hot leads out of
   * twelve scored is a good week, and nine out of four thousand contacts is
   * not the same sentence.
   */
  const leadSegments: Segment[] = (data.leads?.byScore ?? []).map((entry) => ({
    key: entry.score,
    label: leadScoreLabel(entry.score),
    value: entry.count,
  }));

  return (
    <SectionShell>
      <SectionHeader
        title={`Welcome, ${session.user.fullName.split(" ")[0]}`}
        lede={`What ${session.company.name} has sent, received and spent.`}
      />

      {/* ------------------------------------------------------------------ */}
      {/* The totals                                                          */}
      {/* ------------------------------------------------------------------ */}

      <section className="mb-xl">
        <div className="mb-base">
          <FreshnessLine
            label={freshnessLabel(data.freshness)}
            notice={staleDayNotice(data.freshness, data.todayIsCurrent)}
            tone={data.freshness.state}
          />
        </div>

        {totals === null ? (
          <PanelCard title="Nothing counted yet">
            <p className="text-body-sm text-body">
              The first refresh runs within a minute of your workspace being
              created. Until then there are no figures to show — which is not
              the same as there being nothing to count.
            </p>
          </PanelCard>
        ) : (
          <div className="grid grid-cols-1 gap-base tablet:grid-cols-2 desktop:grid-cols-3">
            <StatTile label="Messages" value={totals.messages} />
            <StatTile label="Sent" value={totals.outbound} />
            <StatTile label="Received" value={totals.inbound} />
            <StatTile
              label="Conversations"
              value={totals.conversations}
              detail={`${formatCount(totals.conversationsNewToday)} new ${todayLabel}`}
            />
            <StatTile
              label="Leads"
              value={totals.contacts}
              detail={`${formatCount(totals.contactsNewToday)} new ${todayLabel}`}
            />
            <NotYetCard card={PENDING["orders"]!} />
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* How it is going                                                     */}
      {/* ------------------------------------------------------------------ */}

      <section className="mb-xl">
        <BandHeading
          title="How it is going"
          note="Counted with the totals above, so the same freshness applies."
        />

        <div className="grid grid-cols-1 gap-base desktop:grid-cols-2">
          <PanelCard title="How messages perform">
            {performance === null || performance.attempted === 0 ? (
              <p className="text-body-sm text-body">
                Nothing has been sent yet, so there are no rates to report.
              </p>
            ) : (
              <RateBars
                rows={[
                  {
                    key: "delivered",
                    label: "Delivered",
                    percent: performance.deliveredRate,
                    detail: `${formatCount(performance.delivered)} of ${formatCount(performance.attempted)} messages sent`,
                  },
                  {
                    key: "read",
                    label: "Read",
                    percent: performance.readRate,
                    detail: `${formatCount(performance.read)} of ${formatCount(performance.attempted)} messages sent`,
                  },
                  {
                    key: "replied",
                    label: "Replied",
                    percent: performance.repliedRate,
                    /* The denominator differs from the two above, so it is
                       stated rather than assumed. One customer answering after
                       five reminders is one reply, not one in five. */
                    detail: `${formatCount(performance.threadsReplied)} of ${formatCount(performance.threadsMessaged)} conversations you started`,
                  },
                ]}
              />
            )}
          </PanelCard>

          <PanelCard title="Where every message got to">
            {ladderSegments.length === 0 ? (
              <p className="text-body-sm text-body">
                Nothing has been sent yet.
              </p>
            ) : (
              <>
                <LadderBar segments={ladderSegments} />
                {data.failures.total > 0 ? (
                  /*
                   * A list rather than a sentence, and that is a bug fix as
                   * well as a layout choice. The sentence form read "1 were
                   * delivery-limited by Meta" - every count here can be one,
                   * and three verbs would each need agreeing separately. A
                   * label beside a number has no verb to get wrong.
                   */
                  <dl className="mt-base flex flex-col gap-xxs">
                    <div className="flex items-baseline justify-between gap-sm">
                      <dt className="text-caption text-body">
                        Delivery-limited by Meta
                      </dt>
                      <dd className="text-caption text-ink">
                        {formatCount(data.failures.deliveryLimited)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-sm">
                      <dt className="text-caption text-body">
                        Cannot receive WhatsApp
                      </dt>
                      <dd className="text-caption text-ink">
                        {formatCount(data.failures.undeliverable)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-sm">
                      <dt className="text-caption text-body">
                        Failed for other reasons
                      </dt>
                      <dd className="text-caption text-ink">
                        {formatCount(data.failures.other)}
                      </dd>
                    </div>
                  </dl>
                ) : null}
              </>
            )}
          </PanelCard>

          <PanelCard title="Where conversations come from">
            {sourceSegments.length === 0 ? (
              <p className="text-body-sm text-body">
                No conversations yet.
              </p>
            ) : (
              <Donut
                segments={sourceSegments}
                caption="Campaign covers both bulk messaging and lead sources — WhatsApp records one origin for both."
              />
            )}
          </PanelCard>

          <PanelCard title="Who is handling chats">
            {data.automation && data.automation.total > 0 ? (
              <>
                {/*
                  Two series, not one.

                  A flow and Verse are different capabilities with different
                  remedies - a flow taking no work needs its tree looked at, a
                  campaign taking none needs its knowledge base looked at - so
                  one combined bar would let a tenant whose flow does nothing
                  and whose campaigns do everything read a healthy number and
                  learn nothing from it.

                  They may overlap: a thread a flow handed over and a campaign
                  later picked up is in both. Each is its own proportion of all
                  conversations rather than a slice of a pie, which is why they
                  are allowed to sum past 100.
                */}
                <RateBars
                  rows={[
                    {
                      key: "automated",
                      label: "Answered by a flow",
                      percent:
                        (data.automation.automated / data.automation.total) * 100,
                      /* The denominator, printed. Phase 7's rule about the
                         reply rate applies here for the same reason: an
                         unlabelled proportion reads as though it shared the
                         one above it, and this one does not. */
                      detail: `${data.automation.automated} of ${data.automation.total} conversations`,
                    },
                    {
                      key: "verse",
                      label: "Answered by Verse",
                      percent:
                        (data.automation.verse / data.automation.total) * 100,
                      detail: `${data.automation.verse} of ${data.automation.total} conversations`,
                    },
                  ]}
                />
                <p className="mt-xs text-caption text-muted">
                  Counted from conversations an automation actually stood in,
                  not from threads nobody picked up. A thread both handled is
                  counted in both.
                </p>
              </>
            ) : (
              <p className="text-body-sm text-body">
                No conversation has been through a flow or a campaign yet.
                Publish a flow in Template Messaging, or start a campaign in AI
                Messaging, and this shows how much of the work it took on.
              </p>
            )}
          </PanelCard>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Needs attention — live, every one                                   */}
      {/* ------------------------------------------------------------------ */}

      <section className="mb-xl">
        <BandHeading
          title="Needs attention"
          note="Read just now, not from the counts above."
        />

        <div className="grid grid-cols-1 gap-base desktop:grid-cols-2">
          <ClosingWindowsCard
            rows={data.closing}
            total={data.counts.closingWindows}
            now={windows.now}
          />
          <NumberHealthCard numbers={data.numbers} />
          <SpendCard
            perCurrency={data.spend?.perCurrency ?? []}
            unpricedCount={data.spend?.unpricedCount ?? 0}
            monthLabel={`Since 1 ${windows.monthStart.toLocaleString("en-IN", { month: "long", timeZone: "Asia/Kolkata" })} (${windows.timezoneLabel})`}
          />
          <AdSpendCard
            perCurrency={data.adSpend}
            monthLabel={`Since 1 ${windows.monthStart.toLocaleString("en-IN", { month: "long", timeZone: "Asia/Kolkata" })} (${windows.timezoneLabel})`}
          />
          <PendingTemplatesCard
            templates={data.templates}
            total={data.counts.pendingTemplates}
            now={windows.now}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Conversations                                                       */}
      {/* ------------------------------------------------------------------ */}

      <section className="mb-xl">
        <BandHeading title="Conversations" />

        <div className="grid grid-cols-1 gap-base desktop:grid-cols-2">
          <WaitingCard rows={data.waiting} total={data.counts.waiting} />
          <RecentCard rows={data.recent} />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Leads                                                               */}
      {/* ------------------------------------------------------------------ */}

      <section>
        <BandHeading title="Leads" />

        <div className="grid grid-cols-1 gap-base desktop:grid-cols-2">
          <PanelCard title="Lead temperature">
            {leadSegments.length === 0 ? (
              <p className="text-body-sm text-body">
                Nothing has scored a contact yet. A flow&rsquo;s action step
                sets this from an answer somebody actually gave.
              </p>
            ) : (
              <Donut
                segments={leadSegments}
                caption={
                  data.leads && data.leads.unscored > 0
                    ? `${data.leads.unscored} more contacts have never been scored, which is not the same as cold.`
                    : "Set by a flow's action step, from an answer somebody actually tapped."
                }
              />
            )}
          </PanelCard>
          <LeadSourcesCard rows={data.leadSources} />
          <NotYetCard card={PENDING["leadPyramid"]!} />
        </div>
      </section>
    </SectionShell>
  );
}
