"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  deleteLeadSourceAction,
  setLeadSourceEnabledAction,
} from "../actions";

/**
 * Switch a binding on or off, and delete it.
 *
 * Delete is behind a typed confirmation of the binding's name, and the reason
 * is not that deleting a row is dangerous - it is what deleting takes with it.
 * The rows recording who has already been contacted cascade, so binding the
 * same spreadsheet again messages everybody on it a second time. A confirm
 * dialog protects against a misclick; only typing the name protects against
 * confirming the wrong binding, which is the mistake that costs a customer list
 * a duplicate message each.
 *
 * The same shape as the KYC erasure control, for the same reason.
 */
export function BindingControls({
  leadSourceId,
  name,
  enabled,
  csrf,
}: {
  leadSourceId: string;
  name: string;
  enabled: boolean;
  csrf: React.ReactNode;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  return (
    <>
      <form action={setLeadSourceEnabledAction}>
        {csrf}
        <input type="hidden" name="leadSourceId" value={leadSourceId} />
        <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
        <Button type="submit" variant={enabled ? "outline" : "primary"}>
          {enabled ? "Pause" : "Start polling"}
        </Button>
      </form>

      {confirming ? (
        <form
          action={deleteLeadSourceAction}
          className="flex flex-wrap items-center gap-sm"
        >
          {csrf}
          <input type="hidden" name="leadSourceId" value={leadSourceId} />
          <input
            aria-label={`Type ${name} to confirm deleting this lead source`}
            placeholder={name}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink"
          />
          <Button type="submit" variant="outline" disabled={typed !== name}>
            Delete for good
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              setTyped("");
            }}
          >
            Keep it
          </Button>
          <p className="w-full text-caption text-muted">
            Deleting also forgets who has already been contacted from this
            sheet. Binding it again would message all of them a second time.
          </p>
        </form>
      ) : (
        <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
          Delete
        </Button>
      )}
    </>
  );
}
