import { CopyField } from "../../_components/copy-field";

/**
 * The address a spreadsheet has to be shared with, in full.
 *
 * Shown rather than masked, deliberately, and GOOGLE_SERVICE_ACCOUNT_EMAIL is
 * declared `secret: false` for precisely this. Knowing it grants nothing - it
 * is Google's public identifier for the account - and a tenant who cannot read
 * it cannot complete the setup, which presents not as an error but as a
 * binding that silently never contacts anybody.
 *
 * Masking it would be theatre with a real cost: the most common support
 * question this feature can produce is "which address do I share with", and
 * `sheets@…4f2a` cannot be pasted into Google's share dialog.
 *
 * Editor rather than Viewer, because the optional Apps Script path needs it and
 * asking for it twice - once now, once later - is how a setup gets abandoned
 * half way. Our own access token is scoped `spreadsheets.readonly` regardless,
 * so the extra permission is one we are structurally unable to use.
 */
export function ServiceAccountPanel({ email }: { email: string | null }) {
  return (
    <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
      <h2 className="text-title-sm text-ink">Share your sheet with us first</h2>

      {email ? (
        <>
          <p className="mt-xs max-w-2xl text-body-sm text-body">
            In Google Sheets, press Share and give this address{" "}
            <strong className="text-body-strong">Editor</strong> access. Nothing
            here can read a spreadsheet it has not been shared with, and that is
            the most common reason a lead source contacts nobody.
          </p>

          <div className="mt-base">
            <CopyField value={email} label="address" />
          </div>

          <p className="mt-sm max-w-2xl text-caption text-muted">
            We only ever read. The access we ask Google for is read-only, so
            nothing here can change a cell even in a sheet that would allow it.
          </p>
        </>
      ) : (
        <p className="mt-xs max-w-2xl text-body-sm text-body">
          Google Sheets is not connected for this workspace yet, so there is no
          address to share with. Your platform contact adds the service account;
          once they have, it appears here.
        </p>
      )}
    </section>
  );
}
