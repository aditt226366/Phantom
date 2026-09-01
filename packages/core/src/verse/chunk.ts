/**
 * Turning a document into passages worth retrieving.
 *
 * ---------------------------------------------------------------------------
 * Why ~800 tokens with overlap, rather than paragraphs or pages
 * ---------------------------------------------------------------------------
 *
 * A chunk is the unit of retrieval, so its size is a trade between two ways of
 * being useless:
 *
 *   TOO SMALL - "Delivery takes 3-5 working days." retrieves beautifully and
 *   answers nothing, because the sentence that said which products it applies
 *   to is in a different chunk that did not score as well.
 *
 *   TOO LARGE - a whole page embeds to the average of everything on it, which
 *   is close to nothing in particular. A page containing the refund policy AND
 *   the office address matches "where are you" and "can I get a refund" about
 *   equally badly.
 *
 * ~800 tokens is roughly two or three paragraphs: enough to carry a complete
 * thought with its qualifiers, small enough that the embedding still points
 * somewhere specific.
 *
 * The OVERLAP is the part that is easy to leave out and expensive to miss. A
 * policy split exactly at a boundary - "...refunds are available" | "within 14
 * days of delivery" - produces two chunks, neither of which answers the
 * question, and the first of which answers it WRONGLY and confidently. An
 * overlap means every span of the document appears whole in at least one chunk.
 *
 * ---------------------------------------------------------------------------
 * The token count is an estimate, and that is a deliberate choice
 * ---------------------------------------------------------------------------
 *
 * Real tokenisation needs the provider's tokeniser, which means a dependency
 * per provider and a different answer per model - for a number used only to
 * decide where to cut. The cut does not have to be exact; it has to be
 * consistent and roughly right, because being 15% out changes how many chunks
 * a document makes and nothing else.
 *
 * What it must NOT be used for is a billing figure or a context-window budget.
 * Those come from the provider's own usage numbers on the response, which is
 * why VerseUsage carries them.
 */

/** Characters per token, averaged over English prose. Deliberately rough. */
const CHARS_PER_TOKEN = 4;

export const CHUNK_TARGET_TOKENS = 800;
/**
 * One eighth of the target.
 *
 * Enough to carry a sentence and its subject across a boundary, small enough
 * that the index is not mostly duplicates - at 800/100 a document embeds about
 * 14% more chunks than a non-overlapping split would.
 */
export const CHUNK_OVERLAP_TOKENS = 100;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Chunk {
  seq: number;
  content: string;
  tokenCount: number;
}

/**
 * Split on paragraph boundaries, packing up to the target.
 *
 * Paragraph-first rather than a fixed character window, because a window cuts
 * mid-sentence and a chunk starting "...within 14 days" has lost its subject.
 * A paragraph longer than the target on its own is split on sentences, and a
 * sentence longer than the target is split hard - at which point something
 * unusual is going on (a minified file, a table with no breaks) and cutting it
 * badly is better than emitting one enormous chunk that matches nothing.
 */
export function chunkText(raw: string): Chunk[] {
  const text = normalise(raw);
  if (text.length === 0) return [];

  const target = CHUNK_TARGET_TOKENS * CHARS_PER_TOKEN;
  const overlap = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

  const pieces = splitToPieces(text, target);

  const chunks: Chunk[] = [];
  let buffer = "";

  const flush = () => {
    const content = buffer.trim();
    if (content.length === 0) return;
    chunks.push({
      seq: chunks.length,
      content,
      tokenCount: estimateTokens(content),
    });
    /*
     * Carry the tail forward as the next chunk's head.
     *
     * Taken from the END of what was just emitted rather than from the start of
     * what comes next, so the overlap is text the reader has already seen in
     * context - which is what makes a boundary-split policy whole in the second
     * chunk as well as the first.
     */
    buffer = content.length > overlap ? content.slice(-overlap) : content;
  };

  for (const piece of pieces) {
    if (buffer.length > 0 && buffer.length + piece.length > target) {
      flush();
    }
    buffer = buffer.length > 0 ? `${buffer}\n\n${piece}` : piece;
  }

  const tail = buffer.trim();
  if (tail.length > 0) {
    /*
     * The final buffer may be nothing but the overlap carried from the last
     * flush - a chunk that is entirely a duplicate of text already indexed.
     * Emitting it costs an embedding and adds a near-duplicate that competes
     * with its own original at retrieval time.
     */
    const isOnlyOverlap =
      chunks.length > 0 && chunks[chunks.length - 1]!.content.endsWith(tail);
    if (!isOnlyOverlap) {
      chunks.push({
        seq: chunks.length,
        content: tail,
        tokenCount: estimateTokens(tail),
      });
    }
  }

  return chunks;
}

/**
 * Normalise whitespace without destroying structure.
 *
 * Blank lines are the only paragraph signal a text extraction reliably keeps,
 * so they survive; everything else collapses. PDFs in particular arrive with
 * hard-wrapped lines, non-breaking spaces and form feeds, none of which mean
 * anything and all of which change the embedding.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/\f/g, "\n\n")
    /* Three or more newlines is still one paragraph break. */
    .replace(/\n{3,}/g, "\n\n")
    /* Trailing spaces before a newline, which hard-wrapped PDFs are full of. */
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Paragraphs, then over-long paragraphs by sentence, then by force. */
function splitToPieces(text: string, target: number): string[] {
  const out: string[] = [];

  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= target) {
      out.push(trimmed);
      continue;
    }

    let sentenceBuffer = "";
    for (const sentence of splitSentences(trimmed)) {
      if (sentence.length > target) {
        if (sentenceBuffer.trim().length > 0) {
          out.push(sentenceBuffer.trim());
          sentenceBuffer = "";
        }
        for (let i = 0; i < sentence.length; i += target) {
          out.push(sentence.slice(i, i + target));
        }
        continue;
      }
      if (sentenceBuffer.length + sentence.length > target) {
        out.push(sentenceBuffer.trim());
        sentenceBuffer = "";
      }
      sentenceBuffer += sentence;
    }
    if (sentenceBuffer.trim().length > 0) out.push(sentenceBuffer.trim());
  }

  return out;
}

/**
 * Sentence boundaries, approximately.
 *
 * Deliberately naive: a full stop, question mark or exclamation followed by
 * whitespace. It gets "Rs. 500" wrong and splits it, which costs a slightly
 * odd boundary inside a chunk that is about to be joined to its neighbour
 * anyway. A real sentence segmenter is a dependency and a language problem,
 * and this only ever runs on paragraphs already too long to keep whole.
 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => `${s} `);
}
