"use client";

import * as React from "react";
import Link from "next/link";
import { Inbox, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PasswordBreachBanner } from "@/components/brand/password-breach-banner";
import { VerifyBanner } from "@/components/brand/verify-banner";
import { INBOX_HREF } from "@/lib/nav";
import { ProfileMenu } from "./profile-menu";
import { Sidebar } from "./sidebar";

/**
 * Sidebar + topbar + content.
 *
 * A client component because the overlay sidebar and the profile dropdown hold
 * state. Everything it renders that needs the server — the CSRF field, the
 * session values — arrives as props or children from the layout, so nothing
 * server-only crosses the boundary.
 */
export interface AppShellProps {
  companyName: string;
  fullName: string;
  email: string;
  /** Non-null once the address is confirmed; drives the banner. */
  emailVerified: boolean;
  /** True when a deferred breach check found this password. */
  passwordBreached: boolean;
  signOutAction: (formData: FormData) => void | Promise<void>;
  resendAction: (formData: FormData) => void | Promise<void>;
  csrf: React.ReactNode;
  /** A second copy, because a form may only contain one of each field. */
  resendCsrf: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell({
  companyName,
  fullName,
  email,
  emailVerified,
  passwordBreached,
  signOutAction,
  resendAction,
  csrf,
  resendCsrf,
  children,
}: AppShellProps) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpen(false), []);

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/*
        First focusable element on the page. Without it, a keyboard user tabs
        through all seven nav items on every navigation before reaching the
        content they asked for.
      */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-base focus:top-base focus:z-50 focus:rounded-md focus:bg-surface-card focus:px-base focus:py-sm focus:text-body-strong focus:text-ink focus:outline-2 focus:outline-ink"
      >
        Skip to content
      </a>

      <Sidebar open={open} onClose={close} triggerRef={triggerRef} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-nav shrink-0 items-center justify-between gap-base border-b border-hairline bg-canvas px-base">
          <div className="flex min-w-0 items-center gap-sm">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open navigation"
              aria-expanded={open}
              className="rounded-sm p-xxs text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink desktop:hidden"
            >
              <Menu size={20} aria-hidden="true" />
            </button>

            <span className="truncate font-body text-title-sm text-ink">
              {companyName}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-xs">
            <Button asChild variant="outline" size="sm">
              <Link href={INBOX_HREF}>
                <Inbox size={16} aria-hidden="true" />
                <span className="hidden tablet:inline">Inbox</span>
              </Link>
            </Button>

            <ProfileMenu
              fullName={fullName}
              email={email}
              signOutAction={signOutAction}
              csrf={csrf}
            />
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1 px-base py-lg desktop:px-lg">
          {passwordBreached ? <PasswordBreachBanner className="mb-lg" /> : null}

          {!emailVerified ? (
            <VerifyBanner
              email={email}
              resendAction={resendAction}
              csrf={resendCsrf}
              className="mb-lg"
            />
          ) : null}

          {children}
        </main>
      </div>
    </div>
  );
}
