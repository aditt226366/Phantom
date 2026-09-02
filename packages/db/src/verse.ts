import {
  RETRIEVAL_TOP_K,
  similarityFromCosineDistance,
  type RetrievedChunk,
} from "@whatsapp-os/core/verse";
import { createHash } from "node:crypto";

import type { CompanyClient } from "./with-company.ts";

/**
 * Reading and writing vectors, which is the only thing here that needs raw SQL.
 *
 * ---------------------------------------------------------------------------
 * Why this file is the tenth entry in no-raw-sql.test.ts
 * ---------------------------------------------------------------------------
 *
 * The other nine are there because the statement they need has no
 * query-builder form. This one is narrower and stronger: Prisma has no vector
 * type, so `kb_chunks.embedding` is `Unsupported` - and an `Unsupported` field
 * is omitted from every generated type. It cannot be selected, inserted,
 * compared or ordered by through the query builder at all.
 *
 * Not "this is faster". Not "this is fewer round trips". There is no other way
 * to read this column.
 *
 * Retrieval is `ORDER BY embedding <=> $vector LIMIT k`, which is an operator
 * against a bound value with an ordering and a limit - a shape the builder
 * cannot express even in principle, and the reason pgvector exists.
 *
 * The company_id predicate is redundant beside the RLS policy and is written
 * anyway (R3), for the reason advanceConversation gives: raw SQL bypasses the
 * extension's where-merging entirely, so the policy is otherwise the only
 * thing between this statement and another company's passages - and
 * kb_chunks.content is a tenant's own operating knowledge in plain text.
 */

/**
 * A vector, as pgvector's text input format.
 *
 * Bound as a string and cast, because the driver has no array-to-vector
 * mapping. Written once here rather than at each call site: a malformed vector
 * literal is a runtime cast error at the far end of an ingestion, after the
 * embedding has already been paid for.
 */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export interface ChunkToStore {
  seq: number;
  content: string;
  tokenCount: number;
  embedding: readonly number[];
}

/**
 * The deduplication key: SHA-256 of the passage's exact bytes, hex.
 *
 * Must agree with the migration, which backfilled the same value as
 * `encode(sha256(convert_to(content, 'UTF8')), 'hex')`. A mismatch between the
 * two would be invisible - both sides stay internally consistent, nothing
 * errors, and deduplication silently stops for every row written afterwards.
 * verse-dedupe.test.ts asserts they agree by computing one in Postgres and one
 * here.
 *
 * Exact bytes, never normalised. Trimming or case-folding would merge passages
 * that are not the same text, which is a claim about meaning a hash has no
 * business making - and it is unrecoverable, because the variant that lost is
 * gone. Two passages differing by one space stay two chunks. That is the safe
 * direction to be wrong in.
 */
export function chunkContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Replace a document's passages with a fresh set, deduplicating by content.
 *
 * ---------------------------------------------------------------------------
 * What "replace" means once chunks are shared
 * ---------------------------------------------------------------------------
 *
 * It used to mean delete-then-insert on kb_chunks, because a chunk belonged to
 * exactly one document. Now what belongs to this document is its SOURCE ROWS,
 * so those are what gets replaced. The passages themselves are shared: writing
 * a chunk another document already contributed is a second source row and no
 * new vector.
 *
 * Delete-then-insert on the sources, and for the reason the old comment gave:
 * a re-ingested document is not the same document with edits - it has a
 * different number of chunks at different boundaries, and matching them up by
 * `seq` would leave the tail of a shortened document behind as passages that
 * are still retrievable and no longer true.
 *
 * What it must NOT do is delete the chunks. A passage this document shares with
 * another survives its own document being re-ingested, and orphans are
 * collected at the end rather than assumed away.
 *
 * ---------------------------------------------------------------------------
 * Reusing an existing vector is safe because of the embedding pin
 * ---------------------------------------------------------------------------
 *
 * On conflict this does not re-embed: it takes the chunk already there. That is
 * only correct because a knowledge base holds exactly one embedding model -
 * which is a pin enforced by a versioned re-embedding migration and asserted by
 * verse-embedding-pin.test.ts, not a hope. If a base could hold two, the reused
 * vector could come from the wrong one and every score against it would be
 * meaningless while staying perfectly in range.
 *
 * The caller runs this inside withCompany, so every statement shares one
 * transaction and a crash between them cannot leave a document with no passages
 * while its status says INDEXED.
 */
