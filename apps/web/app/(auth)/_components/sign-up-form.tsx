"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { signUpAction, type AuthFormState } from "../actions";

/**
 * Sign-up form.
 *
 * `csrf` is a Server Component passed as a child — cookies() cannot be read
 * from a client component, and this is how the hidden field gets here without
 * making the whole form server-rendered.
 */
export function SignUpForm({ csrf }: { csrf: ReactNode }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    signUpAction,
    {},
  );

  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-lg" noValidate>
      {csrf}

      <FormStatus message={state.message} />

      {/* Two columns from tablet up; the design system defines no `sm:`. */}
      <div className="grid grid-cols-1 gap-lg tablet:grid-cols-2">
        <Field
          label="Full name"
          name="fullName"
          autoComplete="name"
          error={errors["fullName"]}
          required
        />
        <Field
          label="Company name"
          name="companyName"
          autoComplete="organization"
          error={errors["companyName"]}
          required
        />
        <Field
          label="Work email"
          name="email"
          type="email"
          autoComplete="email"
          error={errors["email"]}
          required
        />
        <Field
          label="Contact number"
          name="phone"
          type="tel"
          autoComplete="tel"
          description="Indian numbers may omit the country code."
          error={errors["phone"]}
          required
        />
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          description="3–32 characters: letters, numbers, dots, underscores."
          error={errors["username"]}
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          /* new-password asks a manager to offer a generated one. */
          autoComplete="new-password"
          description="At least 12 characters."
          error={errors["password"]}
          required
        />
        <Field
          label="Confirm password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          error={errors["confirmPassword"]}
          required
          containerClassName="tablet:col-span-2"
        />
      </div>

      <SubmitButton>Create account</SubmitButton>
    </form>
  );
}

function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Creating account…" : children}
    </Button>
  );
}
