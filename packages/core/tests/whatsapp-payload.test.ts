import { describe, expect, it } from "vitest";
import { parseWebhookPayload } from "../src/whatsapp/payload.ts";

/** A realistic delivery, shaped the way Meta actually sends one. */
function delivery(changes: unknown[]): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "102290129340398", changes }],
  };
}

function messageChange(messages: unknown[], contacts: unknown[] = []): unknown {
  return {
    field: "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550001111", phone_number_id: "PN1" },
      contacts,
      messages,
    },
  };
}

const TEXT_MESSAGE = {
  from: "919876543210",
  id: "wamid.TEXT",
  timestamp: "1786791600",
  type: "text",
  text: { body: "hello there" },
};

describe("one bad part never discards the batch", () => {
  it("keeps the good change when another is unparseable", () => {
    /*
     * The endpoint has already answered 200 by the time this runs, so anything
     * discarded here is gone for good - Meta will not send it again. A single
     * malformed change must cost that change and nothing else.
     */
    const parsed = parseWebhookPayload(
      delivery([{ field: "messages" }, messageChange([TEXT_MESSAGE])]),
    );

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.wamid).toBe("wamid.TEXT");
    expect(parsed.skipped).toEqual([
      { reason: "unparseable_change", field: null },
    ]);
  });

  it("keeps the good entry when another entry is rubbish", () => {
    const parsed = parseWebhookPayload({
      object: "whatsapp_business_account",
      entry: [42, { id: "x", changes: [messageChange([TEXT_MESSAGE])] }],
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.skipped).toEqual([{ reason: "unparseable_entry", field: null }]);
  });

  it("records a change with no metadata rather than guessing the number", () => {
    const parsed = parseWebhookPayload(
      delivery([{ field: "messages", value: { messages: [TEXT_MESSAGE] } }]),
    );

    expect(parsed.messages).toEqual([]);
    expect(parsed.skipped).toEqual([
      { reason: "missing_metadata", field: "messages" },
    ]);
  });

  it("never throws, on anything", () => {
    for (const nonsense of [null, undefined, 7, "text", [], {}, { entry: "no" }]) {
      expect(() => parseWebhookPayload(nonsense)).not.toThrow();
    }
  });

  it("returns empty rather than failing on an unrecognised envelope", () => {
    const parsed = parseWebhookPayload({ entry: "not an array" });

    expect(parsed.messages).toEqual([]);
    expect(parsed.statuses).toEqual([]);
    expect(parsed.skipped).toEqual([
      { reason: "unparseable_envelope", field: null },
    ]);
  });
});

describe("fields Meta adds without telling us", () => {
  it("passes unknown keys through at every level", () => {
    const parsed = parseWebhookPayload({
      object: "whatsapp_business_account",
      brand_new_top_level: true,
      entry: [
        {
          id: "e",
          brand_new_entry_field: 1,
          changes: [
            {
              field: "messages",
              brand_new_change_field: "x",
              value: {
                metadata: { phone_number_id: "PN1", brand_new: [] },
                messages: [{ ...TEXT_MESSAGE, brand_new_message_field: {} }],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.skipped).toEqual([]);
  });
});

describe("a message type this build cannot render", () => {
  it("becomes a record with the raw type, not a discarded message", () => {
    /*
     * The type vocabulary is Meta's. A thread should show a gap with a reason
     * rather than silently miss a message, and the raw type is what tells
     * somebody later what to build.
     */
    const parsed = parseWebhookPayload(
      delivery([
        messageChange([
          { from: "919876543210", id: "wamid.NEW", timestamp: "1786791600", type: "carousel" },
        ]),
      ]),
    );

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      wamid: "wamid.NEW",
      type: "carousel",
      supported: false,
    });
    expect(parsed.skipped).toEqual([]);
  });

  it("marks the types it does render as supported", () => {
    const parsed = parseWebhookPayload(delivery([messageChange([TEXT_MESSAGE])]));

    expect(parsed.messages[0]?.supported).toBe(true);
    expect(parsed.messages[0]?.text).toBe("hello there");
  });
});

describe("what it pulls out", () => {
  it("reads media and its caption", () => {
    const parsed = parseWebhookPayload(
      delivery([
        messageChange([
          {
            from: "919876543210",
            id: "wamid.IMG",
            timestamp: "1786791600",
            type: "image",
            image: {
              id: "MEDIA1",
              mime_type: "image/jpeg",
              sha256: "abc",
              caption: "the invoice",
            },
          },
        ]),
      ]),
    );

    expect(parsed.messages[0]).toMatchObject({
      mediaId: "MEDIA1",
      mediaMimeType: "image/jpeg",
      caption: "the invoice",
      supported: true,
    });
  });

  it("attaches a profile name to the sender it belongs to", () => {
    const parsed = parseWebhookPayload(
      delivery([
        messageChange(
          [TEXT_MESSAGE],
          [{ wa_id: "919876543210", profile: { name: "Priya" } }],
        ),
      ]),
    );

    expect(parsed.messages[0]?.profileName).toBe("Priya");
  });

  it("leaves the profile name null when Meta omits it", () => {
    /* Meta sends it on the first message of a window and not reliably after,
       so null must mean "not told" rather than "no name". */
    const parsed = parseWebhookPayload(delivery([messageChange([TEXT_MESSAGE])]));

    expect(parsed.messages[0]?.profileName).toBeNull();
  });

  it("converts Meta's unix seconds to a date", () => {
    const parsed = parseWebhookPayload(delivery([messageChange([TEXT_MESSAGE])]));

    expect(parsed.messages[0]?.occurredAt.toISOString()).toBe(
      "2026-08-15T11:00:00.000Z",
    );
  });

  it("reads a status with its billing facts", () => {
    const parsed = parseWebhookPayload(
      delivery([
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN1" },
            statuses: [
              {
                id: "wamid.OUT",
                status: "delivered",
                timestamp: "1786791600",
                recipient_id: "919876543210",
                conversation: { id: "CONV1", origin: { type: "service" } },
                pricing: { billable: true, category: "service" },
              },
            ],
          },
        },
      ]),
    );

    expect(parsed.statuses[0]).toMatchObject({
      wamid: "wamid.OUT",
      status: "delivered",
      conversationId: "CONV1",
      billable: true,
      category: "service",
    });
  });

  it("treats a status with no pricing block as not billable", () => {
    const parsed = parseWebhookPayload(
      delivery([
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN1" },
            statuses: [{ id: "w", status: "sent", timestamp: "1786791600" }],
          },
        },
      ]),
    );

    expect(parsed.statuses[0]?.billable).toBe(false);
    expect(parsed.statuses[0]?.category).toBeNull();
  });
});

describe("fields this phase does not handle", () => {
  it("records them rather than dropping them silently", () => {
    /* Template status updates are 4b and quality updates feed the refresh job.
       Counting them keeps the skipped total honest. */
    const parsed = parseWebhookPayload(
      delivery([
        { field: "message_template_status_update", value: {} },
        messageChange([TEXT_MESSAGE]),
      ]),
    );

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.skipped).toEqual([
      { reason: "unhandled_field", field: "message_template_status_update" },
    ]);
  });
});
