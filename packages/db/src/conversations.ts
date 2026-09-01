import { canUseFeatures } from "@whatsapp-os/core/kyc";
import {
  describeWindow,
  sendPolicy,
  statusFromMeta,
  statusesBelow,
  type SendDecision,
  type SendIntent,
  type WindowState,
} from "@whatsapp-os/core/whatsapp";
import { currentKycStatuses } from "./kyc.ts";
import type { CompanyClient } from "./with-company.ts";

/**
 * What a conversation's state allows, and how that state is allowed to move.
 *
 * Three things live here because they are one problem seen three times: facts
 * about a thread arrive out of order, and each must be applied in a way that
 * cannot walk backwards.
 *
 *   canSend             reads the facts the send path decides on
 *   advanceConversation moves the window forward, never back
 *   applyStatusUpdate   moves a message up the ladder, never down
 *
 * The decision itself is not here. sendPolicy() in @whatsapp-os/core takes
 * facts and returns a verdict with no I/O, which is what lets the composer and
 * the worker reach the same answer from different places. This file fetches.
 */

/* ------------------------------------------------------------------------- *
 * canSend
 * ------------------------------------------------------------------------- */

export interface Sendability {
  conversationId: string;
  /** For the composer's "3 hours left", and for the disabled template picker. */
  window: WindowState;
  decision: SendDecision;
  /** Meta's id for the number this thread is on. What the Graph call posts to. */
  phoneNumberId: string;
  /** The contact's wa_id. What the Graph call addresses. */
  waId: string;
}

/**
 * Whether this conversation can be sent to, and what it would be sent through.
 *
 * Null when the conversation is not visible in this scope. Not a throw, and not
 * a refusal carrying a reason: rule 6 - a thread that is not yours does not
 * exist, and the caller renders 404. A "you may not send to this" verdict would
 * confirm the id.
 *
 * `now` is a parameter rather than read from the clock, for the reason
 * describeWindow gives and one more: the worker has to decide the window and
 * the verdict at a single instant, or a thread can be open for the check and
 * closed for the send.
 *
 * The target comes back whatever the verdict is. The worker needs it to make
 * the call and the failure path needs it to explain itself, and re-reading the
 * row would be a second borrow of a pooled connection on the send path.
 */
export async function canSend(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
  intent: SendIntent,
  now: Date,
): Promise<Sendability | null> {
  /*
   * One statement for every fact sendPolicy needs. This runs inside withCompany
   * immediately before a Graph call, so each extra round trip is time on a
   * connection the transaction is already holding.
   *
   * findFirst rather than findUnique: the extension merges companyId - a
   * non-unique column - into `where`, which findUnique's where type does not
   * accept. Same primary-key plan either way.
   *
   * company.deactivatedAt is read through the relation rather than in a second
   * query, and it has to be read at all because resolution deliberately does
   * not check it (correction C2). A suspended workspace resolves, receives, and
   * is refused here.
   */
  const row = await db.conversation.findFirst({
    where: { id: conversationId },
    select: {
      id: true,
      windowExpiresAt: true,
      contact: { select: { waId: true, optedOutAt: true, undeliverableAt: true } },
      whatsappNumber: { select: { phoneNumberId: true, status: true } },
      company: { select: { deactivatedAt: true } },
    },
  });

  if (!row) return null;

  const window = describeWindow(row.windowExpiresAt, now);

  /*
   * A4: the send path inherits the feature gate rather than restating it.
   *
   * canUseFeatures is the owner, and it is called here rather than having
   * sendPolicy grow its own notion of verification - the composer, this
   * function, the worker and every blocked page then agree by construction. A
   * send path with a second opinion about whether a company is verified is how
   * a tenant ends up blocked from six sections and able to message customers
   * from the seventh.
   *
   * Read here, per call, and never cached: an approval can be revoked while a
   * worker is draining a queue, and the next message must be refused.
   *
   * It runs before sendPolicy because it outranks every reason sendPolicy has.
   * An unverified company being told "the 24-hour window has closed, send a
   * template" would be advice toward a feature that is also shut.
   */
  const access = canUseFeatures({
    companyDeactivated: row.company.deactivatedAt !== null,
    documents: await currentKycStatuses(db, companyId),
  });

  if (!access.allowed) {
    /*
     * Flattened to one code deliberately. Which document is outstanding is a
     * question for Profile > Documents, which shows all three with their own
     * reasons; on a failed message bubble it would be an instruction the
     * sender usually cannot act on - the person composing is often not the
     * person who files the paperwork.
     *
     * The exception is a suspended workspace, which keeps its own long-
     * standing refusal: it is not a KYC problem and reporting it as one would
     * send an operator looking for a document that is already approved.
     */
    return {
      conversationId: row.id,
      window,
      decision: {
        allowed: false,
        reason:
          access.reason === "company_deactivated"
            ? "company_deactivated"
            : "company_not_verified",
      },
      phoneNumberId: row.whatsappNumber.phoneNumberId,
      waId: row.contact.waId,
    };
  }

  return {
    conversationId: row.id,
    window,
    decision: sendPolicy(
      {
        window,
        numberStatus: row.whatsappNumber.status,
        companyDeactivated: row.company.deactivatedAt !== null,
        contactOptedOut: row.contact.optedOutAt !== null,
        /*
         * Read here so the send path refuses a dead handset for its own
         * reason. Bulk filters these at import too, and this is the check that
         * is true at the moment the message would actually go - a contact can
         * be marked undeliverable by an earlier recipient of the same run.
         */
        contactUndeliverable: row.contact.undeliverableAt !== null,
      },
      intent,
    ),
    phoneNumberId: row.whatsappNumber.phoneNumberId,
    waId: row.contact.waId,
  };
}

