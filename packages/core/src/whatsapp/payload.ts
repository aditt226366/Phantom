import { z } from "zod";

/**
 * What Meta actually sends, parsed so that one bad part cannot lose the rest.
 *
 * ---------------------------------------------------------------------------
 * Lenient on purpose, and the leniency is structural
 * ---------------------------------------------------------------------------
 *
 * A delivery is a batch: several entries, each with several changes, each
 * carrying several messages or statuses. Strict parsing of the whole envelope
 * means one unrecognised field in one change discards messages from real
 * customers that arrived in the same POST - and the endpoint has already
 * answered 200, so Meta will never send them again.
 *
 * So: unknown fields pass through, each change is parsed independently, and a
 * change that cannot be understood is recorded as skipped rather than thrown.
 * The worst outcome for a malformed part is that one part is missing and says
 * so, never that the batch is lost.
 *
 * An unrecognised message TYPE is not a parse failure at all. It becomes an
 * unsupported-type record with the raw type preserved, because the type
 * vocabulary is Meta's and the thread should show a gap with a reason rather
 * than silently miss a message.
 */

/** Unknown keys survive: Meta adds fields without notice. */
const looseObject = z.looseObject({});

const metadataSchema = z.looseObject({
  phone_number_id: z.string().min(1),
  display_phone_number: z.string().optional(),
});

const contactSchema = z.looseObject({
  wa_id: z.string().min(1),
  profile: z.looseObject({ name: z.string().optional() }).optional(),
});

const messageSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  /** Unix seconds, as a string. Meta has never sent a number here. */
  timestamp: z.string().min(1),
  type: z.string().min(1),
});

const statusSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: z.string().min(1),
  recipient_id: z.string().optional(),
  conversation: z
    .looseObject({
      id: z.string().optional(),
      origin: z.looseObject({ type: z.string().optional() }).optional(),
    })
    .optional(),
  pricing: z
    .looseObject({
      billable: z.boolean().optional(),
      category: z.string().optional(),
      /* CBP, PMP, or whatever Meta names next. Stored verbatim rather than
         mapped: it decides how a category is RATED, and a value we do not
         recognise is exactly the one worth having on the row. */
      pricing_model: z.string().optional(),
    })
    .optional(),
  errors: z.array(looseObject).optional(),
});

const changeValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  contacts: z.array(contactSchema).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
});

const changeSchema = z.looseObject({
  field: z.string().min(1),
  value: changeValueSchema,
});

const entrySchema = z.looseObject({
  id: z.string().optional(),
  changes: z.array(z.unknown()).optional(),
});

const envelopeSchema = z.looseObject({
  object: z.string().optional(),
  entry: z.array(z.unknown()).optional(),
});

/** Message types this build renders. Anything else becomes UNSUPPORTED. */
const RENDERABLE_TYPES = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contacts",
  "interactive",
  "button",
  "reaction",
  "order",
  "system",
]);

export interface InboundMessage {
  kind: "message";
  phoneNumberId: string;
  wamid: string;
  /** Meta's wa_id for the sender. The contact key - never the display number. */
  from: string;
  /** Profile name, when Meta included one. Only sent on some deliveries. */
  profileName: string | null;
  /** Meta's type verbatim, even when unrecognised. */
  type: string;
  /** False when the type is one this build cannot render. */
  supported: boolean;
  text: string | null;
  /** Meta's media id, for the types that carry one. */
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  caption: string | null;
  /**
   * The id on the button or list row the customer tapped.
   *
   * -------------------------------------------------------------------------
   * Two message types, one field, because they are one event
   * -------------------------------------------------------------------------
   *
   * Meta delivers a tap two different ways depending on which kind of message
   * carried the button, and neither is obvious from the other:
   *
   *   type "button"       a quick reply on an APPROVED TEMPLATE. The id is at
   *                       button.payload, and it is the string we supplied per
   *                       send - which is the only hook that lets a tap on a
   *                       template start a flow.
   *   type "interactive"  a reply button or list row on a free-form
   *                       interactive message. The id is at
   *                       interactive.button_reply.id or
   *                       interactive.list_reply.id.
   *
   * Collapsed into one field here rather than left to every reader, because a
   * reader that handled only one of them would work perfectly for flows a
   * customer answered inside the window and silently ignore every entry tap -
   * and entry taps are the ones that start conversations.
   *
   * Null for every other message type, and for a tap whose payload Meta did
   * not include.
   */
  replyId: string | null;

