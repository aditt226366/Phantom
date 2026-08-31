import "server-only";
import { cache } from "react";
import { canUseFeatures, type FeatureAccess } from "@whatsapp-os/core/kyc";
import { currentKycStatuses, withCompany } from "@whatsapp-os/db";
import { requireSession } from "./session.ts";

/**
 * A4's gate, as the application enforces it.
 *
 * ---------------------------------------------------------------------------
 * Where this is called, and where it must never be
 * ---------------------------------------------------------------------------
 *
 * Every page, every loader and every server action of every feature section
 * calls it. Not the layout - rule 4: layouts are cached per segment and are
 * not guaranteed to re-execute on every navigation within one, so a check
 * there would let a tenant navigate from an allowed page into a blocked
 * section and see it. And not the nav, which only decides what is offered.
 *
 * Hiding a link is not a boundary. The URL still resolves, the server action
 * is still reachable by its id, and a tenant who was working normally before
 * an approval was revoked already has both in their history.
 *
 * `apps/web/tests/server/feature-gate-coverage.test.ts` walks app/(app) and
 * fails on a page or an action that calls neither of these, so the one that
 * gets missed is a failing test rather than a hole nobody notices.
 *
 * ---------------------------------------------------------------------------
 * Read per request, never cached beyond one
 * ---------------------------------------------------------------------------
 *
 * React's cache() memoises within a single request, which makes the repeated
 * calls in a page and its actions free. It does not persist across requests,
 * and that is the point: an operator revoking an approval has to close the
 * gate on the tenant's very next navigation, mid-session, with no sign-out.
 *
 * Anything that cached this at sign-in would leave a revoked company working
 * until their cookie expired, which is the failure this whole design exists
 * to make impossible.
 */

/**
 * The verdict for the signed-in company.
 *
 * Redirects to /sign-in when there is no session, because requireSession does
 * - a caller that has one already has paid for it, and React cache() makes the
 * second call free.
 */
export const getFeatureAccess = cache(async (): Promise<FeatureAccess> => {
  const session = await requireSession();

  const facts = await withCompany(session.companyId, async (db, companyId) => {
    const [documents, company] = await Promise.all([
      currentKycStatuses(db, companyId),
      /*
       * Read here rather than taken from the session, which selects only id,
       * name and slug.
       *
       * A suspended company should not resolve a session at all -
       * app_resolve_company refuses it, which is where deactivation is
       * enforced for every entry point that has one. So this is defence in
       * depth and is expected never to fire. It is read anyway because the
       * alternative is passing a hard-coded `false` into the one function
       * whose job is to be shut, on the strength of a guarantee made in
       * another file - and because canUseFeatures reports a suspension ahead
       * of everything else precisely so nobody is sent to upload paperwork
       * that will not help.
       */
      db.company.findFirst({
        where: { id: companyId },
        select: { deactivatedAt: true },
      }),
    ]);

    return { documents, deactivatedAt: company?.deactivatedAt ?? null };
  });

  return canUseFeatures({
    companyDeactivated: facts.deactivatedAt !== null,
    documents: facts.documents,
  });
});

/**
 * Thrown by assertFeatureAccess.
 *
 * A distinct class rather than a plain Error so that a caller which genuinely
 * wants to handle a refusal can, and so that a stray `catch` around unrelated
 * work cannot swallow the gate silently and carry on.
 */
export class FeatureBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`This workspace is not verified: ${reason}`);
    this.name = "FeatureBlockedError";
  }
}

/**
 * The action form: refuse loudly rather than returning a verdict to ignore.
 *
 * A server action that receives a decision has to remember to act on it, and
 * the failure mode of forgetting is the worst one available - the action runs,
 * the mutation lands, and the gate reports a refusal nobody read. Throwing
 * removes that possibility: there is no way to call this and proceed.
 *
 * Pages do the opposite and render a designed state, because a page has
 * somewhere to put an explanation and an action does not.
 */
export async function assertFeatureAccess(): Promise<void> {
  const access = await getFeatureAccess();

  if (!access.allowed) {
    throw new FeatureBlockedError(access.reason);
  }
}