/* ------------------------------------------------------------------------- *
 * The window advance
 * ------------------------------------------------------------------------- */

export interface ConversationActivity {
  /** Meta's timestamp for an inbound message; ours for an outbound one. */
  occurredAt: Date;
  /** The denormalised preview. Applied only if this is the newest message. */
  preview: string | null;
  /** Whether the customer sent it. Only an inbound message moves last_inbound_at. */
  inbound: boolean;
  /**
   * When free-form messaging stops being allowed, or null to leave the window
   * as it is. Computed by the caller - windowExpiryFor() for the ordinary
   * 24-hour case - because the rule is not always last_inbound_at + 24h.
   */
  windowExpiresAt: Date | null;
  /** How much to add to the unread count. 1 for an unread inbound, 0 otherwise. */
  unread: number;
}

/**
 * Apply one message's effect to its conversation, in one statement.
 *
 * ---------------------------------------------------------------------------
 * Why this is raw SQL, and what that buys
 * ---------------------------------------------------------------------------
 *
 * Four columns, three rules, and they disagree about ordering:
 *
 *   window_expires_at     GREATEST - never assignment (risk R1)
 *   last_inbound_at,
 *   last_message_at       GREATEST
 *   last_message_preview  only when this message is the newest one seen
 *   unread_count          always +1, whatever order they arrived in
 *
 * GREATEST has no query-builder form, so the ORM version is three conditional
 * updateMany calls carrying three separately-written "newer wins" guards. The
 * one somebody eventually gets wrong is the one that moves the window backwards
 * and closes a composer while the window is genuinely open - R1 exactly - and
 * it would be wrong only for out-of-order deliveries, which is to say only in
 * production and only sometimes.
 *
 * The stronger half of the argument is atomicity rather than the round trips.
 * Three statements have two gaps in them, and this path has two writers -
 * concurrent webhook deliveries for the same thread - that interleave in those
 * gaps. Message B advancing last_message_at between A's preview guard and A's
 * preview write leaves the newest timestamp beside the older message's text,
 * and the inbox then shows a preview the customer never sent last. A single
 * UPDATE takes one row lock and evaluates every guard against the same tuple,
 * so concurrent deliveries serialise on the row instead of racing inside it.
 * Wrapping the three in a transaction does not fix it: these are writes, so the
 * gap is between statements, not between transactions.
 *
 * Comparing against the stored value rather than reading it first is also what
 * keeps this safe under Prisma's 5s transaction timeout - there is no read to
 * go stale.
 *
 * The company_id predicate is redundant beside the RLS policy and is written
 * anyway (R3). Raw SQL bypasses the extension's where-merging entirely, so the
 * policy is otherwise the only thing between this statement and another
 * company's row.
 *
 * Measured, not assumed: deleting that predicate fails nothing. The isolation
 * test still reports zero rows affected, because the policy is the boundary and
 * is doing the work. It stays for the case the test cannot cover - a future
 * migration that drops or narrows the policy, where the statement would
 * otherwise reach every company's conversations and look exactly as it does
 * now. Recorded here rather than chased, so the next person to notice it is
 * redundant knows it has already been checked.
 */
