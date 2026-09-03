import {
  decrypt,
  secretAad,
  usageDedupeKey,
  type WhatsAppMessageSendJob,
} from "@whatsapp-os/core";
import { classifyBulkError } from "@whatsapp-os/core/bulk";
import {
  sendWhatsAppInteractive,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  readInteractivePayload,
  readTemplatePayload,
} from "@whatsapp-os/core/whatsapp";
import {
  broadcastRunState,
  canSend,
  markContactUndeliverable,
  pauseBroadcastForRateLimit,
  pauseRunForMessage,
  recordSendAccepted,
  recordSendDeclined,
  recordSendRefused,
  recordSendUnconfirmed,
  recordUsage,
  withCompany,
  type CompanyClient,
} from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { log } from "../logger.ts";

/**
 * Hand one already-persisted message to Meta, and remember what it called it.
 *
 * The composer writes the row and enqueues; this is the only thing that talks
 * to Meta. Everything about the shape follows from one fact: /messages has no
 * idempotency key and no "did this land" lookup, so a repeat is a repeat.
 *
 *   attempts: 1                 lives in SEND_JOB_OPTIONS rather than here, so
 *                               the rule travels with the contract instead of
 *                               with one call site
 *   sendAttempt in the job id   BullMQ keeps completed ids for an hour and
 *                               failed ones for a day, so a retry re-enqueued
 *                               under the first attempt's id is silently
 *                               dropped and the button appears to do nothing
 *   read, close, call, write    no provider call inside a transaction
 */

export type SendResult =
  | "sent"
  | "held"
  | "declined"
  | "refused"
  | "unconfirmed"
  | "already_sent"
  | "unknown_message"
  /** Part of a broadcast that is paused. The row stays PENDING for a resume. */
  | "broadcast_paused";

