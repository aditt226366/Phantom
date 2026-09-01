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
    /*
     * `message_template_status_update` used to be the example here, because in
     * 4a it genuinely was unhandled. It is handled now, so this uses a field
     * Meta really does send and this build really does not read - the point
     * being that an unrecognised field is counted rather than discarded, and
     * that one unreadable change never costs the real messages beside it.
     */
    const parsed = parseWebhookPayload(
      delivery([
        { field: "account_update", value: {} },
        messageChange([TEXT_MESSAGE]),
      ]),
    );

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.skipped).toEqual([
      { reason: "unhandled_field", field: "account_update" },
    ]);
  });
});

describe("message_template_status_update", () => {
  function change(value: Record<string, unknown>): unknown {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [{ field: "message_template_status_update", value }],
        },
      ],
    };
  }

  it("carries Meta's verdict rather than triggering a lookup", () => {
    /* The contrast with phone_number_quality_update is the point: a quality
       notification is a reason to re-read the account, because Meta will tell
       us the whole truth about a number. There is no cheap equivalent for one
       template, so this callback is the data. */
    const parsed = parseWebhookPayload(
      change({
        event: "APPROVED",
        message_template_id: "1234",
        message_template_name: "order_update",
        message_template_language: "en_US",
        reason: "NONE",
      }),
    );

    expect(parsed.templateUpdates).toEqual([
      {
        kind: "template",
        metaTemplateId: "1234",
        status: "APPROVED",
        name: "order_update",
        language: "en_US",
        /* NONE is how Meta says there is no reason. */
        reason: null,
        category: null,
      },
    ]);
  });

  it("keeps a real rejection reason", () => {
    const parsed = parseWebhookPayload(
      change({
        event: "REJECTED",
        message_template_id: "1234",
        reason: "INVALID_FORMAT",
      }),
    );

    expect(parsed.templateUpdates[0]).toMatchObject({
      status: "REJECTED",
      reason: "INVALID_FORMAT",
    });
  });

  /* Meta re-categorises on wording, and the price follows the category. */
  it("reads a re-categorisation", () => {
    const parsed = parseWebhookPayload(
      change({
        event: "APPROVED",
        message_template_id: "1234",
        new_category: "MARKETING",
      }),
    );

    expect(parsed.templateUpdates[0]?.category).toBe("MARKETING");
  });

  /*
   * Without an id there is nothing to match on. Skipped rather than applied by
   * name: guessing which template a verdict belongs to would be worst exactly
   * where it matters, on the ones a tenant is waiting for.
   */
  it("skips an update with no template id", () => {
    const parsed = parseWebhookPayload(change({ event: "APPROVED" }));

    expect(parsed.templateUpdates).toEqual([]);
    expect(parsed.skipped).toEqual([
      { reason: "unparseable_change", field: "message_template_status_update" },
    ]);
  });

  it("skips an update with no status", () => {
    const parsed = parseWebhookPayload(change({ message_template_id: "1234" }));

    expect(parsed.templateUpdates).toEqual([]);
    expect(parsed.skipped).toHaveLength(1);
  });

  /* Meta's vocabulary is theirs and they extend it. An unmodelled status must
     survive to the row and render as itself. */
  it("passes through a status this build has never seen", () => {
    const parsed = parseWebhookPayload(
      change({ event: "SOMETHING_NEW", message_template_id: "1234" }),
    );

    expect(parsed.templateUpdates[0]?.status).toBe("SOMETHING_NEW");
  });
});

describe("the two ways a tap arrives", () => {
  /**
   * Meta delivers a button press two different ways depending on which kind of
   * message carried the button, and neither is derivable from the other. A
   * reader that handled only the interactive shape would work perfectly for
   * flows a customer answered inside the window and silently ignore every
   * entry tap - and entry taps are the ones that start conversations.
   */

  function delivery(message: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN1" },
                messages: [message],
              },
            },
          ],
        },
      ],
    };
  }

  it("reads the payload off a template's quick reply", () => {
    /* type "button" - the only thing that can start a flow, because a template
       is the only thing that may go out before a window is open. */
    const parsed = parseWebhookPayload(
      delivery({
        id: "wamid.1",
        from: "919876543210",
        timestamp: "1789000000",
        type: "button",
        button: { payload: "f1.e.ver1.start", text: "Yes please" },
      }),
    );

    expect(parsed.messages[0]?.replyId).toBe("f1.e.ver1.start");
    /* The label is the text, so the thread shows what they pressed. */
    expect(parsed.messages[0]?.text).toBe("Yes please");
  });

  it("reads the id off an interactive reply button", () => {
    const parsed = parseWebhookPayload(
      delivery({
        id: "wamid.2",
        from: "919876543210",
        timestamp: "1789000000",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "f1.r.run1.menu.shoes", title: "Shoes" },
        },
      }),
    );

    expect(parsed.messages[0]?.replyId).toBe("f1.r.run1.menu.shoes");
    expect(parsed.messages[0]?.text).toBe("Shoes");
  });

  it("reads the id off a list row, which Meta names differently", () => {
    const parsed = parseWebhookPayload(
      delivery({
        id: "wamid.3",
        from: "919876543210",
        timestamp: "1789000000",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "f1.r.run1.menu.bags", title: "Bags" },
        },
      }),
    );

    expect(parsed.messages[0]?.replyId).toBe("f1.r.run1.menu.bags");
  });

  it("leaves replyId null on an ordinary text message", () => {
    const parsed = parseWebhookPayload(
      delivery({
        id: "wamid.4",
        from: "919876543210",
        timestamp: "1789000000",
        type: "text",
        text: { body: "hello" },
      }),
    );

    expect(parsed.messages[0]?.replyId).toBeNull();
    expect(parsed.messages[0]?.text).toBe("hello");
  });

  it("does not throw on a shape Meta has changed", () => {
    /* An inbound webhook is the worst place in the system to fail: nobody is
       watching, the delivery retries, and the customer's message is lost. */
    for (const broken of [
      { type: "button" },
      { type: "button", button: null },
      { type: "button", button: "not an object" },
      { type: "interactive", interactive: {} },
      { type: "interactive", interactive: { button_reply: null } },
    ]) {
      const parsed = parseWebhookPayload(
        delivery({
          id: `wamid.${Math.random()}`,
          from: "919876543210",
          timestamp: "1789000000",
          ...broken,
        }),
      );

      expect(parsed.messages[0]?.replyId).toBeNull();
    }
  });
});
