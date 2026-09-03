import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, withCompany, type CompanyClient } from "../src/index.ts";
import {
  ownerClient,
  rawRuntimeClient,
  seedCompany,
  superuserClient,
  truncateAll,
  type SeededCompany,
} from "./helpers.ts";

/**
 * The point of the phase.
 *
 * Every test below deliberately bypasses withCompany and talks to the database
 * directly, because that is the only thing worth proving. An application-layer
 * filter is a convention: it stops the mistakes, not the attacker, and not the
 * raw query someone adds in six months. What must hold is that the *database*
 * refuses, whatever the caller does.
 *
 * If this file goes green while the policies are broken, it is worse than
 * useless — which is why it starts by proving it is connected as a role that
 * RLS actually applies to.
 */

let raw: pg.Pool;
let owner: pg.Pool;
let alpha: SeededCompany;
let beta: SeededCompany;

beforeAll(() => {
  raw = rawRuntimeClient();
  owner = ownerClient();
});

afterAll(async () => {
  await raw.end();
  await owner.end();
});

beforeEach(async () => {
  await truncateAll();
  alpha = await seedCompany("alpha");
  beta = await seedCompany("beta");
});

describe("guard", () => {
  /*
   * This must pass before any assertion below means anything. Pointed at the
   * owner or a superuser, every "returns no rows" test would go green by
   * default and prove precisely nothing.
   */
  it("is connected as a role that RLS applies to", async () => {
    const { rows } = await raw.query(
      `SELECT current_user AS role,
              rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );

    expect(rows[0].role).toBe("app_runtime");
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("seeded two distinct companies", () => {
    expect(alpha.id).not.toBe(beta.id);
    expect(alpha.userIds).toHaveLength(2);
    expect(beta.userIds).toHaveLength(2);
  });
});

describe("reads without a company context", () => {
  it("returns nothing through the ORM", async () => {
    const users = await prisma.user.findMany();
    expect(users).toEqual([]);
  });

  it("returns nothing through raw SQL", async () => {
    /*
     * withCompany's docstring has always admitted that $queryRaw slips past the
     * extension. This is the assertion that the admission no longer matters.
     */
    const { rows } = await raw.query("SELECT * FROM users");
    expect(rows).toEqual([]);
  });

  it("hides companies too", async () => {
    const { rows } = await raw.query("SELECT * FROM companies");
    expect(rows).toEqual([]);
  });
});

describe("reads with a company context", () => {
  it("returns only that company's users", async () => {
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<Array<{ company_id: string }>>`SELECT company_id FROM users`,
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.company_id === alpha.id)).toBe(true);
  });

  it("returns only that company's own row from companies", async () => {
    /*
     * Raw even though Company is absent from COMPANY_SCOPED_MODELS and gets no
     * injected filter today. Adding it there later would silently convert this
     * into a test of the extension, and nothing would say so.
     */
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<Array<{ id: string }>>`SELECT id FROM companies`,
    );

    expect(rows).toEqual([{ id: alpha.id }]);
  });

  it("cannot reach another company by raw SQL from inside a valid context", async () => {
    /*
     * The one that matters most. The caller holds a legitimate session for
     * alpha and deliberately goes looking for beta's rows in raw SQL that no
     * application-layer filter ever inspects.
     */
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM users WHERE company_id = ${beta.id}`,
    );

    expect(rows).toEqual([]);
  });

  it("cannot reach another company's row by primary key", async () => {
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${beta.userIds[0]!}`,
    );

    /* Empty, not a 403 — the row does not exist as far as this caller knows. */
    expect(rows).toEqual([]);
  });
});

describe("writes across companies", () => {
  it("updates nothing", async () => {
    const affected = await withCompany(alpha.id, (db) =>
      db.$executeRaw`UPDATE users SET full_name = 'pwned' WHERE company_id = ${beta.id}`,
    );

    expect(affected).toBe(0);

    const names = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ full_name: string }>>`SELECT full_name FROM users`,
    );
    expect(names.every((r) => r.full_name !== "pwned")).toBe(true);
  });

  it("deletes nothing", async () => {
    const affected = await withCompany(alpha.id, (db) =>
      db.$executeRaw`DELETE FROM users WHERE company_id = ${beta.id}`,
    );

    expect(affected).toBe(0);

    const survivors = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ id: string }>>`SELECT id FROM users`,
    );
    expect(survivors).toHaveLength(2);
  });

  it("rejects an insert into another company via raw SQL", async () => {
    /*
     * Reads fail closed silently (zero rows). Writes fail closed loudly, because
     * WITH CHECK raises rather than filtering. Assert on the error, not a count.
     *
     * Every NOT NULL column is supplied deliberately. A row that would be
     * rejected by a constraint anyway proves nothing about RLS — the test would
     * stay green if every policy on the table were dropped.
     */
    await expect(
      withCompany(
        alpha.id,
        (db) =>
          db.$executeRaw`
            INSERT INTO users (
              id, company_id, full_name, email, username,
              password_hash, phone_e164, password_changed_at,
              created_at, updated_at
            )
            VALUES (
              'smuggled', ${beta.id}, 'Smuggled', 'smuggled@beta.test',
              'smuggled', '$argon2id$placeholder', '+919876500000', now(),
              now(), now()
            )
          `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("leaves the other company untouched after a rejected write", async () => {
    /*
     * Raw, so that the extension's own guard is not what does the rejecting.
     * Written through the ORM this passed with every policy dropped, because
     * the create was refused before it reached the database and both reads had
     * their company filter injected — the test never touched a policy at all.
     *
     * An UPDATE rather than an INSERT, because the two fail differently and
     * the loud one is already covered above. WITH CHECK raises on an insert;
     * USING simply does not match, so a cross-company UPDATE reports success
     * having changed nothing. Zero rows is the assertion, and it is the
     * direction that would otherwise pass unnoticed.
     */
    const affected = await withCompany(
      alpha.id,
      (db) =>
        db.$executeRaw`
          UPDATE users SET full_name = 'Overwritten' WHERE company_id = ${beta.id}
        `,
    );

    expect(affected).toBe(0);

    /*
     * Read back as the superuser. The owner cannot see it — FORCE subjects it
     * to policies scoped TO app_runtime — and reading through withCompany(beta)
     * would put the injected filter back in the path of the assertion.
     */
    const superuser = superuserClient();
    try {
      const { rows } = await superuser.query<{ full_name: string }>(
        "SELECT full_name FROM users WHERE company_id = $1",
        [beta.id],
      );

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.full_name !== "Overwritten")).toBe(true);
    } finally {
      await superuser.end();
    }
  });

  it("rejects creating a company whose id is not the current context", async () => {
    /*
     * companies is self-keyed, so its WITH CHECK compares `id` rather than
     * `company_id`. Raw, so what raises is the policy and not the extension.
     */
    await expect(
      withCompany(
        alpha.id,
        (db) =>
          db.$executeRaw`
            INSERT INTO companies (id, slug, name, created_at, updated_at)
            VALUES ('some-other-id', 'sneaky', 'Sneaky', now(), now())
          `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("the credential vault", () => {
  /**
   * Seed one integration with one secret in each company.
   *
   * Through withCompany, like every other fixture — seeding as the owner would
   * pass locally and fail anywhere the owner is not a superuser.
   */
  async function seedVault(
    company: SeededCompany,
    ciphertext: string,
  ): Promise<string> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "META_ADS", label: "Ads" },
      });

      await db.integrationSecret.create({
        data: {
          companyId,
          integrationId: integration.id,
          key: "META_ADS_ACCESS_TOKEN",
          ciphertext,
          keyId: "k1",
          last4: "9999",
        },
      });

      return integration.id;
    });
  }

  /** Seeding, so the ORM is right here — see helpers.ts. */
  async function recordVerification(
    company: SeededCompany,
    integrationId: string,
    result: { ok: boolean; statusCode?: number; error?: string },
  ): Promise<void> {
    await withCompany(company.id, (db, companyId) =>
      db.integrationVerification.create({
        data: { companyId, integrationId, ...result },
      }),
    );
  }

  it("returns no ciphertext without a company context", async () => {
    await seedVault(alpha, "v2.k1.iv.tag.alpha-ciphertext");

    /*
     * Raw SQL, deliberately: this is the "someone bypassed the application
     * layer" client, so it proves the database refuses rather than proving the
     * extension remembered to add a filter.
     */
    const { rows } = await raw.query("SELECT * FROM integration_secrets");
    expect(rows).toEqual([]);
  });

  it("shows a company only its own secrets, in raw SQL", async () => {
    await seedVault(alpha, "v2.k1.iv.tag.alpha-ciphertext");
    await seedVault(beta, "v2.k1.iv.tag.beta-ciphertext");

    /*
     * Raw, and inside a legitimate context. findMany() here would pass with
     * every policy on the table dropped, because COMPANY_SCOPED_MODELS makes
     * the extension add the filter itself — proving the convention holds, not
     * the boundary. Confirmed the hard way: this test passed with RLS disabled
     * until it was rewritten.
     */
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<
        Array<{ ciphertext: string }>
      >`SELECT ciphertext FROM integration_secrets`,
    );

    expect(rows).toEqual([{ ciphertext: "v2.k1.iv.tag.alpha-ciphertext" }]);
  });

  it("cannot reach another company's ciphertext by primary key", async () => {
    const betaIntegration = await seedVault(beta, "v2.k1.iv.tag.beta-secret");

    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM integrations WHERE id = ${betaIntegration}`,
    );

    /* Empty, not an error — the row does not exist as far as alpha knows. */
    expect(rows).toEqual([]);
  });

  it("rejects writing a secret into another company", async () => {
    const betaIntegration = await seedVault(beta, "v2.k1.iv.tag.beta-secret");

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO integration_secrets (
            id, company_id, integration_id, key, ciphertext, key_id, last4,
            created_at, updated_at
          )
          VALUES (
            'smuggled-secret', ${beta.id}, ${betaIntegration},
            'META_ADS_ACCESS_TOKEN', 'v2.k1.iv.tag.smuggled', 'k1', '0000',
            now(), now()
          )
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("keeps verification logs apart", async () => {
    const alphaIntegration = await seedVault(alpha, "v2.k1.iv.tag.a");
    const betaIntegration = await seedVault(beta, "v2.k1.iv.tag.b");

    await recordVerification(alpha, alphaIntegration, { ok: true });
    await recordVerification(beta, betaIntegration, {
      ok: false,
      statusCode: 401,
      error: "invalid token",
    });

    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<
        Array<{ ok: boolean; error: string | null }>
      >`SELECT ok, error FROM integration_verifications`,
    );

    /* beta's failure carries a provider message; alpha must not see it. */
    expect(rows).toEqual([{ ok: true, error: null }]);
  });
});