  /**
   * The click-to-WhatsApp ad this conversation started from, when it did.
   *
   * -------------------------------------------------------------------------
   * It arrives once and never again
   * -------------------------------------------------------------------------
   *
   * Meta attaches the referral block to the FIRST inbound message of a
   * conversation that began with a click on an ad, and to no later message in
   * it. A reader that drops it has lost the only join between money spent and
   * a person who replied - permanently, and with nothing anywhere to
   * reconstruct it from: the Insights API reports spend per ad and has no idea
   * which WhatsApp thread any of it produced.
   *
   * Parsed here rather than in the ingest, so that every stored payload can be
   * re-read by a backfill through the same function the live path uses. That
   * property is what made the conversation-charge history recoverable when
   * nothing had been recording it for five phases.
   *
   * Null for every message that is not one - which is almost all of them.
   */
  referral: InboundReferral | null;

  occurredAt: Date;
}

/** Meta's referral block, kept verbatim. */
export interface InboundReferral {
  /**
   * Meta's click id. Their attribution reporting is keyed on it, and it is the
   * value to quote when asking them why a number disagrees.
   */
  ctwaClid: string | null;
  /** The ad or post id. This is what joins a conversation to spend. */
  sourceId: string | null;
  /**
   * "ad" or "post", verbatim and never normalised.
   *
   * An organic post referral is not an ad click. Folding the two together
   * would put conversations nobody paid for into a cost-per-lead denominator,
   * which makes the figure look better than it is - the direction nobody
   * checks.
   */
  sourceType: string | null;
  sourceUrl: string | null;
  /**
   * The ad's own copy. What makes a referral legible six weeks later, when the
   * ad has been edited or deleted and Meta will no longer say what it said.
   */
  headline: string | null;
  body: string | null;
}

function readReferral(raw: Record<string, unknown>): InboundReferral | null {
  const referral = raw["referral"] as Record<string, unknown> | undefined;
  if (!referral || typeof referral !== "object") return null;

  const text = (key: string): string | null => {
    const value = referral[key];
    return typeof value === "string" && value !== "" ? value : null;
  };

  const parsed: InboundReferral = {
    ctwaClid: text("ctwa_clid"),
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
  };

  /*
   * A block with nothing identifying in it is not a referral.
   *
   * Meta has sent an empty object here, and storing a row for it would put a
   * conversation in the ads-attributed count with no ad to attribute it to -
   * a lead that inflates the numerator of every cost-per-lead figure and
   * belongs in none of them.
   */
  if (!parsed.ctwaClid && !parsed.sourceId) return null;

  return parsed;
}

export interface StatusUpdate {
  kind: "status";
  phoneNumberId: string;
  wamid: string;
  /** Meta's status verbatim; the ladder maps it, and may not recognise it. */
  status: string;
  occurredAt: Date;
  recipientWaId: string | null;
  /** Meta's conversation id - the 24-hour window they bill against. */
  conversationId: string | null;
  billable: boolean;
  /** marketing | utility | authentication | service, when Meta says. */
  category: string | null;
  /**
   * Meta's rate card for this window - CBP, PMP, and whatever comes next.
   *
   * Kept because it decides how the category is priced, and because Phase 11
   * reprices in arrears from what was recorded rather than from what we assume
   * the rate card was at the time.
   */
  pricingModel: string | null;
  /** Present on a failed status. Already just Meta's own shape. */
  errors: readonly unknown[];
}

export interface SkippedChange {
  /** Machine code, like a send refusal. Never prose. */
  reason:
    | "unparseable_envelope"
    | "unparseable_entry"
    | "unparseable_change"
    | "missing_metadata"
    | "unhandled_field";
  /** Meta's field name, when we got far enough to read one. */
  field: string | null;
}

/**
 * Meta says a number's quality or messaging tier moved.
 *
 * Carried as a TRIGGER, not as data. The payload names a display number and an
 * event, and neither is what we store: the display number is not a key - Meta
 * has changed its spacing - and one event is a worse description of a number's
 * state than the number's state is. So this causes a refresh, which asks Meta
 * for the whole account and writes what comes back.
 *
 * The fields are kept anyway, because a log line saying which number and which
 * event is the difference between "a refresh ran" and knowing why.
 */
