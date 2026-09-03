import type { CompanyClient } from "./with-company.ts";
import { Prisma } from "./generated/prisma/client.ts";

/**
 * The dashboard's reads: one rolled-up row, and four live seeks.
 *
 * ---------------------------------------------------------------------------
 * Why this file holds raw SQL, and what would be worse
 * ---------------------------------------------------------------------------
 *
 * The refresh is one statement. Through the query builder it is nineteen: a
 * count per direction, a count per member of the delivery ladder, a grouped
 * scan for the source distribution, two grouped scans to work out who replied,
 * a sum per currency, and a count of the unpriced. Every one of them is a
 * separate round trip and a separate pass over messages - the table this phase
 * exists to stop scanning - and the nineteen do not see the same instant, so
 * the computed_at stamped over them would be a claim none of the figures
 * individually supports.
 *
 * One statement with FILTER clauses reads messages once, conversations once,
 * contacts once and usage_events once, inside one snapshot. That is the whole
 * reason for the raw SQL, and it is why the CHECK constraints in
 * 20260905090000 assert the partitions rather than trusting the FILTERs.
 *
 * The statement writes company_id from `app_current_company()` rather than from
 * a bound parameter. It is inside withCompany, so the two would agree - but
 * taking it from the transaction-local setting means they *cannot* disagree,
 * and the row's tenancy comes from the same place RLS reads it from.
 *
 * Everything else in this file goes through the query builder, and the time
 * bounds every one of them binds are computed in TypeScript rather than written
 * as `now()`. NOT for the planner reason usually given: `now()` is STABLE, so
 * Postgres 17 folds it while planning and estimates from the histogram exactly
 * as it would a parameter. Measured identical at 50,000 AND at 200,000 rows -
 * the second because a bad estimate only changes the chosen plan once the table
 * is large enough - with a `clock_timestamp()` control proving the measurement
 * can see the effect when it is genuinely there. `npm run db:explain:dashboard`
 * prints all of it.
 *
 * The reasons are the platform day having no SQL form, the tests needing a
 * fixed instant, and `computed_at` having to exist outside the statement that
 * used it. See the header of @whatsapp-os/core/dashboard.
 */

/* ------------------------------------------------------------------------- *
   The rollup
   ------------------------------------------------------------------------- */

/**
 * Recompute one company's rollup.
 *
 * Takes its instants rather than reading a clock, for two reasons. The bounds
 * are bound parameters, which is what lets the planner use an index on
 * usage_events and conversations. And a test can hand it a fixed day boundary
 * and assert an exact count, which is the only way the platform-day arithmetic
 * is checkable at all.
 *
 * Returns nothing. The caller that wants the figures reads them back, which
 * keeps this a write and keeps the read path identical for the worker and the
 * page.
 */