describe("usage events", () => {
  async function record(
    company: SeededCompany,
    costMicros: number,
  ): Promise<void> {
    await withCompany(company.id, (db, companyId) =>
      db.usageEvent.create({
        data: {
          companyId,
          kind: "integration.verify",
          costMicros: BigInt(costMicros),
          currency: "INR",
          priceVersion: 1,
          dedupeKey: `seed:${company.id}:${costMicros}`,
        },
      }),
    );
  }

  it("totals only the company's own spend", async () => {
    await record(alpha, 7);
    await record(beta, 500);

    /*
     * Raw and inside a valid context: a SUM is exactly the shape that would
     * quietly return the whole installation's money if the policy were wrong,
     * and it would look plausible rather than empty.
     */
    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<
        Array<{ total: bigint | null }>
      >`SELECT SUM(cost_micros)::bigint AS total FROM usage_events WHERE currency = 'INR'`,
    );

    expect(Number(rows[0]?.total ?? 0)).toBe(7);
  });
});

describe("whatsapp numbers", () => {
  /**
   * A number needs an integration to hang off, so this seeds both.
   *
   * Through the ORM and outside any `it`, deliberately: seeding is not the
   * claim. no-orm-in-isolation.test.ts scans the bodies below, not this.
   */
  async function seedIntegration(company: SeededCompany): Promise<string> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
      });
      return integration.id;
    });
  }

  async function seedNumber(
    company: SeededCompany,
    phoneNumberId: string,
  ): Promise<string> {
    const integrationId = await seedIntegration(company);

    return withCompany(company.id, async (db, companyId) => {
      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId,
          phoneNumberId,
          displayNumber: "+91 98765 43210",
          status: "CONNECTED",
        },
      });

      return number.id;
    });
  }

  it("does not show one company's numbers to another", async () => {
    await seedNumber(alpha, "alpha-phone-1");
    await seedNumber(beta, "beta-phone-1");

    /*
     * Raw, inside beta's context. Through the ORM the extension would add the
     * company filter itself and this would pass with the policy dropped.
     */
    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<
        Array<{ phone_number_id: string }>
      >`SELECT phone_number_id FROM whatsapp_numbers ORDER BY phone_number_id`,
    );

    expect(rows.map((r) => r.phone_number_id)).toEqual(["beta-phone-1"]);
  });

  it("refuses to write a number into another company", async () => {
    const integrationId = await seedIntegration(alpha);

    /*
     * The WITH CHECK half. A policy with only USING would let a caller holding
     * alpha's context insert a row stamped beta, which reads back as beta's
     * data and is invisible to alpha for ever after.
     */
    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO whatsapp_numbers
            (id, company_id, integration_id, phone_number_id, display_number, updated_at)
          VALUES ('smuggled', ${beta.id}, ${integrationId}, 'beta-phone-2', '+91 90000 00000', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides a seeded number from the table's own owner", async () => {
    /*
     * Seeded first, on purpose. whatsapp_numbers is empty in beforeEach, so an
     * owner reading it would return zero rows whether FORCE were in effect or
     * not — the same vacuous pass this suite exists to avoid. With a row in the
     * table, an empty result is only explicable by FORCE.
     */
    await seedNumber(alpha, "alpha-phone-2");

    const { rows } = await owner.query("SELECT * FROM whatsapp_numbers");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });
});

