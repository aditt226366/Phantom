import type { Metadata } from "next";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { EmptyState } from "@/components/ui/empty-state";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../_components/section";
import { ImportForm } from "../_components/import-form";

export const metadata: Metadata = { title: "New broadcast" };

/**
 * Step one: the list, the template and the number.
 *
 * Only APPROVED templates are offered, and that is not a convenience. A bulk
 * recipient is cold - there is no open 24-hour window - so a template is the
 * only thing that can legally be sent, and an unapproved one would be refused
 * by Meta ten thousand times. sendPolicy enforces it, the schema makes a
 * free-form broadcast unrepresentable, and this list is the third place the
 * same fact shows up: as the absence of anything else to choose.
 */
export default async function NewBroadcastPage() {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Bulk Messaging" />;
  }

  const { templates, numbers } = await withCompany(
    session.companyId,
    async (db, companyId) => {
      const [templates, numbers] = await Promise.all([
        db.whatsAppTemplate.findMany({
          where: { companyId, status: "APPROVED" },
          orderBy: { name: "asc" },
          select: { id: true, name: true, language: true, components: true },
        }),
        db.whatsAppNumber.findMany({
          where: { companyId },
          orderBy: { displayNumber: "asc" },
          select: {
            id: true,
            displayNumber: true,
            verifiedName: true,
            status: true,
            messagingTier: true,
          },
        }),
      ]);

      return { templates, numbers };
    },
  );

  if (templates.length === 0 || numbers.length === 0) {
    return (
      <SectionShell>
        <SectionHeader title="New broadcast" />
        <EmptyState
          tone="peach"
          title={
            templates.length === 0
              ? "No approved template yet"
              : "No number to send from"
          }
          description={
            templates.length === 0
              ? "A broadcast reaches people who have not written to you, and WhatsApp only allows an approved template for that. Create one in Configuration › Templates and send it for approval first."
              : "Connect a WhatsApp number in Configuration before sending to a list."
          }
        />
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      <SectionHeader
        title="New broadcast"
        lede="Upload a CSV of contacts, choose the approved template they will receive, and map the columns on the next step."
      />

      <ImportForm
        templates={templates.map((template) => ({
          id: template.id,
          name: template.name,
          language: template.language,
          body: extractBody(template.components),
        }))}
        numbers={numbers.map((number) => ({
          id: number.id,
          label: number.verifiedName
            ? `${number.displayNumber} · ${number.verifiedName}`
            : number.displayNumber,
          status: number.status,
        }))}
        csrf={<CsrfField />}
      />
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