export interface NumberQualityUpdate {
  kind: "quality";
  displayPhoneNumber: string | null;
  /** Meta's own event string, e.g. FLAGGED, UPGRADE, DOWNGRADE. */
  event: string | null;
  currentLimit: string | null;
}

/**
 * Meta's verdict on a template, which is the only way review ever arrives.
 *
 * Unlike a quality update this IS the data rather than a trigger. There is no
 * cheap way to ask "what happened to this one template", and the callback
 * carries everything worth storing - so it is parsed and applied rather than
 * used as a reason to go and look.
 *
 * `reason` is Meta's own token, and `NONE` is how they say there is no reason.
 * Normalised to null here so no caller has to know that a rejection reason of
 * "NONE" means there is no rejection.
 */
export interface TemplateStatusUpdate {
  kind: "template";
  /** Meta's template id. The only identifier both sides hold. */
  metaTemplateId: string;
  /** APPROVED, REJECTED, PAUSED, DISABLED, IN_APPEAL, and whatever is next. */
  status: string;
  name: string | null;
  language: string | null;
  reason: string | null;
  /** Present when Meta has re-categorised. The price follows this. */
  category: string | null;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  /** Numbers Meta says have changed. A reason to refresh, not a source. */
  qualityUpdates: NumberQualityUpdate[];
  /** What Meta decided about a template under review. */
  templateUpdates: TemplateStatusUpdate[];
  /** Everything that could not be turned into one of the above, and why. */
  skipped: SkippedChange[];
}

/** Unix seconds as a string, which is what Meta sends. */
function toDate(timestamp: string): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(0);
}

function readMedia(
  raw: Record<string, unknown>,
  type: string,
): Pick<InboundMessage, "mediaId" | "mediaMimeType" | "mediaFilename" | "caption"> {
  const media = raw[type];

  if (typeof media !== "object" || media === null) {
    return { mediaId: null, mediaMimeType: null, mediaFilename: null, caption: null };
  }

  const record = media as Record<string, unknown>;
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  return {
    mediaId: str(record["id"]),
    mediaMimeType: str(record["mime_type"]),
    mediaFilename: str(record["filename"]),
    caption: str(record["caption"]),
  };
}

/**
 * The id and the label on whatever the customer tapped.
 *
 * Total, like everything else in this file: a shape Meta has changed, or a
 * message type that carries neither, produces two nulls rather than a throw.
 * An inbound webhook is the worst place in the system to fail - nobody is
 * watching, the delivery retries, and the customer's message is lost.
 */
function readReply(
  raw: Record<string, unknown>,
  type: string,
): { id: string | null; title: string | null } {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  /* A quick reply on an approved template. This is how a flow starts. */
  if (type === "button") {
    const button = raw["button"];
    if (typeof button !== "object" || button === null) {
      return { id: null, title: null };
    }
    const record = button as Record<string, unknown>;
    return { id: str(record["payload"]), title: str(record["text"]) };
  }

  /* A reply button or list row on a free-form interactive message. */
  if (type === "interactive") {
    const interactive = raw["interactive"];
    if (typeof interactive !== "object" || interactive === null) {
      return { id: null, title: null };
    }

    const record = interactive as Record<string, unknown>;
    /* Meta names the two shapes differently and sends exactly one of them. */
    const reply = record["button_reply"] ?? record["list_reply"];

    if (typeof reply !== "object" || reply === null) {
      return { id: null, title: null };
    }

    const chosen = reply as Record<string, unknown>;
    return { id: str(chosen["id"]), title: str(chosen["title"]) };
  }

  return { id: null, title: null };
}

/**
 * Parse one delivery. Never throws.
 *
 * `body` is the already-JSON-parsed payload. Verifying the signature happens
 * over the raw text before this, in @whatsapp-os/core/whatsapp-server.
 */
