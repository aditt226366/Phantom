"use server";

import { revalidatePath } from "next/cache";
import {
  JOB_NAMES,
  SEND_JOB_OPTIONS,
  sendJobId,
} from "@whatsapp-os/core/queues";
import { advanceConversation, canSend, withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { systemQueue } from "@/lib/queue";
import { refusalSentence } from "@/lib/thread-display";

/**
 * Write the message, then enqueue it. Nothing here talks to Meta.
 *
 * The split is the phase's central decision and Phase 5's bulk queue reuses
 * this half unchanged: the composer persists a PENDING row and hands the id to
 * a worker, which is the only thing that calls /messages. A send that went out
 * from the action would put a network round trip inside a request the operator
 * is waiting on, and - far worse - would leave a message that Meta accepted
 * with no row to attach the wamid to if the response were lost.
 */

export interface SendState {
  error?: string;
  /** Cleared on success so the textarea empties. Echoed back on failure. */
  draft?: string;
}

/** Meta's own ceiling for a text body. Refused here rather than by Meta. */
const MAX_BODY_LENGTH = 4096;

export async function sendMessageAction(
  _previous: SendState,
  formData: FormData,
): Promise<SendState> {
  /* Its own check, not the layout's — rule 4. */
  const session = await requireSession();
  await assertCsrf(formData, session);

  const conversationId = String(formData.get("conversationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();

  if (!conversationId) return { error: "Something went wrong. Try again." };
  if (body.length === 0) return { error: "Write something first." };
  if (body.length > MAX_BODY_LENGTH) {
    return {
      draft: body,
      error: `WhatsApp allows ${MAX_BODY_LENGTH} characters and this is ${body.length}.`,
    };
  }

  /*
   * One instant for the check and the row, so a window cannot close between
   * deciding this is allowed and recording when it happened.
   */
  const now = new Date();

  const outcome = await withCompany(session.companyId, async (db, companyId) => {
    /*
     * canSend here is feedback, not the boundary. The worker runs it again
     * immediately before the Graph call and that one is authoritative - by the
     * time a queue has been through, this answer is seconds to minutes old and
     * the 24-hour window may have closed inside the gap. Both exist on purpose;
     * removing this one would mean the operator learns from a red bubble
     * instead of from the composer.
     */
    const sendability = await canSend(
      db,
      companyId,
      conversationId,
      { kind: "freeform" },
      now,
    );

    /* Rule 6: a thread that is not yours does not exist. */
    if (!sendability) return { kind: "gone" } as const;

    if (!sendability.decision.allowed) {
      return { kind: "refused", reason: sendability.decision.reason } as const;
    }

    const message = await db.message.create({
      data: {
        companyId,
        conversationId,
        direction: "OUTBOUND",
        status: "PENDING",
        type: "text",
        body,
        /* Ours, because Meta has not seen this yet. The thread orders on it. */
        occurredAt: now,
        sentByUserId: session.userId,
        sendAttempt: 0,
      },
      select: { id: true, sendAttempt: true },
    });

    /*
     * The thread and the inbox both move now rather than when Meta answers.
     * windowExpiresAt is null: an outbound message never opens or extends a
     * window - only the customer writing does - and passing a value here would
     * hand somebody a way to reopen their own 24 hours by talking.
     */
    await advanceConversation(db, companyId, conversationId, {
      occurredAt: now,
      preview: body,
      inbound: false,
      windowExpiresAt: null,
      unread: 0,
    });

    return { kind: "created", message } as const;
  });

  if (outcome.kind === "gone") {
    return { draft: body, error: "This conversation is no longer available." };
  }

  if (outcome.kind === "refused") {
    return { draft: body, error: refusalSentence(outcome.reason) };
  }

  /*
   * Outside the scope. withCompany holds a pooled connection and times out at
   * 5s, and Redis being slow is not a reason to lose a transaction that has
   * already written the row.
   */
  await systemQueue.add(
    JOB_NAMES.WHATSAPP_MESSAGE_SEND,
    {
      companyId: session.companyId,
      messageId: outcome.message.id,
      sendAttempt: outcome.message.sendAttempt,
    },
    {
      jobId: sendJobId(outcome.message.id, outcome.message.sendAttempt),
      ...SEND_JOB_OPTIONS,
    },
  );

  /* The action stays on the page, so nothing re-renders without this. */
  revalidatePath(`/inbox/${conversationId}`);
  revalidatePath("/inbox");

  return {};
}
