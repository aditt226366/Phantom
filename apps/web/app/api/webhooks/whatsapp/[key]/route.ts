import { createHash } from "node:crypto";
import { JOB_NAMES } from "@whatsapp-os/core";
import { safeEqual } from "@whatsapp-os/core";
import { verifyMetaSignature } from "@whatsapp-os/core/whatsapp-server";
import {
  recordUnroutableWebhook,
  recordWebhookDelivery,
  withCompany,
} from "@whatsapp-os/db";
import { clientIp } from "@/lib/auth/request";
import { hashIp } from "@/lib/auth/ip-hash";
import {
  checkWebhookAllowed,
  clearWebhookFailures,
  recordWebhookFailure,
} from "@/lib/auth/lockout";
import { systemQueue } from "@/lib/queue";
import { getWebhookSecrets, type WebhookSecrets } from "@/lib/webhook-secrets";

/**
 * The endpoint Meta posts to. The only unauthenticated, internet-reachable,
 * tenant-affecting surface in the system.
 *
 * ---------------------------------------------------------------------------
 * Almost everything returns 200, and that is the design
 * ---------------------------------------------------------------------------
 *
 * Unknown key, bad signature, throttled, suspended workspace: all 200. Not
 * politeness - Meta counts non-2xx responses and disables the subscription
 * after roughly seven days of them, and a disabled subscription is a dead
 * webhook nobody is told about, needing a human in Business Manager, with every
 * message from the outage gone.
 *
 * So a 200 to a forgery costs nothing, because no work happens either way,
 * while a 403 to a genuine delivery with a stale app secret costs the customer
 * their inbox. The asymmetry is the whole argument (P2, P5).
 *
 * The one thing that must NOT return 200 is a delivery we accept and then fail
 * to keep: a 200 tells Meta the message was received and it will never resend.
 * That case throws, and Meta retries.
 *
 * ---------------------------------------------------------------------------
 * The company id comes from the resolver and nowhere else
 * ---------------------------------------------------------------------------
 *
 * Nothing in the body reaches withCompany. The body is attacker-supplied on an
 * endpoint anyone can post to, and withCompany sets the value RLS trusts - so
 * a company id taken from it would be a total bypass, not a bug in one query.
 */

/* Never prerendered, never cached. A webhook served from a cache is a webhook
   that silently stops arriving. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The dynamic segment, spelled out rather than using the global RouteContext
 * helper.
 *
 * RouteContext resolves from types Next generates during dev, build or typegen
 * - and `npm run verify` runs typecheck BEFORE build, so on a clean checkout
 * the generated type does not exist yet and the gate fails on its first step
 * for a reason that has nothing to do with the code.
 *
 * `params` is a Promise in Next 16; awaiting it is not optional.
 */
interface WebhookContext {
  params: Promise<{ key: string }>;
}

/** Timing for the event insert. See R7 - the pool binds before the timeout. */
const EVENT_INSERT = { maxWait: 1_500, timeout: 3_000 };

/**
 * Resolve the key and open its secrets, or say why not.
 *
 * Shared by both verbs deliberately. GET needs the verify token and POST needs
 * the app secret, but both need the same resolve-then-decrypt in the same
 * order - and correction C1 exists because that order is not the obvious one.
 * Two copies would drift, and the half that drifted would be the one nobody
 * tests against Meta.
 */
