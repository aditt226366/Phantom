import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PREVIEW_ROWS, toRecords } from "@whatsapp-os/core/leads";
import { templateVariables } from "@whatsapp-os/core/whatsapp";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { CsrfField } from "@/components/ui/csrf-field";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { companyGoogleSecrets } from "@/lib/lead-sources/credentials";
import { listBindingTabs, readBindingSheet } from "@/lib/lead-sources/sheets";
import { SectionHeader, SectionShell } from "../../../../_components/section";
import { LeadMappingForm } from "../../_components/lead-mapping-form";

export const metadata: Metadata = { title: "Map columns" };

/**
 * Step two: the tab, the columns, and how often to look.
 *
 * The live preview is the point of the screen. A mapping is easy to get wrong
 * in a way that is invisible as a set of dropdowns and obvious as a sentence -
 * "Hi 98765 43210, thanks for your enquiry about Asha" is two columns swapped,
 * and nobody reads it as such until they see the message.
 *
 * It matters more here than it does for a bulk send. A broadcast is one list a
 * person watched go out; a lead source runs unattended for months, so a swapped
 * column is wrong for every customer who ever fills in that form.
 *
 * The rows are read live from Google rather than stored. A binding is a
 * long-lived pointer at somebody else's spreadsheet, and a cached copy of three
 * rows would be a snapshot of a customer list sitting in a column that nothing
 * else reads - which is retention nobody asked for, and stale besides.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ leadSourceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Configuration" />;
  }

  const { leadSourceId } = await params;
  const { tab: requestedTab } = await searchParams;

  const binding = await withCompany(session.companyId, (db) =>
    db.leadSource.findFirst({
      where: { id: leadSourceId },
      select: {
        id: true,
        name: true,
        spreadsheetId: true,
        tab: true,
        actionConfig: true,
        pollIntervalSeconds: true,
        template: { select: { name: true, components: true } },
      },
    }),
  );

  /* Rule 6: a binding that is not yours does not exist. */
  if (!binding || !binding.template) notFound();

  const secrets = await companyGoogleSecrets(session.companyId);

  if (!secrets) {
    return (
      <SectionShell>
        <SectionHeader title="Map columns" />
        <EmptyState
          tone="rose"
          title="Google Sheets is not connected"
          description="The service account that reads your spreadsheet is added by your platform contact. Once it is, this page can show you the columns."
        />
      </SectionShell>
    );
  }

  /*
   * The tab comes from the query string so that changing it is a navigation
   * rather than a form round trip - the headers depend on it, and a client-side
   * switch would have to guess at them.
   *
   * It is validated against the tabs Google actually reports rather than
   * trusted. A tab name from a query string reaches the values API as a range,
   * and the only thing between "whatever was in the URL" and a Google call is
   * this check.
   */
  const [tabs, chosenTab] = await resolveTab(
    secrets,
    binding.spreadsheetId,
    requestedTab ?? binding.tab,
  );

  const sheet = chosenTab
    ? await readBindingSheet(secrets, binding.spreadsheetId, chosenTab)
    : null;

  if (!sheet || !sheet.ok) {
    return (
      <SectionShell>
        <SectionHeader title="Map columns" />
        <EmptyState
          tone="rose"
          title="We cannot read that sheet"
          description={
            sheet && !sheet.ok
              ? `Share it with the service account, as Editor, then reload. Google said: ${sheet.error}`
              : "Share it with the service account, as Editor, then reload."
          }
        />
      </SectionShell>
    );
  }

  const content = toRecords(sheet.rows);
  const body = extractBody(binding.template.components);
  const variables = templateVariables(body);
  const existing = readMapping(binding.actionConfig);

  return (
    <SectionShell>
      <SectionHeader
        title={binding.name}
        lede="Say which column holds the phone number, and which one fills each placeholder. The preview is exactly what the next three rows would receive."
      />

      {content.headers.length === 0 ? (
        <EmptyState
          tone="rose"
          title="That tab has no header row"
          description="The first row has to name the columns, so they can be mapped to the message. Add one and reload."
        />
      ) : (
        <LeadMappingForm
          leadSourceId={binding.id}
          tabs={tabs}
          currentTab={chosenTab ?? binding.tab}
          headers={content.headers}
          previewRows={content.rows.slice(0, PREVIEW_ROWS)}
          totalRows={content.rows.length}
          body={body}
          variables={variables}
          initialPhone={existing.phone}
          initialVariables={existing.variables}
          initialInterval={binding.pollIntervalSeconds}
          csrf={<CsrfField />}
        />
      )}
    </SectionShell>
  );
}

/**
 * Every tab, and the one to read - never the raw query value.
 *
 * A tab title from the URL is handed to Google as an A1 range. Validating it
 * against the list Google itself reports means the only titles that reach that
 * call are ones the spreadsheet actually has, and a stale bookmark falls back
 * to the binding's own tab rather than producing a Google error.
 */
async function resolveTab(
  secrets: Record<string, string>,
  spreadsheetId: string,
  wanted: string,
): Promise<[string[], string | null]> {
  const listed = await listBindingTabs(secrets, spreadsheetId);

  if (!listed.ok) return [[], null];

  const titles = listed.titles;
  const chosen = titles.includes(wanted) ? wanted : (titles[0] ?? null);

  return [titles, chosen];
}

/** The stored mapping, or empty. jsonb holds whatever was written. */
function readMapping(raw: unknown): {
  phone: string;
  variables: Record<string, string>;
} {
  const empty = { phone: "", variables: {} };

  if (!raw || typeof raw !== "object") return empty;

  const mapping = (raw as Record<string, unknown>)["mapping"];
  if (!mapping || typeof mapping !== "object") return empty;

  const shape = mapping as Record<string, unknown>;
  const variables: Record<string, string> = {};

  if (shape["variables"] && typeof shape["variables"] === "object") {
    for (const [key, value] of Object.entries(
      shape["variables"] as Record<string, unknown>,
    )) {
      if (typeof value === "string") variables[key] = value;
    }
  }

  return {
    phone: typeof shape["phone"] === "string" ? shape["phone"] : "",
    variables,
  };
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
