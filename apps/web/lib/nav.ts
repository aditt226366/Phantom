import {
  BarChart3,
  CreditCard,
  FileText,
  LayoutDashboard,
  Megaphone,
  Send,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { Route } from "next";

/**
 * The application sections, defined once.
 *
 * The sidebar renders from this, the active-item logic derives from it, and the
 * tests iterate it — so a section added here without a page fails typecheck
 * rather than rendering a dead link. `typedRoutes` makes `href: Route` a
 * compile-time claim that the route exists.
 */

export interface NavSection {
  label: string;
  href: Route;
  icon: LucideIcon;
}

export const NAV_SECTIONS: readonly NavSection[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "AI Messaging", href: "/ai-messaging", icon: Sparkles },
  /*
   * Reserved for the flow builder (A1), not for the Template Studio.
   *
   * The Studio moved to Configuration > Templates because a template is a
   * shared asset - the inbox picker, bulk messaging and the flow builder all
   * draw on the same approved templates - and a shared asset is configuration
   * rather than a section of its own.
   *
   * The section stays in the nav because A1 reserves it, and because the
   * alternative is a nav that loses an item now and grows it back later. It
   * renders what ai-messaging and meta-ads render: an honest description of
   * what will be there.
   */
  { label: "Template Messaging", href: "/template-messaging", icon: FileText },
  { label: "Bulk Messaging", href: "/bulk-messaging", icon: Send },
  { label: "Meta Ads", href: "/meta-ads", icon: Megaphone },
  { label: "Configuration", href: "/configuration", icon: Settings },
  { label: "Billing", href: "/billing", icon: CreditCard },
] as const;

/** Reachable from the topbar rather than the sidebar. */
export const INBOX_HREF = "/inbox" satisfies Route;

export const PROFILE_LINKS: readonly NavSection[] = [
  { label: "Personal details", href: "/profile/personal-details", icon: BarChart3 },
  { label: "Documents", href: "/profile/documents", icon: FileText },
] as const;

/**
 * Is this section the one being viewed?
 *
 * Prefix matching so a nested route keeps its parent highlighted, but only on a
 * segment boundary — otherwise "/bulk-messaging" would also light up for a
 * hypothetical "/bulk-messaging-archive".
 */
export function isActiveSection(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Every path the shell owns. proxy.ts uses this to decide what to protect. */
export const PROTECTED_PREFIXES: readonly string[] = [
  ...NAV_SECTIONS.map((section) => section.href),
  INBOX_HREF,
  "/profile",
] as const;
