"use server";

import { revalidatePath } from "next/cache";
import {
  removeAdAccount,
  selectAdAccount,
  whatsappNumbersForMatching,
  withCompany,
} from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { loadMetaAdsCredentials } from "@/lib/meta-ads/credentials";
import { readAdAccounts, readPageWhatsAppLink } from "@/lib/meta-ads/graph";
import { checkLinkedNumber } from "@/lib/meta-ads/linked-number";

/**
 * Everything the Meta Ads section can do.
 *
 * Every action calls requireSession() and assertFeatureAccess() itself. Rule 4:
 * the layout's check is a redirect for the user's benefit, and a server action
 * is reachable by its id whatever the page rendered.
 */

export interface MetaAdsState {
  error?: string;
  notice?: string;
}

export async function selectAdAccountAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const metaAdAccountId = String(formData.get("adAccountId") ?? "").trim();
  const pageId = String(formData.get("pageId") ?? "").trim();
  const pageName = String(formData.get("pageName") ?? "").trim();

  if (!metaAdAccountId) return { error: "Choose an ad account." };

  const credentials = await loadMetaAdsCredentials(session.companyId);
  if (!credentials) {
    return {
      error:
        "No Meta credentials are stored for this workspace yet. Ask your platform contact to add them.",
    };
  }

  /*
   * The account is re-read from Meta rather than trusted from the form.
   *
   * The form is a request, and its currency field would decide what every
   * spend figure on the dashboard is denominated in. A tenant editing the
   * posted value could label an INR account USD - not a security boundary
   * crossing, since it is their own account, but a number on their own
   * dashboard that is wrong by a factor of eighty with nothing to say so.
   */
  const accounts = await readAdAccounts(credentials.accessToken);
  if (!accounts.ok) {
    return { error: `Meta refused the request: ${accounts.error}` };
  }

  const chosen = accounts.data.find((account) => account.id === metaAdAccountId);
  if (!chosen) {
    /* Rule 6, applied to somebody else's account: if this token cannot see it,
       it does not exist as far as this screen is concerned. */
    return { error: "That ad account is not one this connection can reach." };
  }

  /*
   * The linked-number check, made HERE and not only on the page that rendered
   * the warning. A page's check is advice; this one decides what is stored,
   * and the stored value is what the referral webhook will later be matched
   * against. Doing it only at render time would let a stale form post a Page
   * whose link changed in between.
   */
  const link = pageId
    ? await readPageWhatsAppLink(pageId, credentials.accessToken)
    : null;

  if (link && !link.ok) {
    return { error: `Meta refused the Page lookup: ${link.error}` };
  }

  const ownNumbers = await withCompany(session.companyId, (db, companyId) =>
    whatsappNumbersForMatching(db, companyId),
  );

  const verdict = checkLinkedNumber(
    link?.ok ? link.data.phoneNumber : null,
    ownNumbers,
  );

  await withCompany(session.companyId, (db, companyId) =>
    selectAdAccount(db, companyId, {
      integrationId: credentials.integrationId,
      metaAdAccountId: chosen.id,
      name: chosen.name,
      currency: chosen.currency,
      timezoneName: chosen.timezoneName,
      accountStatus: chosen.accountStatus,
      pageId: pageId || null,
      pageName: pageName || null,
      whatsappNumberId: verdict.kind === "matched" ? verdict.whatsappNumberId : null,
      linkedPhoneE164:
        verdict.kind === "matched"
          ? verdict.displayNumber
          : verdict.kind === "elsewhere"
            ? verdict.linkedPhoneE164
            : null,
    }),
  );

  /* Mutates and does not redirect, so it revalidates the route it changed -
     otherwise the list keeps its old contents until something else happens to
     re-render, which reads as a save that did not work. */
  revalidatePath("/meta-ads");

  return {
    notice:
      verdict.kind === "matched"
        ? `${chosen.name} is connected. Replies will arrive on ${verdict.displayNumber}.`
        : `${chosen.name} is connected, but its Page does not route replies to one of your numbers - see the warning on the account.`,
  };
}

export async function removeAdAccountAction(
  _state: MetaAdsState,
  formData: FormData,
): Promise<MetaAdsState> {
  await assertCsrf(formData);
  const session = await requireSession();
  await assertFeatureAccess();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Nothing to remove." };

  const removed = await withCompany(session.companyId, (db, companyId) =>
    removeAdAccount(db, companyId, id),
  );

  /*
   * Zero rows is not an error the tenant should see as one. Under RLS a row
   * belonging to another company is simply not there, and saying "not found"
   * for both cases is rule 6 - a message that distinguished them would confirm
   * the row exists.
   */
  revalidatePath("/meta-ads");

  return removed > 0
    ? { notice: "Ad account removed. Spend already recorded for it is removed too." }
    : { error: "That ad account is no longer connected." };
}
