import type { Metadata } from "next";
import Link from "next/link";
import { CsrfField } from "@/components/ui/csrf-field";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../../_components/section";
import { createTemplateAction } from "../actions";
import { Studio } from "../_components/studio";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "New template" };

/**
 * The Studio, for something that does not exist yet.
 *
 * A server component whose whole job is the boundary and the CSRF field. The
 * builder is a client component because the preview has to move as somebody
 * types - that is the point of it - and CsrfField is a Server Component
 * because cookies() is server-only, so it is passed in as a prop the way the
 * composer and the app shell both do it.
 */
export default async function Page() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Template Messaging" />;
  }


  return (
    <SectionShell>
      <header className="mb-lg">
        <Link
          href="/configuration/templates"
          className="text-caption text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Back to templates
        </Link>
        <div className="mt-xs">
          <SectionHeader
            title="New template"
            lede="Meta reviews every template. Most answers arrive within a few minutes, some take a day."
          />
        </div>
      </header>

      <Studio
        action={createTemplateAction}
        csrf={<CsrfField />}
        submitLabel="Submit for review"
      />
    </SectionShell>
  );
}