export async function replaceChunks(
  db: CompanyClient,
  companyId: string,
  input: {
    knowledgeBaseId: string;
    documentId: string;
    embeddingModel: string;
    embeddingVersion: number;
    chunks: readonly ChunkToStore[];
  },
): Promise<number> {
  await db.$executeRaw`
    DELETE FROM kb_chunk_sources
     WHERE document_id = ${input.documentId}
       AND company_id = ${companyId}
  `;

  for (const chunk of input.chunks) {
    const hash = chunkContentHash(chunk.content);

    /*
     * DO NOTHING and then read, rather than DO UPDATE ... RETURNING.
     *
     * The upsert-returning trick needs a no-op UPDATE to produce a row on
     * conflict, which writes a new tuple for every duplicate passage - and the
     * duplicate case is the common one this whole change exists for. Two
     * statements on the conflict path, one on the fresh path, and no write that
     * exists only to make a RETURNING clause fire.
     */
    const inserted = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO kb_chunks
        (id, company_id, knowledge_base_id, content_hash, content,
         token_count, embedding, embedding_model, embedding_version)
      VALUES
        (gen_random_uuid()::text, ${companyId}, ${input.knowledgeBaseId},
         ${hash}, ${chunk.content}, ${chunk.tokenCount},
         ${toVectorLiteral(chunk.embedding)}::vector,
         ${input.embeddingModel}, ${input.embeddingVersion})
      ON CONFLICT (company_id, knowledge_base_id, content_hash) DO NOTHING
      RETURNING id
    `;

    const existing =
      inserted[0]?.id === undefined
        ? await db.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM kb_chunks
             WHERE company_id = ${companyId}
               AND knowledge_base_id = ${input.knowledgeBaseId}
               AND content_hash = ${hash}
          `
        : [];

    const chunkId = inserted[0]?.id ?? existing[0]?.id;

    if (chunkId === undefined) {
      /*
       * Unreachable: the INSERT either wrote the row or conflicted with one
       * that exists, and both statements are in the caller's transaction so
       * nothing can remove it in between. Thrown rather than skipped, because
       * the alternative is a document silently missing a passage - which is
       * exactly the class of fault this file keeps finding.
       */
      throw new Error(
        `kb_chunks: no row for content hash ${hash} after insert-or-conflict`,
      );
    }

    await db.$executeRaw`
      INSERT INTO kb_chunk_sources
        (id, company_id, chunk_id, document_id, seq)
      VALUES
        (gen_random_uuid()::text, ${companyId}, ${chunkId},
         ${input.documentId}, ${chunk.seq})
    `;
  }

  await deleteOrphanedChunks(db, companyId, input.knowledgeBaseId);

  return input.chunks.length;
}

/**
 * Delete chunks in this base that no document points at any more.
 *
 * The half a foreign key cannot express. ON DELETE CASCADE removes a chunk's
 * SOURCES when a document goes; nothing in SQL says "and remove the parent when
 * its last child does".
 *
 * Getting this wrong is not a leak, it is a disclosure: a passage with no
 * sources is still in the index and still retrievable, so the assistant would
 * go on answering customers out of a document the tenant deleted - and the
 * citation would name a document that no longer exists. The deletion UI
 * promises the opposite in as many words.
 *
 * Scoped to one base because both callers know theirs, and a sweep of every
 * base would make one document's deletion cost proportional to the tenant's
 * whole corpus rather than to what they deleted.
 */
export async function deleteOrphanedChunks(
  db: CompanyClient,
  companyId: string,
  knowledgeBaseId: string,
): Promise<number> {
  return db.$executeRaw`
    DELETE FROM kb_chunks c
     WHERE c.company_id = ${companyId}
       AND c.knowledge_base_id = ${knowledgeBaseId}
       AND NOT EXISTS (
             SELECT 1 FROM kb_chunk_sources s
              WHERE s.chunk_id = c.id
                AND s.company_id = ${companyId}
           )
  `;
}

/**
 * Remove a document, and any passage that was only in it.
 *
 * One function rather than a delete in the action followed by a sweep, because
 * the two must share a transaction: between them the index holds passages whose
 * document is gone, and a retrieval in that window answers from a deleted
 * source.
 *
 * Returns both numbers, because they are different facts - a caller that wants
 * to say "3 passages removed, 2 still used elsewhere" cannot derive that from a
 * boolean.
 */
