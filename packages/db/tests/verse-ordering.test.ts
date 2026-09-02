import { beforeEach, describe, expect, it } from "vitest";

import { nextCampaignRecipients, retrieveChunks, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * The two limited reads in the Verse layer, against real ties.
 *
 * ---------------------------------------------------------------------------
 * Both of these decide something, rather than merely displaying it
 * ---------------------------------------------------------------------------
 *
 * `nextCampaignRecipients` chooses who the worker messages next, under a limit
 * that exists because a campaign has a per-day cap and a daily send window. A
 * campaign's audience is written in ONE transaction, so every recipient shares
 * a `created_at` to the microsecond - ordering on it alone is not an order, and
 * the database was free to hand back an arbitrary slice of the audience as
 * today's batch. It never double-sends, because a recipient leaves PENDING once
 * handled; what it got wrong is WHO IS REACHED TODAY.
 *
 * `retrieveChunks` chooses what the model is allowed to answer from. Two chunks
 * with identical text have identical embeddings and therefore EXACTLY equal
 * distance, and identical text is ordinary in a knowledge base - a boilerplate
 * paragraph across documents, one page crawled under two URLs, a PDF and its
 * web version both uploaded. Under `LIMIT k` a tie at the boundary decides
 * which chunk is retrieved at all, and the answer cites a document title.
 *
 * Both fixtures assign ids AGAINST insertion order, so a plan returning rows
 * physically - which is what a seq scan over a freshly written table does -
 * gives a different answer and fails.
 */

let company: SeededCompany;

const TIED = new Date("2026-09-08T10:00:00.000Z");

/** Ids whose ascending order is the reverse of the order rows are written. */
function tiedIds(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(count - 1 - i).padStart(3, "0")}`,
  );
}

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("verse-ordering");
});

describe("who the campaign reaches next", () => {
  /** A campaign with `count` recipients, all enrolled in one transaction. */
  async function seedAudience(count: number): Promise<string[]> {
    const ids = tiedIds("rcpt", count);

    await withCompany(company.id, async (db, companyId) => {
      const integration = await db.integration.create({
        data: { companyId, provider: "WHATSAPP_CLOUD", label: "verse" },
        select: { id: true },
      });
      const number = await db.whatsAppNumber.create({
        data: {
          companyId,
          integrationId: integration.id,
          phoneNumberId: "pn-verse",
          displayNumber: "+91 12345 00000",
          status: "CONNECTED",
        },
        select: { id: true },
      });
      const template = await db.whatsAppTemplate.create({
        data: {
          companyId,
          integrationId: integration.id,
          name: "campaign_opener",
          language: "en_US",
          category: "MARKETING",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hello." }],
        },
        select: { id: true },
      });
      const base = await db.knowledgeBase.create({
        data: {
          companyId,
          name: "Base",
          embeddingModel: "text-embedding-3-small",
          embeddingVersion: 1,
        },
        select: { id: true },
      });
      const campaign = await db.verseCampaign.create({
        data: {
          id: "campaign-ordering",
          companyId,
          name: "September",
          goal: "Book a demo.",
          modelTier: "V1",
          knowledgeBaseId: base.id,
          templateId: template.id,
          whatsappNumberId: number.id,
          status: "RUNNING",
          timezone: "Asia/Kolkata",
        },
        select: { id: true },
      });

      /* One transaction, one created_at - which is exactly how an audience is
         enrolled, and exactly what makes the tie real rather than contrived. */
      for (const [i, id] of ids.entries()) {
        await db.verseCampaignRecipient.create({
          data: {
            id,
            companyId,
            campaignId: campaign.id,
            phoneE164: `+9112345${String(i).padStart(5, "0")}`,
            status: "PENDING",
            createdAt: TIED,
          },
        });
      }
    });

    return ids;
  }

  it("takes the same batch every time when the whole audience ties", async () => {
    /*
     * THE assertion. Eight recipients enrolled together, a batch of three, and
     * without a tiebreak the five left behind are whichever five the plan felt
     * like - a different five on a different day, with a daily cap deciding
     * that some of them wait until tomorrow.
     */
    const ids = await seedAudience(8);

    const batch = await withCompany(company.id, (db, companyId) =>
      nextCampaignRecipients(db, companyId, "campaign-ordering", 3),
    );

    expect(batch).toHaveLength(3);
    expect(batch.map((recipient) => recipient.id)).toEqual(
      [...ids].sort().slice(0, 3),
    );
  });

  it("advances rather than repeating, once the first batch is handled", async () => {
    /*
     * The half a stable order alone would not prove. Ordering is only useful
     * here if the filter also moves: a recipient that leaves PENDING must not
     * come back, or a stable order would just mean stably re-sending to the
     * same three people forever.
     */
    const ids = await seedAudience(8);
    const sorted = [...ids].sort();

    await withCompany(company.id, (db, companyId) =>
      db.verseCampaignRecipient.updateMany({
        where: { companyId, id: { in: sorted.slice(0, 3) } },
        data: { status: "SENT" },
      }),
    );

    const second = await withCompany(company.id, (db, companyId) =>
      nextCampaignRecipients(db, companyId, "campaign-ordering", 3),
    );

    expect(second.map((recipient) => recipient.id)).toEqual(sorted.slice(3, 6));
  });
});

describe("which chunks ground the answer", () => {
  /**
   * `count` chunks whose embeddings are IDENTICAL, so distances tie exactly.
   *
   * Not nearly equal - equal. Two chunks holding the same text embed to the
   * same vector, and `<=>` against a query vector then returns the same float
   * for both. That is the case this exists for, and it is the ordinary one.
   */
  async function seedDuplicateChunks(count: number): Promise<string[]> {
    const ids = tiedIds("chunk", count);
    const embedding = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
    const literal = `[${embedding.join(",")}]`;

    await withCompany(company.id, async (db, companyId) => {
      const base = await db.knowledgeBase.create({
        data: {
          id: "kb-ordering",
          companyId,
          name: "Base",
          embeddingModel: "text-embedding-3-small",
          embeddingVersion: 1,
        },
        select: { id: true },
      });
      const document = await db.kbDocument.create({
        data: {
          companyId,
          knowledgeBaseId: base.id,
          title: "Terms",
          /* A FILE carries a filename and no source_url - a CHECK enforces
             that each kind has its own locator and not the other's. */
          kind: "FILE",
          filename: "terms.pdf",
          status: "INDEXED",
        },
        select: { id: true },
      });

      for (const [i, id] of ids.entries()) {
        /* Raw, because `embedding` is Unsupported("vector(1536)") and is
           omitted from every generated type - see CLAUDE.md rule 3. */
        await db.$executeRawUnsafe(
          `INSERT INTO kb_chunks
             (id, company_id, knowledge_base_id, document_id, seq, content,
              token_count, embedding, embedding_model, embedding_version,
              created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, 1, $10)`,
          id,
          companyId,
          base.id,
          document.id,
          i,
          "The same paragraph, repeated verbatim.",
          9,
          literal,
          "text-embedding-3-small",
          TIED,
        );
      }
    });

    return ids;
  }

  it("retrieves the same top-k every time when distances tie exactly", async () => {
    const ids = await seedDuplicateChunks(8);
    const embedding = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);

    const chunks = await withCompany(company.id, (db, companyId) =>
      retrieveChunks(db, companyId, {
        knowledgeBaseId: "kb-ordering",
        embedding,
        limit: 3,
      }),
    );

    expect(chunks).toHaveLength(3);

    /*
     * Every similarity identical - the guard that says the tie is real and
     * this test is not passing because the vectors happened to differ.
     *
     * `similarity`, not distance: retrieveChunks converts `<=>` through
     * similarityFromCosineDistance on the way out, because the sign flip is
     * silent and the floor would otherwise keep exactly what it exists to
     * reject.
     */
    expect(new Set(chunks.map((chunk) => chunk.similarity)).size).toBe(1);

    expect(chunks.map((chunk) => chunk.chunkId)).toEqual(
      [...ids].sort().slice(0, 3),
    );
  });
});
