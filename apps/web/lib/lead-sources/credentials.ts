import "server-only";
import { withCompany } from "@whatsapp-os/db";
import { open, openRenderable } from "@/lib/integrations/seal";

/**
 * The company's Google credentials, for the two things the web side does with
 * them: check a share on save, and show the address to share with.
 *
 * A lead source names its own spreadsheet, so GOOGLE_SHEETS_ID is deliberately
 * not read here. That field predates bindings and belongs to the one-sheet
 * integration check; a binding carries its own id and would be silently wrong
 * if it inherited one from the vault.
 */

/**
 * Decrypted credentials for a Sheets call, or null when unconnected.
 *
 * Returns a plain record because that is what the adapter takes. Never
 * returned to a browser and never logged - the one value a page may render
 * goes through serviceAccountEmail below, which asks isSecretField first.
 */
export async function companyGoogleSecrets(
  companyId: string,
): Promise<Record<string, string> | null> {
  const integration = await withCompany(companyId, (db) =>
    db.integration.findFirst({
      where: { provider: "GOOGLE_SHEETS" },
      select: { id: true, secrets: { select: { key: true, ciphertext: true } } },
    }),
  );

  if (!integration || integration.secrets.length === 0) return null;

  const secrets: Record<string, string> = {};

  for (const row of integration.secrets) {
    secrets[row.key] = open(
      companyId,
      integration.id,
      row.key,
      row.ciphertext,
    );
  }

  return secrets;
}

/**
 * The address a tenant has to share their spreadsheet with.
 *
 * Rendered in full, with a copy control, and that is the reason
 * GOOGLE_SERVICE_ACCOUNT_EMAIL is declared `secret: false`. Knowing it grants
 * nothing - it is Google's public identifier for the account - and a tenant
 * who cannot see it cannot finish the setup at all, which presents as a
 * binding that silently never reads their sheet.
 *
 * Masking it would be security theatre with a real cost: the most common
 * support question this feature can produce is "which address do I share
 * with", and an answer of `sheets@…4f2a` cannot be pasted into Google's share
 * dialog.
 *
 * It goes through openRenderable rather than open, so the non-secret
 * declaration is checked at the moment of rendering rather than assumed here.
 */
export async function serviceAccountEmail(
  companyId: string,
): Promise<string | null> {
  const integration = await withCompany(companyId, (db) =>
    db.integration.findFirst({
      where: { provider: "GOOGLE_SHEETS" },
      select: {
        id: true,
        secrets: {
          where: { key: "GOOGLE_SERVICE_ACCOUNT_EMAIL" },
          select: { key: true, ciphertext: true },
        },
      },
    }),
  );

  const row = integration?.secrets[0];
  if (!integration || !row) return null;

  return openRenderable(companyId, integration.id, row.key, row.ciphertext);
}
