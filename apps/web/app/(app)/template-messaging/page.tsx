import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { formatTimestamp } from "@/lib/format";
import { rejectionExplanation, templateTone } from "@/lib/template-display";
import { SectionHeader, SectionShell } from "../_components/section";

export const metadata: Metadata = { title: "Template Messaging" };

/**
 * Every template this workspace has, and what Meta thinks of each.
 *
 * The rejected ones are the reason this page is a list rather than a launcher.
 * A template that came back REJECTED is the only thing here that needs somebody
 * to do something, and it needs them to read Meta's reason before they do it —
 * so the reason renders on the row, not one click away behind an "edit".
 */
export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const templates = await withCompany(session.companyId, (db) =>
    db.whatsAppTemplate.findMany({
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

      <div className="mb-lg flex flex-wrap items-center gap-sm">
        <Button asChild>
          <Link href="/template-messaging/new">New template</Link>
        </Button>
      </div>

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
          title="No templates yet"
          description="A template is a message Meta has approved in advance. You need one to reach somebody who has not written to you in the last 24 hours."
        />
      )}
    </SectionShell>
  );
}