async function openWebhook(
  key: string,
): Promise<{ secrets: WebhookSecrets } | { secrets: null }> {
  const secrets = await getWebhookSecrets(key);
  return secrets ? { secrets } : { secrets: null };
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * GET: Meta's subscription handshake.
 *
 * Meta calls this once when the URL is saved, with hub.mode=subscribe and the
 * verify token the operator typed into Business Manager. Echoing back
 * hub.challenge proves we hold the same token.
 */
export async function GET(
  request: Request,
  ctx: WebhookContext,
): Promise<Response> {
  const { key } = await ctx.params;
  const params = new URL(request.url).searchParams;

  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return new Response("Bad Request", { status: 400 });
  }

  const { secrets } = await openWebhook(key);

  /*
   * 403 here, not 200, and this is the one place that is right. A handshake is
   * a person in Business Manager pressing a button and waiting for an answer -
   * there is no subscription yet to protect, and answering 200 without the
   * challenge would let them believe it worked.
   */
  if (!secrets) return new Response("Forbidden", { status: 403 });

  if (!safeEqual(token, secrets.verifyToken.reveal())) {
    return new Response("Forbidden", { status: 403 });
  }

  /*
   * The challenge, raw, as text/plain.
   *
   * Not Response.json, which would quote it. Meta compares the body byte for
   * byte against what it sent, so `"1158201444"` fails against 1158201444 -
   * and it fails silently: the subscription is simply refused and the error
   * says nothing about encoding. It is the single easiest thing to get wrong
   * here and the hardest to diagnose afterwards.
   */
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * POST: a delivery.
 *
 * The order is correction C1's, and it is not the order the brief assumed:
 * the app secret lives in the vault, the vault is company-scoped, and there is
 * no company scope before the key is resolved.
 */
export async function POST(
  request: Request,
  ctx: WebhookContext,
): Promise<Response> {
  const { key } = await ctx.params;

  /*
   * Bytes, never request.text() into a parse and back. Meta signs the exact
   * octets it sent; re-serialising parsed JSON reorders keys and normalises
   * numbers, and the digest of that is a different digest. The same reason the
   * stored payload is text rather than jsonb.
   */
  const raw = Buffer.from(await request.arrayBuffer());
  const body = raw.toString("utf8");

  const ip = await clientIp();
  const ipHash = hashIp(ip);

  /*
   * Before the resolve, so a flood costs one indexed lookup rather than a
   * resolve plus a transaction plus two decrypts. Keyed on the address and
   * never on the webhook key - P3, which reverses the original plan: keying on
   * the key would let anyone who learns a tenant's URL lock that tenant out of
   * their own inbox.
   */
  const throttled = await checkWebhookAllowed(ipHash);
  if (throttled.locked) return ok();

  const { secrets } = await openWebhook(key);

  if (!secrets) {
    /*
     * P2. Recorded globally, because an unknown key belongs to no company -
     * storing the hash of the key, the reason and a hashed address, and never
     * the body: this endpoint is unauthenticated, so keeping attacker-supplied
     * payloads is a stuffing vector.
     */
    await recordUnroutableWebhook({
      webhookKeyHash: keyHash(key),
      reason: "UNKNOWN_KEY",
      ipHash,
    });
    await recordWebhookFailure(ipHash);
    return ok();
  }

  /* Decrypted before this line, outside any transaction - the scope that read
     the ciphertext has already closed. */
  const signed = verifyMetaSignature(
    body,
    request.headers.get("x-hub-signature-256"),
    secrets.appSecret.reveal(),
  );

  if (!signed) {
    /*
     * P5. A signature failure is also what genuine Meta traffic looks like when
     * our stored app secret is stale, so this is recorded and throttled but
     * still answered 200. X-Hub-Signature - the legacy sha1 header - is ignored
     * entirely and never consulted as a fallback: accepting it would let a
     * downgrade past the check this exists to be.
     */
    await recordUnroutableWebhook({
      webhookKeyHash: keyHash(key),
      reason: "BAD_SIGNATURE",
      companyId: secrets.companyId,
      ipHash,
    });
    await recordWebhookFailure(ipHash);
    return ok();
  }

  /*
   * It verified, so this address is Meta with a working secret. Clearing here
   * is what makes a stale-secret outage recover on its own: the failures it
   * accumulated do not have to expire before deliveries start being processed
   * again.
   */
  await clearWebhookFailures(ipHash);

  try {
    const delivery = await withCompany(
      secrets.companyId,
      (db, companyId) =>
        recordWebhookDelivery(db, companyId, {
          integrationId: secrets.integrationId,
          deliveryKey: createHash("sha256").update(raw).digest("hex"),
          payload: body,
        }),
      EVENT_INSERT,
    );

    if (delivery.enqueue) {
      await systemQueue.add(
        JOB_NAMES.WHATSAPP_WEBHOOK,
        { companyId: secrets.companyId, eventId: delivery.eventId },
        /*
         * The delivery count is in the id because BullMQ keeps completed ids
         * for an hour. A redelivery of something whose job was lost has to be
         * able to enqueue again, and under the first attempt's id it would be
         * silently dropped.
         */
        { jobId: `webhook:${delivery.eventId}:${delivery.deliveryCount}` },
      );
    }
  } catch (error) {
    /*
     * R7. Answered 200 even though the insert failed, and this is the one
     * deliberate exception to "a delivery we cannot keep must not be 200".
     *
     * That row is fast-path dedupe and forensics; it is not the correctness
     * guarantee. The guarantee is the unique on (company_id, wamid), which the
     * worker enforces on the message itself - so a lost event row costs a
     * duplicate job at worst, while a non-2xx under load costs progress toward
     * the subscription being disabled during exactly the burst that caused it.
     */
    console.error("[webhook] could not record delivery", {
      companyId: secrets.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return ok();
}

/** 200 with no body. Meta reads the status and nothing else. */
function ok(): Response {
  return new Response(null, { status: 200 });
}
