import { chunkText } from "@whatsapp-os/core/verse";
import { VERSE_EMBEDDING } from "@whatsapp-os/core/verse";
import { openaiEmbeddingRouter } from "@whatsapp-os/core/verse";
import {
  crawl,
  extractPdf,
  extractText,
  MAX_CRAWL_PAGES,
} from "@whatsapp-os/core/verse-server";
import type { VerseIngestJob } from "@whatsapp-os/core/queues";
import { readDocumentBytes, replaceChunks, withCompany } from "@whatsapp-os/db";
import { env } from "../env.ts";
import { log } from "../logger.ts";

/**
 * Extract, chunk, embed, store - and say why when it does not work.
 *
 * ---------------------------------------------------------------------------
 * Every failure ends in a sentence, never a status alone
 * ---------------------------------------------------------------------------
 *
 * The realistic failures here all have a remedy the tenant can carry out
 * themselves: re-export a PDF that is a scan, fix the sharing on a URL, point
 * at a page that is not behind robots.txt. A red dot saying FAILED sends them
 * to support for something they could have fixed in a minute, so
 * `failure_reason` is NOT NULL exactly when the status is FAILED, enforced by a
 * CHECK rather than by whoever writes the next handler.
 *
 * ---------------------------------------------------------------------------
 * The embedding batch is where the money is
 * ---------------------------------------------------------------------------
 *
 * One call per chunk would be two thousand round trips for a long PDF and a
 * rate limit rather than an ingestion. Batched, and the router asserts that the
 * provider's ordering is honoured rather than trusting it - reading `data`
 * positionally attaches every chunk's vector to its neighbour, which produces
 * no error and ruins the index permanently.
 */

const EMBED_BATCH = 64;

