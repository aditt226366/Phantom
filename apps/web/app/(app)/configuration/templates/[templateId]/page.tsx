import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  draftFromComponents,
  type TemplateCategory,
  type TemplateComponent,
} from "@whatsapp-os/core/whatsapp";
import { templateEditQuota, withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { CsrfField } from "@/components/ui/csrf-field";
import { requireSession } from "@/lib/auth/session";
import { formatTimestamp } from "@/lib/format";
import {
  QUOTA_CAVEAT,
  quotaLabel,
  rejectionExplanation,
  templateTone,
} from "@/lib/template-display";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { Studio } from "../_components/studio";
import { resubmitTemplateAction } from "../actions";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Template" };

/* A template's status moves when Meta decides. Never a cached render. */
export const dynamic = "force-dynamic";

/**
 * One template: what Meta said, and the Studio loaded with what was sent.
 *
 * The rejection reason is above the builder rather than beside the submit,
 * because it is what somebody came here to read. They arrive from a list row
 * that already told them it was rejected; this page has to tell them why before
 * it shows them the controls to change it.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ templateId: string }>;
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

  const { templateId } = await params;

  const loaded = await withCompany(session.companyId, async (db, companyId) => {
    const template = await db.whatsAppTemplate.findFirst({
      where: { id: templateId },
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        status: true,
        components: true,
        rejectedReason: true,
        statusUpdatedAt: true,
      },
    });

    if (!template) return null;

    return {
      template,
      quota: await templateEditQuota(db, companyId, templateId, new Date()),
    };
  });

  /* Rule 6: not yours means it does not exist. */
  if (!loaded) notFound();

  const { template, quota } = loaded;
  const explanation = rejectionExplanation(template.rejectedReason);

  /*
   * The inverse of buildComponents, so the builder opens on exactly what was
   * submitted. Round-tripped in packages/core's tests: if this lost a field,
   * opening a template and pressing submit without touching anything would
   * silently change it.
   */
  const draft = draftFromComponents(
    template.components as unknown as TemplateComponent[],
    {
      name: template.name,
      language: template.language,
      category: template.category as TemplateCategory,
    },
  );

  return (
    <SectionShell>
      <header className="mb-lg">
        <Link
          href="/configuration/templates"
          className="text-caption text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Back to templates
        </Link>

        <div className="mt-xs flex flex-wrap items-center gap-sm">
          <h1 className="min-w-0 break-words text-display-md text-ink">
            {template.name}
          </h1>
          <Badge variant={templateTone(template.status)}>{template.status}</Badge>
        </div>

        <p className="mt-xxs text-body-sm text-muted">
          {template.language} · {template.category} ·{" "}
          {formatTimestamp(template.statusUpdatedAt)}
        </p>
      </header>

      {/* Meta's token verbatim, our explanation under it. Never instead of it. */}
      {template.rejectedReason ? (
        <div className="mb-lg rounded-xl border border-hairline-strong bg-surface-strong p-base">
          <p className="text-caption-uppercase uppercase text-muted">
            Why Meta rejected it
          </p>
          <p className="mt-xxs break-words text-body-strong text-error">
            {template.rejectedReason}
          </p>
          {explanation ? (
            <p className="mt-xs text-body-sm text-body">{explanation}</p>
          ) : null}
        </div>
      ) : null}

      <SectionHeader title="Edit and resubmit" />

      <Studio
        action={resubmitTemplateAction}
        csrf={
          <>
            <CsrfField />
            <input type="hidden" name="templateId" value={template.id} />
          </>
        }
        initial={draft}
        submitLabel="Resubmit for review"
        quota={
          /*
           * R8, rendered. The label says "here" because that is the only claim
           * this number supports - Meta counts edits made in Business Manager
           * and those never reach our table - and the caveat under it is what
           * stops somebody planning around a floor as though it were a ceiling.
           *
           * Beside the submit, and not gating it. The button attempts the edit
           * and decodes Meta's refusal, because a disabled control that
           * disagreed with Meta would be a support ticket.
           */
          <div className="rounded-md border border-hairline bg-canvas px-sm py-xs">
            <p className="text-caption text-body-strong">
              {quotaLabel(quota.used, quota.limit)}
            </p>
            <p className="mt-xxs text-caption text-muted">{QUOTA_CAVEAT}</p>
          </div>
        }
      />
    </SectionShell>
  );
}