export async function deleteDocumentAndOrphanedChunks(
  db: CompanyClient,
  companyId: string,
  input: { documentId: string; knowledgeBaseId: string },
): Promise<{ documentDeleted: boolean; chunksDeleted: number }> {
  const deleted = await db.kbDocument.deleteMany({
    where: { id: input.documentId, companyId },
  });

  if (deleted.count === 0) {
    return { documentDeleted: false, chunksDeleted: 0 };
  }

  const chunksDeleted = await deleteOrphanedChunks(
    db,
    companyId,
    input.knowledgeBaseId,
  );

  return { documentDeleted: true, chunksDeleted };
}

/**
 * The nearest passages to a question, with their similarity.
 *
 * ---------------------------------------------------------------------------
 * The floor is NOT applied here, deliberately
 * ---------------------------------------------------------------------------
 *
 * This returns the top k whatever they score, and `groundingFor` decides
 * whether any of them are evidence. Filtering in the WHERE clause would be one
 * fewer round trip and would destroy the only thing that makes the floor
 * tunable: a caller holding an empty list cannot tell "the index has nothing
 * like this" from "the index is empty", and /dev/rag could not show why a
 * question was refused.
 *
 * Scoped to one knowledge base as well as one company. A campaign names its
 * base, and answering from a base the tenant did not choose would be the same
 * class of error as answering from another tenant's - less severe and equally
 * invisible.
 *
 * Ordered by distance and then by id, and the reason has changed rather than
 * gone away.
 *
 * It used to be that identical text was several chunks with exactly equal
 * distance - not nearly equal, equal - so a tie at the k boundary decided which
 * copy was retrieved and the answer cited whichever document won. Deduplication
 * removes that: identical text is now one chunk citing every document it
 * appears in, so the tie cannot happen for that reason.
 *
 * The tiebreak stays because equal distances are still reachable without
 * identical text - two passages equidistant from a query, or the degenerate
 * case of an all-zero query vector - and because `k` of anything under a LIMIT
 * needs a total order or the answer is up to the plan. It is one clause and it
 * removes a whole class of question.
 *
 * ---------------------------------------------------------------------------
 * Why `k` now means what it says
 * ---------------------------------------------------------------------------
 *
 * Before deduplication a top-5 could be five copies of one paragraph, so the
 * model saw ONE passage while this function, `groundingFor`, the /dev/rag
 * harness and the operator all counted five. Grounding was thinner than every
 * layer above it believed and nothing reported it. That is also why the
 * acceptance metric had to wait for this: a 20/5 measured against duplicated
 * chunks tunes the floor for a retrieval system nobody intends to ship.
 */
export async function retrieveChunks(
  db: CompanyClient,
  companyId: string,
  input: {
    knowledgeBaseId: string;
    embedding: readonly number[];
    limit?: number;
  },
): Promise<RetrievedChunk[]> {
  const rows = await db.$queryRaw<
    Array<{
      chunk_id: string;
      content: string;
      distance: number;
      sources: Array<{ documentId: string; documentTitle: string; seq: number }>;
    }>
  >`
    SELECT c.id      AS chunk_id,
           c.content AS content,
           c.embedding <=> ${toVectorLiteral(input.embedding)}::vector AS distance,

           /*
            * Every place this passage appears, as one JSON value.
            *
            * A correlated subquery rather than a join, because a join would
            * multiply the rows BEFORE the LIMIT: a chunk in three documents
            * would occupy three of the k slots with the same text, which is a
            * more elaborate version of the fault this whole change removes.
            * The limit has to apply to passages, so the sources are gathered
            * per surviving passage.
            *
            * Ordered, and totally - title, then position, then the document id
            * that cannot tie. A citation list that reshuffles between two
            * answers to the same question reads as two different answers.
            */
           COALESCE(
             (SELECT json_agg(
                       json_build_object(
                         'documentId',    s.document_id,
                         'documentTitle', d.title,
                         'seq',           s.seq
                       )
                       ORDER BY d.title, s.seq, s.document_id
                     )
                FROM kb_chunk_sources s
                JOIN kb_documents d ON d.id = s.document_id
               WHERE s.chunk_id = c.id
                 AND s.company_id = ${companyId}),
             '[]'::json
           ) AS sources

      FROM kb_chunks c
     WHERE c.company_id = ${companyId}
       AND c.knowledge_base_id = ${input.knowledgeBaseId}
     ORDER BY c.embedding <=> ${toVectorLiteral(input.embedding)}::vector,
              c.id
     LIMIT ${input.limit ?? RETRIEVAL_TOP_K}
  `;

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    sources: row.sources,
    content: row.content,
    /*
     * `<=>` is a DISTANCE. Converted through the named helper rather than
     * inline, because the sign flip is silent: the floor would keep exactly
     * the passages it exists to reject and retrieval would confidently return
     * the least relevant chunk in the base.
     */
    similarity: similarityFromCosineDistance(Number(row.distance)),
  }));
}

