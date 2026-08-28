"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  buildComponents,
  CATEGORY_NOTES,
  CATEGORY_RECATEGORISATION_NOTE,
  emptyDraft,
  slugifyTemplateName,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LIMITS,
  templateVariables,
  validateTemplate,
  type HeaderFormat,
  type TemplateCategory,
  type TemplateDraft,
} from "@whatsapp-os/core/whatsapp";
import { Button } from "@/components/ui/button";
import { TemplatePreview } from "./template-preview";

/**
 * The Template Studio: builder on the left, live preview on the right.
 *
 * ---------------------------------------------------------------------------
 * At 390px it is not a split screen, and that is decided here
 * ---------------------------------------------------------------------------
 *
 * A split screen does not split at phone width — two 195px columns are two
 * unusable columns. So below the desktop breakpoint this is one column, and the
 * order is the decision: **the preview comes first, the builder follows.**
 *
 * Builder-first is the obvious arrangement and it is the wrong one. The builder
 * is six controls tall; the preview would sit six hundred pixels below the fold
 * and effectively not exist, which turns the one feature this screen is for
 * into something you have to go and look for. Preview-first means the first
 * thing on screen is what the customer will see, and the controls that change
 * it are underneath.
 *
 * Not sticky, deliberately. A pinned preview eats a third of an 844px viewport
 * and leaves the body field in a slot too short to write a paragraph in — and
 * the capture-time stylesheet flattens `position: sticky` anyway, so a sticky
 * layout would be photographed in a state no user ever sees.
 *
 * This is the widest thing in the product, so every string a tenant types is
 * inside `min-w-0` with `break-words`, and the suite asserts the page is
 * narrower than the viewport before it photographs it (R4).
 */
