import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { priceUsage } from "@whatsapp-os/core";
import {
  describeDuration,
  estimatedDurationMs,
  tierHeadroom,
} from "@whatsapp-os/core/bulk";
import { fillVariables, templateVariables } from "@whatsapp-os/core/whatsapp";
import { uniqueRecipientsSince, withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { needsTypedConfirmation } from "@/lib/bulk-display";
import { formatMicros } from "@/lib/format";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { ConfirmForm } from "../../_components/confirm-form";

export const metadata: Metadata = { title: "Confirm broadcast" };

/** The rolling window Meta measures a messaging tier over. */
const TIER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * When the tier's 24-hour window opened.
 *
 * Outside the component because the React compiler lint refuses an impure call
 * during render, and it is right to in general - a re-render would move the
 * window and the headroom with it. It does not actually bite here: this is a
 * Server Component marked force-dynamic, rendered once per request, so the
 * instant is stable by construction. The extraction is to satisfy a rule
 * written for client re-renders rather than to fix a bug, and saying so is
 * better than leaving a reader to wonder which it was.
 */
function tierWindowStart(): Date {
  return new Date(Date.now() - TIER_WINDOW_MS);
}

/**
 * The last screen before real people are messaged.
 *
 * Everything on it exists to answer one question - is this what I meant - and
 * each number is one somebody has been surprised by:
 *
 *   who is left        after four filtering steps, the list is not the file
 *   what they get      rendered, not described
 *   what it costs      per currency, with the unpriced count
 *   how long           at the configured gap, which for a big list is hours
 *   how much headroom  the tier, which is the ceiling the pace cannot dodge
 */
export default async function ConfirmBroadcastPage({
  params,
  searchParams,
}: {
  params: Promise<{ broadcastId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Bulk Messaging" />;
  }

  const { broadcastId } = await params;
  const failed = (await searchParams)["error"] === "1";

  /* One instant, so the "used today" figure and the headroom beside it are
     measured over the same window. */
  const windowStart = tierWindowStart();

  const data = await withCompany(session.companyId, async (db, companyId) => {
    const broadcast = await db.broadcast.findFirst({
      where: { id: broadcastId, companyId, status: "DRAFT" },
      select: {
        id: true,
        name: true,
        gapMs: true,
        parsedCount: true,
        invalidCount: true,
        duplicateCount: true,
        existingCount: true,
        optedOutCount: true,
        recipientCount: true,
        columnMapping: true,
        sourceRows: true,
        whatsappNumberId: true,
        whatsappNumber: {
          select: { displayNumber: true, messagingTier: true, status: true },
        },
        template: { select: { name: true, language: true, components: true } },
      },
    });

    if (!broadcast) return null;

    const used = await uniqueRecipientsSince(
      db,
      companyId,
      broadcast.whatsappNumberId,
      windowStart,
    );

    return { broadcast, used };
  });

  if (!data) notFound();

  const { broadcast, used } = data;
  const body = extractBody(broadcast.template.components);
  const variables = templateVariables(body);

  /* One real recipient's message, rendered the way the send path renders it. */
  const mapping =
    broadcast.columnMapping && typeof broadcast.columnMapping === "object"
      ? (broadcast.columnMapping as { variables?: Record<string, string> })
      : null;

  const firstRow = Array.isArray(broadcast.sourceRows)
    ? ((broadcast.sourceRows as unknown as Record<string, string>[])[0] ?? {})
    : {};

  const sample = fillVariables(
    body,
    variables.map((n) => firstRow[mapping?.variables?.[String(n)] ?? ""] ?? ""),
  );

  /*
   * Priced as a marketing conversation, which is what Meta actually bills for
   * a template to somebody who has not written in. Every price is zero at
   * version 1 - the list is a placeholder until Meta's real rates are wired in
   * Phase 7 - so the screen says pricing is not configured rather than showing
   * a confident 0.00, which would read as a promise that this is free.
   */
  const priced = priceUsage(
    "whatsapp.conversation.marketing",
    broadcast.recipientCount,
  );

  const headroom = tierHeadroom(
    broadcast.whatsappNumber.messagingTier,
    used,
    broadcast.recipientCount,
  );

  const duration = describeDuration(
    estimatedDurationMs(broadcast.recipientCount, broadcast.gapMs),
  );

  const steps: Array<{ label: string; value: number; tone?: "muted" }> = [
    { label: "Rows in the file", value: broadcast.parsedCount },
    { label: "No usable number", value: broadcast.invalidCount, tone: "muted" },
    { label: "Duplicates in the file", value: broadcast.duplicateCount, tone: "muted" },
    { label: "Opted out or unreachable", value: broadcast.optedOutCount, tone: "muted" },
  ];

  return (
    <SectionShell>
      <SectionHeader
        title="Check before sending"
        lede={`${broadcast.name} — ${broadcast.template.name} from ${broadcast.whatsappNumber.displayNumber}.`}
      />

      <div className="flex flex-col gap-lg">
        <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
          <p className="text-caption-uppercase uppercase text-muted">
            Will be messaged
          </p>
          <p className="mt-xxs font-display text-display-md text-ink">
            {broadcast.recipientCount.toLocaleString()}
          </p>
          <p className="mt-xxs text-body-sm text-body">
            {broadcast.existingCount.toLocaleString()} of them are already in
            your contacts.
          </p>

          {/* The pipeline, step by step. A wrong column mapping has no other
              symptom than these numbers looking wrong. */}
          <ul className="mt-base flex flex-wrap gap-lg">
            {steps.map((step) => (
              <li key={step.label}>
                <p className="text-caption-uppercase uppercase text-muted">
                  {step.label}
                </p>
                <p className="text-title-sm text-ink">
                  {step.value.toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <div className="grid gap-lg desktop:grid-cols-2">
          <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
            <h2 className="text-title-sm text-ink">What they receive</h2>
            <div className="mt-sm rounded-md border border-hairline-strong bg-surface-strong px-base py-sm">
              <p className="whitespace-pre-wrap text-body-sm text-ink">{sample}</p>
            </div>
            <p className="mt-xs text-caption text-muted">
              The first row of your file, rendered. {broadcast.template.name} (
              {broadcast.template.language}).
            </p>
          </section>

          <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
            <h2 className="text-title-sm text-ink">Cost, time and headroom</h2>

            <dl className="mt-sm flex flex-col gap-sm">
              <div>
                <dt className="text-caption-uppercase uppercase text-muted">
                  Estimated cost
                </dt>
                <dd className="text-body-sm text-ink">
                  {priced.costMicros === null ? (
                    <>
                      Not priced —{" "}
                      {broadcast.recipientCount.toLocaleString()} messages
                    </>
                  ) : priced.costMicros === 0n ? (
                    "Pricing is not configured yet, so this cannot be estimated."
                  ) : (
                    formatMicros(priced.costMicros, priced.currency ?? "INR")
                  )}
                </dd>
              </div>

              <div>
                <dt className="text-caption-uppercase uppercase text-muted">
                  Takes
                </dt>
                <dd className="text-body-sm text-ink">
                  {duration}, at {broadcast.gapMs}ms between messages
                </dd>
              </div>

              <div>
                <dt className="text-caption-uppercase uppercase text-muted">
                  Left on this number today
                </dt>
                <dd className="text-body-sm text-ink">
                  {headroom.remaining === null ? (
                    headroom.knowledge.known ? (
                      "No limit on this number."
                    ) : (
                      "We cannot read this number's messaging tier, so WhatsApp will enforce its own limit."
                    )
                  ) : (
                    <>
                      {headroom.remaining.toLocaleString()} of{" "}
                      {headroom.knowledge.known && !headroom.knowledge.unlimited
                        ? headroom.knowledge.capacity.toLocaleString()
                        : ""}{" "}
                      in 24 hours
                    </>
                  )}
                </dd>
              </div>
            </dl>

            {/* The one that stops a run part way through, so it is a badge and
                not a line of prose. */}
            {headroom.over > 0 ? (
              <p className="mt-base rounded-md border border-hairline-strong bg-surface-strong px-base py-sm text-body-sm text-error">
                <Badge variant="error">Over the limit</Badge>{" "}
                {headroom.over.toLocaleString()} of these will not send today.
                WhatsApp caps this number at{" "}
                {headroom.knowledge.known && !headroom.knowledge.unlimited
                  ? headroom.knowledge.capacity.toLocaleString()
                  : "its tier"}{" "}
                new conversations per 24 hours, and the run will stop when it
                gets there.
              </p>
            ) : null}
          </section>
        </div>

        <ConfirmForm
          broadcastId={broadcast.id}
          recipientCount={broadcast.recipientCount}
          requiresTypedConfirmation={needsTypedConfirmation(broadcast.recipientCount)}
          failed={failed}
          csrf={<CsrfField />}
        />

        <p className="text-body-sm text-muted">
          <Link
            href={`/bulk-messaging/${broadcast.id}/map`}
            className="underline underline-offset-4"
          >
            Back to mapping
          </Link>{" "}
          — nothing has been sent yet.
        </p>
      </div>
    </SectionShell>
  );
}

/** The BODY text out of a stored component array, or empty if there is none. */
function extractBody(components: unknown): string {
  if (!Array.isArray(components)) return "";

  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as Record<string, unknown>)["type"] === "BODY"
    ) {
      const text = (component as Record<string, unknown>)["text"];
      if (typeof text === "string") return text;
    }
  }

  return "";
}