export function parseWebhookPayload(body: unknown): ParsedWebhook {
  const result: ParsedWebhook = {
    messages: [],
    statuses: [],
    qualityUpdates: [],
    templateUpdates: [],
    skipped: [],
  };

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    result.skipped.push({ reason: "unparseable_envelope", field: null });
    return result;
  }

  for (const rawEntry of envelope.data.entry ?? []) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      result.skipped.push({ reason: "unparseable_entry", field: null });
      continue;
    }

    for (const rawChange of entry.data.changes ?? []) {
      const change = changeSchema.safeParse(rawChange);
      if (!change.success) {
        result.skipped.push({ reason: "unparseable_change", field: null });
        continue;
      }

      const { field, value } = change.data;

      /*
       * Everything else arrives under `messages`. Template status updates and
       * quality notifications come under their own fields, handled just above,
       * and anything unrecognised is recorded as skipped rather than dropped so
       * the count stays honest.
       */
      if (field === "message_template_status_update") {
        const raw = value as Record<string, unknown>;
        const str = (v: unknown): string | null =>
          typeof v === "string" && v.length > 0 ? v : null;

        const metaTemplateId = str(raw["message_template_id"]);
        const status = str(raw["event"]);

        /*
         * Without an id there is nothing to match, and without a status there
         * is nothing to say. Skipped rather than half-applied: writing a status
         * onto a template chosen by name would be a guess, and the templates
         * this could guess wrong about are the ones a tenant is waiting on.
         */
        if (!metaTemplateId || !status) {
          result.skipped.push({ reason: "unparseable_change", field });
          continue;
        }

        const reason = str(raw["reason"]);

        result.templateUpdates.push({
          kind: "template",
          metaTemplateId,
          status,
          name: str(raw["message_template_name"]),
          language: str(raw["message_template_language"]),
          /* Meta says NONE when there is nothing to report. */
          reason: reason === "NONE" ? null : reason,
          category: str(raw["new_category"]) ?? str(raw["category"]),
        });
        continue;
      }

      if (field === "phone_number_quality_update") {
        /*
         * The third thing that triggers a numbers refresh, alongside a person
         * pressing Refresh and a successful verification. Recorded here and
         * acted on by the worker, which re-reads the account rather than
         * trusting the notification's own contents.
         */
        const raw = value as Record<string, unknown>;
        const str = (v: unknown): string | null =>
          typeof v === "string" && v.length > 0 ? v : null;

        result.qualityUpdates.push({
          kind: "quality",
          displayPhoneNumber: str(raw["display_phone_number"]),
          event: str(raw["event"]),
          currentLimit: str(raw["current_limit"]),
        });
        continue;
      }

      if (field !== "messages") {
        result.skipped.push({ reason: "unhandled_field", field });
        continue;
      }

      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) {
        /* Without it there is no number to attribute anything to. */
        result.skipped.push({ reason: "missing_metadata", field });
        continue;
      }

      const profileByWaId = new Map<string, string | null>();
      for (const contact of value.contacts ?? []) {
        profileByWaId.set(contact.wa_id, contact.profile?.name ?? null);
      }

      for (const message of value.messages ?? []) {
        const raw = message as Record<string, unknown>;
        const supported = RENDERABLE_TYPES.has(message.type);
        const reply = readReply(raw, message.type);

        result.messages.push({
          kind: "message",
          phoneNumberId,
          wamid: message.id,
          from: message.from,
          profileName: profileByWaId.get(message.from) ?? null,
          type: message.type,
          supported,
          /*
           * A tap's visible label is its text.
           *
           * Without it the thread shows an empty bubble where the customer
           * pressed something, and an operator reading back cannot see what
           * they chose - which is the half of the conversation a support call
           * is usually about. The id is deliberately NOT the text: it is
           * correct, unique per run, and unreadable.
           */
          text:
            message.type === "text"
              ? ((raw["text"] as { body?: string } | undefined)?.body ?? null)
              : reply.title,
          replyId: reply.id,
          referral: readReferral(raw),
          ...readMedia(raw, message.type),
          occurredAt: toDate(message.timestamp),
        });
      }

      for (const status of value.statuses ?? []) {
        result.statuses.push({
          kind: "status",
          phoneNumberId,
          wamid: status.id,
          status: status.status,
          occurredAt: toDate(status.timestamp),
          recipientWaId: status.recipient_id ?? null,
          conversationId: status.conversation?.id ?? null,
          billable: status.pricing?.billable ?? false,
          category: status.pricing?.category ?? null,
          pricingModel: status.pricing?.pricing_model ?? null,
          errors: status.errors ?? [],
        });
      }
    }
  }

  return result;
}