export async function advanceConversation(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
  activity: ConversationActivity,
): Promise<void> {
  /*
   * Dates are bound directly and now() is used bare, both of which are only
   * safe because every timestamp column in this schema is timestamptz(3).
   *
   * They were not, until 20260816090000. Prisma's default mapping is
   * timestamp(3) WITHOUT time zone, which stores wall-clock digits with no
   * offset - so binding a Date and casting ::timestamp kept the digits, dropped
   * the offset, and wrote a value out by the node process's UTC offset. This
   * statement carried an explicit `::timestamptz AT TIME ZONE 'UTC'` on every
   * value to work around it. A timestamptz column stores an instant instead,
   * and there is no wall clock left to misread.
   *
   * If a `timestamp without time zone` column ever reappears, the casts have to
   * come back with it - which is what timestamp-columns.test.ts is there to
   * prevent, with an allowlist that is empty and meant to stay that way.
   */
  await db.$executeRaw`
    UPDATE conversations
       SET last_message_at = GREATEST(last_message_at, ${activity.occurredAt}),
           last_inbound_at =
             CASE WHEN ${activity.inbound}
                  THEN GREATEST(last_inbound_at, ${activity.occurredAt})
                  ELSE last_inbound_at
             END,
           window_expires_at =
             GREATEST(window_expires_at, ${activity.windowExpiresAt}),
           last_message_preview =
             CASE WHEN last_message_at IS NULL
                    OR last_message_at <= ${activity.occurredAt}
                  THEN ${activity.preview}
                  ELSE last_message_preview
             END,
           unread_count = unread_count + ${activity.unread},
           updated_at = now()
     WHERE id = ${conversationId}
       AND company_id = ${companyId}
  `;
}

/*
 * GREATEST and NULL, because the behaviour is the opposite of most of SQL and
 * the design leans on it: GREATEST ignores NULL arguments and returns NULL only
 * when every argument is NULL.
 *
 * So a first inbound message on a thread that has no window sets one, and a
 * null windowExpiresAt - outbound activity - leaves an existing window
 * untouched rather than erasing it. Neither case needs a branch. A bare
 * comparison would need both, and would get the first one wrong.
 */

/* ------------------------------------------------------------------------- *
 * The status ladder, applied
 * ------------------------------------------------------------------------- */

export type StatusOutcome =
  /** The row moved up the ladder. */
  | "advanced"
  /** Already at or above this status. Meta redelivered, or reordered. */
  | "stale"
  /** A status string this build does not rank. Nothing was written. */
  | "unknown_status"
  /** No message with that wamid in this company. */
  | "no_such_message";

export interface StatusUpdateInput {
  wamid: string;
  /** Meta's status string, verbatim. An unrecognised value is not an error. */
  status: string;
  occurredAt: Date;
  /** Meta's own error, on a failed status. */
  error?: { code: number | null; title: string | null };
}

/**
 * Move a message to `status`, if and only if that is forward.
 *
 * The comparison is inside the UPDATE because it has to be - status.ts sets out
 * why at length, and the short version is that reading the row, comparing in
 * JavaScript and writing back loses the race it exists to handle. Two workers
 * holding "delivered" and "read" for the same message is the common case rather
 * than the exotic one: a message read on arrival produces both within a second.
 *
 * `status: { in: statusesBelow(next) }` is the ANY(...) list status.ts
 * specifies, written in the query builder. It compiles to one statement with
 * the guard in its WHERE clause, which is the property that matters, so raw SQL
 * would buy nothing here and is not used.
 *
 * The timestamps ride along in the same statement, so delivered_at can only be
 * stamped by an update that was itself allowed to move. They cannot come to
 * disagree with the status they describe.
 */
