import {
  decrypt,
  secretAad,
  usageDedupeKey,
  type WhatsAppMessageSendJob,
} from "@whatsapp-os/core";
import {
  sendWhatsAppTemplate,
  sendWhatsAppText,
} from "@whatsapp-os/core/whatsapp";
import {
  canSend,
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
  | "unknown_message";

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
        /* Present means this row is a template send. The payload holds the
           name, language and the parameter values chosen at send time. */
        templatePayload: true,
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

    log.info("send declined by policy", { companyId, messageId, reason });
    return { result: "declined" };
  }

  /* 4. The call. No scope is open. Same outcome union either way, so step 5
     below does not branch - a template that times out becomes UNCONFIRMED by
     exactly the path a text does. */
  const outcome = template
    ? await sendWhatsAppTemplate(secrets, {
        to: sendability.waId,
        name: template.name,
        language: template.language,
        parameters: template.parameters,
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

/**
 * What a template row carries, or null if this is an ordinary text.
 *
 * Parsed defensively because `template_payload` is jsonb: the column will hold
 * whatever was written, and a row half-written by an older build must not make
 * the worker throw on every attempt. A payload it cannot read is treated as a
 * text send, which is the safe direction - the message goes out as its body
 * rather than as a template nobody could reconstruct.
 */
function readTemplatePayload(
  raw: unknown,
): { name: string; language: string; parameters: string[] } | null {
  if (!raw || typeof raw !== "object") return null;

  const payload = raw as Record<string, unknown>;
  const name = payload["name"];
  const language = payload["language"];

  if (typeof name !== "string" || typeof language !== "string") return null;

  const parameters = Array.isArray(payload["parameters"])
    ? payload["parameters"].filter((v): v is string => typeof v === "string")
    : [];

  return { name, language, parameters };
}
