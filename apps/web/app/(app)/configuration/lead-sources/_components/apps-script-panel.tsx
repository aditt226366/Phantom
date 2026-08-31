"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * The optional script, and the instructions for installing it.
 *
 * Collapsed by default, and that is a claim about the product rather than a
 * layout preference: polling is the default and the fallback, and a tenant who
 * never opens this loses nothing but latency. Presenting it expanded would make
 * a lead source look like it needs a script to work, which is the opposite of
 * true and is the kind of thing that gets a setup abandoned half way.
 *
 * The script text is shown in full and is deliberately readable. Somebody is
 * pasting code into their own spreadsheet, and code they cannot read is code
 * they should not paste.
 */
export function AppsScriptPanel({
  source,
  url,
}: {
  source: string;
  url: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* No clipboard, or permission refused. The text below is still there to
         select, which is why it is rendered as text and not as an input. */
    }
  }

  return (
    <section className="rounded-lg border border-hairline bg-surface-card px-base py-base">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div className="min-w-0">
          <h2 className="text-title-sm text-ink">Contact leads instantly</h2>
          <p className="mt-xxs max-w-2xl text-body-sm text-body">
            Optional. This sheet is already read on a schedule; a small script
            in the spreadsheet tells us the moment a row is added instead.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Hide the script" : "Show the script"}
        </Button>
      </div>

      {open ? (
        <div className="mt-base flex flex-col gap-base">
          <ol className="flex list-decimal flex-col gap-xs pl-base text-body-sm text-body">
            <li>
              In your spreadsheet, open <strong>Extensions</strong> &rarr;{" "}
              <strong>Apps Script</strong>.
            </li>
            <li>Replace everything in the editor with the script below.</li>
            <li>
              Save, then run <code>whatsappOsInstall</code> once from the
              function menu and approve the permissions Google asks for.
            </li>
          </ol>

          <div>
            <p className="text-caption-uppercase text-muted">
              This binding&rsquo;s address
            </p>
            <code className="mt-xxs block break-all rounded-md border border-hairline bg-canvas px-sm py-xs font-body text-caption text-body-strong">
              {url}
            </code>
            <p className="mt-xs max-w-2xl text-caption text-muted">
              It belongs to this lead source alone. Deleting this lead source
              stops it working, and it carries no data &mdash; the script only
              says &ldquo;look now&rdquo;, and the read that follows uses the
              access you granted by sharing the sheet.
            </p>
          </div>

          <div>
            <pre className="max-h-96 overflow-auto rounded-md border border-hairline bg-canvas px-sm py-xs font-body text-caption text-body-strong">
              {source}
            </pre>
            <div className="mt-sm">
              <Button type="button" variant="outline" onClick={copy}>
                {copied ? "Copied" : "Copy the script"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
