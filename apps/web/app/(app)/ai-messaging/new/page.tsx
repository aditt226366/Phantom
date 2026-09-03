import type { Metadata } from "next";
import Link from "next/link";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CsrfField } from "@/components/ui/csrf-field";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../_components/section";
import { CampaignWizard } from "../_components/campaign-forms";

export const metadata: Metadata = { title: "New campaign" };

/**
 * The wizard, and the two things that must exist before it can be used.
 *
 * A campaign cannot be created without an approved template and a knowledge
 * base, so this page checks for both and says which is missing rather than
 * rendering a form with two empty selects. An empty dropdown is a dead end
 * somebody reports as a bug; a sentence naming what to do is not.
 */
export default async function NewCampaignPage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="AI Messaging" />;
  }

  const { templates, bases, numbers } = await withCompany(
    session.companyId,
    async (db, companyId) => {
      const [templates, bases, numbers] = await Promise.all([
        db.whatsAppTemplate.findMany({
          where: { companyId, status: "APPROVED" },
          /* Then id: one template approved in two languages is two rows
             sharing a name, so name alone is not an order. */
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: { id: true, name: true, language: true },
        }),
        db.knowledgeBase.findMany({
          where: { companyId, archivedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, name: true },
        }),
        db.whatsAppNumber.findMany({
          where: { companyId },
          /* Then id. Meta's refresh writes an account's numbers in one pass,
             so they tie - this is the dashboard's own bug, same table. */
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, displayNumber: true },
        }),
      ]);

      return { templates, bases, numbers };
    },
  );

  if (templates.length === 0 || bases.length === 0) {
    return (
      <SectionShell>
        <SectionHeader title="New campaign" />
        <EmptyState
          tone="mint"
          title={
            templates.length === 0
              ? "No approved template yet"
              : "No knowledge base yet"
          }
          description={
            templates.length === 0
              ? "A campaign opens conversations with a template Meta has approved. Create one in Template Messaging and submit it — approval usually takes a few minutes."
              : "A campaign answers from a knowledge base and nothing else. Add what your business knows first."
          }
          action={
            <Button asChild>
              <Link
                href={
                  templates.length === 0
                    ? "/template-messaging"
                    : "/ai-messaging/knowledge"
                }
              >
                {templates.length === 0
                  ? "Go to Template Messaging"
                  : "Go to the knowledge base"}
              </Link>
            </Button>
          }
        />
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      <SectionHeader
        title="New campaign"
        lede="Who it messages, what it is for, and when it is allowed to speak."
      />
      <Card>
        <CampaignWizard
          templates={templates.map((template) => ({
            id: template.id,
            label: `${template.name} (${template.language})`,
          }))}
          bases={bases.map((base) => ({ id: base.id, label: base.name }))}
          numbers={numbers.map((number) => ({
            id: number.id,
            label: number.displayNumber,
          }))}
          /*
           * India, because that is where this product's tenants are and a
           * default nobody changes is better than an empty box everybody has
           * to fill. It is an editable field, not a hardcoded value: the
           * schedule is read in whatever zone the tenant sets.
           */
          defaultTimezone="Asia/Kolkata"
          csrf={<CsrfField />}
        />
      </Card>
    </SectionShell>
  );
}
