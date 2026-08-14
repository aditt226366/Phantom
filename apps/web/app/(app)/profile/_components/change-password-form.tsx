"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { changePasswordAction, type ChangePasswordState } from "../actions";

export function ChangePasswordForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState<ChangePasswordState, FormData>(
    changePasswordAction,
    {},
  );

  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-lg" noValidate>
      {csrf}

      <FormStatus
        message={state.success ?? state.message}
        tone={state.success ? "success" : "error"}
      />

      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        error={errors["currentPassword"]}
        required
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        description="At least 12 characters."
        error={errors["newPassword"]}
        required
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        error={errors["confirmPassword"]}
        required
      />

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="self-start">
      {pending ? "Changing…" : "Change password"}
    </Button>
  );
}