/**
 * Whether a knowledge base holds vectors from more than one model.
 *
 * A mixed index is the failure the embedding pin exists to prevent, and it is
 * completely invisible from the outside - every score stays in range and every
 * result sorts. This is what a re-embedding migration checks itself against,
 * and what the /dev/rag harness reports.
 */
export async function embeddingModelsInBase(
  db: CompanyClient,
  companyId: string,
  knowledgeBaseId: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ embedding_model: string }>>`
    SELECT DISTINCT embedding_model
      FROM kb_chunks
     WHERE company_id = ${companyId}
       AND knowledge_base_id = ${knowledgeBaseId}
     ORDER BY embedding_model
  `;

  return rows.map((row) => row.embedding_model);
}

/**
 * The uploaded file, for the one caller that needs it.
 *
 * The query builder, not raw SQL. `bytes` is an ordinary `Bytes?` column that
 * Prisma models perfectly well, and there is no slicing here - extraction wants
 * the whole file. An unnecessary raw statement in an allowlisted file is
 * exactly the drift the allowlist exists to stop: the list is per file and the
 * justification is per statement.
 *
 * media-store.ts and kyc.ts slice their byte columns with `substring()` to
 * stream them, which is why THEY are raw. Nothing streams this one.
 *
 * findFirst rather than findUnique, because the extension merges companyId - a
 * non-unique column - into `where`, which findUnique's type does not accept.
 */
export async function readDocumentBytes(
  db: CompanyClient,
  documentId: string,
): Promise<Uint8Array | null> {
  const row = await db.kbDocument.findFirst({
    where: { id: documentId },
    select: { bytes: true },
  });

  return row?.bytes ? new Uint8Array(row.bytes) : null;
}

/* ------------------------------------------------------------------------- *
 * What one Verse turn needs to know
 * ------------------------------------------------------------------------- */

export interface VerseContext {
  conversationId: string;
  contactId: string;
  /** Which campaign is driving, and therefore whose goal and base to use. */
  campaignId: string;
  campaignName: string;
  goal: string;
  modelTier: string;
  knowledgeBaseId: string;
  businessName: string;
  /** The approved template that reopens a lapsed conversation. */
  templateId: string;
  /** Oldest first. What the model reads as the conversation so far. */
  history: Array<{ inbound: boolean; body: string | null }>;
}

/**
 * Everything one reply needs, or null if Verse must not answer.
 *
 * ---------------------------------------------------------------------------
 * The driver is read here, and it is the authorisation
 * ---------------------------------------------------------------------------
 *
 * Null when this conversation is not Verse's to answer - it is held by an
 * operator, by a flow, or by nobody at all. That is not an error and is not
 * logged as one: it is the ordinary outcome of a customer replying to a thread
 * a person has since taken over, which happens constantly.
 *
 * Reading it here rather than trusting the enqueue site matters because time
 * passes between the two. A webhook enqueues, an operator opens the thread and
 * replies, and the job then runs against a conversation somebody else is now
 * having. The claim at enqueue time is worth nothing; the claim at answer time
 * is the whole guarantee.
 */
