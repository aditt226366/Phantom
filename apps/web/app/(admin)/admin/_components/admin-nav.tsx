import Link from "next/link";
import { AdminCsrfField } from "./admin-csrf-field";
import { adminSignOutAction } from "../actions";

/**
 * The console's chrome.
 *
 * Rendered by the layout, which is convenience only — CLAUDE.md rule 4. Every
 * page underneath calls requireAdminSession() itself, because a layout is
 * cached per segment and is not guaranteed to re-run on navigation within it.
 *
 * Log out is a form, not a link: it changes server state, and a GET that
 * changes state is one a prefetcher can fire on hover.
 */

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/companies", label: "Companies" },
] as const;

export function AdminNav({ username }: { username: string }) {
  return (
    <header className="border-b border-hairline bg-surface-card">
      <div className="mx-auto flex h-nav max-w-container items-center justify-between gap-base px-lg">
        <div className="flex items-center gap-lg">
          <span className="font-display text-title-md text-ink">
            Platform admin
          </span>

          <nav aria-label="Admin sections" className="flex items-center gap-base">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-nav-link text-body transition-colors hover:text-ink"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-base">
          <span className="text-body-sm text-muted">{username}</span>

          <form action={adminSignOutAction}>
            <AdminCsrfField />
            <button
              type="submit"
              className="rounded-pill border border-hairline-strong px-base py-xs font-body text-button text-ink transition-colors hover:border-ink"
            >
              Log out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
