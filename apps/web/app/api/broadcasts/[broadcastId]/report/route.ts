import { csvRows, safeCsvFilename, toCsv } from "@whatsapp-os/core/bulk";
import { withCompany } from "@whatsapp-os/db";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { deliveryLabel } from "@/lib/bulk-display";

/**
 * One row per recipient, as a CSV.
 *
 * ---------------------------------------------------------------------------
 * The boundary, again
 * ---------------------------------------------------------------------------
 *
 * `isProtected()` in proxy.ts is false for `/api/*` - the webhook lives there
 * and must stay reachable by Meta - so requireSession() here is not defence in
 * depth. It is the only thing between an anonymous GET and a customer list.
 *
 * The feature gate runs too. A4 gates bulk messaging, and a route handler is
 * an entry point like any other - reachable by URL whether or not a page
 * rendered a link to it.
 *
 * ---------------------------------------------------------------------------
 * Streamed, not assembled
 * ---------------------------------------------------------------------------
 *
 * A finished broadcast has as many rows as it had recipients, and building a
 * ten-thousand-row string in memory before sending a byte is both a spike and
 * a request that appears to hang. Rows are pulled in pages and pushed as they
 * come, so the download starts immediately and the process holds one page at a
 * time.
 *
 * No Content-Length for the same reason: the length is not known until the
 * last page is read, and a wrong one is worse than none.
 */

/* A customer list. Never prerendered, never cached by the framework. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Rows per query. Large enough to be few round trips, small enough to hold. */
const PAGE = 500;

const HEADER = [
  "phone",
  "status",
  "reason",
  "sent_at",
  "delivered_at",
  "read_at",
] as const;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ broadcastId: string }> },
): Promise<Response> {
  /* The boundary. See the note above - nothing else is protecting this. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return new Response("Not Found", { status: 404 });
  }

  const { broadcastId } = await ctx.params;

  const broadcast = await withCompany(session.companyId, (db, companyId) =>
    db.broadcast.findFirst({
      where: { id: broadcastId, companyId },
      select: { id: true, name: true },
    }),
  );

  /* Rule 6: a broadcast that is not yours does not exist. */
  if (!broadcast) return new Response("Not Found", { status: 404 });

  const filename = safeCsvFilename(broadcast.name, "broadcast-report");
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let sentHeader = false;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const rows = await withCompany(session.companyId, (db, companyId) =>
          db.broadcastRecipient.findMany({
            where: { companyId, broadcastId },
            /* By id, which is stable and unique - an offset would skip or
               repeat rows if anything were written while the download ran. */
            orderBy: { id: "asc" },
            take: PAGE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
              id: true,
              phoneE164: true,
              state: true,
              skipReason: true,
              messageId: true,
            },
          }),
        );

        if (rows.length === 0) {
          if (!sentHeader) {
            /* An empty broadcast still gets a header, so the file opens as a
               spreadsheet rather than as nothing. */
            controller.enqueue(encoder.encode(toCsv(HEADER, [])));
          }
          controller.close();
          return;
        }

        /*
         * The messages for this page, in a second query rather than a join.
         *
         * broadcast_recipients.message_id is a plain column with no relation:
         * the row it points at is an ordinary message, and giving the audience
         * table a foreign key into the message table would tie a draft's
         * bookkeeping to rows that do not exist yet. Two queries per page of
         * 500 is the honest cost of that, and both are indexed lookups.
         */
        const messageIds = rows
          .map((row) => row.messageId)
          .filter((id): id is string => id !== null);

        const messages = await withCompany(session.companyId, (db, companyId) =>
          db.message.findMany({
            where: { companyId, id: { in: messageIds } },
            select: {
              id: true,
              status: true,
              errorTitle: true,
              occurredAt: true,
              deliveredAt: true,
              readAt: true,
            },
          }),
        );

        const byId = new Map(messages.map((message) => [message.id, message]));

        const body = rows.map((row) => {
          const message = row.messageId ? byId.get(row.messageId) : undefined;

          return [
            row.phoneE164,
            message ? deliveryLabel(message.status) : stateLabel(row.state),
            message?.errorTitle ?? row.skipReason ?? "",
            iso(message?.occurredAt),
            iso(message?.deliveredAt),
            iso(message?.readAt),
          ];
        });

        /*
         * The first page carries the BOM and the header; every later one
         * carries neither. csvRows exists for exactly this - stripping them
         * back off a toCsv() result is the version that breaks silently the
         * first time a field matches the pattern being stripped.
         */
        const chunk = sentHeader ? csvRows(body) : toCsv(HEADER, body);
        sentHeader = true;
        cursor = rows.at(-1)?.id;

        controller.enqueue(encoder.encode(chunk));
      },
    },
    /* Never read ahead: one pull is one page, and nothing is fetched for a
       client that has closed the tab. */
    { highWaterMark: 0 },
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      /* A customer list must never sit in a shared cache. Same reasoning as
         the media and KYC routes. */
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function stateLabel(state: string): string {
  return state === "SKIPPED" ? "Skipped" : "Queued";
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : "";
}
