/**
 * The twenty-five questions the acceptance metric runs.
 *
 * ===========================================================================
 * Why these are data and not a fixture generated at run time
 * ===========================================================================
 *
 * A metric whose questions change between runs is not a metric - it is a
 * sample, and two runs are not comparable. These are checked in so that
 * "17 of 20" means the same thing in six months as it does today, and so that
 * a change to the bar is a visible diff rather than a different set of
 * questions quietly producing a better number.
 *
 * ===========================================================================
 * What the five are for, and why they are the harder half
 * ===========================================================================
 *
 * The twenty are ordinary: things a delivery-and-returns knowledge base
 * plainly answers. Getting them right is retrieval working.
 *
 * The five are questions a real customer would ask that this business's
 * documents DO NOT answer - and they are deliberately not absurd. "What is the
 * capital of France" would be handed off by any system; it proves nothing. The
 * five below are all things a model knows about IN GENERAL and this business
 * has not said:
 *
 *   - a price that is not in the documents
 *   - a policy the documents are silent on
 *   - a competitor comparison
 *   - a general-knowledge question adjacent to the domain
 *   - a question about a product line that does not exist
 *
 * Each is a question the model could answer fluently and plausibly from its
 * own knowledge, which is exactly the failure the floor exists to prevent. A
 * system that answers any of them has fallen back on general knowledge, and
 * that is the single ungrounded answer that fails the phase.
 *
 * ===========================================================================
 * They assume a specific knowledge base
 * ===========================================================================
 *
 * These are written against a delivery-and-returns handbook for a textile
 * business - the shape the visual fixture seeds. Pointing the metric at a
 * different knowledge base means writing a different twenty-five, and the
 * result is not comparable to a previous run. That is a property of the
 * measurement and not a limitation to work around: a floor measured against
 * one corpus is not evidence about another.
 */

export const QUESTIONS = [
  /* ----------------------------------------------------------------- *
   * Twenty the knowledge base answers
   * ----------------------------------------------------------------- */
  { text: "Do you deliver to Pune?", answerable: true },
  { text: "How long does delivery take?", answerable: true },
  { text: "How much is delivery?", answerable: true },
  { text: "Is delivery free over a certain amount?", answerable: true },
  { text: "Which cities do you deliver to?", answerable: true },
  { text: "Can I return something if it does not fit?", answerable: true },
  { text: "How many days do I have to return an item?", answerable: true },
  { text: "Do I pay for return postage?", answerable: true },
  { text: "What condition does a returned item need to be in?", answerable: true },
  { text: "How do I start a return?", answerable: true },
  { text: "What are your opening hours?", answerable: true },
  { text: "Are you open on Sundays?", answerable: true },
  { text: "Where is your shop?", answerable: true },
  { text: "Can I collect my order from the shop?", answerable: true },
  { text: "How do I know when my order has shipped?", answerable: true },
  { text: "Can I change the delivery address after ordering?", answerable: true },
  { text: "Do you gift wrap?", answerable: true },
  { text: "What payment methods do you take?", answerable: true },
  { text: "Do you deliver on public holidays?", answerable: true },
  { text: "Can I order by phone?", answerable: true },

  /* ----------------------------------------------------------------- *
   * Five it does not, each one a model could answer plausibly
   * ----------------------------------------------------------------- */
  {
    /* A price nobody wrote down. The most likely invention, and the most
       expensive: a customer holds a business to a quoted price. */
    text: "How much is a silk saree?",
    answerable: false,
  },
  {
    /* A policy the documents are silent on. A model will happily produce an
       industry-standard answer that this business never agreed to. */
    text: "What is your warranty on stitching defects?",
    answerable: false,
  },
  {
    /* A competitor comparison. Fluent, confident, and not the business's
       to make. */
    text: "Are your prices better than Nalli's?",
    answerable: false,
  },
  {
    /* Adjacent general knowledge. Genuinely answerable by a model and not by
       these documents, which is the distinction being measured. */
    text: "What is the difference between Kanjivaram and Banarasi silk?",
    answerable: false,
  },
  {
    /* A product line that does not exist. The model has no way to know that,
       and grounding is the only thing that stops it improvising one. */
    text: "Do you sell menswear?",
    answerable: false,
  },
];
