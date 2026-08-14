import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The form-level result message, for useActionState.
 *
 * ---------------------------------------------------------------------------
 * The live region is always rendered, even when empty
 * ---------------------------------------------------------------------------
 *
 * aria-live only announces changes to a region that was already in the
 * accessibility tree. Mounting the element at the same moment as the text —
 * the obvious `{error && <div role="status">…</div>}` — means the region and
 * its content appear together and most screen readers say nothing at all. So
 * the wrapper is unconditional and only the message inside it is conditional.
 *
 * ---------------------------------------------------------------------------
 * One message, and never a specific one
 * ---------------------------------------------------------------------------
 *
 * Sign-in must not distinguish "no such user" from "wrong password". This
 * component renders whatever it is handed, so the discipline lives at the call
 * site — but there is exactly one slot here on purpose: nowhere to put a
 * helpful second line that quietly turns into an account-existence oracle.
 */
export interface FormStatusProps {
  /** Absent or empty renders the live region with nothing in it. */
  message?: string | undefined;
  tone?: "error" | "success";
  className?: string;
}

export function FormStatus({
  message,
  tone = "error",
  className,
}: FormStatusProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(message ? "block" : "sr-only", className)}
    >
      {message ? (
        <p
          className={cn(
            /*
             * Colour is carried by the text on a neutral plate, matching Badge.
             * A saturated fill would read as an action, and the system reserves
             * filled colour for the ink CTA alone.
             */
            "rounded-md border border-hairline-strong bg-surface-strong px-base py-sm text-body-sm",
            tone === "error" ? "text-error" : "text-success",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
