"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A value that exists to be copied somewhere else.
 *
 * The text is selectable and wraps rather than being hidden behind the button,
 * for two reasons: `navigator.clipboard` needs a secure context and is not
 * guaranteed anywhere, and somebody reading a support ticket needs to be able
 * to compare this against what is in Meta's console character by character.
 * The button is the convenience; the text is the contract.
 *
 * `break-all` is load-bearing rather than cosmetic. A webhook URL is seventy-odd
 * characters with no space in it, so its min-content width is the whole string —
 * exactly the automatic-minimum-size shape that has twice pushed a page wider
 * than a 390px viewport here. The screenshot suite asserts the width before it
 * photographs anything, so this is checked and not hoped for.
 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* No clipboard, or permission refused. The text above is still there to
         select, which is why it is rendered as text and not as an input. */
    }
  }

  return (
    <div className="flex flex-col gap-sm">
      <code className="block break-all rounded-md border border-hairline bg-canvas px-sm py-xs font-body text-caption text-body-strong">
        {value}
      </code>
      <div>
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? "Copied" : `Copy ${label}`}
        </Button>
      </div>
    </div>
  );
}
