"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { signInAction, type AuthFormState } from "../actions";

/**
 * Sign-in form.
 *
 * No per-field errors, by design: the action returns one message for every
 * failure, and marking a field invalid would say which half was wrong.
 */
export function SignInForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    signInAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-lg" noValidate>
      {csrf}

      <FormStatus message={state.message} />

      <div className="flex flex-col gap-lg">
        <Field label="Username" name="username" autoComplete="username" required />
        <Field
          label="Password"
          name="password"
          type="password"
          /* current-password asks a manager to fill the saved one. */
          autoComplete="current-password"
          required
        />
      </div>

      <SubmitButton>Sign in</SubmitButton>
    </form>
  );
}

function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Signing in…" : children}
    </Button>
  );
}
