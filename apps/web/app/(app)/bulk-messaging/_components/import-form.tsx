"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { importListAction, type ImportState } from "../actions";

/**
 * The import step's form.
 *
 * A plain file input and two selects. No drag-and-drop surface with a hidden
 * field: the plain control works without JavaScript, every assistive
 * technology already understands it, and it is what a phone opens its own file
 * picker for.
 *
 * `accept` is a hint to the picker and nothing more. The file is parsed on the
 * server from its bytes, because the audience it produces decides who gets
 * messaged - the same reason the KYC upload reads magic bytes rather than
 * trusting a Content-Type.
 */

export interface ImportTemplateOption {
  id: string;
  name: string;
  language: string;
  body: string;
}

export interface ImportNumberOption {
  id: string;
  label: string;
  status: string;
}

export function ImportForm({
  templates,
  numbers,
  csrf,
}: {
  templates: ImportTemplateOption[];
  numbers: ImportNumberOption[];
  csrf: React.ReactNode;
}) {
  const [state, action, pending] = useActionState<ImportState, FormData>(
    importListAction,
    {},
  );

  const [templateId, setTemplateId] = React.useState(templates[0]?.id ?? "");
  const selected = templates.find((t) => t.id === templateId) ?? templates[0];

  const selectClass =
    "w-full rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink";

  return (
    <form action={action} className="flex flex-col gap-lg">
      {csrf}

      <div className="rounded-lg border border-hairline bg-surface-card px-base py-base">
        <div className="flex flex-col gap-base">
          <div className="flex flex-col gap-xxs">
            <Label htmlFor="broadcast-name">Name</Label>
            <input
              id="broadcast-name"
              name="name"
              placeholder="Diwali offer, October list"
              className={selectClass}
            />
            <p className="text-caption text-muted">
              For your own reference. Defaults to the filename.
            </p>
          </div>

          <div className="flex flex-col gap-xxs">
            <Label htmlFor="broadcast-file">Contact list</Label>
            <input
              id="broadcast-file"
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="max-w-full text-body-sm text-body file:mr-sm file:rounded-pill file:border file:border-hairline-strong file:bg-surface-strong file:px-sm file:py-xxs file:font-body file:text-body-sm file:text-ink"
            />
            <p className="text-caption text-muted">
              CSV with a header row, up to 5 MB. Excel files are not read yet —
              export as CSV first.
            </p>
          </div>

          <div className="flex flex-col gap-xxs">
            <Label htmlFor="broadcast-template">Template</Label>
            <select
              id="broadcast-template"
              name="templateId"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className={selectClass}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} ({template.language})
                </option>
              ))}
            </select>
            <p className="text-caption text-muted">
              Only approved templates. Nobody on a list has written to you, so
              WhatsApp allows nothing else.
            </p>
          </div>

          {/* The message itself, with its placeholders still in. The mapping
              step is where each one is given a column. */}
          {selected ? (
            <div className="rounded-md border border-hairline-strong bg-surface-strong px-base py-sm">
              <p className="text-caption-uppercase uppercase text-muted">
                What it says
              </p>
              <p className="mt-xxs whitespace-pre-wrap text-body-sm text-ink">
                {selected.body || "This template has no body text."}
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-xxs">
            <Label htmlFor="broadcast-number">Send from</Label>
            <select
              id="broadcast-number"
              name="whatsappNumberId"
              className={selectClass}
            >
              {numbers.map((number) => (
                <option key={number.id} value={number.id}>
                  {number.label} — {number.status}
                </option>
              ))}
            </select>
            <p className="text-caption text-muted">
              This number&rsquo;s messaging tier caps how many people you can
              reach in a day. The next step shows how much is left.
            </p>
          </div>
        </div>
      </div>

      <FormStatus message={state.message} />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Reading the file…" : "Continue to mapping"}
        </Button>
      </div>
    </form>
  );
}
