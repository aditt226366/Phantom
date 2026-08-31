/**
 * What each section says before it has anything to show.
 *
 * ---------------------------------------------------------------------------
 * Here rather than inline, because the test that guards it had to grep
 * ---------------------------------------------------------------------------
 *
 * "A designed empty state, not a spinner" means the copy is the work, and
 * `shell.test.ts` exists to stop six sections quietly converging on one shared
 * sentence. It did that by reading each page's source for `description="..."`,
 * which worked for exactly as long as every description was a string literal.
 *
 * Template Messaging now has two — one per tab — so the description became a
 * JSX expression and the regex found nothing. The test failed, and it was
 * right to: it could no longer see what it was checking.
 *
 * The conventions file names this exact failure ("a source-level assertion must
 * parse, not grep" / "assert a value, not a substring"), so the fix is the one
 * it prescribes rather than a cleverer regex. The copy is a value now, the
 * pages read it from here, and the test imports it and compares strings. A
 * seventh section sharing a sentence is a failing equality rather than a
 * pattern that happens to still match.
 */

export const EMPTY_COPY = {
  "ai-messaging":
    "A campaign sends an approved template to your leads, then lets Verse answer their replies from your knowledge base.",
  "bulk-messaging":
    "Upload a CSV of contacts, map its columns to an approved template, and see exactly who will be messaged before anything goes out.",
  "meta-ads":
    "Connect a Meta ad account to see your click-to-WhatsApp campaigns and match replies back to the ads that caused them.",
  configuration:
    "Connect your WhatsApp Business number, set business hours, and choose who is notified when a conversation needs a person.",
  inbox:
    "Replies from your contacts arrive here. Conversations Verse cannot answer are handed over with the history attached.",
  /* Two, because the tab changes what "empty" means: no templates at all, or
     none that came from Meta. Both are distinct from every other section and
     from each other, which is what the guard checks.

     Keyed by path rather than by section name since the Studio moved: the
     guard resolves a key to app/(app)/<key>/page.tsx, so the key IS the route
     and a stale one fails rather than quietly checking nothing.

     A "#variant" suffix marks a second copy for the same page. It used to be
     a "-library" suffix the guard stripped, which worked for exactly one
     variant and would have silently mis-resolved a route that genuinely ended
     in those characters. The marker cannot appear in a path, so splitting on
     it is unambiguous. */
  "configuration/templates":
    "A template is a message Meta has approved in advance. You need one to reach somebody who has not written to you in the last 24 hours.",
  "configuration/templates#library":
    "Sync to pull in any templates already on your WhatsApp Business Account, including ones made in Meta Business Manager.",
  /* The section A1 reserves for the flow builder. Not the Studio, which now
     lives in Configuration - this describes what is actually coming. */
  "template-messaging":
    "A flow is a decision tree built from WhatsApp's reply buttons and lists, where every branch is a rule somebody drew rather than a model's guess.",
  /* The inbox's two views. The default is threads a customer has written in;
     the second is every thread, including the one-way ones a broadcast makes. */
  "inbox#all":
    "No conversations at all yet, including any a broadcast started. Threads appear here the moment a message goes out or arrives.",
} as const;

export type EmptySection = keyof typeof EMPTY_COPY;
