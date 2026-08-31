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
    "Upload a contact list and send an approved template to everyone on it.",
  "meta-ads":
    "Connect a Meta ad account to see your click-to-WhatsApp campaigns and match replies back to the ads that caused them.",
  configuration:
    "Connect your WhatsApp Business number, set business hours, and choose who is notified when a conversation needs a person.",
  inbox:
    "Replies from your contacts arrive here. Conversations Verse cannot answer are handed over with the history attached.",
  /* Two, because the tab changes what "empty" means: no templates at all, or
     none that came from Meta. Both are distinct from every other section and
     from each other, which is what the guard checks. */
  "template-messaging":
    "A template is a message Meta has approved in advance. You need one to reach somebody who has not written to you in the last 24 hours.",
  "template-messaging-library":
    "Sync to pull in any templates already on your WhatsApp Business Account, including ones made in Meta Business Manager.",
} as const;

export type EmptySection = keyof typeof EMPTY_COPY;
