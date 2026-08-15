"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The workspace tabs.
 *
 * Real routes, not a tab component holding state. Each tab is a URL, so the
 * back button works, a tab is linkable into a support thread, and every page
 * gets to run its own guard and its own query — which is what CLAUDE.md rule 4
 * asks for and what a client-side tab switcher quietly prevents.
 *
 * Client only for the active-state highlight; there is no other behaviour
 * here, and the links work without JavaScript.
 *
 * No Features tab. It is not in scope for this phase, and an empty tab
 * promising one is a commitment nobody made.
 */

const TABS = [
  { segment: "", label: "Overview" },
  { segment: "/integrations", label: "Integrations" },
  { segment: "/documents", label: "Documents" },
  { segment: "/billing", label: "Billing" },
] as const;

export function CompanyTabs({ companyId }: { companyId: string }) {
  const pathname = usePathname();
  const base = `/admin/companies/${companyId}`;

  return (
    <nav aria-label="Company sections" className="border-b border-hairline">
      <ul className="flex list-none flex-wrap gap-lg">
        {TABS.map((tab) => {
          const href = `${base}${tab.segment}`;
          const active = pathname === href;

          return (
            <li key={tab.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px inline-block border-b-2 pb-sm text-nav-link transition-colors ${
                  active
                    ? "border-ink text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
