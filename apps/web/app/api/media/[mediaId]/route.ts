import { mediaStore, withCompany } from "@whatsapp-os/db";
import { requireSession } from "@/lib/auth/session";

/**
 * Serve a file a customer sent.
 *
 * ---------------------------------------------------------------------------
 * R6: this is the first tenant read with no proxy protection
 * ---------------------------------------------------------------------------
 *
 * `isProtected()` in proxy.ts is false for `/api/*`, deliberately - the webhook
 * lives under it and must stay reachable by Meta. Every tenant page in this app
 * is behind both the proxy redirect and its own `requireSession()`; this route
 * has only the second one.
 *
 * So the `requireSession()` below is not defence in depth. It is the boundary,
 * and the only thing between a signed-out request and somebody's customer's
 * photograph. There is a test that asserts it rather than trusting it.
 *
 * The company scope is the second half: `mediaStore.get` takes the session's
 * company id and reads inside `withCompany`, so RLS refuses another tenant's
 * row even if the id is guessed. A media id is a cuid, but "unguessable" is not
 * an access control.
 */

/* A tenant's private bytes. Never prerendered, never cached by the framework. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface MediaContext {
  params: Promise<{ mediaId: string }>;
}

/**
 * Filenames come from a customer's handset, so they are attacker-controlled.
 *
 * A newline in a header value splits the response; a quote closes the parameter
 * early. Stripped rather than encoded, because the filename here is a
 * convenience on a download and not something worth an RFC 5987 dance.
 */
function safeFilename(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.replace(/[^\w.\- ]+/g, "").trim().slice(0, 100);
  return cleaned.length > 0 ? cleaned : null;
}

export async function GET(
  request: Request,
  ctx: MediaContext,
): Promise<Response> {
  /* The boundary. See the note above - nothing else is protecting this. */
  const session = await requireSession();
  const { mediaId } = await ctx.params;

  const meta = await withCompany(session.companyId, (db, companyId) =>
    mediaStore.stat(db, companyId, mediaId),
  );

  /*
   * 404 for absent, for another company's, and for a row whose bytes were never
   * kept - rule 6, and the three are deliberately indistinguishable. A 403 on
   * the second would confirm the row exists, and a distinct code on the third
   * would describe someone else's storage.
   */
  if (!meta || meta.state !== "STORED") {
    return new Response("Not Found", { status: 404 });
  }

  /*
   * Strong, and the sha256 rather than a timestamp: the hash IS the content, so
   * two rows holding the same bytes validate against each other and a re-upload
   * of identical bytes is not a cache miss. Quoted, unprefixed - a W/ prefix
   * would make it weak, and weak validators cannot be used for range requests.
   */
  const etag = `"${meta.sha256}"`;

  if (request.headers.get("if-none-match") === etag) {
    /* 304 carries no body, and must repeat the validators it was matched on. */
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": CACHE_CONTROL },
    });
  }

  const stream = await mediaStore.get(session.companyId, mediaId);

  if (!stream) {
    /* Between the stat and the read: retention deleted it, or another request
       is mid-write. Same answer as never having existed. */
    return new Response("Not Found", { status: 404 });
  }

  const filename = safeFilename(meta.fileName);

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": meta.mimeType,
      /*
       * From byte_size, which a CHECK constraint ties to octet_length(bytes) -
       * so this cannot drift from what the stream emits. If the row vanishes
       * mid-read the store raises MediaTruncatedError into the stream and the
       * client sees a short body against this length, which is the honest
       * failure: a truncated image rather than a silently complete-looking one.
       */
      "content-length": String(meta.byteSize),
      etag,
      "cache-control": CACHE_CONTROL,
      /* inline so a thread renders it; the filename is only for a save-as. */
      "content-disposition": filename
        ? `inline; filename="${filename}"`
        : "inline",
      /*
       * Meta's own bytes, and the content type is Meta's word for them. Stops a
       * browser sniffing an image/jpeg that is actually HTML into a script that
       * runs on this origin.
       */
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * `private`, and deliberately without a max-age.
 *
 * `private` keeps it out of every shared cache: a CDN or corporate proxy that
 * stored one tenant's photograph and served it to the next request for the same
 * URL would be a cross-tenant leak through infrastructure this app does not
 * control.
 *
 * `no-cache` is not "do not store" - it means the browser may keep it but must
 * revalidate, which the ETag above makes a cheap 304. The alternative, a long
 * max-age, would leave a customer's photograph readable from disk cache after
 * the session that was allowed to see it has ended.
 *
 * If somebody later wants a max-age for performance, that is a decision about
 * how long a signed-out browser keeps tenant media - not a tuning knob. The
 * test asserts this contains `private` AND does not contain `public`, because
 * "private, public" would satisfy a contains-only check while meaning the
 * opposite.
 */
const CACHE_CONTROL = "private, no-cache";
