"use client";

import * as React from "react";
import { fillVariables } from "@whatsapp-os/core/whatsapp";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { mapColumnsAction } from "../actions";

/**
 * The mapping, and a preview of what three real recipients will receive.
 *
 * The preview is the reason this component is a client one. A mapping is easy
 * to get wrong in a way that is invisible as a set of dropdowns and obvious as
 * a sentence: "Hi 98765 43210, your order 1204 is ready" is two columns
 * swapped, and nobody reads it as such until they see the message.
 *
 * It renders through the SAME fillVariables the send path uses, over the same
 * body text, so what is on screen is what a recipient gets. A second renderer
 * here - a regex written for the preview - is how a preview comes to be
 * reassuring and wrong.
 */
export function MappingForm({
  broadcastId,
  headers,
  previewRows,
  body,
  variables,
  initialPhone,
  initialVariables,
  csrf,
}: {
  broadcastId: string;
  headers: string[];
  previewRows: Record<string, string>[];
  body: string;
  /** Meta's positions, sorted. From templateVariables. */
  variables: number[];
  initialPhone: string;
  initialVariables: Record<string, string>;
  csrf: React.ReactNode;
}) {
  const [phone, setPhone] = React.useState(initialPhone);
  const [mapping, setMapping] = React.useState<Record<string, string>>(
    () => ({ ...initialVariables }),
  );

  const selectClass =
    "w-full rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink";

  const missing = [
    ...(phone ? [] : ["the phone column"]),
    ...variables.filter((n) => !mapping[String(n)]).map((n) => `{{${n}}}`),
  ];

  return (
    <form action={mapColumnsAction} className="flex flex-col gap-lg">
      {csrf}
      <input type="hidden" name="broadcastId" value={broadcastId} />

      <div className="grid gap-lg desktop:grid-cols-2">
        <div className="rounded-lg border border-hairline bg-surface-card px-base py-base">
          <h2 className="text-title-sm text-ink">Columns</h2>

          <div className="mt-base flex flex-col gap-base">
            <div className="flex flex-col gap-xxs">
              <Label htmlFor="phone-column">Phone number</Label>
              <select
                id="phone-column"
                name="phoneColumn"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className={selectClass}
              >
                <option value="">Choose a column…</option>
                {headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
              <p className="text-caption text-muted">
                Numbers without a country code are read as Indian.
              </p>
            </div>

            {variables.map((position) => (
              <div key={position} className="flex flex-col gap-xxs">
                <Label htmlFor={`variable-${position}`}>
                  {`Placeholder {{${position}}}`}
                </Label>
                <select
                  id={`variable-${position}`}
                  name={`variable_${position}`}
                  value={mapping[String(position)] ?? ""}
                  onChange={(event) =>
                    setMapping((current) => ({
                      ...current,
                      [String(position)]: event.target.value,
                    }))
                  }
                  className={selectClass}
                >
                  <option value="">Choose a column…</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
            ))}

            {variables.length === 0 ? (
              <p className="text-body-sm text-body">
                This template has no placeholders, so every recipient gets the
                same message.
              </p>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-hairline bg-surface-card px-base py-base">
          <h2 className="text-title-sm text-ink">
            What the first {previewRows.length} will receive
          </h2>

          <ul className="mt-base flex flex-col gap-sm">
            {previewRows.map((row, index) => {
              const values = variables.map((n) => row[mapping[String(n)] ?? ""] ?? "");

              return (
                <li
                  key={index}
                  className="rounded-md border border-hairline-strong bg-surface-strong px-base py-sm"
                >
                  <p className="text-caption text-muted">
                    {/* The number as it appears in the file. Normalisation
                        happens on the server, and showing a normalised value
                        here would hide the row that is about to be rejected. */}
                    {phone ? row[phone] || "— no number in this row —" : "— no column chosen —"}
                  </p>
                  <p className="mt-xxs whitespace-pre-wrap text-body-sm text-ink">
                    {fillVariables(body, values)}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <Button type="submit" disabled={missing.length > 0}>
          Check the list
        </Button>
        {missing.length > 0 ? (
          <p className="text-body-sm text-body">
            Still to map: {missing.join(", ")}.
          </p>
        ) : null}
      </div>
    </form>
  );
}
