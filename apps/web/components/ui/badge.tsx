import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge / pill.
 *
 * Always pill geometry, always the uppercase caption step (12px / 600 /
 * +0.96px tracking).
 *
 * On the semantic variants the colour is carried by the *text*, not a filled
 * background. That is deliberate: a saturated fill would read as an action,
 * and the system reserves filled colour for the ink CTA alone. Green here is
 * status, never something to click.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-xxs rounded-pill px-[10px] py-xxs font-body text-caption-uppercase uppercase",
  {
    variants: {
      variant: {
        default: "bg-surface-strong text-ink",
        outline: "border border-hairline-strong bg-transparent text-ink",
        "on-dark": "bg-surface-dark-elevated text-on-dark",
        success: "bg-surface-strong text-success",
        error: "bg-surface-strong text-error",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
