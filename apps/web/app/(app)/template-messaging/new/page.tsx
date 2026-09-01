import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Button } from "@/components/ui/button";
import { CsrfField } from "@/components/ui/csrf-field";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../_components/section";
import { NewFlowForm } from "../_components/new-flow-form";

export const metadata: Metadata = { title: "New flow" };

/**
 * Naming a flow and choosing the template that opens it.
 *
 * The template is chosen here rather than in the editor because a flow without
 * one is not a draft of anything. Interactive messages are free-form, so they
 * only work inside the 24-hour customer service window; an approved template
 * with quick-reply buttons is the only legal way to start a conversation and
 * the only way to restart one after a day of silence.
 *
 * Only APPROVED templates are offered. An unapproved one would build a flow
 * that cannot open, and the failure would arrive as a refusal from Meta in a
 * customer's thread rather than as a choice not offered here.
 */
export default async function NewFlowPage() {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Template Messaging" />;
  }

  const templates = await withCompany(session.companyId, (db, companyId) =>
    db.whatsAppTemplate.findMany({
      where: { companyId, status: "APPROVED" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, language: true },
    }),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="New flow"
        lede="A flow opens with an approved template. Its quick-reply buttons are what a customer taps to begin."
      />

      {templates.length === 0 ? (
        <EmptyState
          tone="peach"
          title="No approved template yet"
          description="A flow can only be opened by a template Meta has approved, because an interactive message needs the 24-hour window to already be open. Create one and come back once it is approved."
          action={
            <Button asChild>
              <Link href="/configuration/templates">Go to Templates</Link>
            </Button>
          }
        />
      ) : (
        <NewFlowForm templates={templates} csrf={<CsrfField />} />
      )}
    </SectionShell>
  );
}
