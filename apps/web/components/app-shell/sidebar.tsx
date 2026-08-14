"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { NAV_SECTIONS, isActiveSection } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The section navigation.
 *
 * Persistent from `desktop:` up, an overlay below it. Only `tablet:`,
 * `desktop:` and `wide:` exist in this design system — the default Tailwind
 * `sm:`/`md:`/`lg:` are not defined.
 */

export interface SidebarProps {
  open: boolean;
  onClose: () => void;
  /** Focus returns here when the overlay closes. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Sidebar({ open, onClose, triggerRef }: SidebarProps) {
  const pathname = usePathname();
  const panelRef = React.useRef<HTMLDivElement>(null);

  /*
   * Focus management for the overlay.
   *
   * Three things, and leaving any of them out makes the overlay unusable
   * without a mouse: focus moves into the panel on open, Tab cycles within it
   * rather than escaping to the page behind, and focus returns to the button
   * that opened it on close — otherwise the user is dropped at the top of the
   * document with no idea where they are.
   */
  React.useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    if (!panel) return;

    /*
     * Captured now rather than read during cleanup: the ref may point
     * somewhere else by then, and the button that opened the panel is stable
     * for as long as it is mounted.
     */
    const trigger = triggerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        panel!.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      /* The trigger if we still have it, otherwise wherever focus came from. */
      (trigger ?? previouslyFocused)?.focus();
    };
  }, [open, onClose, triggerRef]);

  return (
    <>
      {open ? (
        <div
          /* Decoration; Escape and the close button are the real affordances. */
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-surface-dark/40 desktop:hidden"
        />
      ) : null}

      <div
        ref={panelRef}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-sidebar flex-col border-r border-hairline bg-surface-card",
          "transition-transform duration-150",
          open ? "translate-x-0" : "-translate-x-full",
          /* Always in flow and always visible from desktop up. */
          "desktop:static desktop:translate-x-0",
        )}
      >
        <div className="flex h-nav shrink-0 items-center justify-between border-b border-hairline px-base">
          <span className="font-display text-title-md text-ink">
            whatsapp-os
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-sm p-xxs text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink desktop:hidden"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <nav aria-label="Sections" className="flex flex-col gap-xxs p-sm">
          {NAV_SECTIONS.map((section) => {
            const active = isActiveSection(section.href, pathname);
            const Icon = section.icon;

            return (
              <Link
                key={section.href}
                href={section.href}
                onClick={onClose}
                /*
                 * aria-current, not just a colour. A screen reader user gets
                 * no benefit from the highlight.
                 */
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-sm rounded-md px-sm py-xs font-body text-nav-link",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                  active
                    ? "bg-surface-strong text-ink"
                    : "text-body hover:bg-surface-strong hover:text-ink",
                )}
              >
                <Icon size={16} aria-hidden="true" className="shrink-0" />
                {section.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
