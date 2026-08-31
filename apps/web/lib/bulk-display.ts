import type { BroadcastStatus } from "@whatsapp-os/db";

/**
 * How a broadcast and its recipients are presented.
 *
 * Extracted from the pages for the reason number-display.ts and kyc-display.ts
 * give: a badge choice is a decision with branches, and asserting a rendered
 * substring is not a test of one. The tests assert returned values.
 */

export type StatusVariant = "success" | "error" | "default" | "outline";

export function broadcastStatusLabel(status: BroadcastStatus): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "RUNNING":
      return "Sending";
    case "PAUSED":
      return "Paused";
    case "CANCELLED":
      return "Cancelled";
    case "COMPLETED":
      return "Sent";
  }
}

/**
 * The chip's colour.
 *
 * CANCELLED is not an error. Somebody chose it, usually deliberately and
 * usually because they spotted something - painting it red would make a
 * correct decision look like a fault, next to broadcasts that genuinely
 * failed.
 */
export function broadcastStatusVariant(status: BroadcastStatus): StatusVariant {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "RUNNING":
      return "default";
    case "PAUSED":
    case "CANCELLED":
      return "outline";
    case "DRAFT":
      return "outline";
  }
}

/** Which controls a run offers. Derived once so the page and the actions agree. */
export interface RunControls {
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
}

export function runControls(status: BroadcastStatus): RunControls {
  return {
    canPause: status === "RUNNING",
    canResume: status === "PAUSED",
    /*
     * Cancellable while running OR paused. A paused broadcast is the state
     * somebody is most likely to want to abandon - they stopped it because
     * something was wrong - and a Cancel that only appeared while running
     * would force them to resume first, sending more messages on the way to
     * stopping.
     */
    canCancel: status === "RUNNING" || status === "PAUSED",
  };
}

/** Is this broadcast still going to send anything? */
export function isLive(status: BroadcastStatus): boolean {
  return status === "RUNNING" || status === "PAUSED";
}

/**
 * The confirm step's friction threshold.
 *
 * Above this, the tenant types the recipient count to proceed. A thousand is
 * where a mistake stops being an embarrassment and starts being a bill and a
 * quality-rating problem - and it is low enough that anybody sending to their
 * whole list crosses it.
 */
export const TYPE_TO_CONFIRM_ABOVE = 1_000;

export function needsTypedConfirmation(recipientCount: number): boolean {
  return recipientCount > TYPE_TO_CONFIRM_ABOVE;
}

/**
 * How a message status reads on a broadcast report.
 *
 * Deliberately different words from the inbox's. On one message "Sent" means
 * Meta took it; across ten thousand, an operator is asking "how far has this
 * got", and the answer is a funnel - handed over, arrived, read.
 */
export function deliveryLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Queued";
    case "SENT":
      return "Sent";
    case "HELD":
      return "Held by Meta";
    case "DELIVERED":
      return "Delivered";
    case "READ":
      return "Read";
    case "FAILED":
      return "Failed";
    case "UNCONFIRMED":
      return "Unconfirmed";
    default:
      /* Renders the value rather than a blank, because a count with no label
         is the hardest kind of gap to notice on a report. */
      return status;
  }
}

/** The order a funnel reads in. Anything unrecognised sorts to the end. */
const DELIVERY_ORDER = [
  "PENDING",
  "SENT",
  "HELD",
  "DELIVERED",
  "READ",
  "UNCONFIRMED",
  "FAILED",
];

export function orderDeliveryStatuses(statuses: string[]): string[] {
  return [...statuses].sort((a, b) => {
    const ai = DELIVERY_ORDER.indexOf(a);
    const bi = DELIVERY_ORDER.indexOf(b);
    return (ai === -1 ? DELIVERY_ORDER.length : ai) -
      (bi === -1 ? DELIVERY_ORDER.length : bi);
  });
}
