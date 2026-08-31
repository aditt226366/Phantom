"use client";

import { useState, type ReactNode } from "react";
import { templateVariables } from "@whatsapp-os/core/whatsapp";
import { Button } from "@/components/ui/button";

export interface PickableTemplate {
  id: string;
  name: string;
  language: string;
  /** The body text, so the variables can be counted and previewed. */
  body: string;
}

/**
 * Choose an approved template and fill in its variables.
 *
 * ---------------------------------------------------------------------------
 * The variables are the point, not the picker
 * ---------------------------------------------------------------------------
 *
 * A template with {{1}} in it cannot be sent by choosing it. Meta matches
 * parameters positionally, so every variable needs a value at send time, and a
 * picker that only picks would produce a message reading "Hi {{1}}" to a real
 * customer - or a Graph refusal, depending on which Meta rejects first.
 *
 * So selecting a template with variables reveals one input per variable, and
 * Send stays disabled until each has something in it. The numbering shown is
 * Meta's own, because that is what a tenant sees in the Studio and in Business
 * Manager, and renumbering it here to "first value / second value" would make
 * the two screens describe the same template differently.
 */
export function TemplatePicker({
  templates,
  conversationId,
  action,
  csrf,
}: {
  templates: PickableTemplate[];
  conversationId: string;
  action: (formData: FormData) => void;
  csrf: ReactNode;
}) {
  /*
   * The first one, not an empty prompt.
   *
   * A "Choose a template…" default costs a click to learn anything at all, and
   * what somebody needs to see is the body and how many values it wants - which
   * is the difference between a template being sendable now and needing three
   * things typed first. Send stays disabled until every variable has a value,
   * so preselecting cannot send anything by itself.
   *
   * Ordered by name upstream, so "first" is stable rather than whichever row
   * the database felt like returning.
   */
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const [values, setValues] = useState<string[]>([]);

  const selected = templates.find((template) => template.id === selectedId);
  const variables = selected ? templateVariables(selected.body) : [];
  const ready =
    selected !== undefined &&
    variables.every((n) => (values[n - 1] ?? "").trim().length > 0);

  if (templates.length === 0) {
    /* Named rather than hidden. A tenant whose window has closed and who has
       no approved template needs to know that is why, and where to go. */
    return (
      <p className="text-caption text-muted">
        No approved templates yet — one is the only way to reach somebody
        outside the 24-hour window.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-sm">
      {csrf}
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="templateId" value={selectedId} />

      <select
        value={selectedId}
        onChange={(event) => {
          setSelectedId(event.target.value);
          /* Cleared on change: values typed for one template's {{1}} are not
             values for another's, and carrying them over would send whichever
             was left behind. */
          setValues([]);
        }}
        aria-label="Template"
        className="w-full rounded-md border border-hairline-strong bg-surface-card px-sm py-xs text-body-sm text-ink"
      >
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name} ({template.language})
          </option>
        ))}
      </select>

      {selected ? (
        <p className="min-w-0 whitespace-pre-wrap break-words rounded-md border border-hairline bg-canvas px-sm py-xs text-caption text-body">
          {selected.body}
        </p>
      ) : null}

      {variables.map((n) => (
        <label key={n} className="flex min-w-0 items-center gap-xs">
          <span className="shrink-0 text-caption text-muted">{`{{${n}}}`}</span>
          <input
            name={`parameter_${n}`}
            value={values[n - 1] ?? ""}
            onChange={(event) => {
              const next = [...values];
              next[n - 1] = event.target.value;
              setValues(next);
            }}
            className="w-full rounded-md border border-hairline-strong bg-surface-card px-sm py-xs text-body-sm text-ink"
          />
        </label>
      ))}

      <div>
        <Button type="submit" disabled={!ready}>
          Send template
        </Button>
      </div>
    </form>
  );
}