describe("conversations and messages", () => {
  /** A contact, a conversation and one message, through the real path. */
  async function seedThread(
    company: SeededCompany,
    label: string,
  ): Promise<{ conversationId: string; wamid: string }> {
    const integrationId = await withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "Primary" },
      });
      return integration.id;
    });

    return withCompany(company.id, async (db, companyId) => {
      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId,
          phoneNumberId: `${label}-pn`,
          displayNumber: "+91 98765 43210",
        },
      });
      const contact = await db.contact.create({
        data: { companyId, waId: `${label}-wa`, profileName: `${label} person` },
      });
      const conversation = await db.conversation.create({
        data: {
          companyId,
          contactId: contact.id,
          whatsappNumberId: number.id,
          lastMessageAt: new Date(),
        },
      });
      const wamid = `${label}-wamid`;
      await db.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: "INBOUND",
          type: "text",
          status: "DELIVERED",
          wamid,
          body: `${label} said something`,
          occurredAt: new Date(),
        },
      });

      return { conversationId: conversation.id, wamid };
    });
  }

  it("does not show one company's messages to another", async () => {
    await seedThread(alpha, "alpha");
    await seedThread(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ wamid: string }>>`SELECT wamid FROM messages ORDER BY wamid`,
    );

    expect(rows.map((r) => r.wamid)).toEqual(["beta-wamid"]);
  });

  it("does not show one company's contacts or conversations to another", async () => {
    await seedThread(alpha, "alpha");
    await seedThread(beta, "beta");

    const rows = await withCompany(alpha.id, (db) =>
      db.$queryRaw<Array<{ wa_id: string; n: bigint }>>`
        SELECT c.wa_id, count(v.id) AS n
          FROM contacts c LEFT JOIN conversations v ON v.contact_id = c.id
         GROUP BY c.wa_id ORDER BY c.wa_id`,
    );

    /* A join is the shape that leaks a whole installation while looking
       plausible - one row per contact, and every count still correct. */
    expect(rows.map((r) => r.wa_id)).toEqual(["alpha-wa"]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("refuses to write a message into another company", async () => {
    const { conversationId } = await seedThread(alpha, "alpha");

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO messages
            (id, company_id, conversation_id, direction, status, type, occurred_at, updated_at)
          VALUES ('smuggled', ${beta.id}, ${conversationId}, 'OUTBOUND', 'PENDING', 'text', now(), now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let the raw window advance reach another company's thread", async () => {
    const { conversationId } = await seedThread(alpha, "alpha");

    /*
     * advanceConversation is raw SQL, so the extension's where-merging does not
     * apply to it: the RLS policy is the whole boundary, and the explicit
     * company_id predicate is the second, visible half.
     *
     * Written out here rather than called through the function on purpose. This
     * file's rule is raw SQL only - a call that went through a model in
     * COMPANY_SCOPED_MODELS would have its filter injected and would pass with
     * every policy dropped - and stating the statement makes it obvious that
     * what is under test is the UPDATE reaching zero rows rather than an
     * argument being checked somewhere.
     */
    const affected = await withCompany(beta.id, (db) =>
      db.$executeRaw`
        UPDATE conversations
           SET window_expires_at = now() AT TIME ZONE 'UTC',
               unread_count = unread_count + 1
         WHERE id = ${conversationId}`,
    );

    expect(affected, "beta's scope advanced alpha's window").toBe(0);

    const [row] = await withCompany(alpha.id, (db) =>
      db.$queryRaw<Array<{ window_expires_at: Date | null; unread_count: number }>>`
        SELECT window_expires_at, unread_count FROM conversations WHERE id = ${conversationId}`,
    );

    expect(row?.window_expires_at).toBeNull();
    expect(Number(row?.unread_count)).toBe(0);
  });

  it("hides a seeded thread from the table's own owner", async () => {
    await seedThread(alpha, "alpha");

    const contacts = await owner.query("SELECT * FROM contacts");
    const conversations = await owner.query("SELECT * FROM conversations");
    const messages = await owner.query("SELECT * FROM messages");

    expect(
      [contacts.rows, conversations.rows, messages.rows],
      "FORCE ROW LEVEL SECURITY is not in effect",
    ).toEqual([[], [], []]);
  });
});

describe("stored media", () => {
  async function storeMedia(company: SeededCompany, label: string): Promise<void> {
    await withCompany(company.id, async (db, companyId) => {
      await db.whatsAppMedia.create({
        data: {
          companyId,
          sha256: `${label}-sha`,
          mimeType: "image/jpeg",
          byteSize: 3,
          state: "STORED",
          bytes: new TextEncoder().encode("abc"),
        },
      });
    });
  }

  it("does not serve one company's media to another", async () => {
    await storeMedia(alpha, "alpha");
    await storeMedia(beta, "beta");

    /*
     * The read path is /api/media/[mediaId], which takes an id straight from a
     * URL. RLS is what makes guessing one useless, so this is the assertion
     * behind that route returning 404 rather than somebody else's photograph.
     */
    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ sha256: string }>>`SELECT sha256 FROM whatsapp_media ORDER BY sha256`,
    );

    expect(rows.map((r) => r.sha256)).toEqual(["beta-sha"]);
  });

  it("refuses to write media into another company", async () => {
    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO whatsapp_media
            (id, company_id, sha256, mime_type, byte_size, state, updated_at)
          VALUES ('smuggled', ${beta.id}, 'smuggled-sha', 'image/jpeg', 0, 'PENDING', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides stored media from the table's own owner", async () => {
    await storeMedia(alpha, "alpha");

    const { rows } = await owner.query("SELECT * FROM whatsapp_media");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });
});

describe("templates and their edit log", () => {
  async function seedTemplate(
    company: SeededCompany,
    name: string,
  ): Promise<string> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: name },
        select: { id: true },
      });

      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name,
          language: "en_US",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hello {{1}}" }],
        },
        select: { id: true },
      });

      await db.whatsAppTemplateEdit.create({
        data: {
          companyId,
          templateId: template.id,
          components: [{ type: "BODY", text: "Hello {{1}}" }],
        },
      });

      return template.id;
    });
  }

  it("does not show one company's templates to another", async () => {
    await seedTemplate(alpha, "alpha_offer");
    await seedTemplate(beta, "beta_offer");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM whatsapp_templates ORDER BY name`,
    );

    expect(rows.map((r) => r.name)).toEqual(["beta_offer"]);
  });

  /*
   * The edit log is what the quota is counted from, so a leak here is not only
   * a disclosure - it would let one company's edits consume another's allowance
   * and lock them out of fixing a rejected template.
   */
  it("does not count one company's edits against another", async () => {
    await seedTemplate(alpha, "alpha_offer");
    await seedTemplate(beta, "beta_offer");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM whatsapp_template_edits`,
    );

    expect(Number(rows[0]?.count)).toBe(1);
  });

  /* A fixture, deliberately outside any `it`: seeding goes through the ORM on
     purpose, and no-orm-in-isolation examines assertion bodies only. */
  async function seedIntegration(company: SeededCompany): Promise<string> {
    return withCompany(company.id, async (db, companyId) => {
      const row = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "smuggle" },
        select: { id: true },
      });
      return row.id;
    });
  }

  it("refuses to write a template into another company", async () => {
    const integrationId = await seedIntegration(alpha);

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO whatsapp_templates
            (id, company_id, integration_id, name, language, category,
             components, updated_at)
          VALUES ('smuggled', ${beta.id}, ${integrationId}, 'smuggled',
                  'en_US', 'MARKETING', '[]'::jsonb, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides templates from the table's own owner", async () => {
    await seedTemplate(alpha, "alpha_offer");

    const { rows } = await owner.query("SELECT * FROM whatsapp_templates");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });
});