export async function applyStatusUpdate(
  db: CompanyClient,
  companyId: string,
  input: StatusUpdateInput,
): Promise<StatusOutcome> {
  const next = statusFromMeta(input.status);

  /*
   * Unranked means leave it alone, and it is not an error - Meta has shipped
   * new status strings before, and the raw value survives in
   * whatsapp_webhook_events.payload. Returning before the write also keeps an
   * unknown status from touching updated_at.
   */
  if (next === null) return "unknown_status";

  const { count } = await db.message.updateMany({
    where: { wamid: input.wamid, status: { in: [...statusesBelow(next)] } },
    data: {
      status: next,
      /* undefined leaves the column alone; only the arriving status stamps. */
      deliveredAt: next === "DELIVERED" ? input.occurredAt : undefined,
      readAt: next === "READ" ? input.occurredAt : undefined,
      failedAt: next === "FAILED" ? input.occurredAt : undefined,
      /*
       * Only on a failure, and only in Meta's namespace. error_source is what
       * keeps this apart from a POLICY refusal written by the send path, so a
       * support reply never quotes a Graph code Meta did not issue.
       */
      errorSource: next === "FAILED" ? "META" : undefined,
      errorCode: next === "FAILED" ? (input.error?.code ?? null) : undefined,
      errorTitle: next === "FAILED" ? (input.error?.title ?? null) : undefined,
    },
  });

  if (count > 0) return "advanced";

  /*
   * Zero rows conflates two facts the caller needs apart: "already at or above
   * this" is ordinary Meta redelivery, while "we have no such message" means a
   * status arrived for something we never sent - a message sent from Business
   * Manager, or a row that went missing - which is worth recording as a skipped
   * reason rather than counting as routine.
   *
   * The extra read happens only on the paths that did not advance. The common
   * case stays one statement.
   *
   * -------------------------------------------------------------------------
   * no_such_message DROPS the callback, and that is a decision (C7)
   * -------------------------------------------------------------------------
   *
   * Nothing redelivers a webhook we answered 200 to, so a status that lands
   * here is gone. Including the one case that looks alarming: Meta can deliver
   * `sent` for a wamid before the send job has finished storing it.
   *
   * It was weighed against a small orphan_statuses table, keyed on
   * (company_id, wamid) and drained by the send worker after it writes the
   * wamid. Rejected, for reasons that hold only as long as this stays true:
   *
   *   THE SEND WORKER WRITES SENT (or HELD) FROM THE GRAPH RESPONSE ITSELF,
   *   in the same update that stores the wamid.
   *
   * That is what makes a lost `sent` redundant rather than load-bearing - the
   * status floor comes from the response, not from the callback, so no message
   * is left reading PENDING for ever. What a lost callback can still cost is a
   * DELIVERED or READ, leaving the ticks grey on a message that arrived; that
   * needs the whole webhook chain to beat an UPDATE already in flight, and a
   * later `read` rescues the thread anyway because the ladder is monotonic.
   *
   * The table was also not the tidy option it appears to be. Most of what
   * arrives here is a wamid that will never be ours - somebody replying from
   * Business Manager - and nothing drains those, so it would need a retention
   * job on day one and an extra read on the send path to claim the rest.
   *
   * If the send worker ever stops setting the status from the response, this
   * reasoning is void and the orphan table becomes the right answer. Every
   * occurrence is counted as status_no_such_message on the webhook event and
   * surfaces on the admin Overview, so the assumption is measured rather than
   * trusted.
   */
  const existing = await db.message.findFirst({
    where: { wamid: input.wamid },
    select: { id: true },
  });

  return existing ? "stale" : "no_such_message";
}

/* ------------------------------------------------------------------------- *
 * Read receipts
 * ------------------------------------------------------------------------- */

export interface ReadReceiptTarget {
  /**
   * Our row id for the newest inbound message, and the dedupe key.
   *
   * Ours rather than Meta's wamid because it is what the enqueue site already
   * has in hand, and because it is stable - a wamid is Meta's identifier for a
   * message and there is exactly one per inbound row anyway, so either would
   * dedupe correctly. This one needs no second lookup.
   */
  messageId: string;
  /** What the mark-read call addresses. Meta marks everything before it too. */
  wamid: string;
  /**
   * How many were unread when the reader looked.
   *
   * The number they saw, and the number the badge is decremented by - which is
   * what makes the reset order-independent. See markConversationRead.
   */
  unreadCount: number;
}

