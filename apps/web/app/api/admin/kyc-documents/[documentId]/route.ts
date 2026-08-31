import { safeDocumentFilename } from "@whatsapp-os/core/kyc-server";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { requestContext } from "@/lib/auth/request";
import {
  getKycDocument,
  readKycDocumentBytes,
  writeAdminAudit,
} from "@/lib/admin-db";

/**
 * Serve one verification document to the platform operator.
 *
 * ---------------------------------------------------------------------------
 * This is the only way a KYC document's bytes leave the server
 * ---------------------------------------------------------------------------
 *
 * Nothing else selects the column - not a page loader, not a server action's
 * return value, not a log line. That is deliberate and worth defending: this
 * is the most sensitive data the system holds, and the number of exits is a
 * number worth keeping at one.
 *
 * `isProtected()` in proxy.ts is false for `/api/*` - the webhook lives under
 * it and must stay reachable by Meta - so the requireAdminSession() below is
 * not defence in depth. It is the boundary, and the only thing between an
 * anonymous request and somebody's Aadhaar card. There is a test that asserts
 * it rather than trusting it.
 *
 * Admin-only, with no tenant arm. The tenant's own Documents page shows the
 * status of each upload and never serves the file back: a tenant already has
 * the document they sent, so a download route for them would add a second exit
 * for these bytes and buy nothing.
 *
 * ---------------------------------------------------------------------------
 * Every access is audited, including the ones that only look
 * ---------------------------------------------------------------------------
 *
 * These are identity documents, so "who looked at this, and when" is part of
 * the record rather than an extra. The audit row is written BEFORE the stream
 * starts: a row for a transfer that then failed is a small over-count, and a
 * transfer with no row because the connection dropped after the bytes went out
 * is a gap in exactly the log an incident review reads.
 */

/* A person's identity document. Never prerendered, never cached by Next. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DocumentContext {
  params: Promise<{ documentId: string }>;
}

export async function GET(
  request: Request,
  ctx: DocumentContext,
): Promise<Response> {
  /* The boundary. See the note above - nothing else is protecting this. */
  const session = await requireAdminSession();
  const { documentId } = await ctx.params;

  const meta = await getKycDocument(documentId);

  if (!meta) {
    return new Response("Not Found", { status: 404 });
  }

  /*
   * `?download=1` switches Content-Disposition from inline to attachment.
   *
   * Two behaviours rather than two routes, because they are one read of one
   * file with one authorization question - and a second route would be a
   * second place to forget the audit row.
   */
  const download = new URL(request.url).searchParams.get("download") === "1";

  /*
   * Strong, and the sha256 rather than a timestamp: the hash IS the content.
   * Quoted and unprefixed - a W/ prefix would make it weak.
   */
  const etag = `"${meta.sha256}"`;

  if (request.headers.get("if-none-match") === etag) {
    /*
     * Audited even so. A 304 means the operator's browser already holds the
     * document and is displaying it; treating that as "did not look" would
     * make the log under-count exactly the operator who looks most often.
     */
    await recordAccess(session.adminUserId, meta, download, true);

    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": CACHE_CONTROL },
    });
  }

  await recordAccess(session.adminUserId, meta, download, false);

  const stream = await readKycDocumentBytes(documentId);

  if (!stream) {
    /* Between the metadata read and the byte read: an erasure request landed.
       Same answer as never having existed. */
    return new Response("Not Found", { status: 404 });
  }

  const filename = safeDocumentFilename(meta.originalFilename);

  return new Response(stream, {
    status: 200,
    headers: {
      /*
       * Our stored finding, which readPdfUpload established from the bytes -
       * never the Content-Type the uploader's browser volunteered.
       */
      "content-type": meta.mimeType,
      /*
       * From byte_size, which a CHECK constraint ties to octet_length(bytes),
       * so this cannot drift from what the stream emits.
       */
      "content-length": String(meta.byteSize),
      etag,
      "cache-control": CACHE_CONTROL,
      "content-disposition": buildDisposition(download, filename),
      /*
       * A PDF is a scriptable format and this one was uploaded by a stranger.
       * nosniff stops a browser deciding an application/pdf is really HTML and
       * running it on this origin - which is the admin panel's origin, holding
       * the session that can read every tenant's documents.
       */
      "x-content-type-options": "nosniff",
      /*
       * Belt and braces on the same risk: even served as a PDF, nothing in it
       * may fetch, frame, or script anything. `sandbox` with no allow-list is
       * the strongest form and is what stops a crafted PDF calling home with
       * whatever it can read.
       */
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function buildDisposition(download: boolean, filename: string | null): string {
  const kind = download ? "attachment" : "inline";

  /*
   * No filename at all rather than an empty one when nothing survives
   * sanitisation: filename="" makes some browsers save the file under the
   * URL's last segment, which here is an opaque cuid.
   */
  return filename ? `${kind}; filename="${filename}"` : kind;
}

async function recordAccess(
  adminUserId: string,
  meta: { id: string; companyId: string; kind: string },
  download: boolean,
  cached: boolean,
): Promise<void> {
  const context = await requestContext();

  await writeAdminAudit({
    adminUserId,
    action: download ? "admin.kyc.document.download" : "admin.kyc.document.view",
    ...(context.ip ? { ip: context.ip } : {}),
    metadata: {
      documentId: meta.id,
      companyId: meta.companyId,
      kind: meta.kind,
      /* A 304 is still a look, and saying which kind keeps the count honest. */
      cached,
    },
  });
}

/**
 * `private`, and deliberately without a max-age.
 *
 * `private` keeps it out of every shared cache: a CDN or corporate proxy that
 * stored one tenant's Aadhaar card and served it to the next request for the
 * same URL would be a disclosure through infrastructure this app does not
 * control.
 *
 * `no-cache` is not "do not store" - it means the browser may keep it but must
 * revalidate, which the ETag makes a cheap 304. A long max-age would leave an
 * identity document readable from an operator's disk cache after the session
 * allowed to see it has ended.
 *
 * The test asserts this contains `private` AND does not contain `public`,
 * because "private, public" would satisfy a contains-only check while meaning
 * the opposite.
 */
const CACHE_CONTROL = "private, no-cache";
