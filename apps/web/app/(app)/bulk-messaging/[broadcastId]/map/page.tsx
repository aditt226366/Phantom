import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { templateVariables } from "@whatsapp-os/core/whatsapp";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { MappingForm } from "../../_components/mapping-form";

export const metadata: Metadata = { title: "Map columns" };

/** How many rows the preview renders. Three is enough to spot a wrong column. */
const PREVIEW_ROWS = 3;

/**
 * Step two: which column feeds the number, and which feeds each placeholder.
 *
 * The live preview is the point of the screen. A mapping is easy to get wrong
 * in a way that is invisible as a set of dropdowns and obvious as a sentence -
 * "Hi 98765 43210, your order 1204 is ready" is a mapping with two columns
 * swapped, and nobody reads it as such until they see the message.
 *
 * Three rows rather than one, because the first row of a spreadsheet is often
 * the tidiest and a blank cell two rows down is exactly what this is for.
 */
export default async function MapColumnsPage({
  params,
}: {
  params: Promise<{ broadcastId: string }>;
}) {
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Bulk Messaging" />;
  }

  const { broadcastId } = await params;

  const broadcast = await withCompany(session.companyId, (db, companyId) =>
    db.broadcast.findFirst({
      where: { id: broadcastId, companyId, status: "DRAFT" },
      select: {
        id: true,
        name: true,
        sourceHeaders: true,
        sourceRows: true,
        columnMapping: true,
        parsedCount: true,
        template: { select: { name: true, components: true } },
      },
    }),
  );

  /* Rule 6, and it covers the ordinary case too: a broadcast that has already
     been sent has no source rows and no mapping step to return to. */
  if (!broadcast || !Array.isArray(broadcast.sourceRows)) notFound();

  const headers = Array.isArray(broadcast.sourceHeaders)
    ? (broadcast.sourceHeaders as unknown[]).filter(
        (h): h is string => typeof h === "string",
      )
    : [];

  const rows = (broadcast.sourceRows as unknown as Record<string, string>[])
    .slice(0, PREVIEW_ROWS)
    .map((row) => {
      /* Only the mapped columns could ever be rendered, but the preview needs
         every header available to react to a change in the dropdowns. */
      const trimmed: Record<string, string> = {};
      for (const header of headers) trimmed[header] = String(row[header] ?? "");
      return trimmed;
    });

  const body = extractBody(broadcast.template.components);
  const variables = templateVariables(body);

  const existing =
    broadcast.columnMapping &&
    typeof broadcast.columnMapping === "object" &&
    !Array.isArray(broadcast.columnMapping)
      ? (broadcast.columnMapping as { phone?: string; variables?: Record<string, string> })
      : null;

  return (
    <SectionShell>
      <SectionHeader
        title="Map the columns"
        lede={`${broadcast.parsedCount.toLocaleString()} rows read from ${broadcast.name}. Tell us which column holds the phone number, and which fills each placeholder.`}
      />

      <MappingForm
        broadcastId={broadcast.id}
        headers={headers}
        previewRows={rows}
        body={body}
        variables={variables}
        initialPhone={existing?.phone ?? guessPhoneColumn(headers)}
        initialVariables={existing?.variables ?? {}}
        csrf={<CsrfField />}
      />
    </SectionShell>
  );
}

/**
 * A first guess at the phone column, from its name.
 *
 * A convenience and never a decision - the tenant confirms it on screen, and
 * the audience is built from what they confirmed. Worth having because the
 * column is called some variant of "phone" in almost every list, and a wrong
 * guess costs one dropdown change while a right one costs nothing.
 */
function guessPhoneColumn(headers: string[]): string {
  const candidates = ["phone", "mobile", "number", "whatsapp", "contact"];

  for (const header of headers) {
    const lower = header.toLowerCase();
    if (candidates.some((candidate) => lower.includes(candidate))) return header;
  }

  return "";
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
