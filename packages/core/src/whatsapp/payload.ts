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
  occurredAt: Date;
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

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
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
 * Parse one delivery. Never throws.
 *
 * `body` is the already-JSON-parsed payload. Verifying the signature happens
 * over the raw text before this, in @whatsapp-os/core/whatsapp-server.
 */
export function parseWebhookPayload(body: unknown): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [], skipped: [] };

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
       * Everything we act on arrives under `messages`. Template status updates
       * and quality notifications come under their own fields and are Phase 4b
       * and the refresh job respectively - recorded as skipped rather than
       * dropped, so the count is honest.
       */
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
        const text =
          message.type === "text"
            ? ((raw["text"] as { body?: string } | undefined)?.body ?? null)
            : null;

        result.messages.push({
          kind: "message",
          phoneNumberId,
          wamid: message.id,
          from: message.from,
          profileName: profileByWaId.get(message.from) ?? null,
          type: message.type,
          supported,
          text,
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
          errors: status.errors ?? [],
        });
      }
    }
  }

  return result;
}
