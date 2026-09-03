import { beforeEach, describe, expect, it } from "vitest";

import { claimDriver, releaseDriver, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * One driver per conversation, and the asymmetry that makes it worth having.
 *
 * ---------------------------------------------------------------------------
 * What this is protecting against
 * ---------------------------------------------------------------------------
 *
 * Phase 8 shipped the two-writer bug: a flow run standing in a thread while an
 * operator types is a conversation with two authors, neither aware of the
 * other, and only the customer able to see both. That was fixed for TWO
 * writers by having the inbox hand off any live run.
 *
 * Verse is the third, and three is where "whoever wrote last wins" stops being
 * survivable. The losing writer is not merely overwritten - it carries on, on
 * its own schedule, into a conversation somebody else is now having.
 *
 * The rule under test:
 *
 *     A PERSON DISPLACES ANYTHING.
 *     AN AUTOMATION NEVER DISPLACES ANOTHER AUTOMATION.
 *
 * Both halves are asserted, because either one alone is a different and wrong
 * rule. "Anyone may displace anyone" is last-writer-wins with extra steps;
 * "nobody may displace anybody" leaves an operator locked out of a thread by a
 * flow run that is waiting for a tap that will never come.
 */

let alpha: SeededCompany;

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("driver-alpha");
});

/** A conversation, through the ORM, outside any assertion. */
async function seedConversation(company: SeededCompany): Promise<string> {
  return withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "WHATSAPP_CLOUD", label: "driver" },
      select: { id: true },
    });
    const number = await db.whatsAppNumber.create({
      data: {
        companyId,
        integrationId: integration.id,
        phoneNumberId: "pn-driver",
        displayNumber: "+91 12345 00000",
        status: "CONNECTED",
      },
      select: { id: true },
    });
    const contact = await db.contact.create({
      data: { companyId, waId: "911234500001", phoneE164: "+911234500001" },
      select: { id: true },
    });
    const conversation = await db.conversation.create({
      data: {
        companyId,
        contactId: contact.id,
        whatsappNumberId: number.id,
      },
      select: { id: true },
    });
    return conversation.id;
  });
}

function readDriver(companyId: string, conversationId: string) {
  return withCompany(companyId, (db) =>
    db.conversation.findFirst({
      where: { id: conversationId },
      select: { driver: true, driverSince: true, driverRef: true },
    }),
  );
}

const AT = new Date("2026-09-08T10:00:00.000Z");

describe("claiming an unheld conversation", () => {
  it("lets an automation take a thread nobody is driving", async () => {
    const conversationId = await seedConversation(alpha);

    const claim = await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: AT,
      }),
    );

    expect(claim).toEqual({
      kind: "claimed",
      displaced: "NOBODY",
      displacedRef: null,
    });

    const row = await readDriver(alpha.id, conversationId);
    expect(row?.driver).toBe("VERSE");
    expect(row?.driverRef).toBe("campaign-1");
    expect(row?.driverSince).toEqual(AT);
  });

  it("reports a conversation in another scope as gone, never as refused", async () => {
    /*
     * Rule 6. A "you may not claim this" verdict would confirm the row exists.
     */
    const beta = await seedCompany("driver-beta");
    const conversationId = await seedConversation(beta);

    const claim = await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: null,
        at: AT,
      }),
    );

    expect(claim).toEqual({ kind: "gone" });
  });
});

describe("an automation never displaces another automation", () => {
  it("refuses Verse a thread a flow is standing in, and names the holder", async () => {
    /*
     * The case from the brief: a lead source starting an AI campaign on a
     * conversation with a live flow run. Resolving it by whoever writes last
     * leaves BOTH live - the flow still holds its position and still speaks
     * when the next tap arrives - and the customer is asked two unrelated
     * questions by one business.
     */
    const conversationId = await seedConversation(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "FLOW",
        ref: "run-7",
        at: AT,
      }),
    );

    const claim = await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: new Date(AT.getTime() + 60_000),
      }),
    );

    expect(claim).toEqual({
      kind: "refused",
      heldBy: "FLOW",
      heldRef: "run-7",
    });
  });

  it("leaves the incumbent completely untouched when it refuses", async () => {
    /*
     * A refusal that still moved driver_since would reorder a queue sorted on
     * it, and a refusal that overwrote driver_ref would leave the thread
     * labelled with the campaign that did NOT get it.
     */
    const conversationId = await seedConversation(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "FLOW",
        ref: "run-7",
        at: AT,
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: new Date(AT.getTime() + 60_000),
      }),
    );

    const row = await readDriver(alpha.id, conversationId);
    expect(row?.driver).toBe("FLOW");
    expect(row?.driverRef).toBe("run-7");
    expect(row?.driverSince).toEqual(AT);
  });

  it("refuses a second campaign a thread the first campaign holds", async () => {
    /* Same-kind, different ref. Two Verse campaigns are still two writers. */
    const conversationId = await seedConversation(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: AT,
      }),
    );

    const claim = await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-2",
        at: AT,
      }),
    );

    expect(claim.kind).toBe("refused");
  });
});

