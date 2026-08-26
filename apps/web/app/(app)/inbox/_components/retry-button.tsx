"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { retryMessageAction, type RetryState } from "../actions";

/**
 * Send one message again.
 *
 * The warning renders beside the control rather than behind a confirmation
 * dialog, and that is a deliberate choice about which mistake to prevent. A
 * dialog is dismissed by people who have already decided to click; text above
 * the button is read by people deciding. It also means the dangerous case is
 * visible in a screenshot instead of one click away from anybody looking.
 */
export function RetryButton({
  messageId,
  label,
  warning,
  csrf,
}: {
  messageId: string;
  label: string;
  /** Null when non-delivery is proven and a retry cannot duplicate anything. */
  warning: string | null;
  csrf: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<RetryState, FormData>(
    retryMessageAction,
    {},
  );

  return (
    <form action={formAction} className="mt-xs flex flex-col gap-xs">
      {csrf}
      <input type="hidden" name="messageId" value={messageId} />

      {warning ? (
        <p className="text-caption text-body-strong">{warning}</p>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-caption text-error">
          {state.error}
        </p>
      ) : null}

      <div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Queueing…" : label}
        </Button>
      </div>
    </form>
  );
}