export async function handleWhatsAppMessageSend(
  payload: WhatsAppMessageSendJob,
): Promise<{ result: SendResult }> {
  const { companyId, messageId } = payload;

  /* 1. Read the message and the credentials, then close the scope. */
  const loaded = await withCompany(companyId, (db) =>
    db.message.findFirst({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        body: true,
        wamid: true,
        /* What the row SAYS it is, so an unreadable payload can be told from a
           genuine text message. Without it both look identical to the reader
           and the fault silently becomes a text send. */
        type: true,
        /* Present means this row is a template send. The payload holds the
           name, language and the parameter values chosen at send time - and,
           for a flow's entry, one payload per quick-reply button. */
        templatePayload: true,
        /* Present means this row is a flow's interactive step: reply buttons
           or a list, with ids naming the run and the node that asked. */
        interactivePayload: true,
        /* Present means this row is one recipient of a broadcast, and that the
           run's status has to be consulted before anything is sent. */
        broadcastId: true,
        conversation: {
          select: {
            contact: { select: { id: true, waId: true } },
            whatsappNumber: {
              select: {
                integrationId: true,
                integration: {
                  select: { secrets: { select: { key: true, ciphertext: true } } },
                },
              },
            },
          },
        },
      },
    }),
  );

  if (!loaded) return { result: "unknown_message" };

  if (loaded.wamid) {
    /*
     * Meta has already named this message, so it has already been handed over.
     * Refusing to send again is the point of attempts: 1 - a second POST here
     * reaches a real customer twice and cannot be un-sent.
     */
    log.warn("send skipped: the message already has a wamid", {
      companyId,
      messageId,
    });
    return { result: "already_sent" };
  }

  /*
   * The pause check, and it is why pause is immediate.
   *
   * Thousands of sends may be sitting in Redis with their delays already
   * computed. Removing them on a pause would be a slow, racy sweep of a
   * structure being consumed at the same time; letting every job wake up and
   * ask costs one indexed read and is exact.
   *
   * Before the decrypt and before canSend deliberately - a paused broadcast
   * should not be doing key material work, and a cancelled one should not be
   * reading credentials at all.
   */
  if (loaded.broadcastId) {
    const state = await withCompany(companyId, (db, scoped) =>
      broadcastRunState(db, scoped, loaded.broadcastId!),
    );

    if (state === "paused") {
      /*
       * The row stays PENDING and nothing is written. Resume re-enqueues it
       * with a fresh delay, so a paused broadcast keeps its place rather than
       * losing the recipients that happened to be mid-flight.
       */
      log.info("send deferred: broadcast paused", {
        companyId,
        messageId,
        broadcastId: loaded.broadcastId,
      });
      return { result: "broadcast_paused" };
    }

    if (state === "stopped") {
      /*
       * Cancelled, completed or gone. Recorded as a refusal rather than
       * dropped silently: the message row exists and somebody will look at it,
       * and a row with no status and no reason is the shape of a bug where
       * "the campaign was cancelled" is the shape of an answer.
       */
      await withCompany(companyId, (db, scoped) =>
        recordSendDeclined(db, scoped, messageId, "broadcast_cancelled", new Date()),
      );

      log.info("send declined: broadcast stopped", {
        companyId,
        messageId,
        broadcastId: loaded.broadcastId,
      });
      return { result: "declined" };
    }
  }

  const number = loaded.conversation.whatsappNumber;

  /* 2. Decrypt. CPU only, nothing open. */
  const secrets: Record<string, string> = {};
  for (const row of number.integration.secrets) {
    secrets[row.key] = decrypt(
      row.ciphertext,
      keyring(),
      secretAad(companyId, number.integrationId, row.key),
    );
  }

  /*
   * 3. canSend, as late as a database read can be: after the decrypt, in its
   * own short scope, immediately before the call.
   *
   * The composer already ran this and showed the operator an answer. It runs
   * again because that answer is minutes old by the time a queue has been
   * through it, and the 24-hour window can close in between - which is exactly
   * the case where the composer said yes and Meta would say no. This one is the
   * boundary; the other is feedback.
   */
  const now = new Date();

  /* Decided once, before the check and the call, so they cannot disagree. */
  const template = readTemplatePayload(loaded.templatePayload);
  const interactive = readInteractivePayload(loaded.interactivePayload);

  /*
   * A stored payload that will not read back is REFUSED, not downgraded.
   *
   * -------------------------------------------------------------------------
   * What this used to do, and why the symptom pointed somewhere else
   * -------------------------------------------------------------------------
   *
   * Both readers return null defensively, and the null used to fall through to
   * the text branch below. For a row whose `type` is `template` or
   * `interactive`, that sends the rendered body as ordinary free-form text -
   * a different message than the producer wrote, missing its variables,
   * missing the button payloads that make a tap start a flow.
   *
   * And free-form text is exactly what Meta refuses outside a 24-hour window.
   * So a payload fault on a cold recipient - which is every bulk, lead-source
   * and campaign send - arrived as `window_closed` on a message whose window
   * was fine, and nothing anywhere named the real cause.
   *
   * Refusing costs one message that was going to be wrong anyway, and puts
   * the reason on the row where the thread renders it.
   */
  const payloadUnreadable =
    (loaded.type === "template" && template === null) ||
    (loaded.type === "interactive" && interactive === null);

  if (payloadUnreadable) {
    await withCompany(companyId, (db, scoped) =>
      recordSendDeclined(
        db,
        scoped,
        messageId,
        "stored_payload_unreadable",
        now,
      ),
    );

    log.error("send declined: stored payload could not be read", {
      companyId,
      messageId,
      type: loaded.type,
    });

    return { result: "declined" };
  }

  const sendability = await withCompany(companyId, (db, scoped) =>
    canSend(
      db,
      scoped,
      loaded.conversationId,
      /*
       * The intent has to match what is actually about to be sent, or the
       * boundary is checking the wrong question. A template row asked with a
       * freeform intent would be refused the moment the window closed - which
       * is the one case a template exists for.
       *
       * `approved: true` because the composer only lists approved templates and
       * the row was written from one. Meta re-checks anyway, and an approval
       * withdrawn between listing and sending comes back as a refusal with its
       * own reason rather than as something guessed at here.
       *
       * An interactive step is FREEFORM, which is the whole reason a flow can
       * pause. Interactive messages need no approval and only work inside the
       * 24-hour window, so asking with a template intent here would send a
       * customer a question Meta refuses - and the flow would fail rather than
       * pause with its position kept. This is where that check lives: in the
       * send path, immediately before the call, never in a disabled control.
       */
      template ? { kind: "template", approved: true } : { kind: "freeform" },
      now,
    ),
  );

  if (!sendability) return { result: "unknown_message" };

  if (!sendability.decision.allowed) {
    const reason = sendability.decision.reason;

    /*
     * Written to the row, not only logged. A refusal the operator cannot see is
     * a message that silently never went, and the thread is where they look.
     */
    await withCompany(companyId, (db, scoped) =>
      recordSendDeclined(db, scoped, messageId, reason, now),
    );

    /*
     * The second trigger for pausing a flow run, and the one the executor's
     * own pre-check cannot cover: the window can close between a step being
     * planned and the queue reaching it. Without this the run sits ACTIVE for
     * ever beside a thread of POLICY failures, and the tenant's only signal
     * that a deadline passed is a red bubble.
     *
     * Only for window_closed. Every other refusal here is about the workspace,
     * the number or the contact, and none of those is a state the entry
     * template can resume from - pausing on one would promise a recovery that
     * is not available.
     */
    if (reason === "window_closed") {
      const runId = await pauseRunForMessage(companyId, messageId);
      if (runId) {
        log.info("flow run paused: the window closed before the send", {
          companyId,
          messageId,
          runId,
        });
      }
    }

    log.info("send declined by policy", { companyId, messageId, reason });
    return { result: "declined" };
  }

  /* 4. The call. No scope is open. One outcome union whichever shape goes out,
     so step 5 below does not branch - an interactive question that times out
     becomes UNCONFIRMED by exactly the path a template does, which is what
     keeps a flow from inventing its own idea of what "sent" means. */
  const outcome = template
    ? await sendWhatsAppTemplate(secrets, {
        to: sendability.waId,
        name: template.name,
        language: template.language,
        parameters: template.parameters,
        ...(template.buttonPayloads.length > 0
          ? { buttonPayloads: template.buttonPayloads }
          : {}),
      })
    : interactive
      ? await sendWhatsAppInteractive(secrets, {
          to: sendability.waId,
          interactive,
        })
      : await sendWhatsAppText(secrets, {
          to: sendability.waId,
          body: loaded.body ?? "",
        });

  /* 5. Write what happened. */
  if (outcome.ok) {
    await withCompany(companyId, async (db, scoped) => {
      await recordSendAccepted(db, scoped, messageId, {
        wamid: outcome.wamid,
        held: outcome.held,
        waId: outcome.waId,
      });

      await reconcileWaId(db, {
        contactId: loaded.conversation.contact.id,
        stored: loaded.conversation.contact.waId,
        canonical: outcome.waId,
        companyId,
        messageId,
      });

      /*
       * Deduped on OUR message id, never the wamid - correction C3. The wamid
       * does not exist until Meta answers, so a send that timed out and was
       * retried produces a second wamid for the same message row, and this
       * table becomes an invoice.
       */
      await recordUsage(db, scoped, {
        kind: "whatsapp.message.sent",
        dedupeKey: usageDedupeKey("whatsapp.message.sent", messageId),
      });
    });

    log.info("message sent", {
      companyId,
      messageId,
      wamid: outcome.wamid,
      held: outcome.held,
    });

    return { result: outcome.held ? "held" : "sent" };
  }

  if (outcome.delivery === "refused") {
    /*
     * Meta answered, so non-delivery is proven and a retry cannot duplicate
     * anything. Its own code and title are stored, because they are what the
     * thread shows and what a support conversation quotes.
     */
    await withCompany(companyId, (db, scoped) =>
      recordSendRefused(db, scoped, messageId, {
        code: readCode(outcome.details),
        title: outcome.error,
        occurredAt: new Date(),
        /*
         * The kind decides whether the badge moves, and it comes from
         * decodeGraphFailure rather than from statusCode - Meta's 190 arrives
         * with a 400 as often as a 401. See recordSendRefused.
         */
        kind: outcome.kind,
        integrationId: number.integrationId,
      }),
    );

    /*
     * What the refusal means beyond this one message.
     *
     * Two of Meta's codes carry information about something other than the
     * message that produced them, and acting on it is the difference between
     * learning and repeating:
     *
     *   131026  the handset cannot receive WhatsApp. Remembered on the CONTACT,
     *           so every future broadcast drops them at import rather than
     *           spending a send to be told again.
     *   131049, 130472, 131056, 133016
     *           the number is being rate limited. The run pauses, so the
     *           remaining thousands are not thrown at a wall - every delayed
     *           job reads the status and declines, which makes the back-off
     *           take effect on the very next message.
     *
     * Only for a broadcast. An operator sending one message by hand has
     * already seen the failure, and pausing something they are not running
     * would be acting on a state that does not exist.
     */
    const action = classifyBulkError(readCode(outcome.details));

    if (action === "undeliverable") {
      await withCompany(companyId, (db, scoped) =>
        markContactUndeliverable(
          db,
          scoped,
          loaded.conversation.contact.id,
          new Date(),
        ),
      );

      log.info("contact marked undeliverable", {
        companyId,
        messageId,
        contactId: loaded.conversation.contact.id,
      });
    }

    if (action === "backoff" && loaded.broadcastId) {
      const paused = await withCompany(companyId, (db, scoped) =>
        pauseBroadcastForRateLimit(db, scoped, loaded.broadcastId!),
      );

      log.warn("broadcast paused by a rate limit", {
        companyId,
        messageId,
        broadcastId: loaded.broadcastId,
        code: readCode(outcome.details),
        /* False means somebody had already paused or cancelled it, which is
           not a problem - it is the guard doing its job. */
        paused,
      });
    }

    log.warn("Meta refused the message", {
      companyId,
      messageId,
      kind: outcome.kind,
      error: outcome.error,
    });

    return { result: "refused" };
  }

  /*
   * No answer at all. Meta may have sent it and may not, and no query resolves
   * the ambiguity - which is why this job runs once, and why the row gets a
   * status of its own rather than being left looking unsent.
   *
   * No usage is recorded. If Meta did send it we under-bill by one message,
   * which is the right way round to be wrong about somebody's invoice.
   */
  await withCompany(companyId, (db, scoped) =>
    recordSendUnconfirmed(db, scoped, messageId),
  );

  log.error("send outcome unknown", { companyId, messageId, error: outcome.error });

  return { result: "unconfirmed" };
}