/**
 * What opening this thread should tell Meta, or null if it should tell it
 * nothing.
 *
 * ---------------------------------------------------------------------------
 * Only the newest inbound message matters
 * ---------------------------------------------------------------------------
 *
 * Marking one message read marks every earlier one read with it - that is
 * Meta's behaviour, not an assumption - so a thread with forty unread messages
 * is one call naming the last of them, never forty.
 *
 * ---------------------------------------------------------------------------
 * Null is the common answer, and it is what stops the duplicate POSTs
 * ---------------------------------------------------------------------------
 *
 * Null when there is nothing unread, or nothing inbound, or the newest inbound
 * message has no wamid to name. The unread count is the test that matters:
 * opening a thread that is already read is the ordinary case - people re-open
 * threads constantly - and it must enqueue nothing at all rather than enqueue a
 * job that discovers there is nothing to do.
 *
 * The same check serves the worker on a retry. If the POST succeeded and the
 * reset succeeded, a second attempt finds the count at zero and does nothing;
 * if the POST succeeded and the reset did not, the count is still up and the
 * retry re-sends a call Meta treats as idempotent, then resets.
 */
export async function readReceiptTarget(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
): Promise<ReadReceiptTarget | null> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId },
    select: { unreadCount: true, lastMessageAt: true },
  });

  if (!conversation || conversation.unreadCount === 0) return null;
  if (!conversation.lastMessageAt) return null;

  const newest = await db.message.findFirst({
    where: { conversationId, direction: "INBOUND", wamid: { not: null } },
    /* The thread's own ordering, tie-broken the same way, so "newest" here and
       "last" in the thread cannot disagree. */
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { id: true, wamid: true },
  });

  if (!newest?.wamid) return null;

  return {
    messageId: newest.id,
    wamid: newest.wamid,
    unreadCount: conversation.unreadCount,
  };
}

/**
 * Subtract what the reader saw, never assign.
 *
 * ---------------------------------------------------------------------------
 * Relative, for the same reason the window uses GREATEST
 * ---------------------------------------------------------------------------
 *
 * `unread_count = 0` is a read-modify-write with the read in the operator's
 * head: they opened a thread showing three unread, and by the time the receipt
 * has been sent and the reset runs, a fourth may have arrived. Assigning zero
 * drops that message's badge silently - the thread looks read, nobody is told,
 * and the customer waits.
 *
 * Subtracting the number they actually saw is correct in every ordering,
 * without a predicate to get right:
 *
 *   nothing arrived meanwhile      N - N     = 0
 *   two arrived meanwhile          N + 2 - N = 2
 *   one arrived OUT OF ORDER       N + 1 - N = 1
 *
 * The third is the one a timestamp guard cannot do. Meta redelivers late, and a
 * message with an older occurred_at increments the count without moving
 * last_message_at, because that column advances with GREATEST - so
 * `WHERE last_message_at <= seen` would pass and clear a badge nobody saw.
 * A decrement does not care what order they arrived in, which is why there is
 * no WHERE clause here beyond identity.
 *
 * It also removes a milder wrong answer the predicate had: our own outbound
 * reply moves last_message_at too, so replying in that same moment used to
 * block the reset and leave the badge up for one more open. Nothing about a
 * reply changes how many unread messages the reader saw.
 *
 * ---------------------------------------------------------------------------
 * What GREATEST(0, ...) is for
 * ---------------------------------------------------------------------------
 *
 * One hazard remains: a job that failed AFTER this applied, then retried, would
 * subtract the same N twice. It is already bounded - readReceiptTarget returns
 * null at zero, so the second attempt normally never gets here - but "normally"
 * is doing work in that sentence, and a negative badge is a rendering bug that
 * outlives the cause.
 *
 * The clamp is the whole mitigation, deliberately. The alternative is a column
 * recording which receipt was last applied, read through on every open, and
 * that is a schema change and a second writer to keep honest for a case whose
 * only symptom is a number that should not go below zero.
 *
 * Raw SQL because GREATEST has no query-builder form - the same reason
 * advanceConversation is raw, in the same already-sanctioned file. The
 * company_id predicate is redundant beside the policy and written anyway (R3).
 */
export async function markConversationRead(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
  seen: number,
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ unread_count: number }>>`
    UPDATE conversations
       SET unread_count = GREATEST(0, unread_count - ${seen}),
           updated_at = now()
     WHERE id = ${conversationId}
       AND company_id = ${companyId}
    RETURNING unread_count
  `;

  /* No row means the thread is not visible in this scope. Nothing was cleared
     and nothing remains to report. */
  return rows[0]?.unread_count ?? 0;
}

/* ------------------------------------------------------------------------- *
 * "A person is needed here"
 * ------------------------------------------------------------------------- */

