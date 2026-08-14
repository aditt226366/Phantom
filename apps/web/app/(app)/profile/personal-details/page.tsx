import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/session";
import { SectionHeader, SectionShell } from "../../_components/section";

export const metadata: Metadata = { title: "Personal details" };

/** What was given at signup. Read-only until editing exists. */
export default async function PersonalDetailsPage() {
  const session = await requireSession();

  const rows = [
    { label: "Full name", value: session.user.fullName },
    { label: "Company", value: session.company.name },
    { label: "Work email", value: session.user.email },
    { label: "Contact number", value: session.user.phoneE164 },
    { label: "Username", value: session.user.username },
  ];

  return (
    <SectionShell>
      <SectionHeader
        title="Personal details"
        lede="Taken from your sign-up. Editing arrives with the rest of account management."
      />

      <dl className="divide-y divide-hairline rounded-xl border border-hairline bg-surface-card">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-col gap-xxs px-lg py-base tablet:flex-row tablet:items-center tablet:justify-between"
          >
            <dt className="text-body-sm text-muted">{row.label}</dt>
            <dd className="text-body-strong text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </SectionShell>
  );
}