export async function refreshDashboardRollup(
  db: CompanyClient,
  bounds: { computedAt: Date; dayStart: Date; monthStart: Date },
): Promise<void> {
  await db.$executeRaw`
    WITH msg AS (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE direction = 'INBOUND')::int  AS inbound,
        count(*) FILTER (WHERE direction = 'OUTBOUND')::int AS outbound,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'PENDING')::int     AS pending,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'UNCONFIRMED')::int AS unconfirmed,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'HELD')::int        AS held,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'SENT')::int        AS sent,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'FAILED')::int      AS failed,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'DELIVERED')::int   AS delivered,
        count(*) FILTER (WHERE direction = 'OUTBOUND' AND status = 'READ')::int        AS "read"
      FROM messages
    ),
    /*
     * Why the failure key is a COALESCE of three things.
     *
     * error_code is Meta's, and the only one the grouping in
     * summariseFailures can classify. A POLICY failure is our own refusal and
     * carries no code, so it keys on its source instead and lands in "other".
     * A failure with neither - which the schema permits and nothing writes
     * today - keys on UNKNOWN rather than being dropped, because a breakdown
     * whose total disagrees with the failed count beside it reads as an
     * arithmetic bug in the page.
     */
    fail AS (
      SELECT coalesce(jsonb_object_agg(key, n), '{}'::jsonb) AS by_code
      FROM (
        SELECT
          coalesce(error_code::text, error_source::text, 'UNKNOWN') AS key,
          count(*)::int AS n
        FROM messages
        WHERE direction = 'OUTBOUND' AND status = 'FAILED'
        GROUP BY 1
      ) grouped
    ),
    /*
     * Who replied, per thread.
     *
     * The newest inbound against the OLDEST outbound, and the asymmetry is
     * deliberate. A thread the customer started, that we then answered, is not
     * the customer replying to us - comparing against the newest outbound would
     * count it as one. Comparing against the first message the business ever
     * sent asks the question that was meant: did they write to us after we
     * wrote to them.
     */
    threads AS (
      SELECT
        count(*) FILTER (WHERE first_out IS NOT NULL)::int AS messaged,
        count(*) FILTER (WHERE first_out IS NOT NULL AND last_in > first_out)::int AS replied
      FROM (
        SELECT
          conversation_id,
          min(occurred_at) FILTER (WHERE direction = 'OUTBOUND') AS first_out,
          max(occurred_at) FILTER (WHERE direction = 'INBOUND')  AS last_in
        FROM messages
        GROUP BY conversation_id
      ) per_thread
    ),
    conv AS (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE created_at >= ${bounds.dayStart})::int AS new_today
      FROM conversations
    ),
    conv_source AS (
      SELECT coalesce(jsonb_object_agg(source, n), '{}'::jsonb) AS by_source
      FROM (
        SELECT source::text AS source, count(*)::int AS n
        FROM conversations
        GROUP BY 1
      ) grouped
    ),
    contact AS (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE created_at >= ${bounds.dayStart})::int AS new_today
      FROM contacts
    ),
    /*
     * Lead temperature, and the WHERE is the whole of it.
     *
     * Contacts with no score are excluded rather than grouped under a null
     * key. Unscored is not COLD - it means nothing has scored them - and a map
     * carrying a fourth bucket would be summed into the total by the first
     * component written in a hurry.
     */
    score AS (
      SELECT coalesce(jsonb_object_agg(score, n), '{}'::jsonb) AS by_score
      FROM (
        SELECT lead_score::text AS score, count(*)::int AS n
        FROM contacts
        WHERE lead_score IS NOT NULL
        GROUP BY 1
      ) grouped
    ),
    /*
     * Threads a flow actually stood in.
     *
     * DISTINCT over flow_runs rather than a count of runs: a customer who came
     * back next month has two runs in one conversation, and counting runs
     * would report more automated threads than the tenant has threads. The
     * CHECK in 20260906120000 refuses that outright.
     */
    automated AS (
      SELECT count(DISTINCT conversation_id)::int AS n FROM flow_runs
    ),
    /*
     * Threads a Verse campaign stood in.
     *
     * From the conversation's DRIVER rather than from campaign recipients,
     * and the difference matters. A recipient row says a campaign MESSAGED
     * somebody; the driver says Verse was actually the one speaking for the
     * business in that thread. A campaign that opened a thousand conversations
     * and then handed every one of them to a person automated nothing, and
     * counting recipients would report the opposite.
     *
     * Driver OR driver_ref: a thread Verse has since released - because it
     * handed over - still had Verse in it, and a count that dropped those
     * would fall every time the assistant did the right thing.
     */
    verse AS (
      SELECT count(DISTINCT c.id)::int AS n
        FROM conversations c
       WHERE c.driver = 'VERSE'
          OR EXISTS (
               SELECT 1 FROM verse_campaign_recipients r
                WHERE r.conversation_id = c.id AND r.status = 'SENT'
             )
    ),
    /*
     * Spend since the first of the month, per currency, as text.
     *
     * to_jsonb over the sum would write a JSON number, and cost_micros is a
     * bigint - so the value would round past 2^53 with nothing to say so. The
     * ::text cast is what keeps the digits, and currencySpend parses them back
     * to BigInt without a float in the path.
     */
    cost AS (
      SELECT coalesce(jsonb_object_agg(currency, micros), '{}'::jsonb) AS by_currency
      FROM (
        SELECT currency, sum(cost_micros)::text AS micros
        FROM usage_events
        WHERE occurred_at >= ${bounds.monthStart}
          AND currency IS NOT NULL
          AND cost_micros IS NOT NULL
        GROUP BY currency
      ) grouped
    ),
    unpriced AS (
      SELECT count(*)::int AS n
      FROM usage_events
      WHERE occurred_at >= ${bounds.monthStart}
        AND cost_micros IS NULL
    )
    INSERT INTO dashboard_rollups (
      company_id, computed_at, day_start, month_start,
      messages_total, messages_inbound, messages_outbound,
      outbound_pending, outbound_unconfirmed, outbound_held, outbound_sent,
      outbound_failed, outbound_delivered, outbound_read,
      failures_by_code,
      conversations_total, conversations_new_today,
      conversations_messaged, conversations_replied, conversations_by_source,
      contacts_total, contacts_new_today, contacts_by_score,
      conversations_automated,
      conversations_verse,
      cost_by_currency, cost_unpriced_count
    )
    SELECT
      app_current_company(), ${bounds.computedAt}, ${bounds.dayStart}, ${bounds.monthStart},
      msg.total, msg.inbound, msg.outbound,
      msg.pending, msg.unconfirmed, msg.held, msg.sent,
      msg.failed, msg.delivered, msg."read",
      fail.by_code,
      conv.total, conv.new_today,
      threads.messaged, threads.replied, conv_source.by_source,
      contact.total, contact.new_today, score.by_score,
      automated.n,
      verse.n,
      cost.by_currency, unpriced.n
    FROM msg, fail, threads, conv, conv_source, contact, score, automated, verse,
         cost, unpriced
    ON CONFLICT (company_id) DO UPDATE SET
      computed_at             = EXCLUDED.computed_at,
      day_start               = EXCLUDED.day_start,
      month_start             = EXCLUDED.month_start,
      messages_total          = EXCLUDED.messages_total,
      messages_inbound        = EXCLUDED.messages_inbound,
      messages_outbound       = EXCLUDED.messages_outbound,
      outbound_pending        = EXCLUDED.outbound_pending,
      outbound_unconfirmed    = EXCLUDED.outbound_unconfirmed,
      outbound_held           = EXCLUDED.outbound_held,
      outbound_sent           = EXCLUDED.outbound_sent,
      outbound_failed         = EXCLUDED.outbound_failed,
      outbound_delivered      = EXCLUDED.outbound_delivered,
      outbound_read           = EXCLUDED.outbound_read,
      failures_by_code        = EXCLUDED.failures_by_code,
      conversations_total     = EXCLUDED.conversations_total,
      conversations_new_today = EXCLUDED.conversations_new_today,
      conversations_messaged  = EXCLUDED.conversations_messaged,
      conversations_replied   = EXCLUDED.conversations_replied,
      conversations_by_source = EXCLUDED.conversations_by_source,
      contacts_total          = EXCLUDED.contacts_total,
      contacts_new_today      = EXCLUDED.contacts_new_today,
      contacts_by_score       = EXCLUDED.contacts_by_score,
      conversations_automated = EXCLUDED.conversations_automated,
      conversations_verse = EXCLUDED.conversations_verse,
      cost_by_currency        = EXCLUDED.cost_by_currency,
      cost_unpriced_count     = EXCLUDED.cost_unpriced_count
  `;
}

