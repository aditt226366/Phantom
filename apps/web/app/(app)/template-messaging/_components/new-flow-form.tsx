"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { createFlowAction, type FlowFormState } from "../actions";

/**
 * Name it, and pick the template that opens it.
 *
 * The CSRF field arrives as a prop rather than an import. It is a Server
 * Component - `cookies()` is server-only - and a client module importing one
 * drags next/headers into the browser graph, which fails the build with an
 * import trace that names every file except this one.
 */
export function NewFlowForm({
  templates,
  csrf,
}: {
  templates: ReadonlyArray<{ id: string; name: string; language: string }>;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<FlowFormState, FormData>(
    createFlowAction,
    {},
  );

  return (
    <form action={action} className="flex max-w-narrow flex-col gap-base">
      {/* Rendered on the server and passed through; see the note above. */}
      {csrf}

      <Field
        label="Name"
        name="name"
        required
        maxLength={120}
        placeholder="New enquiry"
        description="Only your team sees this."
      />

      <div>
        <Label htmlFor="templateId">Opening template</Label>
        <p className="mb-xxs text-caption text-muted">
          Its quick-reply buttons are what a customer taps to start the flow.
          Only approved templates can do that.
        </p>
        <select
          id="templateId"
          name="templateId"
          required
          className="h-input w-full rounded-md border border-hairline-strong bg-surface-card px-sm text-body-sm text-ink focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.language})
            </option>
          ))}
        </select>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          Create flow
        </Button>
      </div>

      <FormStatus message={state.message} tone="error" />
    </form>
  );
}
