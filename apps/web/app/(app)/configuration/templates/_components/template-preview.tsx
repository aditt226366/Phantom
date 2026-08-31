"use client";

import { fillVariables, type TemplateComponent } from "@whatsapp-os/core/whatsapp";

/**
 * What the customer will see, rendered from the array that goes to Meta.
 *
 * ---------------------------------------------------------------------------
 * This component takes components, not a draft
 * ---------------------------------------------------------------------------
 *
 * That signature is decision 10, expressed as a type. It cannot read the
 * builder's state, so it cannot render anything the submission does not
 * contain — a footer the submission drops, a button the submission reorders, a
 * variable the submission leaves raw. The only thing it adds is substituting
 * the samples, and it does that to the submission's own text.
 *
 * Give it a `draft` instead and the guarantee is gone: the preview would then
 * be a second reading of the same intent, free to disagree with the first, and
 * the disagreement would surface as a message somebody approved that their
 * customer did not receive.
 */
export function TemplatePreview({
  components,
  samples,
}: {
  components: TemplateComponent[];
  samples: string[];
}) {
  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  const footer = components.find((c) => c.type === "FOOTER");
  const buttons = components.find((c) => c.type === "BUTTONS");

  return (
    <div className="rounded-xl border border-hairline bg-canvas p-base">
      <p className="mb-sm text-caption-uppercase uppercase text-muted">Preview</p>

      {/* The chat ground, so the bubble reads as a message rather than a card. */}
      <div className="rounded-lg bg-surface-strong p-sm">
        {/* min-w-0 and break-words: every string in here is typed by a tenant
            and has no bounded length. R4's shape, on the widest page we have. */}
        <div className="min-w-0 max-w-narrow rounded-xl border border-hairline bg-surface-card p-sm">
          {header && header.type === "HEADER" ? (
            header.format === "TEXT" ? (
              <p className="mb-xs break-words text-body-strong text-ink">
                {fillVariables(header.text, samples)}
              </p>
            ) : (
              /* A media header carries no content until send time — Meta wants
                 the file then, not now. Named rather than drawn as an empty
                 box, so the preview is not quietly lying about what arrives. */
              <p className="mb-xs rounded-md border border-dashed border-hairline-strong px-sm py-xs text-caption text-muted">
                {header.format.toLowerCase()} attached at send time
              </p>
            )
          ) : null}

          {/*
            The text, not merely the presence of the component. buildComponents
            always emits a BODY - Meta requires one and an empty template still
            has the field - so testing for the component alone rendered an empty
            paragraph inside an empty bubble, and the guidance below never
            appeared at all. Found by looking at the screenshot.
          */}
          {body && body.type === "BODY" && body.text.trim().length > 0 ? (
            <p className="whitespace-pre-wrap break-words text-body-sm text-ink">
              {fillVariables(body.text, samples)}
            </p>
          ) : (
            <p className="text-body-sm text-muted-soft">Write a body to see it here.</p>
          )}

          {footer && footer.type === "FOOTER" ? (
            <p className="mt-xs break-words text-caption text-muted">{footer.text}</p>
          ) : null}
        </div>

        {buttons && buttons.type === "BUTTONS" && buttons.buttons.length > 0 ? (
          <div className="mt-xs flex flex-col gap-xxs">
            {buttons.buttons.map((button, index) => (
              <div
                key={`${button.type}-${index}`}
                className="min-w-0 max-w-narrow truncate rounded-lg border border-hairline bg-surface-card px-sm py-xs text-center text-caption text-ink"
              >
                {button.text}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
