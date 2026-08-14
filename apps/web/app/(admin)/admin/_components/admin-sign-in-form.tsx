"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { adminSignInAction, type AdminFormState } from "../actions";

export function AdminSignInForm({
  csrf,
  next,
}: {
  csrf: ReactNode;
  next: string;
}) {
  const [state, formAction] = useActionState<AdminFormState, FormData>(
    adminSignInAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-lg" noValidate>
      {csrf}
      {/* Already validated server-side before the redirect; re-validated in
          the action, because a hidden field is client-controlled. */}
      <input type="hidden" name="next" defaultValue={next} />

      <FormStatus message={state.message} />

      <Field label="Username" name="username" autoComplete="username" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}