describe("KYC documents", () => {
  /* A fixture, deliberately outside any `it` - seeding goes through the ORM on
     purpose, and no-orm-in-isolation examines assertion bodies only. */
  async function fileDocument(
    company: SeededCompany,
    label: string,
  ): Promise<string> {
    const bytes = new Uint8Array(16);
    bytes.set(new TextEncoder().encode("%PDF-"));

    return withCompany(company.id, async (db, companyId) => {
      const row = await db.kycDocument.create({
        data: {
          companyId,
          kind: "AADHAAR",
          bytes,
          byteSize: bytes.byteLength,
          sha256: `${label}-sha`,
          mimeType: "application/pdf",
          originalFilename: `${label}-aadhaar.pdf`,
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  /*
   * This is the most sensitive table in the system, so the three assertions
   * below are the same three every tenant table gets and are worth no less
   * care: an Aadhaar number leaking across tenants is not a bug report, it is
   * a notifiable incident.
   */
  it("does not serve one company's documents to another", async () => {
    await fileDocument(alpha, "alpha");
    await fileDocument(beta, "beta");

    /*
     * The read path is /api/kyc-documents/[documentId], which takes an id
     * straight from a URL. RLS is what makes guessing one useless, so this is
     * the assertion behind that route returning 404 rather than somebody's
     * identity document.
     */
    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ sha256: string }>>`
        SELECT sha256 FROM kyc_documents ORDER BY sha256`,
    );

    expect(rows.map((r) => r.sha256)).toEqual(["beta-sha"]);
  });

  it("does not leak the bytes through a chunked read", async () => {
    /*
     * The download streams with substring() rather than selecting the column,
     * so the policy has to hold for that shape too. It does - the USING clause
     * filters the row before any expression over it is evaluated - and this
     * asserts it rather than reasoning about it, because a slice of an
     * invisible row returning NULL and a slice of a visible one returning
     * bytes are indistinguishable from the route's side.
     */
    const documentId = await fileDocument(alpha, "alpha");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ chunk: Uint8Array | null }>>`
        SELECT substring(bytes from 1 for 5) AS chunk
          FROM kyc_documents WHERE id = ${documentId}`,
    );

    expect(rows).toEqual([]);
  });

  it("refuses to file a document into another company", async () => {
    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO kyc_documents
            (id, company_id, kind, bytes, byte_size, sha256, mime_type,
             original_filename)
          VALUES ('smuggled', ${beta.id}, 'GST', '%5044462d'::bytea, 5,
                  'smuggled-sha', 'application/pdf', 'smuggled.pdf')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides documents from the table's own owner", async () => {
    await fileDocument(alpha, "alpha");

    const { rows } = await owner.query("SELECT * FROM kyc_documents");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });
});

describe("broadcasts and their audiences", () => {
  /* A fixture, deliberately outside any `it` - seeding goes through the ORM on
     purpose, and no-orm-in-isolation examines assertion bodies only. */
  interface SeededBroadcast {
    id: string;
    templateId: string;
    whatsappNumberId: string;
  }

  async function seedBroadcast(
    company: SeededCompany,
    label: string,
  ): Promise<SeededBroadcast> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label },
        select: { id: true },
      });

      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: `${label}-pn`,
          displayNumber: "+91 98765 43210",
          status: "CONNECTED",
        },
        select: { id: true },
      });

      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: `${label}_offer`,
          language: "en_US",
          category: "MARKETING",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hello {{1}}" }],
        },
        select: { id: true },
      });

      const broadcast = await db.broadcast.create({
        data: {
          companyId,
          name: `${label} campaign`,
          templateId: template.id,
          whatsappNumberId: number.id,
          gapMs: 800,
          recipientCount: 1,
        },
        select: { id: true },
      });

      await db.broadcastRecipient.create({
        data: {
          companyId,
          broadcastId: broadcast.id,
          phoneE164: `+9198765432${label === "alpha" ? "10" : "11"}`,
          variables: ["Anita"],
        },
      });

      return {
        id: broadcast.id,
        templateId: template.id,
        whatsappNumberId: number.id,
      };
    });
  }

  it("does not show one company's broadcasts to another", async () => {
    await seedBroadcast(alpha, "alpha");
    await seedBroadcast(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM broadcasts ORDER BY name`,
    );

    expect(rows.map((r) => r.name)).toEqual(["beta campaign"]);
  });

  /*
   * The audience is a list of real people's phone numbers, so a leak here is a
   * disclosure of a customer's contact book - and worse, it is the table a
   * send job walks. A row visible across the boundary would not merely be read;
   * it would be MESSAGED, from the wrong company's number.
   */
  it("does not show one company's audience to another", async () => {
    await seedBroadcast(alpha, "alpha");
    await seedBroadcast(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ phone_e164: string }>>`
        SELECT phone_e164 FROM broadcast_recipients ORDER BY phone_e164`,
    );

    expect(rows.map((r) => r.phone_e164)).toEqual(["+919876543211"]);
  });

  it("refuses to write a broadcast into another company", async () => {
    /* alpha's own template and number, so the foreign keys are satisfiable and
       the only thing left that can refuse the insert is the policy. They come
       back from the fixture rather than a lookup here, because a lookup in an
       assertion body would go through the extension and prove nothing. */
    const seeded = await seedBroadcast(alpha, "alpha");

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO broadcasts
            (id, company_id, name, template_id, whatsapp_number_id, gap_ms,
             updated_at)
          VALUES ('smuggled', ${beta.id}, 'smuggled', ${seeded.templateId},
                  ${seeded.whatsappNumberId}, 800, now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to write a recipient into another company", async () => {
    const seeded = await seedBroadcast(alpha, "alpha");

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO broadcast_recipients
            (id, company_id, broadcast_id, phone_e164, variables)
          VALUES ('smuggled', ${beta.id}, ${seeded.id}, '+919999999999',
                  '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides broadcasts and their audiences from the table's own owner", async () => {
    await seedBroadcast(alpha, "alpha");

    const broadcasts = await owner.query("SELECT * FROM broadcasts");
    const recipients = await owner.query("SELECT * FROM broadcast_recipients");

    expect(
      broadcasts.rows,
      "FORCE ROW LEVEL SECURITY is not in effect on broadcasts",
    ).toEqual([]);
    expect(
      recipients.rows,
      "FORCE ROW LEVEL SECURITY is not in effect on broadcast_recipients",
    ).toEqual([]);
  });
});

describe("lead sources and the rows they have claimed", () => {
  /* A fixture, deliberately outside any `it` - seeding goes through the ORM on
     purpose, and no-orm-in-isolation examines assertion bodies only. */
  interface SeededLeadSource {
    id: string;
    templateId: string;
    whatsappNumberId: string;
  }

  async function seedLeadSource(
    company: SeededCompany,
    label: string,
  ): Promise<SeededLeadSource> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: `${label}-leads` },
        select: { id: true },
      });

      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: `${label}-leads-pn`,
          displayNumber: "+91 98765 43210",
          status: "CONNECTED",
        },
        select: { id: true },
      });

      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: `${label}_welcome`,
          language: "en_US",
          category: "MARKETING",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hello {{1}}" }],
        },
        select: { id: true },
      });

      const source = await db.leadSource.create({
        data: {
          companyId,
          name: `${label} sheet`,
          spreadsheetId: `${label}-spreadsheet`,
          tab: "Leads",
          actionConfig: { kind: "TEMPLATE", templateId: template.id, mapping: {} },
          templateId: template.id,
          whatsappNumberId: number.id,
        },
        select: { id: true },
      });

      await db.leadSourceRow.create({
        data: {
          companyId,
          leadSourceId: source.id,
          spreadsheetId: `${label}-spreadsheet`,
          tab: "Leads",
          rowHash: `${label}-hash`,
          phoneE164: `+9198765432${label === "alpha" ? "10" : "11"}`,
          state: "SKIPPED",
          skipReason: "fixture",
        },
      });

      return {
        id: source.id,
        templateId: template.id,
        whatsappNumberId: number.id,
      };
    });
  }

  it("does not show one company's lead sources to another", async () => {
    await seedLeadSource(alpha, "alpha");
    await seedLeadSource(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lead_sources ORDER BY name`,
    );

    expect(rows.map((r) => r.name)).toEqual(["beta sheet"]);
  });

  /*
   * A claimed row is a real person's phone number and the fact that this
   * business contacted them. A leak here is a disclosure of one tenant's
   * customer list to another - and this is also the table the unique index
   * lives on, so a row visible across the boundary is a row that could
   * suppress or duplicate somebody else's send.
   */
  it("does not show one company's claimed rows to another", async () => {
    await seedLeadSource(alpha, "alpha");
    await seedLeadSource(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ phone_e164: string }>>`
        SELECT phone_e164 FROM lead_source_rows ORDER BY phone_e164`,
    );

    expect(rows.map((r) => r.phone_e164)).toEqual(["+919876543211"]);
  });

  it("refuses to write a lead source into another company", async () => {
    /* alpha's own template and number, so the foreign keys are satisfiable and
       the only thing left that can refuse the insert is the policy. */
    const seeded = await seedLeadSource(alpha, "alpha");

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO lead_sources
            (id, company_id, name, spreadsheet_id, tab, action_config,
             template_id, whatsapp_number_id, updated_at)
          VALUES ('smuggled', ${beta.id}, 'smuggled', 'sheet', 'Leads',
                  '{}'::jsonb, ${seeded.templateId}, ${seeded.whatsappNumberId},
                  now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to write a claimed row into another company", async () => {
    const seeded = await seedLeadSource(alpha, "alpha");

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRaw`
          INSERT INTO lead_source_rows
            (id, company_id, lead_source_id, spreadsheet_id, tab, row_hash,
             phone_e164, state, skip_reason)
          VALUES ('smuggled', ${beta.id}, ${seeded.id}, 'sheet', 'Leads', 'h',
                  '+919999999999', 'SKIPPED', 'smuggled')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  /*
   * The unique index is scoped by company_id, and this is what says so.
   *
   * Without company_id in the index, one tenant's claimed hash would suppress
   * another tenant's - two businesses whose sheets happen to hold the same
   * customer with the same message, and the second one silently never sends.
   * The policy alone would not catch it: a unique violation is raised before
   * the row is ever checked against a policy.
   */
  it("lets two companies claim the same lead independently", async () => {
    await seedLeadSource(alpha, "alpha");
    await seedLeadSource(beta, "beta");

    await withCompany(alpha.id, (db) =>
      db.$executeRaw`
        UPDATE lead_source_rows SET spreadsheet_id = 'shared', row_hash = 'same'`,
    );

    await expect(
      withCompany(beta.id, (db) =>
        db.$executeRaw`
          UPDATE lead_source_rows SET spreadsheet_id = 'shared', row_hash = 'same'`,
      ),
    ).resolves.toBe(1);
  });

  it("hides lead sources and their rows from the table's own owner", async () => {
    await seedLeadSource(alpha, "alpha");

    const sources = await owner.query("SELECT * FROM lead_sources");
    const rows = await owner.query("SELECT * FROM lead_source_rows");

    expect(
      sources.rows,
      "FORCE ROW LEVEL SECURITY is not in effect on lead_sources",
    ).toEqual([]);
    expect(
      rows.rows,
      "FORCE ROW LEVEL SECURITY is not in effect on lead_source_rows",
    ).toEqual([]);
  });
});

describe("a tenant's knowledge and the campaigns that read it", () => {
  /* Seeding goes through the ORM on purpose; no-orm-in-isolation examines
     assertion bodies only. */
  async function seedKnowledge(company: SeededCompany, label: string) {
    return withCompany(company.id, async (db, companyId) => {
      const base = await db.knowledgeBase.create({
        data: {
          companyId,
          name: `${label} handbook`,
          embeddingModel: "text-embedding-3-small",
          embeddingVersion: 1,
        },
        select: { id: true },
      });

      const document = await db.kbDocument.create({
        data: {
          companyId,
          knowledgeBaseId: base.id,
          kind: "FILE",
          title: `${label} refund policy`,
          filename: `${label}-refunds.pdf`,
          mimeType: "application/pdf",
          status: "INDEXED",
        },
        select: { id: true },
      });

      /*
       * The chunk is written with raw SQL because `embedding` is Unsupported
       * in Prisma and cannot be inserted any other way - which is the same
       * reason packages/db/src/verse.ts exists.
       */
      const vector = `[${new Array(1536).fill(0.01).join(",")}]`;
      await db.$executeRawUnsafe(
        `INSERT INTO kb_chunks
           (id, company_id, knowledge_base_id, content_hash, content,
            token_count, embedding, embedding_model, embedding_version)
         VALUES ($1, $2, $3, encode(sha256(convert_to($4, 'UTF8')), 'hex'), $4,
                 12, $5::vector, 'text-embedding-3-small', 1)`,
        `${label}-chunk`,
        companyId,
        base.id,
        `${label} refunds are available within 14 days.`,
        vector,
      );

      /* Where the passage came from, now a row of its own. Written here too so
         the isolation fixture matches the shape retrieval actually reads. */
      await db.$executeRawUnsafe(
        `INSERT INTO kb_chunk_sources (id, company_id, chunk_id, document_id, seq)
         VALUES ($1, $2, $3, $4, 0)`,
        `${label}-source`,
        companyId,
        `${label}-chunk`,
        document.id,
      );

      return { baseId: base.id, documentId: document.id };
    });
  }

  async function seedCampaign(company: SeededCompany, label: string) {
    const { baseId } = await seedKnowledge(company, `${label}-c`);

    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: `${label}-verse` },
        select: { id: true },
      });
      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: `${label}_verse_open`,
          language: "en_US",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hello {{1}}" }],
          status: "APPROVED",
        },
        select: { id: true },
      });
      await db.verseCampaign.create({
        data: {
          companyId,
          name: `${label} winter push`,
          goal: `${label} secret goal`,
          templateId: template.id,
          modelTier: "V1",
          knowledgeBaseId: baseId,
          timezone: "Asia/Kolkata",
        },
      });
    });
  }

  it("does not show one company's knowledge bases to another", async () => {
    await seedKnowledge(alpha, "alpha");
    await seedKnowledge(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM knowledge_bases ORDER BY name`,
    );

    expect(rows).toEqual([{ name: "beta handbook" }]);
  });

  it("does not show one company's passages to another", async () => {
    /*
     * The single most sensitive read this phase adds. kb_chunks.content is the
     * tenant's own operating knowledge in plain text - pricing, policies,
     * scripts - sliced into passages that are, by design, the parts worth
     * quoting. A competitor reading another tenant's chunks would have the
     * business, not a contact list.
     */
    await seedKnowledge(alpha, "alpha");
    await seedKnowledge(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ content: string }>>`
        SELECT content FROM kb_chunks ORDER BY content`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain("beta refunds");
  });

  it("does not let a similarity search reach across companies", async () => {
    /*
     * Retrieval is an ORDER BY on a distance operator with a LIMIT, and it has
     * no WHERE clause of its own naming the company - the policy is what
     * scopes it. So this asserts the shape retrieval actually uses rather than
     * a plain SELECT: a nearest-neighbour query that ignores company_id
     * entirely still cannot see another tenant's passages.
     *
     * Worth its own test because the HNSW index has no notion of the policy.
     * The index is searched first and the rows are filtered after, so "the
     * index found it" and "the caller may read it" are genuinely different
     * questions here in a way they are not for a btree lookup.
     */
    await seedKnowledge(alpha, "alpha");
    await seedKnowledge(beta, "beta");

    const probe = `[${new Array(1536).fill(0.01).join(",")}]`;

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRawUnsafe<Array<{ content: string }>>(
        `SELECT content FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT 10`,
        probe,
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain("beta refunds");
  });

  it("refuses to write a chunk into another company", async () => {
    const { baseId, documentId } = await seedKnowledge(beta, "beta");
    const vector = `[${new Array(1536).fill(0.02).join(",")}]`;

    await expect(
      withCompany(alpha.id, (db) =>
        db.$executeRawUnsafe(
          `INSERT INTO kb_chunks
             (id, company_id, knowledge_base_id, content_hash, content,
              token_count, embedding, embedding_model, embedding_version)
           VALUES ('smuggled', $1, $2,
                   encode(sha256(convert_to('injected', 'UTF8')), 'hex'),
                   'injected', 3, $3::vector, 'text-embedding-3-small', 1)`,
          beta.id,
          baseId,
          vector,
        ),
      ),
    ).rejects.toThrow();
  });

  it("does not show one company's campaigns, including the goal", async () => {
    /*
     * `goal` is the tenant's own words, verbatim, describing what they are
     * trying to get out of a conversation. It is strategy in a text column.
     */
    await seedCampaign(alpha, "alpha");
    await seedCampaign(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ goal: string }>>`SELECT goal FROM verse_campaigns`,
    );

    expect(rows).toEqual([{ goal: "beta secret goal" }]);
  });
});