/**
 * The stored row, or null when nothing has ever computed one.
 *
 * Null is a real answer and the page renders it as one. A company created
 * before this phase, or one whose scheduler failed to register, has no row -
 * and showing zeroes there would be the page confidently reporting that nothing
 * has ever been sent.
 */
export async function readDashboardRollup(
  db: CompanyClient,
  companyId: string,
) {
  return db.dashboardRollup.findUnique({ where: { companyId } });
}

/* ------------------------------------------------------------------------- *
   The live seeks
   ------------------------------------------------------------------------- */

/** How many rows each of the lists below returns. A card, not a report. */
export const DASHBOARD_LIST_LIMIT = 6;

export interface ClosingWindow {
  conversationId: string;
  name: string;
  windowExpiresAt: Date;
  lastMessagePreview: string | null;
}

/**
 * Threads whose 24-hour window shuts inside the horizon.
 *
 * Not rolled up, and this is the card that decides it. A minute of staleness on
 * a total is nothing; a minute of staleness here is the difference between
 * reaching somebody inside their window and messaging them after it shut. It is
 * also the cheapest query on the page - a range seek on
 * (company_id, window_expires_at) returning a handful of rows.
 *
 * It is a seek because of the index, not because of how the bounds are passed:
 * measured at 50,000 AND 200,000 conversations, the bound-parameter form and
 * the `now()`-inline form produce an identical Index Scan on
 * (company_id, window_expires_at) with the same estimate at both scales. What
 * would make it a scan is dropping that index, and what would make the bounds
 * untestable is writing them inline - which is the reason they are arguments.
 *
 * `gt: now` and not `gte`: a window that expired a second ago is closed, and
 * listing it under "closing soon" sends somebody to a thread they cannot
 * message.
 */
