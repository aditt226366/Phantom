import {
  RETRIEVAL_TOP_K,
  similarityFromCosineDistance,
  type RetrievedChunk,
} from "@whatsapp-os/core/verse";
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
 * Replace a document's passages with a fresh set.
 *
 * Delete-then-insert rather than upsert, because a re-ingested document is not
 * the same document with edits - it has a different number of chunks at
 * different boundaries, and matching them up by `seq` would leave the tail of a
 * shortened document behind as passages that are still retrievable and no
 * longer true.
 *
 * The caller runs this inside withCompany, so both statements share one
 * transaction and a crash between them cannot leave a document with no
 * passages while its status says INDEXED.
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
    DELETE FROM kb_chunks
     WHERE document_id = ${input.documentId}
       AND company_id = ${companyId}
  `;

  for (const chunk of input.chunks) {
    await db.$executeRaw`
      INSERT INTO kb_chunks
        (id, company_id, knowledge_base_id, document_id, seq, content,
         token_count, embedding, embedding_model, embedding_version)
      VALUES
        (gen_random_uuid()::text, ${companyId}, ${input.knowledgeBaseId},
         ${input.documentId}, ${chunk.seq}, ${chunk.content},
         ${chunk.tokenCount}, ${toVectorLiteral(chunk.embedding)}::vector,
         ${input.embeddingModel}, ${input.embeddingVersion})
    `;
  }

  return input.chunks.length;
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
      document_id: string;
      document_title: string;
      seq: number;
      content: string;
      distance: number;
    }>
  >`
    SELECT c.id            AS chunk_id,
           c.document_id   AS document_id,
           d.title         AS document_title,
           c.seq           AS seq,
           c.content       AS content,
           c.embedding <=> ${toVectorLiteral(input.embedding)}::vector AS distance
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
     WHERE c.company_id = ${companyId}
       AND c.knowledge_base_id = ${input.knowledgeBaseId}
     ORDER BY c.embedding <=> ${toVectorLiteral(input.embedding)}::vector
     LIMIT ${input.limit ?? RETRIEVAL_TOP_K}
  `;

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    seq: row.seq,
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
