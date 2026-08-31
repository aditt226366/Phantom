"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { RunControls as Controls } from "@/lib/bulk-display";
import {
  cancelBroadcastAction,
  pauseBroadcastAction,
  resumeBroadcastAction,
} from "../actions";

/**
 * Pause, resume, cancel.
 *
 * Three separate forms rather than one with a hidden intent field. A single
 * form would put Cancel one wrong value away from Pause, on the control that
 * cannot be undone - and each posts to a named action, so what happened is
 * legible in a log rather than needing the body decoded.
 *
 * Cancel is an outline button and not a filled one. The system reserves filled
 * colour for the primary action, and on a running broadcast the primary action
 * is to let it finish.
 */
export function RunControls({
  broadcastId,
  controls,
  csrf,
}: {
  broadcastId: string;
  controls: Controls;
  csrf: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-xs">
      {controls.canPause ? (
        <form action={pauseBroadcastAction}>
          {csrf}
          <input type="hidden" name="broadcastId" value={broadcastId} />
          <Button type="submit" variant="outline" size="sm">
            Pause
          </Button>
        </form>
      ) : null}

      {controls.canResume ? (
        <form action={resumeBroadcastAction}>
          {csrf}
          <input type="hidden" name="broadcastId" value={broadcastId} />
          <Button type="submit" size="sm">
            Resume
          </Button>
        </form>
      ) : null}

      {controls.canCancel ? (
        <form action={cancelBroadcastAction}>
          {csrf}
          <input type="hidden" name="broadcastId" value={broadcastId} />
          <Button type="submit" variant="outline" size="sm">
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}