describe("a person displaces anything", () => {
  it.each(["FLOW", "VERSE"] as const)(
    "lets an operator take a thread held by %s",
    async (incumbent) => {
      const conversationId = await seedConversation(alpha);

      await withCompany(alpha.id, (db, companyId) =>
        claimDriver(db, companyId, conversationId, {
          driver: incumbent,
          ref: "held",
          at: AT,
        }),
      );

      const claim = await withCompany(alpha.id, (db, companyId) =>
        claimDriver(db, companyId, conversationId, {
          driver: "OPERATOR",
          ref: "user-1",
          at: new Date(AT.getTime() + 60_000),
        }),
      );

      /*
       * The displaced driver comes back, and the operator path needs it:
       * displacing a FLOW means a run has to be handed off, and displacing
       * NOBODY does not.
       */
      expect(claim).toEqual({
        kind: "claimed",
        displaced: incumbent,
        displacedRef: "held",
      });

      const row = await readDriver(alpha.id, conversationId);
      expect(row?.driver).toBe("OPERATOR");
    },
  );
});

describe("re-claiming", () => {
  it("does not move driver_since when the same driver claims again", async () => {
    /*
     * A campaign sending its second message must not look like it arrived
     * twice, and anything sorted on that instant would reorder under it. The
     * same reasoning as flagNeedsHuman's COALESCE.
     */
    const conversationId = await seedConversation(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: AT,
      }),
    );

    const again = await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: new Date(AT.getTime() + 3_600_000),
      }),
    );

    expect(again.kind).toBe("claimed");

    const row = await readDriver(alpha.id, conversationId);
    /* Exact instant, never a tolerance - a tolerant comparison here passes on
       a UTC machine and hides an offset fault on every other one. */
    expect(row?.driverSince).toEqual(AT);
  });
});

describe("releasing", () => {
  it("clears the driver and its instant together", async () => {
    /* The CHECK requires them to agree: an instant left behind by a release
       makes a released thread render as though something had been holding it
       since Tuesday. */
    const conversationId = await seedConversation(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: AT,
      }),
    );

    await withCompany(alpha.id, (db, companyId) =>
      releaseDriver(db, companyId, conversationId),
    );

    const row = await readDriver(alpha.id, conversationId);
    expect(row).toEqual({
      driver: "NOBODY",
      driverSince: null,
      driverRef: null,
    });
  });

  it("lets the next automation in once released", async () => {
    const conversationId = await seedConversation(alpha);

    await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "FLOW",
        ref: "run-7",
        at: AT,
      }),
    );
    await withCompany(alpha.id, (db, companyId) =>
      releaseDriver(db, companyId, conversationId),
    );

    const claim = await withCompany(alpha.id, (db, companyId) =>
      claimDriver(db, companyId, conversationId, {
        driver: "VERSE",
        ref: "campaign-1",
        at: AT,
      }),
    );

    expect(claim.kind).toBe("claimed");
  });
});

describe("the CHECK behind the column", () => {
  it("refuses a driver with no instant", async () => {
    /*
     * The database half. claimDriver always writes both, so this asserts what
     * stops a LATER writer - a migration backfill, a hand-written UPDATE -
     * from producing a row the inbox cannot render.
     */
    const conversationId = await seedConversation(alpha);

    await expect(
      withCompany(alpha.id, (db, companyId) =>
        db.$executeRaw`
          UPDATE conversations
             SET driver = 'VERSE', driver_since = NULL
           WHERE id = ${conversationId} AND company_id = ${companyId}`,
      ),
    ).rejects.toThrow();
  });

  it("refuses a driver_ref with nobody driving", async () => {
    const conversationId = await seedConversation(alpha);

    await expect(
      withCompany(alpha.id, (db, companyId) =>
        db.$executeRaw`
          UPDATE conversations
             SET driver = 'NOBODY', driver_since = NULL, driver_ref = 'orphan'
           WHERE id = ${conversationId} AND company_id = ${companyId}`,
      ),
    ).rejects.toThrow();
  });
});
