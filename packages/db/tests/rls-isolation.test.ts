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
