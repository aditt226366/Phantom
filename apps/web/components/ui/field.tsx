import * as React from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A labelled form control.
 *
 * This is the composition from the styleguide's FormGallery, packaged so the
 * wiring cannot be got wrong twice: `htmlFor` matching the control id,
 * `aria-invalid` driving the error styling, and `aria-describedby` pointing at
 * the message. Hand-rolling that at every call site is how a form ends up with
 * an error a screen reader never announces.
 *
 * Deliberately a Server Component. Nothing here needs state — the error arrives
 * as a prop from useActionState in the parent — and marking it "use client"
 * would drag every form that uses it into the client bundle for no reason.
 */
export interface FieldProps extends Omit<InputProps, "id" | "name"> {
  label: string;
  name: string;
  /** Validation message. Its presence is what puts the control in the error state. */
  error?: string;
  /** Hint shown under the label, before the control. */
  description?: string;
  /** Defaults to `name`, which is unique within a form. */
  id?: string;
  /** Class for the wrapper, not the input. */
  containerClassName?: string;
}

export function Field({
  label,
  name,
  error,
  description,
  id,
  required,
  containerClassName,
  className,
  ...props
}: FieldProps) {
  const fieldId = id ?? name;
  const errorId = `${fieldId}-error`;
  const descriptionId = `${fieldId}-description`;

  /*
   * Both are referenced when both exist, so the hint is not lost the moment
   * the field goes invalid — which is exactly when it is most useful.
   */
  const describedBy =
    [error ? errorId : null, description ? descriptionId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-xs", containerClassName)}>
      <Label htmlFor={fieldId}>
        {label}
        {required ? (
          /*
           * Decoration only. The real signal is the `required` attribute, which
           * assistive tech reports as "required" on its own; an asterisk read
           * aloud as "star" adds noise and communicates nothing.
           */
          <span aria-hidden="true" className="text-error">
            {" "}
            *
          </span>
        ) : null}
      </Label>

      {description ? (
        <p id={descriptionId} className="text-caption text-muted">
          {description}
        </p>
      ) : null}

      <Input
        id={fieldId}
        name={name}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={className}
        {...props}
      />

      {error ? (
        <p id={errorId} className="text-caption text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
