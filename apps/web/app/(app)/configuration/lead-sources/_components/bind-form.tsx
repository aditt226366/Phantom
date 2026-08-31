"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { bindSheetAction, type BindState } from "../actions";

/**
 * The binding form.
 *
 * Three fields and a paste. The sheet's id is parsed out of whatever they
 * paste on the server, because what arrives is an address-bar URL with a
 * fragment on it, not an id - nobody has ever gone looking for the id on its
 * own.
 *
 * The submit is deliberately worded as a check rather than a save. It performs
 * a real call to Google before anything is written, so "Check and continue" is
 * what it does; "Save" would promise a write that a missing share prevents.
 */

export interface BindTemplateOption {
  id: string;
  name: string;
  language: string;
  body: string;
}

export interface BindNumberOption {
  id: string;
  label: string;
  status: string;
}

export function BindForm({
  templates,
  numbers,
  csrf,
}: {
  templates: BindTemplateOption[];
  numbers: BindNumberOption[];
  csrf: React.ReactNode;
}) {
  const [state, action, pending] = useActionState<BindState, FormData>(
    bindSheetAction,
    {},
  );

  const [templateId, setTemplateId] = React.useState(templates[0]?.id ?? "");
  const selected = templates.find((t) => t.id === templateId) ?? templates[0];

  const fieldClass =
    "w-full rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink";

  return (
    <form action={action} className="flex flex-col gap-lg">
      {csrf}

      <div className="rounded-lg border border-hairline bg-surface-card px-base py-base">
        <div className="flex flex-col gap-base">
          <div className="flex flex-col gap-xxs">
            <Label htmlFor="lead-source-name">Name</Label>
            <input
              id="lead-source-name"
              name="name"
              placeholder="Website enquiries"
              defaultValue={state.values?.name ?? ""}
              className={fieldClass}
            />
            <p className="text-caption text-muted">
              Optional. Defaults to the name of the tab.
            </p>
          </div>

          <div className="flex flex-col gap-xxs">
            <Label htmlFor="lead-source-url">Google Sheet link</Label>
            <input
              id="lead-source-url"
              name="sheetUrl"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              defaultValue={state.values?.sheetUrl ?? ""}
              className={fieldClass}
            />
            <p className="text-caption text-muted">
              Copy it straight from your browser&rsquo;s address bar. The tab you
              are looking at is the one we will offer first.
            </p>
          </div>

          <div className="flex flex-col gap-xxs">
            <Label htmlFor="lead-source-template">Template to send</Label>
            <select
              id="lead-source-template"
              name="templateId"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className={fieldClass}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} · {template.language}
                </option>
              ))}
            </select>
            <p className="text-caption text-muted">
              Only approved templates. A new lead has never written to you, so a
              template is the only thing WhatsApp permits.
            </p>
          </div>

          {selected ? (
            <div className="rounded-md border border-hairline-strong bg-surface-strong px-base py-sm">
              <p className="text-caption-uppercase text-muted">They will receive</p>
              <p className="mt-xxs whitespace-pre-wrap text-body-sm text-ink">
                {selected.body}
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-xxs">
            <Label htmlFor="lead-source-number">Send from</Label>
            <select
              id="lead-source-number"
              name="whatsappNumberId"
              className={fieldClass}
              defaultValue={numbers[0]?.id ?? ""}
            >
              {numbers.map((number) => (
                <option key={number.id} value={number.id}>
                  {number.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <FormStatus message={state.message} />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Checking the sheet…" : "Check and continue"}
        </Button>
      </div>
    </form>
  );
}