describe("flows, their versions, and the runs pinned to them", () => {
  /* A fixture, deliberately outside any `it` - seeding goes through the ORM on
     purpose, and no-orm-in-isolation examines assertion bodies only. */
  interface SeededFlow {
    flowId: string;
    versionId: string;
    runId: string;
    conversationId: string;
    contactId: string;
    templateId: string;
  }

  async function seedFlow(
    company: SeededCompany,
    label: string,
  ): Promise<SeededFlow> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: `${label}-flows` },
        select: { id: true },
      });

      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: `${label}-flow-pn`,
          displayNumber: "+91 98765 43210",
          status: "CONNECTED",
        },
        select: { id: true },
      });

      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: `${label}_flow_entry`,
          language: "en_US",
          category: "MARKETING",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hello" }],
        },
        select: { id: true },
      });

      const contact = await db.contact.create({
        data: { companyId, waId: `${label}-flow-wa`, phoneE164: "+919876543210" },
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

      const flow = await db.flow.create({
        data: { companyId, name: `${label} enquiry flow` },
        select: { id: true },
      });

      const version = await db.flowVersion.create({
        data: {
          companyId,
          flowId: flow.id,
          version: 1,
          entryTemplateId: template.id,
          graph: {
            entryNodeId: "start",
            nodes: [
              {
                id: "start",
                kind: "entry",
                templateId: template.id,
                variables: [],
                choices: [{ key: "yes", label: "Yes", next: "done" }],
              },
              { id: "done", kind: "end", body: null },
            ],
          },
        },
        select: { id: true },
      });

      const run = await db.flowRun.create({
        data: {
          companyId,
          flowId: flow.id,
          flowVersionId: version.id,
          conversationId: conversation.id,
          activeConversationId: conversation.id,
          contactId: contact.id,
          currentNodeId: "start",
        },
        select: { id: true },
      });

      await db.flowRunStep.create({
        data: {
          companyId,
          flowRunId: run.id,
          seq: 1,
          kind: "STARTED",
          nodeId: "start",
        },
      });

      return {
        flowId: flow.id,
        versionId: version.id,
        runId: run.id,
        conversationId: conversation.id,
        contactId: contact.id,
        templateId: template.id,
      };
    });
  }

  it("does not show one company's flows to another", async () => {
    await seedFlow(alpha, "alpha");
    await seedFlow(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM flows ORDER BY name`,
    );

    expect(rows).toEqual([{ name: "beta enquiry flow" }]);
  });

  it("does not show one company's versions or the trees inside them", async () => {
    /*
     * The graph is the tenant's product. A competitor reading another tenant's
     * flow would have their decision tree, their copy and their qualifying
     * questions - which is a worse leak than a contact list, because it is the
     * thing that took work to write.
     */
    await seedFlow(alpha, "alpha");
    await seedFlow(beta, "beta");

    const rows = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ graph: unknown }>>`SELECT graph FROM flow_versions`,
    );

    expect(rows).toHaveLength(1);
  });

  it("does not show one company's runs or the answers in them", async () => {
    /*
     * variables holds what a customer typed and tapped. It is the most
     * personal column this phase adds, and it is per run rather than per
     * contact precisely so it does not accumulate into a profile.
     */
    await seedFlow(alpha, "alpha");
    await seedFlow(beta, "beta");

    const runs = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ id: string }>>`SELECT id FROM flow_runs`,
    );
    const steps = await withCompany(beta.id, (db) =>
      db.$queryRaw<Array<{ id: string }>>`SELECT id FROM flow_run_steps`,
    );

    expect(runs).toHaveLength(1);
    expect(steps).toHaveLength(1);
  });

  it("refuses to write a flow into another company", async () => {
    const target = await seedFlow(alpha, "alpha");

    await expect(
      withCompany(beta.id, (db) =>
        db.$executeRaw`
          INSERT INTO flows (id, company_id, name, updated_at)
          VALUES ('planted-flow', ${alpha.id}, 'planted', now())`,
      ),
    ).rejects.toThrow();

    await expect(
      withCompany(beta.id, (db) =>
        db.$executeRaw`
          INSERT INTO flow_runs
            (id, company_id, flow_id, flow_version_id, conversation_id,
             contact_id, current_node_id, updated_at)
          VALUES ('planted-run', ${alpha.id}, ${target.flowId}, ${target.versionId},
                  ${target.conversationId}, ${target.contactId}, 'start', now())`,
      ),
    ).rejects.toThrow();
  });

  it("cannot advance another company's run", async () => {
    /*
     * The write that would matter most if the policy were missing. A run is a
     * position in somebody's conversation, and moving it sends that customer
     * the next question in a tree they were never put into.
     */
    await seedFlow(alpha, "alpha");
    await seedFlow(beta, "beta");

    const touched = await withCompany(beta.id, (db) =>
      db.$executeRaw`UPDATE flow_runs SET current_node_id = 'hijacked'`,
    );

    expect(touched).toBe(1);

    const alphaNodes = await withCompany(alpha.id, (db) =>
      db.$queryRaw<Array<{ current_node_id: string }>>`
        SELECT current_node_id FROM flow_runs`,
    );

    expect(alphaNodes).toEqual([{ current_node_id: "start" }]);
  });

  it("hides flows, versions, runs and steps from the table's own owner", async () => {
    await seedFlow(alpha, "alpha");

    for (const table of ["flows", "flow_versions", "flow_runs", "flow_run_steps"]) {
      const { rows } = await owner.query(`SELECT * FROM ${table}`);
      expect(
        rows,
        `FORCE ROW LEVEL SECURITY is not in effect on ${table}`,
      ).toEqual([]);
    }
  });
});

describe("a tenant's ad accounts, campaigns, spend and the clicks that arrived", () => {
  /*
   * Seeded through the ORM, deliberately, and asserted through raw SQL.
   *
   * Seeding cannot go through the owner connection: FORCE ROW LEVEL SECURITY
   * subjects it to policies scoped TO app_runtime, so an owner INSERT matches
   * no policy and is refused outright. And it must not go through the ORM
   * inside an `it` body, because every model here is in COMPANY_SCOPED_MODELS
   * and the extension injects the company filter - which is what made three of
   * the five vault isolation tests pass with RLS switched off.
   *
   * So: helpers outside the bodies, raw SQL inside them. That split is what
   * no-orm-in-isolation.test.ts enforces.
   */
  async function seedAdAccount(
    company: SeededCompany,
    label: string,
    currency: string,
    spendMicros: bigint,
  ): Promise<{ accountId: string; numberId: string }> {
    return withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "META_ADS", label: `${label} ads` },
        select: { id: true },
      });

      /* The Page's linked number, this company's own - which is what makes the
         cross-company write below an attempt rather than a typo. */
      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: `${label}-pnid`,
          displayNumber: `+9100000${label.length}`,
          verifiedName: label,
        },
        select: { id: true },
      });

      const account = await db.metaAdAccount.create({
        data: {
          companyId,
          integrationId: integration.id,
          metaAdAccountId: `act_${label}`,
          name: `${label} ad account`,
          currency,
          pageId: `page-${label}`,
          pageName: `${label} Page`,
          whatsappNumberId: number.id,
          linkedPhoneE164: `+9100000${label.length}`,
        },
        select: { id: true },
      });

      await db.metaCampaign.create({
        data: {
          companyId,
          adAccountId: account.id,
          metaCampaignId: `mc-${label}`,
          name: `${label} monsoon sale`,
          objective: "OUTCOME_LEADS",
          dailyBudgetMicros: 500_000_000n,
          currency,
        },
      });

      await db.metaAdInsight.create({
        data: {
          companyId,
          adAccountId: account.id,
          metaCampaignId: `mc-${label}`,
          campaignName: `${label} monsoon sale`,
          date: new Date("2026-09-01T00:00:00.000Z"),
          impressions: 4200n,
          clicks: 130n,
          spendMicros,
          currency,
        },
      });

      return { accountId: account.id, numberId: number.id };
    });
  }

  /** A click-to-WhatsApp referral, which needs a whole thread beneath it. */
  async function seedReferral(
    company: SeededCompany,
    label: string,
    numberId: string,
  ): Promise<void> {
    await withCompany(company.id, async (db, companyId) => {
      const contact = await db.contact.create({
        data: {
          companyId,
          waId: `wa-${label}`,
          phoneE164: `+9199999${label.length}`,
          source: "ADS_CLICK_TO_WHATSAPP",
        },
        select: { id: true },
      });

      const conversation = await db.conversation.create({
        data: {
          companyId,
          contactId: contact.id,
          whatsappNumberId: numberId,
          source: "ADS_CLICK_TO_WHATSAPP",
        },
        select: { id: true },
      });

      const message = await db.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: "INBOUND",
          status: "DELIVERED",
          type: "text",
          occurredAt: new Date("2026-09-01T09:00:00.000Z"),
        },
        select: { id: true },
      });

      await db.metaAdReferral.create({
        data: {
          companyId,
          conversationId: conversation.id,
          contactId: contact.id,
          messageId: message.id,
          ctwaClid: `clid-${label}`,
          sourceId: `ad-${label}`,
          sourceType: "ad",
          headline: `${label} headline`,
          body: `${label} body copy`,
          occurredAt: new Date("2026-09-01T09:00:00.000Z"),
        },
      });
    });
  }

  beforeEach(async () => {
    const a = await seedAdAccount(alpha, "alpha", "INR", 812_340_000n);
    const b = await seedAdAccount(beta, "beta", "USD", 41_990_000n);
    await seedReferral(alpha, "alpha", a.numberId);
    await seedReferral(beta, "beta", b.numberId);
  });

  it("does not show one company's ad accounts to another", async () => {
    await raw.query("SELECT set_config('app.company_id', $1, false)", [alpha.id]);

    const { rows } = await raw.query("SELECT meta_ad_account_id FROM meta_ad_accounts");

    expect(rows).toEqual([{ meta_ad_account_id: "act_alpha" }]);
  });

  it("does not show one company's campaigns to another", async () => {
    await raw.query("SELECT set_config('app.company_id', $1, false)", [beta.id]);

    const { rows } = await raw.query("SELECT name FROM meta_campaigns");

    expect(rows).toEqual([{ name: "beta monsoon sale" }]);
  });

  it("does not show one company's ad spend to another", async () => {
    /*
     * The one with the sharpest consequence. Spend is money, denominated per
     * account, and a leak here would not look like a leak - it would look like
     * a dashboard saying this month cost more than the tenant thought.
     */
    await raw.query("SELECT set_config('app.company_id', $1, false)", [alpha.id]);

    const { rows } = await raw.query(
      "SELECT spend_micros::text AS spend, currency FROM meta_ad_insights",
    );

    expect(rows).toEqual([{ spend: "812340000", currency: "INR" }]);
  });

  it("does not show one company's ad clicks to another", async () => {
    await raw.query("SELECT set_config('app.company_id', $1, false)", [beta.id]);

    const { rows } = await raw.query(
      "SELECT ctwa_clid, headline FROM meta_ad_referrals",
    );

    expect(rows).toEqual([{ ctwa_clid: "clid-beta", headline: "beta headline" }]);
  });

  it("refuses to write a campaign into another company", async () => {
    await raw.query("SELECT set_config('app.company_id', $1, false)", [alpha.id]);

    const { rows } = await raw.query(
      "SELECT id FROM meta_ad_accounts WHERE meta_ad_account_id = 'act_alpha'",
    );
    const mine = (rows[0] as { id: string }).id;

    await expect(
      raw.query(
        `INSERT INTO meta_campaigns
           (id, company_id, ad_account_id, meta_campaign_id, name, objective,
            status, currency, updated_at)
         VALUES ('smuggled', $1, $2, 'mc-smuggled', 'not mine', 'OUTCOME_LEADS',
                 'PAUSED', 'USD', now())`,
        [beta.id, mine],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to write spend into another company", async () => {
    await raw.query("SELECT set_config('app.company_id', $1, false)", [beta.id]);

    const { rows } = await raw.query(
      "SELECT id FROM meta_ad_accounts WHERE meta_ad_account_id = 'act_beta'",
    );
    const mine = (rows[0] as { id: string }).id;

    await expect(
      raw.query(
        `INSERT INTO meta_ad_insights
           (id, company_id, ad_account_id, meta_campaign_id, date, spend_micros,
            currency, updated_at)
         VALUES ('smuggled', $1, $2, 'mc-beta', DATE '2026-09-02', 1, 'INR', now())`,
        [alpha.id, mine],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot attribute another company's conversation to an ad", async () => {
    /*
     * The write worth making, if it were possible. A referral names a
     * conversation, so an insert accepted across the boundary would attach
     * this company's ad to somebody else's customer - and the join it feeds is
     * "which ad produced this lead".
     */
    await raw.query("SELECT set_config('app.company_id', $1, false)", [alpha.id]);

    /* Alpha's OWN thread, stamped with beta's company id. The row is entirely
       constructible - every foreign key resolves - so the only thing that can
       refuse it is the policy. An INSERT ... SELECT over beta's rows would
       have matched nothing under this context and inserted zero rows, which
       is a test that passes without the boundary existing. */
    const { rows } = await raw.query(
      `SELECT c.id AS conversation_id, c.contact_id, m.id AS message_id
         FROM conversations c JOIN messages m ON m.conversation_id = c.id
        LIMIT 1`,
    );
    const mine = rows[0] as {
      conversation_id: string;
      contact_id: string;
      message_id: string;
    };

    await expect(
      raw.query(
        `INSERT INTO meta_ad_referrals
           (id, company_id, conversation_id, contact_id, message_id, source_id,
            occurred_at)
         VALUES ('smuggled', $1, $2, $3, $4, 'ad-alpha', now())`,
        [beta.id, mine.conversation_id, mine.contact_id, mine.message_id],
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides ad accounts from the table's own owner", async () => {
    const { rows } = await owner.query("SELECT * FROM meta_ad_accounts");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });

  it("hides ad spend from the table's own owner", async () => {
    const { rows } = await owner.query("SELECT * FROM meta_ad_insights");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });

  it("hides ad clicks from the table's own owner", async () => {
    const { rows } = await owner.query("SELECT * FROM meta_ad_referrals");

    expect(rows, "FORCE ROW LEVEL SECURITY is not in effect").toEqual([]);
  });
});


describe("the table owner", () => {
  /** Every table whose owner must still be subject to its own policies. */
  const TENANT_TABLES = ["users", "companies"] as const;

  it("is not a superuser and does not bypass RLS", async () => {
    /*
     * This is what makes the next test mean anything. A superuser ignores RLS
     * unconditionally — FORCE or not — so if the owner were the container's
     * postgres superuser, "the owner sees nothing" would be untestable and the
     * FORCE clause would be decorative.
     */
    const { rows } = await owner.query(
      `SELECT current_user AS role, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );

    expect(rows[0].role).toBe("whatsapp_owner");
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("owns these tables", async () => {
    const { rows } = await owner.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tableowner = current_user
       ORDER BY tablename`,
    );

    const owned = rows.map((r: { tablename: string }) => r.tablename);
    for (const table of TENANT_TABLES) {
      expect(owned, `${table} is not owned by the connecting role`).toContain(
        table,
      );
    }
  });

  it.each(TENANT_TABLES)(
    "sees no rows in %s without a company context",
    async (table) => {
      /*
       * The only direct proof that FORCE ROW LEVEL SECURITY does anything.
       *
       * The connection owns this table and there are seeded rows in it. ENABLE
       * alone would let the owner read every one of them; FORCE is what
       * subjects the owner to the same policies as everyone else, and those
       * policies are scoped TO app_runtime / app_admin, so this role matches
       * none of them and the table reads as empty.
       */
      const { rows } = await owner.query(`SELECT * FROM "${table}"`);

      expect(rows, `${table}: FORCE ROW LEVEL SECURITY is not in effect`).toEqual(
        [],
      );
    },
  );

  it("can still TRUNCATE, which is why app_runtime must not", async () => {
    /*
     * TRUNCATE ignores RLS entirely. The owner keeps it because the test
     * harness needs it; app_runtime is denied it precisely because it would be
     * a one-statement bypass of every policy above.
     */
    await expect(owner.query('TRUNCATE TABLE "users" CASCADE')).resolves.toBeDefined();

    await expect(
      raw.query('TRUNCATE TABLE "users" CASCADE'),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the company context does not leak", () => {
  it("is gone once the transaction ends", async () => {
    /*
     * The regression this guards against is someone "simplifying" withCompany
     * back to a plain SET outside a transaction. That would work in every test
     * above and silently hand one tenant's context to the next request that
     * borrows the same pooled connection.
     *
     * raw is a pool of exactly 1, so this is the same physical connection.
     */
    /* Any statement will do; it is the scope ending that is under test. */
    await withCompany(alpha.id, (db) => db.$queryRaw`SELECT 1`);

    const { rows } = await raw.query(
      "SELECT current_setting('app.company_id', true) AS company",
    );
    expect(rows[0].company === null || rows[0].company === "").toBe(true);

    const after = await raw.query("SELECT * FROM users");
    expect(after.rows).toEqual([]);
  });

  it("keeps concurrent scopes apart", async () => {
    /*
     * Two assertions per scope, because they fail in different ways.
     *
     * app_current_company() catches a leak directly: the wrong id means one
     * transaction overwrote another's setting on a shared connection. The
     * count catches the subtler case where the setting survived but visibility
     * did not — a policy consulting something other than the GUC, or a
     * connection whose context was reset between the two statements.
     *
     * Both are raw. This test previously used findMany() and passed with every
     * policy in the database dropped, which made it a test of the extension's
     * injected filter — precisely the thing that cannot detect a GUC leak.
     */
    const scopeView = async (db: CompanyClient, otherCompanyId: string) => {
      const [context] = await db.$queryRaw<Array<{ company: string | null }>>`
        SELECT app_current_company() AS company`;

      const [own] = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM users`;

      const [other] = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM users WHERE company_id = ${otherCompanyId}`;

      return {
        context: context?.company ?? null,
        ownRows: Number(own?.count ?? -1),
        otherCompanyRows: Number(other?.count ?? -1),
      };
    };

    for (let round = 0; round < 10; round++) {
      const [alphaView, betaView] = await Promise.all([
        withCompany(alpha.id, (db) => scopeView(db, beta.id)),
        withCompany(beta.id, (db) => scopeView(db, alpha.id)),
      ]);

      expect(alphaView.context).toBe(alpha.id);
      expect(betaView.context).toBe(beta.id);
      expect(alphaView.otherCompanyRows).toBe(0);
      expect(betaView.otherCompanyRows).toBe(0);
      expect(alphaView.ownRows).toBe(2);
      expect(betaView.ownRows).toBe(2);
    }
  });
});
