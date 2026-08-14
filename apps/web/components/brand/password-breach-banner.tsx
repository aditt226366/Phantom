import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "This password has appeared in a breach."
 *
 * Shown when a deferred check found the password in HaveIBeenPwned's corpus —
 * meaning signup could not reach the service, the account was created anyway,
 * and the retry at the next sign-in found it.
 *
 * ---------------------------------------------------------------------------
 * Advisory, not a block
 * ---------------------------------------------------------------------------
 *
 * The user is already signed in when they see this: they proved they know the
 * password. Refusing the session would lock someone out of their own account
 * over a password they can still type, and leave them no route to fix it —
 * strictly worse than the risk, which is that a credential-stuffing attempt
 * elsewhere might work here too.
 *
 * Not dismissible, unlike the email-verification banner. That one marks a task
 * the user has already been asked to do and will be reminded of again; this
 * marks a live weakness that does not resolve on its own.
 */
export function PasswordBreachBanner({ className }: { className?: string }) {
  return (
    <div
      /*
       * Assertive rather than polite: this is not a status update, and a screen
       * reader user should not have to reach it in reading order to learn of it.
       */
      role="alert"
      className={cn(
        "flex items-start gap-sm rounded-lg border border-hairline-strong",
        "bg-surface-strong px-base py-sm",
        className,
      )}
    >
      <ShieldAlert
        size={18}
        aria-hidden="true"
        className="mt-xxs shrink-0 text-error"
      />

      <p className="text-body-sm text-body">
        <span className="text-body-strong text-error">
          This password has appeared in a data breach.
        </span>{" "}
        It still works, but it is known to attackers and should be replaced.{" "}
        <Link
          href="/profile/personal-details"
          className="text-ink underline underline-offset-4"
        >
          Your account details
        </Link>
        .
      </p>
    </div>
  );
}
