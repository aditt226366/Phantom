"use client";

import * as React from "react";
import Link from "next/link";
import {
  POLL_INTERVAL_DEFAULT_SECONDS,
  POLL_INTERVAL_MIN_SECONDS,
} from "@whatsapp-os/core/leads";
import { fillVariables } from "@whatsapp-os/core/whatsapp";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { mapLeadSourceAction } from "../actions";

/**
 * The mapping, the tab, the interval, and a preview of three real messages.
 *
 * The preview is why this is a client component. It renders through the SAME
 * fillVariables the send path uses, over the same body text, so what is on
 * screen is what a lead receives. A second renderer written for the preview -
 * a regex over {{n}} - is how a preview comes to be reassuring and wrong.
 *
 * It matters more here than on a bulk import. A broadcast is one list somebody
 * watched go out; this runs unattended for months, so a swapped column is
 * wrong for every customer who ever fills in that form.
 */

/** The intervals offered, and what each costs. See POLL_INTERVAL_* in core. */
const INTERVALS = [
  { seconds: 10, label: "Every 10 seconds" },
  { seconds: 30, label: "Every 30 seconds" },
  { seconds: 60, label: "Every minute" },
  { seconds: 300, label: "Every 5 minutes" },
  { seconds: 1800, label: "Every 30 minutes" },
] as const;

export function LeadMappingForm({
  leadSourceId,
  tabs,
  currentTab,
  headers,
  previewRows,
  totalRows,
  body,
  variables,
  initialPhone,
  initialVariables,
  initialInterval,
  csrf,
}: {
  leadSourceId: string;
  tabs: string[];
  currentTab: string;
  headers: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
  body: string;
  /** Meta's positions, sorted. From templateVariables. */
  variables: number[];
  initialPhone: string;
  initialVariables: Record<string, string>;
  initialInterval: number;
  csrf: React.ReactNode;
}) {
  const [phone, setPhone] = React.useState(initialPhone);
  const [mapping, setMapping] = React.useState<Record<string, string>>(() => ({
    ...initialVariables,
  }));

  const selectClass =
    "w-full rounded-md border border-hairline-strong bg-canvas px-sm py-xs font-body text-body-sm text-ink";

  const missing = [
    ...(phone ? [] : ["the phone column"]),
    ...variables.filter((n) => !mapping[String(n)]).map((n) => `{{${n}}}`),
  ];

  return (
    <div className="flex flex-col gap-lg">
      {/*
        Its own GET form, because switching tab changes the headers and only
        the server knows them. A client-side switch would have to guess, and a
        guess that is wrong offers columns the tab does not have.
      */}
      {tabs.length > 1 ? (
        <form
          method="get"
          className="flex flex-wrap items-end gap-sm rounded-lg border border-hairline bg-surface-card px-base py-base"
        >
          <div className="flex min-w-0 flex-col gap-xxs">
            <Label htmlFor="tab-select">Tab</Label>
            <select
              id="tab-select"
              name="tab"
              defaultValue={currentTab}
              className={selectClass}
            >
              {tabs.map((tab) => (
                <option key={tab} value={tab}>
                  {tab}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="outline">
            Read this tab
          </Button>
        </form>
      ) : null}

      <form action={mapLeadSourceAction} className="flex flex-col gap-lg">
        {csrf}
        <input type="hidden" name="leadSourceId" value={leadSourceId} />
        <input type="hidden" name="tab" value={currentTab} />

        <div className="grid gap-lg desktop:grid-cols-2">
          <div className="rounded-lg border border-hairline bg-surface-card px-base py-base">
            <h2 className="text-title-sm text-ink">Columns</h2>
            <p className="mt-xxs text-caption text-muted">
              {currentTab} · {totalRows.toLocaleString()} rows today
            </p>

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
                  This template has no placeholders, so every lead gets the same
                  message.
                </p>
              ) : null}

              <div className="flex flex-col gap-xxs">
                <Label htmlFor="poll-interval">How often to look</Label>
                <select
                  id="poll-interval"
                  name="pollIntervalSeconds"
                  defaultValue={String(initialInterval || POLL_INTERVAL_DEFAULT_SECONDS)}
                  className={selectClass}
                >
                  {INTERVALS.map((option) => (
                    <option key={option.seconds} value={option.seconds}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-caption text-muted">
                  Google limits how often every workspace here can read a
                  spreadsheet between them, which is why{" "}
                  {POLL_INTERVAL_MIN_SECONDS} seconds is the fastest offered.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-hairline bg-surface-card px-base py-base">
            <h2 className="text-title-sm text-ink">
              What the next {previewRows.length} would receive
            </h2>

            {previewRows.length === 0 ? (
              <p className="mt-base text-body-sm text-body">
                That tab has a header row and no data yet. The mapping can still
                be saved, and rows added later will be picked up.
              </p>
            ) : (
              <ul className="mt-base flex flex-col gap-sm">
                {previewRows.map((row, index) => {
                  const values = variables.map(
                    (n) => row[mapping[String(n)] ?? ""] ?? "",
                  );

                  return (
                    <li
                      key={index}
                      className="rounded-md border border-hairline-strong bg-surface-strong px-base py-sm"
                    >
                      <p className="break-all text-caption text-muted">
                        {/* The number as it appears in the sheet. Normalising
                            it here would hide the row that is about to be
                            rejected, which is the row worth seeing. */}
                        {phone
                          ? row[phone] || "— no number in this row —"
                          : "— no column chosen —"}
                      </p>
                      <p className="mt-xxs whitespace-pre-wrap text-body-sm text-ink">
                        {fillVariables(body, values)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/*
          Stated where the decision is taken, in its own plate rather than as a
          caption beside the button.

          A tenant who binds a sheet holding five thousand leads, presses Save
          and start, and sees nothing happen concludes the feature is broken -
          and they are not being unreasonable, because the page above says
          "every new row becomes a lead" and five thousand rows are, to them,
          new. The behaviour is right; the silence is the bug.

          Rendered whether or not the mapping is finished, because somebody
          reading this screen for the first time should learn it before they
          have committed to anything.
        */}
        <section className="rounded-lg border border-hairline-strong bg-surface-strong px-base py-base">
          {totalRows > 0 ? (
            <>
              <p className="text-body-strong text-ink">
                The {totalRows.toLocaleString()}{" "}
                {totalRows === 1 ? "row" : "rows"} already in this tab will not
                be contacted.
              </p>
              <p className="mt-xs max-w-2xl text-body-sm text-body">
                A lead source picks up rows added from the moment you start it.
                Nothing that is in the sheet today is messaged, so binding a
                sheet cannot surprise a list of people who enquired months ago.
              </p>
              <p className="mt-xs max-w-2xl text-body-sm text-body">
                To message the ones already there,{" "}
                <Link
                  href="/bulk-messaging"
                  className="text-ink underline underline-offset-2"
                >
                  use Bulk messaging
                </Link>{" "}
                &mdash; it shows you who is on the list and what it will cost
                before anything is sent.
              </p>
            </>
          ) : (
            <p className="max-w-2xl text-body-sm text-body">
              This tab has no rows yet, so there is no backlog to skip. Every
              row added from now on becomes a lead.
            </p>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-sm">
          <Button type="submit" disabled={missing.length > 0}>
            Save and start
          </Button>
          {missing.length > 0 ? (
            <p className="text-body-sm text-body">
              Still to map: {missing.join(", ")}.
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
