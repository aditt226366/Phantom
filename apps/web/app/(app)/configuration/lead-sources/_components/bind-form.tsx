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

/**
 * A published flow this binding could start instead of sending one template.
 *
 * Only published ones are offered. A draft has no version customers can be put
 * into, and a binding pointed at one would contact real leads with buttons
 * that resolve to nothing.
 */
export interface BindFlowOption {
  /** The VERSION, not the flow. A run pins its version; so does a binding. */
  versionId: string;
  name: string;
  /** The entry template's own name, so the choice says what actually goes out. */
  templateName: string;
}

export interface BindNumberOption {
  id: string;
  label: string;
  status: string;
}

export function BindForm({
  flows,
  templates,
  numbers,
  csrf,
}: {
  templates: BindTemplateOption[];
  flows: BindFlowOption[];
  numbers: BindNumberOption[];
  csrf: React.ReactNode;
}) {
  const [state, action, pending] = useActionState<BindState, FormData>(
    bindSheetAction,
    {},
  );

  const [templateId, setTemplateId] = React.useState(templates[0]?.id ?? "");
  const selected = templates.find((t) => t.id === templateId) ?? templates[0];
  /*
   * What happens to a new row. The second member of the action column, and the
   * only thing on this form that changes between them - the sheet, the tab and
   * the number are the same question either way.
   */
  const [actionKind, setActionKind] = React.useState<"TEMPLATE" | "FLOW">(
    "TEMPLATE",
  );

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
            <Label htmlFor="lead-source-action">What happens with a new row</Label>
            <select
              id="lead-source-action"
              name="actionKind"
              value={actionKind}
              onChange={(event) =>
                setActionKind(event.target.value === "FLOW" ? "FLOW" : "TEMPLATE")
              }
              className={fieldClass}
              disabled={flows.length === 0}
            >
              <option value="TEMPLATE">Send one template</option>
              <option value="FLOW" disabled={flows.length === 0}>
                Start a flow
              </option>
            </select>
            <p className="text-caption text-muted">
              {flows.length === 0
                ? "Publish a flow in Template Messaging and it will appear here."
                : "A flow opens with its own approved template, so a new lead is contacted the same way either way. What differs is that their answer goes somewhere."}
            </p>
          </div>

          {actionKind === "FLOW" ? (
            <div className="flex flex-col gap-xxs">
              <Label htmlFor="lead-source-flow">Flow to start</Label>
              <select
                id="lead-source-flow"
                name="flowVersionId"
                className={fieldClass}
                defaultValue={flows[0]?.versionId ?? ""}
              >
                {flows.map((flow) => (
                  <option key={flow.versionId} value={flow.versionId}>
                    {flow.name} · opens with {flow.templateName}
                  </option>
                ))}
              </select>
              <p className="text-caption text-muted">
                The version that is live now. Republishing the flow later does
                not move this binding, so an import already under way cannot be
                split across two different trees.
              </p>
            </div>
          ) : null}

          <div
            className="flex flex-col gap-xxs"
            hidden={actionKind === "FLOW"}
          >
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

          {selected && actionKind === "TEMPLATE" ? (
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
