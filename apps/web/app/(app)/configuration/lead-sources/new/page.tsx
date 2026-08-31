import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Button } from "@/components/ui/button";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { serviceAccountEmail } from "@/lib/lead-sources/credentials";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { BindForm } from "../_components/bind-form";
import { ServiceAccountPanel } from "../_components/service-account-panel";

export const metadata: Metadata = { title: "Bind a sheet" };

/**
 * Step one: which sheet, which template, which number.
 *
 * The share panel is repeated here rather than only on the list page, because
 * this is the screen somebody is on when they discover they have not shared
 * the sheet - the save fails, and the address they need has to be beside the
 * message telling them so, not one navigation away.
 */
export default async function Page() {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Configuration" />;
  }

  const [email, options] = await Promise.all([
    serviceAccountEmail(session.companyId),
    withCompany(session.companyId, async (db) => ({
      templates: await db.whatsAppTemplate.findMany({
        where: { status: "APPROVED" },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, language: true, components: true },
      }),
      numbers: await db.whatsAppNumber.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          displayNumber: true,
          verifiedName: true,
          status: true,
        },
      }),
    })),
  ]);

  /* Nothing to bind to. Rendering a form whose submit can only ever fail is
     worse than sending them to the page that fixes it. */
  if (options.templates.length === 0 || options.numbers.length === 0) {
    redirect("/configuration/lead-sources");
  }

  return (
    <SectionShell>
      <SectionHeader
        title="Bind a sheet"
        lede="Paste the link to a Google Sheet. Every row added from now on becomes a lead and receives the template you choose."
      />

      <div className="flex flex-col gap-lg">
        <ServiceAccountPanel email={email} />

        <BindForm
          templates={options.templates.map((template) => ({
            id: template.id,
            name: template.name,
            language: template.language,
            body: extractBody(template.components),
          }))}
          numbers={options.numbers.map((number) => ({
            id: number.id,
            label: number.verifiedName
              ? `${number.displayNumber} · ${number.verifiedName}`
              : number.displayNumber,
            status: number.status,
          }))}
          csrf={<CsrfField />}
        />

        <div>
          <Button asChild variant="ghost">
            <Link href="/configuration/lead-sources">Back to lead sources</Link>
          </Button>
        </div>
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
