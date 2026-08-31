"use client";

import * as React from "react";
import { useActionState } from "react";
import type { KycKind } from "@whatsapp-os/core/kyc";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import {
  uploadKycDocumentAction,
  type UploadDocumentState,
} from "../actions";

/**
 * The upload control for one document.
 *
 * A form and a real file input, not a drag-and-drop surface with a hidden
 * field. The plain control works without JavaScript, is the one every
 * assistive technology already understands, and is what a phone opens its own
 * file picker for.
 *
 * `accept` is a convenience for the picker and nothing more. The file type is
 * decided from the first five bytes on the server, because accept is a filter
 * a browser applies to a dialog and not a rule anybody has to obey.
 */
export interface UploadControlProps {
  kind: KycKind;
  label: string;
  /** False once approved. The action refuses it too - this hides the control. */
  replaceable: boolean;
  /** True when a document of this kind already exists, changing the verb. */
  replacing: boolean;
  csrf: React.ReactNode;
}

export function UploadControl({
  kind,
  label,
  replaceable,
  replacing,
  csrf,
}: UploadControlProps) {
  const [state, action, pending] = useActionState<UploadDocumentState, FormData>(
    uploadKycDocumentAction,
    {},
  );

  const inputId = `kyc-file-${kind}`;

  if (!replaceable) return null;

  return (
    <form action={action} className="flex flex-col gap-xs">
      {csrf}
      <input type="hidden" name="kind" value={kind} />

      <div className="flex flex-wrap items-center gap-xs">
        {/* The label names the document, not "the file". Three of these on one
            page all reading "Choose file" is three identical announcements to
            a screen reader. */}
        <label htmlFor={inputId} className="sr-only">
          {replacing ? `Replace ${label}` : `Upload ${label}`} (PDF, up to 5 MB)
        </label>

        <input
          id={inputId}
          type="file"
          name="file"
          accept="application/pdf"
          required
          className="max-w-full text-body-sm text-body file:mr-sm file:rounded-pill file:border file:border-hairline-strong file:bg-surface-strong file:px-sm file:py-xxs file:font-body file:text-body-sm file:text-ink"
        />

        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Uploading…" : replacing ? "Replace" : "Upload"}
        </Button>
      </div>

      <FormStatus
        message={state.message ?? state.success}
        tone={state.message ? "error" : "success"}
      />
    </form>
  );
}
