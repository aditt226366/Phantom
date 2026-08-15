"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  INTEGRATION_LABELS,
  integrationFields,
  type IntegrationProviderName,
} from "@whatsapp-os/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import {
  saveIntegrationAction,
  type IntegrationFormState,
} from "../actions";

/**
 * One provider's credentials.
 *
 * Two rules hold here, and both are about what the browser is allowed to see.
 *
 * A secret field is never given a value — not from the database, which the
 * panel cannot read, and not from `state.values`, which cannot contain one.
 * Its placeholder shows the mask so an operator can tell a stored credential
 * from an empty slot, and the mask is built from last4 alone.
 *
 * A blank field means "leave it alone". That is what makes it possible to
 * rotate one credential without re-typing three others that are not
 * displayable, and it is why every field is optional.
 */

export interface StoredSecretHint {
  key: string;
  last4: string | null;
}

export interface IntegrationFormProps {
  companyId: string;
  provider: IntegrationProviderName;
  stored: readonly StoredSecretHint[];
  csrf: ReactNode;
}

function maskFor(hint: StoredSecretHint | undefined): string {
  if (!hint) return "Not set";
  return hint.last4 ? `••••••••${hint.last4}` : "•••••••• (stored)";
}

export function IntegrationForm({
  companyId,
  provider,
  stored,
  csrf,
}: IntegrationFormProps) {
  const [state, formAction] = useActionState<IntegrationFormState, FormData>(
    saveIntegrationAction,
    {},
  );

  const hints = new Map(stored.map((hint) => [hint.key, hint]));

  return (
    <form action={formAction} className="flex flex-col gap-base">
      {csrf}
      <input type="hidden" name="companyId" defaultValue={companyId} />
      <input type="hidden" name="provider" defaultValue={provider} />

      <FormStatus
        message={state.success ?? state.message}
        tone={state.success ? "success" : "error"}
      />

      {integrationFields(provider).map((field) => {
        const hint = hints.get(field.key);

        return (
          <Field
            key={field.key}
            name={field.key}
            label={field.label}
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={maskFor(hint)}
            /*
             * Secret fields get nothing back. state.values holds only
             * non-secret entries, so this is belt and braces — and it is the
             * belt worth keeping, because the day someone widens the state is
             * the day this line is the only thing standing between a token and
             * the page source.
             */
            {...(field.secret
              ? {}
              : { defaultValue: state.values?.[field.key] ?? "" })}
            {...(field.hint ? { description: field.hint } : {})}
            {...(state.fieldErrors?.[field.key]
              ? { error: state.fieldErrors[field.key] }
              : {})}
          />
        );
      })}

      <p className="text-body-sm text-muted">
        Leave a field blank to keep the credential already stored for{" "}
        {INTEGRATION_LABELS[provider]}. Secret values are never shown and must
        be re-entered to change them.
      </p>

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="outline" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}
