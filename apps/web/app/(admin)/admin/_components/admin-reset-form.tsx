"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { adminResetPasswordAction, type AdminFormState } from "../actions";

/**
 * The Phase 2 button, in primitive form.
 *
 * Renders the outcome and nothing else — no token, no link, no confirmation of
 * whether the account exists.
 */
export function AdminResetForm({
  csrf,
  defaultUsername = "",
}: {
  csrf: ReactNode;
  /** Prefilled from the company header, so the operator is not guessing. */
  defaultUsername?: string;
}) {
  const [state, formAction] = useActionState<AdminFormState, FormData>(
    adminResetPasswordAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-base">
      {csrf}
      <FormStatus message={state.message} tone="success" />
      <div className="flex flex-col gap-base tablet:flex-row tablet:items-end">
        <Field
          label="Username"
          name="username"
          defaultValue={defaultUsername}
          autoComplete="off"
          containerClassName="tablet:max-w-narrow tablet:flex-1"
          required
        />
        <Submit />
      </div>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={pending}>
      {pending ? "Sending…" : "Send reset link"}
    </Button>
  );
}