export function Studio({
  action,
  csrf,
  initial,
  submitLabel,
  quota,
}: {
  /** The server action the form posts to. */
  action: (formData: FormData) => void;
  csrf: ReactNode;
  initial?: TemplateDraft;
  submitLabel: string;
  /** Rendered above the submit, when editing something that exists. */
  quota?: ReactNode;
}) {
  const [draft, setDraft] = useState<TemplateDraft>(initial ?? emptyDraft());

  /* The one assembly. The preview below reads this, and so does the hidden
     field that carries it to the server — there is no second construction of
     the same thing anywhere on this screen. */
  const components = useMemo(() => buildComponents(draft), [draft]);
  const issues = useMemo(() => validateTemplate(draft), [draft]);
  const variables = useMemo(() => templateVariables(draft.body), [draft.body]);

  const set = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  const issueFor = (field: string): string | undefined =>
    issues.find((issue) => issue.field === field)?.message;

  return (
    <form action={action} className="flex flex-col gap-lg desktop:grid desktop:grid-cols-2 desktop:items-start">
      {csrf}
      <input type="hidden" name="draft" value={JSON.stringify(draft)} />

      {/*
        Preview first in the DOM so it is first on a phone, and moved to the
        right-hand column on desktop with `order`. One DOM order, two layouts —
        rather than rendering the preview twice and hiding one, which would put
        two copies of the thing decision 10 exists to keep singular on one page.
      */}
      <div className="desktop:order-2 desktop:sticky desktop:top-lg">
        <TemplatePreview components={components} samples={draft.samples} />
      </div>

      <div className="flex flex-col gap-base desktop:order-1">
        <Field label="Name" hint="Lowercase, digits and underscores." error={issueFor("name")}>
          <input
            value={draft.name}
            onChange={(event) => set("name", slugifyTemplateName(event.target.value))}
            placeholder="order_shipped"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-1 gap-base tablet:grid-cols-2">
          <Field label="Language">
            <input
              value={draft.language}
              onChange={(event) => set("language", event.target.value)}
              placeholder="en_US"
              className={inputClass}
            />
          </Field>

          <Field label="Category">
            <select
              value={draft.category}
              onChange={(event) => set("category", event.target.value as TemplateCategory)}
              className={inputClass}
            >
              {TEMPLATE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* The price note, which is the reason category is a decision rather
            than a dropdown. Both halves render: what this one costs, and that
            Meta may move it regardless. */}
        <p className="text-caption text-body">{CATEGORY_NOTES[draft.category]}</p>
        <p className="text-caption text-muted">{CATEGORY_RECATEGORISATION_NOTE}</p>

        <Field label="Header">
          <select
            value={draft.headerFormat}
            onChange={(event) => set("headerFormat", event.target.value as HeaderFormat)}
            className={inputClass}
          >
            {(["NONE", "TEXT", "IMAGE", "DOCUMENT", "VIDEO"] as const).map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </Field>

        {draft.headerFormat === "TEXT" ? (
          <Field
            label="Header text"
            hint={counter(draft.headerText.length, TEMPLATE_LIMITS.header)}
            error={issueFor("header")}
          >
            <input
              value={draft.headerText}
              onChange={(event) => set("headerText", event.target.value)}
              className={inputClass}
            />
          </Field>
        ) : null}

        <Field
          label="Body"
          hint={counter(draft.body.length, TEMPLATE_LIMITS.body)}
          error={issueFor("body")}
        >
          <textarea
            value={draft.body}
            onChange={(event) => set("body", event.target.value)}
            rows={5}
            placeholder="Hi {{1}}, your order {{2}} has shipped."
            className={inputClass}
          />
        </Field>

        {variables.length > 0 ? (
          <Field
            label="Example values"
            hint="Meta's reviewer reads these, so they should look like real data."
            error={issueFor("samples")}
          >
            <div className="flex flex-col gap-xs">
              {variables.map((n) => (
                <div key={n} className="flex items-center gap-xs">
                  <span className="shrink-0 text-caption text-muted">{`{{${n}}}`}</span>
                  <input
                    value={draft.samples[n - 1] ?? ""}
                    onChange={(event) => {
                      const next = [...draft.samples];
                      next[n - 1] = event.target.value;
                      set("samples", next);
                    }}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>
          </Field>
        ) : null}

        <Field
          label="Footer"
          hint={counter(draft.footer.length, TEMPLATE_LIMITS.footer)}
          error={issueFor("footer")}
        >
          <input
            value={draft.footer}
            onChange={(event) => set("footer", event.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Buttons" error={issueFor("buttons")}>
          <select
            value={draft.buttonKind}
            onChange={(event) =>
              set("buttonKind", event.target.value as TemplateDraft["buttonKind"])
            }
            className={inputClass}
          >
            <option value="NONE">None</option>
            <option value="QUICK_REPLY">Quick replies</option>
            <option value="CALL_TO_ACTION">Call to action</option>
          </select>
        </Field>

        {draft.buttonKind === "QUICK_REPLY" ? (
          <div className="flex flex-col gap-xs">
            {Array.from({ length: TEMPLATE_LIMITS.quickReplies }, (_, index) => (
              <input
                key={index}
                value={draft.quickReplies[index] ?? ""}
                onChange={(event) => {
                  const next = [...draft.quickReplies];
                  next[index] = event.target.value;
                  set("quickReplies", next);
                }}
                placeholder={`Quick reply ${index + 1}`}
                className={inputClass}
              />
            ))}
          </div>
        ) : null}

        {draft.buttonKind === "CALL_TO_ACTION" ? (
          <div className="flex flex-col gap-xs">
            <input
              value={draft.urlButton?.text ?? ""}
              onChange={(event) =>
                set("urlButton", {
                  text: event.target.value,
                  url: draft.urlButton?.url ?? "",
                })
              }
              placeholder="Link button text"
              className={inputClass}
            />
            <input
              value={draft.urlButton?.url ?? ""}
              onChange={(event) =>
                set("urlButton", {
                  text: draft.urlButton?.text ?? "",
                  url: event.target.value,
                })
              }
              placeholder="https://example.com/orders"
              className={inputClass}
            />
            <input
              value={draft.phoneButton?.text ?? ""}
              onChange={(event) =>
                set("phoneButton", {
                  text: event.target.value,
                  phone: draft.phoneButton?.phone ?? "",
                })
              }
              placeholder="Call button text"
              className={inputClass}
            />
            <input
              value={draft.phoneButton?.phone ?? ""}
              onChange={(event) =>
                set("phoneButton", {
                  text: draft.phoneButton?.text ?? "",
                  phone: event.target.value,
                })
              }
              placeholder="+919812345670"
              className={inputClass}
            />
          </div>
        ) : null}

        {quota}

        {/*
          Disabled on validation, and only on validation this side of Meta.
          Everything checked here is a rule Meta publishes and refuses on, so
          blocking it costs a round trip and teaches the tenant the rule. The
          edit quota is the opposite case and is never a disabled button (R8) —
          it is a number this app cannot know, so submitting attempts it and
          decodes the refusal.
        */}
        <div className="flex flex-wrap items-center gap-sm">
          <Button type="submit" disabled={issues.length > 0}>
            {submitLabel}
          </Button>
          {issues.length > 0 ? (
            <span className="text-caption text-muted">
              {issues.length} thing{issues.length === 1 ? "" : "s"} to fix first
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-hairline-strong bg-surface-card px-sm py-xs text-body-sm text-ink placeholder:text-muted-soft";

function counter(used: number, limit: number): string {
  return `${used} / ${limit}`;
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-xxs">
      <span className="flex flex-wrap items-baseline justify-between gap-xs">
        <span className="text-caption-uppercase uppercase text-muted">{label}</span>
        {hint ? <span className="text-caption text-muted-soft">{hint}</span> : null}
      </span>
      {children}
      {error ? <span className="text-caption text-error">{error}</span> : null}
    </label>
  );
}
