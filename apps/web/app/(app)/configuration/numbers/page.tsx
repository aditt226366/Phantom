import type { Metadata } from "next";
import { withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { formatTimestamp } from "@/lib/format";
import { qualityVariant, statusVariant, webhookUrl } from "@/lib/number-display";
import { SectionHeader, SectionShell } from "../../_components/section";
import { CopyField } from "../_components/copy-field";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Numbers" };

/**
 * The numbers behind a company's WhatsApp connection, and the URL Meta posts to.
 *
 * ---------------------------------------------------------------------------
 * Everything on this page is a cache, and it says so
 * ---------------------------------------------------------------------------
 *
 * Not one value here is typed by a person. The refresh job owns the whole row,
 * and `metadata_refreshed_at` is rendered beside the rest precisely because a
 * cache with no age is a claim nobody can check. This page never calls the
 * Graph API to freshen what it is about to show — a Graph call on page load is
 * the thing the cache exists to prevent, and staleness shown honestly beats a
 * dashboard that phones Meta every time somebody opens it.
 *
 * Meta's own strings are rendered verbatim, including ones this build has never
 * seen. `status` is text and not an enum for that reason, and the badge choice
 * in lib/number-display.ts is deliberately neutral about anything it does not
 * recognise rather than guessing.
 */
export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Configuration" />;
  }


  const { integration, numbers } = await withCompany(
    session.companyId,
    async (db) => {
      const found = await db.integration.findFirst({
        where: { provider: "WHATSAPP_CLOUD" },
        select: { id: true, label: true, webhookKey: true },
      });

      return {
        integration: found,
        /* Tie-broken on id. The index leads with created_at, and every row a
           single refresh writes carries the same one — so ordering on it alone
           is a different sequence run to run, which a screenshot notices even
           when a person would not. */
        numbers: await db.whatsAppNumber.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          select: {
            id: true,
            displayNumber: true,
            verifiedName: true,
            qualityRating: true,
            status: true,
            messagingTier: true,
            throughputLevel: true,
            metadataRefreshedAt: true,
            missingSince: true,
          },
        }),
      };
    },
  );

  return (
    <SectionShell>
      <SectionHeader
        title="Numbers"
        lede="The phone numbers under your WhatsApp Business Account, as Meta last reported them. Nothing here is edited from this page."
      />

      {integration ? (
        <div className="flex flex-col gap-lg">
          <WebhookPanel webhookKey={integration.webhookKey} />

          {numbers.length > 0 ? (
            <div className="grid gap-base desktop:grid-cols-2">
              {numbers.map((number) => (
                <NumberCard key={number.id} number={number} />
              ))}
            </div>
          ) : (
            <EmptyState
              tone="sky"
              title="No numbers yet"
              description="Numbers appear here once Meta has been asked for them. If you have added one in Business Manager and it is still missing, the next refresh will pick it up."
            />
          )}
        </div>
      ) : (
        <EmptyState
          tone="rose"
          title="WhatsApp is not connected"
          description="Once your WhatsApp Business Account is connected, the numbers under it and the address Meta delivers to both appear here."
        />
      )}
    </SectionShell>
  );
}

/**
 * The address Meta posts to.
 *
 * On this page because this is where somebody looking for it will be, and
 * because until now the only way to read it was a query against the database.
 *
 * Rotation is not here, and that is a decision rather than an omission: the old
 * URL stops resolving the instant the new key commits, so every inbound message
 * is dropped until the tenant has pasted the replacement into Meta — during
 * which Meta is accumulating failures toward disabling the subscription
 * outright. It needs a confirmation step, copy that says exactly that, and the
 * secret cache evicted alongside. That is its own commit, not a button next to
 * a value somebody came here to read.
 */
function WebhookPanel({ webhookKey }: { webhookKey: string }) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-lg">
      <h2 className="font-display text-display-sm text-ink">Webhook address</h2>

      <p className="mt-xs max-w-2xl text-body-sm text-body">
        Paste this into the Callback URL field of your Meta app, under WhatsApp
        &rarr; Configuration. It is how a customer&rsquo;s message reaches this
        inbox, and it is specific to your workspace — treat it like a password.
      </p>

      <div className="mt-base">
        <CopyField value={webhookUrl(env.APP_URL, webhookKey)} label="URL" />
      </div>
    </section>
  );
}

interface NumberRow {
  displayNumber: string;
  verifiedName: string | null;
  qualityRating: string;
  status: string;
  messagingTier: string | null;
  throughputLevel: string | null;
  metadataRefreshedAt: Date | null;
  missingSince: Date | null;
}

function NumberCard({ number }: { number: NumberRow }) {
  return (
    <section className="flex flex-col rounded-xl border border-hairline bg-surface-card p-lg">
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="min-w-0">
          <h3 className="break-words font-display text-title-md text-ink">
            {number.displayNumber}
          </h3>
          {/*
           * Meta approves the display name separately from the number, so a
           * live number with none is an ordinary state and not missing data.
           * Named rather than dashed, the way formatTimestamp says "Never".
           */}
          <p className="mt-xxs break-words text-body-sm text-muted">
            {number.verifiedName ?? "No approved display name"}
          </p>
        </div>

        <Badge variant={statusVariant(number.status)}>{number.status}</Badge>
      </div>

      {number.missingSince ? (
        <p className="mt-base rounded-md border border-hairline-strong bg-surface-strong px-sm py-xs text-caption text-body-strong">
          Meta stopped returning this number on{" "}
          {formatTimestamp(number.missingSince)}. Everything below is what it
          last said, and has not been checked since.
        </p>
      ) : null}

      <dl className="mt-base grid grid-cols-[auto_1fr] items-baseline gap-x-base gap-y-sm">
        <Row label="Quality">
          <Badge variant={qualityVariant(number.qualityRating)}>
            {number.qualityRating}
          </Badge>
        </Row>
        <Row label="Messaging tier">{number.messagingTier ?? "Not reported"}</Row>
        <Row label="Throughput">{number.throughputLevel ?? "Not reported"}</Row>
        <Row label="Last checked">
          {formatTimestamp(number.metadataRefreshedAt)}
        </Row>
      </dl>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-caption-uppercase uppercase text-muted">{label}</dt>
      <dd className="break-words text-body-sm text-body-strong">{children}</dd>
    </>
  );
}