export async function closingWindows(
  db: CompanyClient,
  bounds: { now: Date; closingHorizon: Date },
  limit: number = DASHBOARD_LIST_LIMIT,
): Promise<ClosingWindow[]> {
  const rows = await db.conversation.findMany({
    where: {
      windowExpiresAt: { gt: bounds.now, lte: bounds.closingHorizon },
    },
    orderBy: [{ windowExpiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      windowExpiresAt: true,
      lastMessagePreview: true,
      contact: { select: { displayName: true, profileName: true, waId: true } },
    },
  });

  return rows.map((row) => ({
    conversationId: row.id,
    name: contactName(row.contact),
    /* Non-null by the predicate; the type does not know that. */
    windowExpiresAt: row.windowExpiresAt as Date,
    lastMessagePreview: row.lastMessagePreview,
  }));
}

/** How many are closing, when the list itself has been truncated. */
export async function countClosingWindows(
  db: CompanyClient,
  bounds: { now: Date; closingHorizon: Date },
): Promise<number> {
  return db.conversation.count({
    where: { windowExpiresAt: { gt: bounds.now, lte: bounds.closingHorizon } },
  });
}

/**
 * What "waiting for a human" means, in one place.
 *
 * The card and its count MUST read the same predicate. Two copies of it is how
 * a page ends up saying "3" above a list of five, and the discrepancy is
 * invisible until somebody counts - at which point the number nobody trusts is
 * the one they were meant to act on.
 */
const WAITING_FOR_A_HUMAN: Prisma.ConversationWhereInput = {
  OR: [
    /* Somebody decided a person is needed, explicitly. */
    { needsHumanAt: { not: null } },
    /* Phase 5's: the customer is waiting and nobody has taken the thread. */
    { assignedUserId: null, unreadCount: { gt: 0 } },
  ],
};

export interface WaitingThread {
  conversationId: string;
  name: string;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  /** Why a person was asked for. Null for an ordinary unread thread. */
  needsHumanReason: string | null;
}

/**
 * Threads nobody has picked up, oldest first.
 *
 * Oldest, deliberately, and the opposite of every other list on this page. The
 * recent-conversations card is a feed and sorts newest first; this one is a
 * queue, and the thread at the top of a queue is the one that has been waiting
 * longest. Sorting it newest-first would bury the customer who has been ignored
 * since Tuesday under the one who wrote a minute ago.
 *
 * ---------------------------------------------------------------------------
 * Two ways in, because there are now two kinds of waiting
 * ---------------------------------------------------------------------------
 *
 * The original clause is Phase 5's and still holds: an unread inbound message
 * on a thread nobody has taken. That is the customer waiting on us.
 *
 * `needs_human_at` is the other kind, and it is not derivable from anything.
 * A flow's handoff node decides the automation cannot finish, which is true
 * with nothing unread and nobody assigned - and the first version of it faked
 * the unread count precisely because this clause did not exist, which meant
 * opening the thread erased the request.
 *
 * An OR rather than a replacement: the flag does not describe an unread
 * customer message, and a queue that showed only flagged threads would lose
 * every ordinary one the moment this column shipped.
 */
export async function waitingForAHuman(
  db: CompanyClient,
  limit: number = DASHBOARD_LIST_LIMIT,
): Promise<WaitingThread[]> {
  const rows = await db.conversation.findMany({
    where: WAITING_FOR_A_HUMAN,
    /*
     * By when the thread started waiting, not by its newest message.
     *
     * A flagged thread whose customer then went quiet keeps its place: the
     * flag is what is waiting, and last_message_at would send it to the back
     * of the queue every time anything happened in it. NULLS LAST puts the
     * ordinary unread threads - which have no flag - after the flagged ones,
     * which is the right order for somebody picking work up.
     */
    orderBy: [
      { needsHumanAt: { sort: "asc", nulls: "last" } },
      { lastMessageAt: "asc" },
      { id: "asc" },
    ],
    take: limit,
    select: {
      id: true,
      unreadCount: true,
      lastMessageAt: true,
      lastMessagePreview: true,
      needsHumanReason: true,
      contact: { select: { displayName: true, profileName: true, waId: true } },
    },
  });

  return rows.map((row) => ({
    conversationId: row.id,
    name: contactName(row.contact),
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    /*
     * Null for an ordinary unread thread, which is not a gap: nobody claimed
     * anything about it, the customer simply wrote. The card shows the reason
     * only where there is one, so a flagged thread says why it is in the queue
     * and an unread one does not pretend to.
     */
    needsHumanReason: row.needsHumanReason,
  }));
}

export async function countWaitingForAHuman(
  db: CompanyClient,
): Promise<number> {
  return db.conversation.count({ where: WAITING_FOR_A_HUMAN });
}

export interface RecentThread {
  conversationId: string;
  name: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  /** Whether the window is open. Never the instant - see below. */
  windowOpen: boolean;
}

/**
 * The newest threads, as a feed.
 *
 * `windowOpen` is a boolean and never a timestamp, and that is a fixture rule
 * rather than a design preference. The visual suite seeds an open thread as
 * `now() + 18h`, because a conversation cannot be both permanently open and
 * described by a fixed instant - so any page rendering that column as a time
 * produces a screenshot that never matches twice. The rule binds whoever
 * renders one: an open/closed state or a coarse bucket, never an instant.
 */
export async function recentThreads(
  db: CompanyClient,
  bounds: { now: Date },
  limit: number = DASHBOARD_LIST_LIMIT,
): Promise<RecentThread[]> {
  const rows = await db.conversation.findMany({
    where: { lastMessageAt: { not: null } },
    orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      lastMessageAt: true,
      lastMessagePreview: true,
      windowExpiresAt: true,
      contact: { select: { displayName: true, profileName: true, waId: true } },
    },
  });

  return rows.map((row) => ({
    conversationId: row.id,
    name: contactName(row.contact),
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    windowOpen:
      row.windowExpiresAt !== null &&
      row.windowExpiresAt.getTime() > bounds.now.getTime(),
  }));
}