/**
 * Flag a thread for a person, with the reason they will read.
 *
 * ---------------------------------------------------------------------------
 * Why this is a state and not a derivation any more
 * ---------------------------------------------------------------------------
 *
 * Phase 5 derived it - `assigned_user_id IS NULL AND unread_count > 0` - and
 * that was right while a customer writing in was the only way a thread came to
 * need somebody. A flow's handoff node is a proactive claim: the automation has
 * decided it cannot finish, which is true whether or not anybody has read the
 * thread and whether or not a reply is owed.
 *
 * The handoff originally faked those inputs by incrementing unread_count. That
 * lies about what the column means, and markConversationRead undoes it - so
 * opening the thread to find out why a person was wanted destroyed the only
 * record that one was.
 *
 * ---------------------------------------------------------------------------
 * The instant does not move once it is set
 * ---------------------------------------------------------------------------
 *
 * `needs_human_at` is what the queue sorts on, oldest first, so re-flagging an
 * already-flagged thread must not send it to the back. A customer who taps
 * through three branches into a second handoff has been waiting since the
 * first one, and that is the number the person picking work up needs.
 *
 * The reason is updated, because the newest one is the most useful sentence -
 * but the clock keeps running from when the thread first needed somebody.
 */
export async function flagNeedsHuman(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
  input: { reason: string; at: Date },
): Promise<void> {
  await db.$executeRaw`
    UPDATE conversations
       SET needs_human_at = COALESCE(needs_human_at, ${input.at}),
           needs_human_reason = ${input.reason},
           updated_at = now()
     WHERE id = ${conversationId}
       AND company_id = ${companyId}
  `;
}

/**
 * Somebody has taken the thread.
 *
 * Both columns together, because the CHECK requires them to agree - a reason
 * left behind on an unflagged thread is a sentence that would be shown the
 * next time it IS flagged, for something that has nothing to do with why.
 *
 * Deliberately NOT called by anything that merely reads. Opening a thread is
 * how somebody finds out whether they want it, and a flag that cleared on
 * being looked at is the bug this column was added to fix.
 */
export async function clearNeedsHuman(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
): Promise<void> {
  /*
   * The query builder, unlike its counterpart above.
   *
   * flagNeedsHuman needs raw SQL for one reason - COALESCE, so that re-flagging
   * cannot move the instant a queue sorts on - and this has no such need. An
   * unnecessary raw statement in a file the allowlist happens to permit is
   * exactly the drift that rule exists to stop: the list is per file, and the
   * justification is per statement.
   *
   * updateMany rather than update, because the extension merges companyId into
   * `where` and update's where type accepts only a unique.
   */
  await db.conversation.updateMany({
    where: { id: conversationId, companyId },
    data: { needsHumanAt: null, needsHumanReason: null },
  });
}

/* ------------------------------------------------------------------------- *
 * Who is driving this conversation
 * ------------------------------------------------------------------------- */

export type ConversationDriver = "NOBODY" | "OPERATOR" | "FLOW" | "VERSE";

export type DriverClaim =
  /** The claim succeeded. `displaced` is who was driving before. */
  | { kind: "claimed"; displaced: ConversationDriver; displacedRef: string | null }
  /**
   * Another automation is already here, and this one will not push it aside.
   *
   * The whole point of the type. See below - an automation displacing another
   * automation is the failure this column exists to make impossible.
   */
  | { kind: "refused"; heldBy: ConversationDriver; heldRef: string | null }
  /** Not visible in this scope. Rule 6: it does not exist. */
  | { kind: "gone" };

