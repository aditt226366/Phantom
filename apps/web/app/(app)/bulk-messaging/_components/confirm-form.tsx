"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { startBroadcastAction } from "../actions";

/**
 * Send, with friction proportional to the number of people it reaches.
 *
 * Under a thousand it is a button. Above, the tenant types the recipient count
 * - the same shape the KYC erasure uses, and for the same reason: a confirm
 * step protects against a misclick, and typing a value protects against
 * confirming the WRONG thing. Here the thing being confirmed is the size, so
 * the size is what gets typed, and somebody who thought this was a list of
 * fifty finds out by being asked to type 11,204.
 *
 * The check is repeated in the action, because a POST does not have to come
 * from this page.
 */
export function ConfirmForm({
  broadcastId,
  recipientCount,
  requiresTypedConfirmation,
  failed,
  csrf,
}: {
  broadcastId: string;
  recipientCount: number;
  requiresTypedConfirmation: boolean;
  failed: boolean;
  csrf: React.ReactNode;
}) {
  const [typed, setTyped] = React.useState("");

  const ready =
    recipientCount > 0 &&
    (!requiresTypedConfirmation || typed.trim() === String(recipientCount));

  return (
    <form
      action={startBroadcastAction}
      className="rounded-lg border border-hairline-strong bg-surface-card px-base py-base"
    >
      {csrf}
      <input type="hidden" name="broadcastId" value={broadcastId} />

      {recipientCount === 0 ? (
        <p className="text-body-sm text-body">
          Nothing is left to send after cleaning. Check the column mapping — a
          phone column pointed at the wrong field rejects every row.
        </p>
      ) : (
        <>
          {requiresTypedConfirmation ? (
            <div className="mb-base flex flex-col gap-xxs">
              <Label htmlFor="confirm-count">
                Type {recipientCount.toLocaleString()} to confirm
              </Label>
              <input
                id="confirm-count"
                name="confirmCount"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                inputMode="numeric"
                className="max-w-narrow rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink"
              />
              <p className="text-caption text-muted">
                This reaches {recipientCount.toLocaleString()} people and cannot
                be un-sent.
              </p>
            </div>
          ) : null}

          <Button type="submit" disabled={!ready}>
            Send to {recipientCount.toLocaleString()}{" "}
            {recipientCount === 1 ? "person" : "people"}
          </Button>
        </>
      )}

      <FormStatus
        message={
          failed
            ? "That did not start. The confirmation did not match, or the broadcast had already been started in another tab."
            : undefined
        }
        className="mt-base"
      />
    </form>
  );
}