export interface NumberHealth {
  id: string;
  displayNumber: string;
  verifiedName: string | null;
  qualityRating: string;
  status: string;
  messagingTier: string | null;
  metadataRefreshedAt: Date | null;
  missingSince: Date | null;
}

/**
 * Every number Meta has told us about, with the two facts that kill an account.
 *
 * Quality rating and messaging tier, per number. Nothing else in the product
 * surfaces them together on a page anybody opens daily, and a rating that has
 * dropped to YELLOW is the warning before a number is restricted - which is not
 * recoverable by apologising to a support queue.
 *
 * Ordered by creation so the list does not reorder under the reader when a
 * rating changes - and then by id, which is what actually makes that true.
 *
 * `created_at` alone is not a total order. Meta's refresh job inserts several
 * numbers in one pass and they tie to the microsecond, and with a tied sort
 * key Postgres may return them in any order it likes - so the card this
 * comment promised would hold still reshuffled between two refreshes with
 * nothing changed. The screenshot suite is what said so: the same three
 * fixture numbers, identical `created_at`, came back reversed on a later run
 * with no edit to the query. Adding the primary key as the last key makes the
 * order total by construction, for this and every other list here.
 *
 * `metadataRefreshedAt` comes back with it because every value here is a cache
 * of Meta's, and a cache with no age is a claim nobody can check - the numbers
 * page already makes that argument and this card inherits it rather than
 * restating it as a fresher-looking number.
 */
