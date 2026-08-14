import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Text input.
 *
 * Brand geometry: 44px tall, 8px radius (inputs are the one place the system
 * does not use a pill), 12x16 padding, hairline-strong border thickening to a
 * 2px ink ring on focus.
 *
 * `aria-invalid` drives the error styling rather than a prop, so it stays in
 * step with what assistive tech is told.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, type = "text", ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "h-input w-full rounded-md border border-hairline-strong bg-surface-card",
          "px-base py-sm font-body text-body-md text-ink",
          "placeholder:text-muted-soft",
          "transition-colors duration-150",
          "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink",
          "disabled:cursor-not-allowed disabled:bg-surface-strong disabled:text-muted-soft",
          "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:outline-error",
          className,
        )}
        {...props}
      />
    );
  },
);

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, rows = 4, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          "w-full rounded-md border border-hairline-strong bg-surface-card",
          "px-base py-sm font-body text-body-md text-ink",
          "placeholder:text-muted-soft",
          "transition-colors duration-150",
          "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink",
          "disabled:cursor-not-allowed disabled:bg-surface-strong disabled:text-muted-soft",
          "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:outline-error",
          className,
        )}
        {...props}
      />
    );
  },
);