/** Meta's error code, when the decoder kept one. */
function readCode(details: Record<string, unknown> | undefined): number | null {
  const code = details?.["code"];
  return typeof code === "number" ? code : null;
}

/**
 * Point the contact at the wa_id Meta actually uses.
 *
 * Brazil and Mexico have historically differed by a digit between the number
 * that messages and the wa_id it arrives as. Send to one form and the reply
 * comes back under the other, which creates a second contact - with its own
 * conversation and its own 24-hour window - for the same person, and neither
 * half then holds the whole thread. It is the reason wa_id is the contact key
 * rather than the normalised number.
 *
 * Not attempted when it would collide. If another contact already holds the
 * canonical wa_id then these are two rows for one person, and merging them
 * means moving conversations and messages between them: a bigger operation than
 * a send job should perform, and not one that should happen as a side effect of
 * a message going out. It is logged for somebody to decide about.
 */
async function reconcileWaId(
  db: CompanyClient,
  input: {
    contactId: string;
    stored: string;
    canonical: string | null;
    companyId: string;
    messageId: string;
  },
): Promise<void> {
  const { canonical, stored, contactId } = input;

  if (!canonical || canonical === stored) return;

  const clash = await db.contact.findFirst({
    where: { waId: canonical },
    select: { id: true },
  });

  if (clash && clash.id !== contactId) {
    log.warn("two contacts for one wa_id", {
      companyId: input.companyId,
      messageId: input.messageId,
      stored,
      canonical,
    });
    return;
  }

  await db.contact.update({
    where: { id: contactId },
    data: { waId: canonical },
  });

  log.info("contact wa_id reconciled", {
    companyId: input.companyId,
    stored,
    canonical,
  });
}


