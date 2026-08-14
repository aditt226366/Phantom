"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Your email is not verified yet" — with a way to fix it.
 *
 * Dismissible until reload, not permanently: an unverified account is a real
 * outstanding task, and a banner that can be dismissed forever is one the user
 * will never see again on the one day it matters. Deliberately no persistence.
 *
 * Resend is a form submission, not a link. It has a side effect, so it must not
 * be a GET — and `typedRoutes` would reject a Link to a route that does not
 * exist anyway.
 */
export interface VerifyBannerProps {
  email: string;
  /**
   * Server action. Optional so the styleguide can render the banner without
   * one; the button is disabled when it is absent.
   */
  resendAction?: (formData: FormData) => void | Promise<void>;
  /**
   * Hidden CSRF input, rendered by a Server Component parent and placed inside
   * this component's form. Resend is a mutating POST like any other.
   */
  csrf?: React.ReactNode;
  className?: string;
}

export function VerifyBanner({
  email,
  resendAction,
  csrf,
  className,
}: VerifyBannerProps) {
  const [dismissed, setDismissed] = React.useState(false);

  if (dismissed) return null;

  return (
    <div
      className={cn(
        "flex flex-col gap-sm rounded-lg border border-hairline-strong",
        "bg-surface-strong px-base py-sm",
        "tablet:flex-row tablet:items-center tablet:justify-between",
        className,
      )}
    >
      <p className="text-body-sm text-body">
        <span className="text-body-strong text-ink">Verify your email.</span>{" "}
        We sent a link to {email}.
      </p>

      <div className="flex shrink-0 items-center gap-xs">
        <form action={resendAction}>
          {csrf}
          <Button type="submit" variant="outline" size="sm" disabled={!resendAction}>
            Resend link
          </Button>
        </form>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
