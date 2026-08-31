import { JOB_NAMES } from "@whatsapp-os/core";
import { resolveCompany, withCompany } from "@whatsapp-os/db";
import { clientIp } from "@/lib/auth/request";
import { hashIp } from "@/lib/auth/ip-hash";
import {
  checkWebhookAllowed,
  clearWebhookFailures,
  recordWebhookFailure,
} from "@/lib/auth/lockout";
import { systemQueue } from "@/lib/queue";

/**
 * The doorbell a tenant's own Apps Script rings.
 *
 * ---------------------------------------------------------------------------
 * It accepts nothing and does nothing but schedule a read
 * ---------------------------------------------------------------------------
 *
 * No body is read. Not "the body is validated" - it is never looked at. The
 * poll this enqueues reads the spreadsheet through the tenant's own credential,
 * with the same cleaning and the same unique index as every scheduled poll, so
 * there is no shape a request could take that would put a lead into the system.
 *
 * The worst an attacker holding the URL can do is make us read a sheet we were
 * going to read anyway, a little sooner. That is why this endpoint needs no
 * signature: there is no signed statement to make, because the request asserts
 * nothing.
 *
 * ---------------------------------------------------------------------------
 * The company id comes from the resolver and nowhere else
 * ---------------------------------------------------------------------------
 *
 * CLAUDE.md rule 3. There is no session here, so the id has to come from the
 * database - app_resolve_company's `lead_source` kind, which turns an
 * unguessable key into one text value and refuses a suspended workspace. A
 * company id taken from a path segment or a body would be a total bypass of
 * every policy in the schema rather than a bug in one query.
 *
 * ---------------------------------------------------------------------------
 * Why this one returns 404 where the Meta webhook returns 200
 * ---------------------------------------------------------------------------
 *
 * That endpoint answers 200 to almost everything because Meta counts non-2xx
 * responses and disables a subscription after about a week of them - a dead
 * webhook nobody is told about, needing a human in Business Manager.
 *
 * Nothing of the kind applies to Apps Script. It is the tenant's own code,
 * there is no subscription to lose, and a 404 is what tells them the script was
 * pasted with the wrong URL or belongs to a binding they have deleted. Being
 * unhelpfully quiet here would cost them the one signal they have.
 */

/* Never prerendered, never cached. A doorbell served from a cache is one that
   rings once and then stops. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The dynamic segment, spelled out rather than using the global RouteContext
 * helper - `npm run verify` typechecks before it builds, so on a clean checkout
 * the generated type does not exist yet and the gate fails on its first step
 * for a reason unrelated to the code.
 */
interface PingContext {
  params: Promise<{ key: string }>;
}

export async function POST(
  _request: Request,
  context: PingContext,
): Promise<Response> {
  const { key } = await context.params;

  /*
   * The same per-IP throttle the Meta webhook uses, and for the same reason:
   * this is an unauthenticated, internet-reachable endpoint whose path segment
   * is the only credential, so without it somebody can walk the keyspace for
   * free. A wrong key costs a resolver lookup; a million wrong keys should not.
   */
  const ipHash = hashIp(await clientIp());
  const throttle = await checkWebhookAllowed(ipHash);

  if (throttle.locked) {
    return Response.json({ ok: false }, { status: 429 });
  }

  const companyId = await resolveCompany("lead_source", key);

  if (!companyId) {
    /*
     * Unknown key, or a suspended workspace - and deliberately the same answer
     * for both. Distinguishing them would tell an unauthenticated caller which
     * keys are real, which is the one piece of information this endpoint has to
     * give away.
     */
    await recordWebhookFailure(ipHash);
    return Response.json({ ok: false }, { status: 404 });
  }

  await clearWebhookFailures(ipHash);

  /*
   * Re-read inside the company scope before enqueueing.
   *
   * The resolver returned a company id and nothing else - by design, it selects
   * one text value rather than a row. So the binding's id and whether it is
   * even active are read here, through RLS, with the scope the resolver
   * established.
   *
   * A paused binding rings and nothing happens. The poll handler would return
   * early anyway, but not enqueueing at all means a tenant who pauses a binding
   * and leaves the script installed is not generating a job per edit for ever.
   */
  const binding = await withCompany(companyId, (db, scoped) =>
    db.leadSource.findFirst({
      where: { webhookKey: key, companyId: scoped, status: "ACTIVE" },
      select: { id: true },
    }),
  );

  if (!binding) {
    /* Resolved, so the key is real - it belongs to a binding that is paused or
       in error. 200, because nothing is wrong with the request and the tenant's
       script should not start reporting failures because they pressed Pause. */
    return Response.json({ ok: true, polled: false });
  }

  /*
   * A job id per binding per second.
   *
   * BullMQ refuses a job whose id it already holds, and that refusal is the
   * deduplication here. A spreadsheet being edited by four people fires onChange
   * continuously, and without this every keystroke-ish change would be its own
   * poll - which is both a wasted read against a per-project quota and a way for
   * one tenant's busy sheet to exhaust everybody's allowance.
   *
   * One second rather than the poll interval: the point of this path is that a
   * lead is contacted in seconds, and collapsing to the interval would give
   * back exactly the latency the script exists to remove.
   */
  const bucket = Math.floor(Date.now() / 1000);

  await systemQueue.add(
    JOB_NAMES.LEAD_SOURCE_POLL,
    { companyId, leadSourceId: binding.id },
    { jobId: `lead-poll:${binding.id}:${bucket}` },
  );

  return Response.json({ ok: true, polled: true });
}
