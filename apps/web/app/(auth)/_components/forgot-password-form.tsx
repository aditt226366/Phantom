"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import {
  forgotPasswordAction,
  resetPasswordAction,
  type PasswordFormState,
} from "../password-actions";

export function ForgotPasswordForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState<PasswordFormState, FormData>(
    forgotPasswordAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-lg" noValidate>
      {csrf}
      <FormStatus message={state.message} />
      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Submit label="Send reset link" pendingLabel="Sending…" />
    </form>
  );
}

export function ResetPasswordForm({
  csrf,
  token,
}: {
  csrf: ReactNode;
  token: string;
}) {
  const [state, formAction] = useActionState<PasswordFormState, FormData>(
    resetPasswordAction,
    {},
  );

  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-lg" noValidate>
      {csrf}
      <input type="hidden" name="token" defaultValue={token} />

      <FormStatus message={state.message} />

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

      <Submit label="Set new password" pendingLabel="Saving…" />
    </form>
  );
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? pendingLabel : label}
    </Button>
  );
}
