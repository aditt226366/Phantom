import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { formatTimestamp } from "@/lib/format";
import { rejectionExplanation, templateTone } from "@/lib/template-display";
import { CsrfField } from "@/components/ui/csrf-field";
import { SectionHeader, SectionShell } from "../_components/section";
import { syncTemplatesAction } from "./actions";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Template Messaging" };

/**
 * Every template this workspace has, and what Meta thinks of each.
 *
 * The rejected ones are the reason this page is a list rather than a launcher.
 * A template that came back REJECTED is the only thing here that needs somebody
 * to do something, and it needs them to read Meta's reason before they do it —
 * so the reason renders on the row, not one click away behind an "edit".
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Template Messaging" />;
  }


  const query = await searchParams;
  const view = query["view"] === "library" ? "library" : "yours";

  const templates = await withCompany(session.companyId, (db) =>
    db.whatsAppTemplate.findMany({
      /*
       * The tab is a filter on authorship, which is also the truth about
       * where each template came from: a null createdByUserId means the sync
       * job adopted it from Meta rather than somebody building it here.
       */
      where: view === "library"
        ? { createdByUserId: null }
        : { createdByUserId: { not: null } },
      /* The index is (company_id, updated_at DESC). Tie-broken on id. */
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        status: true,
        rejectedReason: true,
        statusUpdatedAt: true,
      },
    }),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="Template Messaging"
        lede="Templates are how you start a conversation, or continue one after the 24-hour window has closed. Meta reviews each one."
      />

      <nav aria-label="Template views" className="mb-base flex items-center gap-base">
        <Tab href="/template-messaging" active={view === "yours"}>
          Yours
        </Tab>
        <Tab href="/template-messaging?view=library" active={view === "library"}>
          From Meta
        </Tab>
      </nav>

      <div className="mb-lg flex flex-wrap items-center gap-sm">
        {view === "yours" ? (
          <Button asChild>
            <Link href="/template-messaging/new">New template</Link>
          </Button>
        ) : (
          <form action={syncTemplatesAction}>
            <CsrfField />
            <Button type="submit" variant="outline">
              Sync from Meta
            </Button>
          </form>
        )}
      </div>

      {view === "library" ? (
        /*
         * Said plainly, because the alternative is a tenant assuming this is
         * Meta's pre-written catalogue. It is not - it is their own WABA's
         * templates, including ones made in Business Manager, which need no
         * review here only because they have already had it.
         */
        <p className="mb-base max-w-2xl text-body-sm text-body">
          Templates already on your WhatsApp Business Account that were not
          created here — usually made in Meta Business Manager. They are
          approved already, so they can be sent without waiting for review.
        </p>
      ) : null}

      {templates.length > 0 ? (
        <ul className="flex flex-col gap-sm">
          {templates.map((template) => {
            const explanation = rejectionExplanation(template.rejectedReason);

            return (
              <li
                key={template.id}
                className="rounded-xl border border-hairline bg-surface-card p-base"
              >
                {/* min-w-0 on the growing child: a template name is typed by a
                    tenant and has no bounded length. */}
                <div className="flex flex-wrap items-start justify-between gap-sm">
                  <p className="min-w-0 flex-1 break-words text-body-strong text-ink">
                    {template.name}
                  </p>
                  <Badge variant={templateTone(template.status)}>
                    {template.status}
                  </Badge>
                </div>

                <p className="mt-xxs text-caption text-muted">
                  {template.language} · {template.category} ·{" "}
                  {formatTimestamp(template.statusUpdatedAt)}
                </p>

                {/*
                 * Meta's token, verbatim, and our explanation underneath it.
                 * Never the explanation alone: the token is what Meta's support
                 * asks for and what Business Manager shows beside the same
                 * template, so replacing it would leave somebody unable to
                 * describe their own problem to the people who can fix it.
                 */}
                {template.rejectedReason ? (
                  <div className="mt-sm rounded-md border border-hairline-strong bg-surface-strong px-sm py-xs">
                    <p className="break-words text-caption text-error">
                      {template.rejectedReason}
                    </p>
                    {explanation ? (
                      <p className="mt-xxs text-caption text-body">{explanation}</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          tone="lavender"
          title={view === "library" ? "Nothing from Meta yet" : "No templates yet"}
          description={
            view === "library"
              ? EMPTY_COPY["template-messaging-library"]
              : EMPTY_COPY["template-messaging"]
          }
        />
      )}
    </SectionShell>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`text-nav-link transition-colors ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