/**
 * Take over a conversation, or refuse to.
 *
 * ---------------------------------------------------------------------------
 * The rule, and why it is not "last writer wins"
 * ---------------------------------------------------------------------------
 *
 * A PERSON DISPLACES ANYTHING. AN AUTOMATION NEVER DISPLACES ANOTHER
 * AUTOMATION.
 *
 * Both halves are load-bearing and they are asymmetric on purpose.
 *
 * The first half is what Phase 8 already established: an operator replying in a
 * thread hands off any live flow run, because a person has read the
 * conversation and decided to answer it. Nothing an automation is part-way
 * through is worth more than that.
 *
 * The second half is new here, and it is the reason this is a column rather
 * than a convention. A lead source enrolling somebody in a Verse campaign, on a
 * conversation where a flow run is standing waiting for a button tap, is two
 * automations writing into one thread on independent schedules. Whichever wrote
 * last would "win" only in the sense of writing last: the other one is still
 * live, still holds its position, and still speaks when its own timer or its
 * own webhook says to. The customer sees a business asking them two unrelated
 * questions and answering neither.
 *
 * Refusing is the correct outcome and not a limitation. A contact already in a
 * conversation is not a good candidate for a cold campaign opener, so declining
 * to enrol them loses nothing that was worth having - and the caller records
 * the skip with its reason, which is a fact somebody can act on rather than a
 * silent overwrite.
 *
 * ---------------------------------------------------------------------------
 * One statement, because the read and the write cannot be separated
 * ---------------------------------------------------------------------------
 *
 * Reading the driver, deciding in JavaScript and writing back is a
 * read-modify-write with a gap in it, and this path genuinely has concurrent
 * writers - a campaign worker and a webhook-driven flow advance can reach the
 * same row at the same instant. Both would read NOBODY and both would claim.
 *
 * So the guard is in the WHERE clause, evaluated against one locked tuple, the
 * same argument advanceConversation makes at greater length. The CTE reads the
 * prior value under FOR UPDATE so the caller learns what it displaced - which
 * the operator path needs, because displacing a FLOW means a run has to be
 * handed off and displacing NOBODY does not.
 *
 * Re-claiming with the same driver and the same ref is idempotent and does NOT
 * move driver_since: a campaign that sends a second message must not look like
 * it arrived twice, and a queue sorted on that instant would reorder under it.
 * The same reasoning as flagNeedsHuman's COALESCE.
 */
export async function claimDriver(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
  input: { driver: Exclude<ConversationDriver, "NOBODY">; ref: string | null; at: Date },
): Promise<DriverClaim> {
  const rows = await db.$queryRaw<
    Array<{
      prev: ConversationDriver;
      prev_ref: string | null;
      changed: boolean;
    }>
  >`
    WITH locked AS (
      SELECT id, driver AS prev, driver_ref AS prev_ref
        FROM conversations
       WHERE id = ${conversationId} AND company_id = ${companyId}
       FOR UPDATE
    ), updated AS (
      UPDATE conversations c
         SET driver = ${input.driver}::conversation_driver,
             driver_since =
               CASE WHEN c.driver = ${input.driver}::conversation_driver
                     AND c.driver_ref IS NOT DISTINCT FROM ${input.ref}
                    THEN c.driver_since
                    ELSE ${input.at}
               END,
             driver_ref = ${input.ref},
             updated_at = now()
        FROM locked l
       WHERE c.id = l.id
         AND (
           /* A person outranks every automation. */
           ${input.driver}::conversation_driver = 'OPERATOR'
           /* Nobody is here. */
           OR l.prev = 'NOBODY'
           /* Already ours: idempotent re-claim. */
           OR (l.prev = ${input.driver}::conversation_driver
               AND l.prev_ref IS NOT DISTINCT FROM ${input.ref})
         )
      RETURNING c.id
    )
    SELECT l.prev,
           l.prev_ref,
           EXISTS (SELECT 1 FROM updated) AS changed
      FROM locked l
  `;

  const row = rows[0];
  if (!row) return { kind: "gone" };

  if (!row.changed) {
    return { kind: "refused", heldBy: row.prev, heldRef: row.prev_ref };
  }

  return { kind: "claimed", displaced: row.prev, displacedRef: row.prev_ref };
}

/**
 * Nobody is driving any more.
 *
 * Unconditional, and deliberately so: this is called when a run ends, a
 * campaign finishes with a contact, or an operator closes a thread, and in
 * every one of those the caller already knows it owns the conversation. A
 * conditional release would leave a thread stuck under a driver that has gone
 * away, which is worse than a release that was not strictly necessary.
 *
 * The query builder rather than raw SQL: there is no GREATEST, no COALESCE and
 * no lock to take, and an unnecessary raw statement in an allowlisted file is
 * exactly the drift that rule exists to stop. Both columns together, because
 * the CHECK requires them to agree.
 */
export async function releaseDriver(
  db: CompanyClient,
  companyId: string,
  conversationId: string,
): Promise<void> {
  await db.conversation.updateMany({
    where: { id: conversationId, companyId },
    data: { driver: "NOBODY", driverSince: null, driverRef: null },
  });
}