export async function handleVerseIngest(job: VerseIngestJob): Promise<void> {
  const { companyId, documentId } = job;

  const document = await withCompany(companyId, (db) =>
    db.kbDocument.findFirst({
      where: { id: documentId },
      select: {
        id: true,
        knowledgeBaseId: true,
        kind: true,
        title: true,
        sourceUrl: true,
        filename: true,
        mimeType: true,
        knowledgeBase: {
          select: { embeddingModel: true, embeddingVersion: true },
        },
      },
    }),
  );

  if (!document) {
    /* Deleted between enqueue and run. Not an error - the work is moot. */
    log.info("verse.ingest: document is gone", { documentId });
    return;
  }

  const fail = async (reason: string) => {
    await withCompany(companyId, (db) =>
      db.kbDocument.updateMany({
        where: { id: documentId, companyId },
        data: { status: "FAILED", failureReason: reason },
      }),
    );
    log.warn("verse.ingest: failed", { documentId, reason });
  };

  /*
   * The pin, checked before a single byte is read.
   *
   * A base stamped with a different model than the one this build would write
   * must not gain new chunks: the two sets are not comparable, and a mixed
   * index returns plausible scores for passages that have nothing to do with
   * the question. Refusing here is the only moment this is cheap - afterwards
   * the vectors are already written and the base is already poisoned.
   */
  if (
    document.knowledgeBase.embeddingModel !== VERSE_EMBEDDING.model ||
    document.knowledgeBase.embeddingVersion !== VERSE_EMBEDDING.version
  ) {
    await fail(
      `This knowledge base was built with ${document.knowledgeBase.embeddingModel} ` +
        `v${document.knowledgeBase.embeddingVersion} and this server writes ` +
        `${VERSE_EMBEDDING.model} v${VERSE_EMBEDDING.version}. Vectors from two ` +
        "models cannot be compared, so nothing was added. The base has to be " +
        "re-embedded before it can take new documents.",
    );
    return;
  }

  await withCompany(companyId, (db) =>
    db.kbDocument.updateMany({
      where: { id: documentId, companyId },
      data: { status: "EXTRACTING", failureReason: null },
    }),
  );

  /* --------------------------------------------------------------------- *
   * Extract
   * --------------------------------------------------------------------- */

  let text: string;

  if (document.kind === "URL") {
    const seed = document.sourceUrl;
    if (!seed) {
      await fail("This document has no URL to read.");
      return;
    }

    const result = await crawl(fetch, seed, { maxPages: MAX_CRAWL_PAGES });

    if (result.pages.length === 0) {
      await fail(
        result.blockedByRobots.length > 0
          ? "Every page found was disallowed by the site's robots.txt, so " +
              "nothing was indexed. robots.txt is the site operator's standing " +
              "instruction about automated access, and it is respected even " +
              "when the site belongs to you - change it there if this is " +
              "wrong."
          : "Nothing readable was found at that address. Check the page loads " +
              "publicly and is not behind a login.",
      );
      return;
    }

    /*
     * Pages joined with their titles, so a chunk that spans a boundary still
     * carries which page it came from. Without the heading a retrieved
     * passage from a forty-page crawl is unattributable.
     */
    text = result.pages
      .map((page) => `# ${page.title}\n${page.url}\n\n${page.text}`)
      .join("\n\n");

    log.info("verse.ingest: crawled", {
      documentId,
      pages: result.pages.length,
      blocked: result.blockedByRobots.length,
      hitPageCap: result.hitPageCap,
    });
  } else {
    const bytes = await withCompany(companyId, (db) =>
      readDocumentBytes(db, documentId),
    );

    if (!bytes) {
      await fail("The uploaded file could not be read back.");
      return;
    }

    const extraction =
      document.mimeType === "application/pdf"
        ? await extractPdf(bytes)
        : extractText(bytes);

    if (extraction.kind === "failed") {
      await fail(extraction.reason);
      return;
    }

    text = extraction.text;
  }

  /* --------------------------------------------------------------------- *
   * Chunk and embed
   * --------------------------------------------------------------------- */

  const chunks = chunkText(text);

  if (chunks.length === 0) {
    await fail("There was no text to index in this document.");
    return;
  }

  await withCompany(companyId, (db) =>
    db.kbDocument.updateMany({
      where: { id: documentId, companyId },
      data: { status: "EMBEDDING" },
    }),
  );

  const apiKey = env.VERSE_EMBEDDING_API_KEY;
  if (!apiKey) {
    await fail(
      `No embedding credential is configured on this server ` +
        `(${VERSE_EMBEDDING.keyVar}). Nothing was indexed.`,
    );
    return;
  }

  const router = openaiEmbeddingRouter(fetch, apiKey);
  const vectors: number[][] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const embedded = await router.embed(batch.map((chunk) => chunk.content));

    if (embedded.kind === "failed") {
      await fail(`The embedding service refused this document: ${embedded.reason}`);
      return;
    }

    for (const vector of embedded.vectors) vectors.push([...vector]);
  }

  /* --------------------------------------------------------------------- *
   * Store
   * --------------------------------------------------------------------- */

  /*
   * One transaction for the delete and every insert, so a crash cannot leave a
   * document holding half a set of passages while its status says INDEXED.
   * HTTP is finished by this point - the embedding calls are above, outside
   * the transaction, because withCompany holds a pooled connection and times
   * out after 5s.
   */
  const stored = await withCompany(companyId, async (db, scopedCompanyId) => {
    const count = await replaceChunks(db, scopedCompanyId, {
      knowledgeBaseId: document.knowledgeBaseId,
      documentId,
      embeddingModel: VERSE_EMBEDDING.model,
      embeddingVersion: VERSE_EMBEDDING.version,
      chunks: chunks.map((chunk, index) => ({
        seq: chunk.seq,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: vectors[index]!,
      })),
    });

    await db.kbDocument.updateMany({
      where: { id: documentId, companyId: scopedCompanyId },
      data: {
        status: "INDEXED",
        failureReason: null,
        chunkCount: count,
        indexedAt: new Date(),
      },
    });

    return count;
  });

  log.info("verse.ingest: indexed", { documentId, chunks: stored });
}
