import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Button.
 *
 * The design system allows exactly one filled action colour - the near-black
 * ink pill - and it is deliberately scarce. Everything else is an outline, a
 * quiet ghost, or inline text. There is no saturated "brand" variant and no
 * success/danger fill: green exists only as a semantic status colour, never
 * as something you click.
 *
 * Geometry is fixed by the brand: pill radius, 40px tall, 15px/500 label.
 */
const buttonVariants = cva(
  [
    "inline-flex select-none items-center justify-center gap-xs whitespace-nowrap",
    "text-button font-body",
    "transition-colors duration-150",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
    "disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        /** The primary action. Near-black ink pill. Use once per view. */
        primary:
          "rounded-pill bg-primary text-on-primary hover:bg-primary-active active:bg-primary-active",
        /** Secondary. Transparent pill with a hairline border. */
        outline:
          "rounded-pill border border-hairline-strong bg-transparent text-ink hover:bg-surface-strong active:bg-hairline",
        /** Tertiary. No border until hovered. */
        ghost:
          "rounded-pill bg-transparent text-ink hover:bg-surface-strong active:bg-hairline",
        /** Inline text link. */
        link: "bg-transparent text-ink underline-offset-4 hover:underline",
        /** Primary, inverted for use on a dark band. */
        "on-dark":
          "rounded-pill bg-surface-card text-ink hover:bg-surface-strong active:bg-hairline",
      },
      size: {
        /** Brand default: 40px tall, 10px x 20px padding. */
        default: "h-button px-md",
        sm: "h-8 px-sm text-caption",
        lg: "h-11 px-lg",
        icon: "h-button w-button p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element (e.g. a next/link) instead of a <button>. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, asChild = false, ...props }, ref) {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

export { buttonVariants };
