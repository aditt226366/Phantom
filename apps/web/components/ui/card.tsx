import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Card.
 *
 * Elevation in this system is "hairline + one soft drop tier" - there is no
 * shadow ramp. A card is a white surface on the off-white canvas, separated by
 * a 1px hairline, optionally lifting on hover.
 *
 * Variants map onto the design doc's card components:
 *   default -> feature-card / pricing-tier-card / testimonial-card
 *   flush   -> product-card-stack (children fill edge to edge)
 *   soft    -> gradient-orb-card (softer canvas, 24px radius)
 *   dark    -> pricing-tier-featured (dark inversion)
 */
const cardVariants = cva("relative", {
  variants: {
    variant: {
      default:
        "rounded-xl border border-hairline bg-surface-card text-ink",
      flush:
        "overflow-hidden rounded-xl border border-hairline bg-surface-card text-ink",
      soft: "overflow-hidden rounded-xxl border border-hairline-soft bg-canvas-soft text-ink",
      dark: "rounded-xl border border-surface-dark-elevated bg-surface-dark text-on-dark",
    },
    padding: {
      none: "p-0",
      /** feature-card */
      md: "p-lg",
      /** pricing / testimonial / orb card */
      lg: "p-xl",
    },
    interactive: {
      true: "transition-shadow duration-150 hover:shadow-soft-drop",
      false: "",
    },
  },
  defaultVariants: {
    variant: "default",
    padding: "md",
    interactive: false,
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant, padding, interactive, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(cardVariants({ variant, padding, interactive }), className)}
      {...props}
    />
  );
});

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...props }, ref) {
  return (
    <div ref={ref} className={cn("flex flex-col gap-xs", className)} {...props} />
  );
});

/** Component titles run Inter 500, not the display serif. */
export const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardTitle({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn("font-body text-title-md text-ink", className)}
      {...props}
    />
  );
});

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p ref={ref} className={cn("text-body-md text-body", className)} {...props} />
  );
});

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn("mt-base", className)} {...props} />;
});

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn("mt-lg flex items-center gap-sm", className)}
      {...props}
    />
  );
});

export { cardVariants };