export async function numberHealth(db: CompanyClient): Promise<NumberHealth[]> {
  return db.whatsAppNumber.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      displayNumber: true,
      verifiedName: true,
      qualityRating: true,
      status: true,
      messagingTier: true,
      metadataRefreshedAt: true,
      missingSince: true,
    },
  });
}

export interface PendingTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  /** When it was submitted, so the card can say how long it has waited. */
  submittedAt: Date;
}

/**
 * Templates Meta has not answered on yet, oldest first.
 *
 * Oldest first for the same reason the waiting queue is: age is the whole
 * point. Meta usually answers in minutes and occasionally takes days, and the
 * only way to notice the second case is to see the age beside the name.
 *
 * `statusUpdatedAt ?? createdAt` is the submission moment: Meta stamps the
 * first when it says something, and until it does the row's own creation is the
 * only date there is.
 */
export async function pendingTemplates(
  db: CompanyClient,
  limit: number = DASHBOARD_LIST_LIMIT,
): Promise<PendingTemplate[]> {
  const rows = await db.whatsAppTemplate.findMany({
    where: { status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      name: true,
      language: true,
      category: true,
      createdAt: true,
      statusUpdatedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    submittedAt: row.statusUpdatedAt ?? row.createdAt,
  }));
}

export async function countPendingTemplates(
  db: CompanyClient,
): Promise<number> {
  return db.whatsAppTemplate.count({ where: { status: "PENDING" } });
}

/* ------------------------------------------------------------------------- *
   Shared
   ------------------------------------------------------------------------- */

/**
 * What to call a contact, in the order the inbox already uses.
 *
 * A name somebody here typed wins over the one the contact set on their own
 * profile, and the wa_id is the fallback that always exists. Duplicated from
 * nothing - the inbox builds its own because it selects different columns - but
 * the precedence is the same, and a dashboard that named people differently
 * from the inbox they link into would look like two products.
 */
function contactName(contact: {
  displayName: string | null;
  profileName: string | null;
  waId: string;
}): string {
  return contact.displayName ?? contact.profileName ?? contact.waId;
}

/** jsonb comes back as Prisma's JsonValue. These narrow it, once, here. */
export function countMap(
  value: Prisma.JsonValue | null | undefined,
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number") out[key] = entry;
  }
  return out;
}

/**
 * The currency map, narrowed to strings.
 *
 * Strings, because that is what the column stores and why - a jsonb number is
 * a double and cost_micros is a bigint. A value that arrives as a number here
 * has already lost whatever precision it was going to lose, so it is dropped
 * rather than silently coerced: an absent currency row is visible, and a
 * currency row that is quietly wrong by a few hundred rupees is not.
 */
export function microsMap(
  value: Prisma.JsonValue | null | undefined,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