export async function verseContextFor(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
  historyLimit = 20,
): Promise<VerseContext | null> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId },
    select: {
      id: true,
      contactId: true,
      driver: true,
      driverRef: true,
      company: { select: { name: true } },
    },
  });

  if (!conversation) return null;
  if (conversation.driver !== "VERSE" || !conversation.driverRef) return null;

  const campaign = await db.verseCampaign.findFirst({
    where: { id: conversation.driverRef },
    select: {
      id: true,
      name: true,
      goal: true,
      modelTier: true,
      knowledgeBaseId: true,
      templateId: true,
      status: true,
    },
  });

  /*
   * A campaign that has stopped does not keep answering.
   *
   * PAUSED and STOPPED both land here. The driver is deliberately NOT released
   * as a side effect of this read - releasing it would let another automation
   * take the thread the moment a person paused a campaign to look at it, which
   * is the opposite of what pausing is for.
   */
  if (!campaign) return null;
  if (campaign.status !== "RUNNING") return null;

  const history = await db.message.findMany({
    where: { conversationId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: historyLimit,
    select: { direction: true, body: true },
  });

  return {
    conversationId: conversation.id,
    contactId: conversation.contactId,
    campaignId: campaign.id,
    campaignName: campaign.name,
    goal: campaign.goal,
    modelTier: campaign.modelTier,
    knowledgeBaseId: campaign.knowledgeBaseId,
    businessName: conversation.company.name,
    templateId: campaign.templateId,
    /* Reversed: the query sorts newest-first so the LIMIT keeps the most
       recent turns, and the model reads oldest-first. */
    history: history
      .reverse()
      .map((message) => ({
        inbound: message.direction === "INBOUND",
        body: message.body,
      })),
  };
}

/* ------------------------------------------------------------------------- *
 * Campaigns
 * ------------------------------------------------------------------------- */

/**
 * How many of this campaign's messages went out on the tenant's today.
 *
 * The tenant's day, not the server's, and the caller computes the boundary
 * with `localDay` - a cap of 200 that resets at UTC midnight resets at 05:30
 * for an Indian tenant, in the middle of their morning, and they would report
 * it as the cap not working.
 *
 * Counted from the recipients rather than from `messages`, because that is
 * what the cap is about: people contacted by THIS campaign. A message row can
 * also be an answer or a handoff, and counting those would spend a tenant's
 * daily allowance on replies to people it had already reached.
 */
export async function campaignSentSince(
  db: CompanyClient,
  companyId: string,
  campaignId: string,
  since: Date,
): Promise<number> {
  return db.verseCampaignRecipient.count({
    where: {
      companyId,
      campaignId,
      status: "SENT",
      updatedAt: { gte: since },
    },
  });
}

/**
 * Stop a campaign because its template can no longer be sent.
 *
 * ---------------------------------------------------------------------------
 * STOPPED and not PAUSED, and the difference is not cosmetic
 * ---------------------------------------------------------------------------
 *
 * PAUSED means a person chose it and Resume will undo it. This is neither:
 * Meta revoked the approval, nobody here decided anything, and Resume would
 * put the campaign straight back into refusing one message at a time.
 *
 * A CHECK ties `stopped_reason` to the status, so a stopped campaign cannot
 * exist without the sentence an operator reads.
 *
 * Conditional on the current status so a campaign a person paused a moment ago
 * is not overwritten - the person's PAUSED is a decision and this is a fact,
 * and the fact does not need to erase the decision to be true.
 */
export async function stopCampaignForTemplate(
  db: CompanyClient,
  companyId: string,
  campaignId: string,
  reason: string,
): Promise<boolean> {
  const { count } = await db.verseCampaign.updateMany({
    where: {
      id: campaignId,
      companyId,
      status: { in: ["RUNNING", "SCHEDULED"] },
    },
    data: { status: "STOPPED", stoppedReason: reason },
  });

  return count > 0;
}

/**
 * The next recipients this campaign should contact.
 *
 * `take` is the caller's remaining allowance for the day, so the cap is applied
 * as a LIMIT rather than by fetching everybody and stopping - which at ten
 * thousand recipients is ten thousand rows read to send fifty.
 */
export async function nextCampaignRecipients(
  db: CompanyClient,
  companyId: string,
  campaignId: string,
  take: number,
): Promise<
  Array<{ id: string; phoneE164: string; variables: unknown; contactId: string | null }>
> {
  return db.verseCampaignRecipient.findMany({
    where: { companyId, campaignId, status: "PENDING" },
    /*
     * Then id, because an audience is written in ONE transaction and every
     * recipient carries the same created_at to the microsecond - so ordering
     * on it alone is not an order at all.
     *
     * Under a LIMIT that decides who is in the batch, not merely what sequence
     * it comes back in. It does not double-send: a recipient leaves PENDING
     * once handled, so the filter advances either way. What it decides is WHO
     * IS REACHED TODAY, because a campaign has a per-day cap and a daily send
     * window - and with a tied key the database picks the day's fifty out of
     * an arbitrary slice of the audience. Enrolment order is the one the
     * operator can reason about, and it is what pendingRecipients already does
     * for broadcasts, for the same reason.
     */
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true, phoneE164: true, variables: true, contactId: true },
  });
}
